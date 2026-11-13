import * as api from "./api.js";

// 豆包工作（doubao.com）签到工具。
//
// 流程：detail 只读预检 → 上报落地页事件 → 打签到接口。
//
// detail 用客户端身份（aid=1044603）时是活的：2026-11-13 抓包返回 code:0，
// data.tasks 里的 daily_signin 直接给出 checked_in_today / continuous_days /
// total_amount。它只用于"今天已签就省掉一次写请求"和展示连续天数，不设闸：
// detail code:2 只代表这套参数没命中活动组，绝不据此判 inactive（同参数下
// checkin 仍可能 code:0，线上已实测）。
//
// 成功判据完全落在 checkin 的 data.checked_in 上：
//   checked_in:true + idempotent:false → 本次真的签上
//   checked_in:true + idempotent:true  → 今天早就签过（幂等重放，不重复记额度）
//
// 这家有一条与另外几家都不同的硬约束：**没有 refresh_token 自动续期**。
// Cookie 里的 LARK_SUITE_ACCESS_TOKEN 大约 5–6 天就过期，过期只能人工重抓。
// 所以凭据里放了一个只读的「到期时间」，并且 401/710012001 一律报 login_required，
// 不重试、不吞掉 —— 让它在卡片上一直红着，比每天安静地失败要好。
//
// 上游方言（翻成内核状态）：
//   code:0 + data.checked_in=true + idempotent:false → claimed（本次新领到）
//   code:0 + data.checked_in=true + idempotent:true  → already（今天早就签过）
//   710012001 / HTTP 401 / 403                       → login_required（不重试）
//   710010702                                        → pending（今天还没开门，换窗口再来）
//   code:2 / campaign not found                      → inactive（活动换季，要改配置）
//   710022004 / HTTP 429                             → rate_limited
//   HTTP 408 / 5xx / 网络失败                         → waiting（请求可能已生效，下一轮再试）
//
// 一个反复踩过的坑：这些"看起来像失败"的码不能用 error 表达。
// error 在界面上是红条（NEEDS_ACTION），而 710010702 每天都会出现；
// 把它染红等于训练用户忽略红条。

const GROUP_FALLBACK = api.defaultGroup;

export default {
  id: "doubao",
  name: "豆包工作",
  order: 50,
  summary: "每天签到领取豆包工作赠送的额度",

  // 工具级：同一个账号在两套身份参数下命中的活动配置可能不同，
  // 所以 aid / device_platform 这些放在 config 而不是 creds —— 它们不是"这个号是谁"，
  // 而是"我们假装自己是谁"。换一条链路不该要求用户重录 Cookie。
  config: [
    {
      key: "profile",
      label: "身份参数组合",
      type: "select",
      // 不设 required：这两项都有代码内的默认值，要求"先保存一次配置"才肯跑，
      // 只会让刚加进来的工具在 cron 里静默空转（报缺项的那条文案还说是配置没填）。
      default: "client",
      options: [
        { value: "client", label: "客户端（aid=1044603，detail + checkin 均已实测）" },
        { value: "work", label: "工作端（aid=497858，checkin 已实测，detail 不可用）" },
      ],
      help: "默认「客户端」：2026-11-13 抓包里 detail 与 checkin 都回 code:0，是当前唯一能读详情的身份。"
        + "切回「工作端」后 checkin 仍能跑，但 detail 会回 code:2，只能盲签。",
    },
    {
      key: "campaignGroup",
      label: "活动组代码",
      type: "text",
      default: GROUP_FALLBACK,
      help: "已预填当前值，通常不用动（留空也回落到这个默认值）。上游换季时会返回 code:2 campaign not found，"
        + "届时把这个值改成新的（工具不再自动猜组名）。",
    },
    {
      key: "deviceId",
      label: "设备标识（device_id）",
      type: "text",
      default: "1202216710179008",
      placeholder: "抓包里的 device_id",
      help: "已按 2026-11-13 客户端抓包预填。换机器/换号时改成自己的值；"
        + "留空则不发送，detail 可能读不到活动，checkin 仍会尝试。",
    },
    {
      key: "webId",
      label: "web_id",
      type: "text",
      default: "7699062794213803529",
      placeholder: "抓包里的 web_id（tea_uuid 取 device_id）",
    },
    {
      key: "userAgent",
      label: "User-Agent（可选）",
      type: "text",
      placeholder: "留空则按所选身份组合自带默认值",
      help: "默认值与抓包一致（Chrome/147 + SamanthaDoubaoWork）。"
        + "纯服务端接口未必校验它，但保持与客户端一致能少一个变量。",
    },
    {
      key: "extraQuery",
      label: "附加查询参数（可选）",
      type: "textarea",
      placeholder: "可直接粘贴抓包 URL 里 ? 之后的一整段",
      help: "用于补/换 msToken、a_bogus 等签名参数：同名参数会覆盖内置的抓包默认值。"
        + "detail 默认会先带抓包签名、失败再自动不带签名重试一次；签名过期时不必手动清空。",
    },
    { key: "timeoutMs", label: "请求超时（毫秒）", type: "text", placeholder: "30000" },
  ],

  creds: [
    {
      key: "cookie",
      label: "网页 Cookie（整段）",
      type: "textarea",
      required: true,
      secret: true,
      help: "从 www.doubao.com 的任意请求头里整段复制（不能精简）：账号标识要么来自 multi_sids，"
        + "要么来自 LARK_SUITE_ACCESS_TOKEN，这两个字段在 Application 面板里看不到。",
    },
    {
      key: "uid",
      label: "账号标识",
      type: "text",
      required: false,
      pattern: "^[A-Za-z0-9._-]{1,64}$",
      patternMessage: "只允许字母、数字、点、下划线、横线，最长 64",
      help: "仅当 Cookie 里既没有 multi_sids、也没有可解的 LARK_SUITE_ACCESS_TOKEN 时才填。"
        + "它是账号的键名，建号后不要再改 —— 改了等于另起一个账号。",
    },
    {
      key: "expiresAt",
      label: "凭据最早到期时间",
      type: "datetime",
      readonly: true,
      help: "取自 LARK_SUITE_ACCESS_TOKEN 的 exp（约 5–6 天）。到期后只能重新抓 Cookie，豆包没有自动续期接口。",
    },
  ],

  // 一次性迁移：旧版默认是 work，detail 只有 client 能读。已存 work 的配置在打开
  // 配置页时切成 client，并打上标记；用户之后若主动选回 work，不会被再次改掉。
  migrateConfig(values) {
    const current = values && typeof values === "object" ? values : {};
    if (current.profile === "work" && current.profileMigrated !== "1") {
      return { ...current, profile: "client", profileMigrated: "1" };
    }
    return null;
  },

  uidOf(values) {
    const uid = api.uidFromCookie(values);
    const expiresAt = api.expiresAtFromCookie(values);
    // 顺手解出来的到期时间是 readonly 字段，coerceFields 收不到，只能从这里带进账号记录
    return expiresAt > 0 ? { uid, cred: { expiresAt: String(expiresAt) } } : uid;
  },

  schedule: {
    // 签到按自然日结算（响应里的 checkin_date 是北京时间的日历日），所以逻辑日在零点翻。
    resetHour: 0,
    // 上游的"今天开门"时刻会漂移（实测 10:45 还拒、10:55 才放行），单一时刻不可靠。
    // 9 点起跑，靠 pending 自带的一小时节流把尝试摊到 9/10/11/12… 覆盖整个上午。
    notBeforeHour: 9,
    minIntervalSec: 1800,
    // pending 每小时才重试一次，maxDaily 只是兜住真正的失败重试，不会把窗口耗光
    maxDaily: 8,
    backoff: [10, 30, 60],   // 单位是分钟：限流后 10 → 30 → 60 分钟再来
  },

  hosts: api.doubaoHosts,

  // 典型 3 次：detail 1 + report 1 + checkin 1；detail 签名回退、签到未确认再复核
  // 各会多 1 次。声明 5 留余量，单轮预算 45 足够。
  steps: [
    {
      id: "checkin",
      label: "每日签到",
      cost: 5,
      async run(ctx) {
        const group = String((ctx.config || {}).campaignGroup || "").trim() || GROUP_FALLBACK;

        // detail 只读预检：登录态失效先报 login_required，今天已签则省掉一次写请求。
        // detail 的其他失败（code:2 / 5xx / 签名过期）一律不设闸，继续走 checkin。
        const detail = await api.readDetail(ctx, group);
        if (detail.kind === "login") {
          return {
            status: "login_required",
            message: `详情读取被拒：登录态已失效（${detail.message || "401/710012001"}），请重新抓取完整 Cookie`,
            credits: 0,
          };
        }
        if (detail.kind === "ok" && detail.checkedInToday) {
          const extra = [
            detail.continuousDays ? `连续 ${detail.continuousDays} 天` : "",
            detail.totalAmount ? `累计 ${detail.totalAmount} 额度` : "",
          ].filter(Boolean).join("，");
          return {
            status: "already",
            message: `今日已签到（detail 确认${extra ? `：${extra}` : ""}），不再发签到请求`,
            credits: 0,
          };
        }

        // 落地页事件是 best-effort，失败不影响签到
        await api.reportLanding(ctx);

        const claim = await api.checkin(ctx, group);

        if (claim.kind === "login") {
          return {
            status: "login_required",
            message: `签到被拒：登录态已失效（${claim.message || "401/710012001"}），请重新抓取完整 Cookie`,
            credits: 0,
          };
        }
        if (claim.kind === "rate") {
          return { status: "rate_limited", message: `签到被限流：${claim.message || "429"}`, credits: 0 };
        }
        if (claim.kind === "pending") {
          return {
            status: "pending",
            message: "签到接口说今天还没开放（710010702）：属于正常的开窗漂移，下一轮再来",
            credits: 0,
          };
        }
        if (claim.kind === "risk") {
          return {
            status: "error",
            message: `签到被判定为人机验证/风控：${claim.message || "无详情"}（不是凭据问题，重试也不会好）`,
            credits: 0,
          };
        }
        if (claim.kind === "notfound") {
          return {
            status: "inactive",
            message: `活动组 ${group} 不存在（campaign not found）：要么已换季，要么这个号不在投放范围。`
              + "请核对「活动组代码」，必要时到网页端确认活动入口是否还在",
            credits: 0,
          };
        }
        if (claim.kind === "transient") {
          // 超时不等于失败：签到是写请求，可能已经在服务端生效了。
          // 报 error 会让人立刻去重抓 Cookie，报 waiting 才是这儿的真相。
          return {
            status: "waiting",
            message: "签到请求超时或上游 5xx：可能已经在服务端生效，下一轮再看",
            credits: 0,
          };
        }
        if (claim.kind === "unconfirmed") {
          // 签到回了 code:0 但没给 checked_in：再用 detail 复核一次。
          // detail 说已签才算已签，但这次不是"新领取"，额度记 0；detail 也读不到就 waiting。
          const verify = await api.readDetail(ctx, group);
          if (verify.kind === "ok" && verify.checkedInToday) {
            return {
              status: "already",
              message: `签到响应未被确认，但 detail 显示今日已签`
                + `${verify.continuousDays ? `（连续 ${verify.continuousDays} 天）` : ""}；按已签处理，不记额度`,
              credits: 0,
            };
          }
          return {
            status: "waiting",
            message: `${claim.message || "签到未被确认"}：不当作成功，下一轮再试`,
            credits: 0,
          };
        }
        if (claim.kind === "error") {
          return { status: "error", message: `签到失败：${claim.message || "未知响应"}`, credits: 0 };
        }

        if (claim.idempotent) {
          return {
            status: "already",
            message: `今日已签到（上游判为幂等重放）`
              + `${claim.continuousDays ? `，连续 ${claim.continuousDays} 天` : ""}`,
            credits: 0,
          };
        }

        const extras = [
          claim.rewardAmount ? `+${claim.rewardAmount} 额度` : "本次到账 0",
          claim.continuousDays ? `连续 ${claim.continuousDays} 天` : "",
          claim.checkinDate ? claim.checkinDate : "",
        ].filter(Boolean).join("，");

        return {
          status: "claimed",
          message: `签到成功：${extras}`,
          credits: claim.rewardAmount,
        };
      },
    },
  ],

  // 「测试」按钮：先本地验 uid/到期时间，再发一次只读 detail 读今日状态。
  // detail 失败按原因报，不伪装成"已连通"。
  async validate(ctx) {
    const cred = (ctx.account && ctx.account.cred) || {};
    const uid = api.uidFromCookie(cred);
    if (!uid) {
      return {
        status: "error",
        message: "Cookie 里解不出账号标识：multi_sids 与 LARK_SUITE_ACCESS_TOKEN 都没有。"
          + "请从请求头整段复制，不要手工删字段",
        credits: 0,
      };
    }
    const expiresAt = api.expiresAtFromCookie(cred);
    if (expiresAt > 0 && expiresAt <= ctx.now) {
      return {
        status: "login_required",
        message: "LARK_SUITE_ACCESS_TOKEN 已过期，请重新抓取整段 Cookie",
        credits: 0,
      };
    }
    const tail = expiresAt > 0
      ? `LARK 令牌还剩 ${Math.ceil((expiresAt - ctx.now) / 86400)} 天`
      : "Cookie 里没有 LARK_SUITE_ACCESS_TOKEN，判断不了到期时间";

    // detail 是只读接口，正好拿来当「测试」：既验登录态，也把今日状态带出来。
    // 它失败不等于凭据不行（签名过期/活动组不对都可能），按失败原因分开报。
    const group = String((ctx.config || {}).campaignGroup || "").trim() || GROUP_FALLBACK;
    const detail = await api.readDetail(ctx, group);
    if (detail.kind === "login") {
      return {
        status: "login_required",
        message: `登录态已失效（${detail.message || "401/710012001"}），请重新抓取整段 Cookie`,
      };
    }
    if (detail.kind === "notfound") {
      // code:2 只说明这套身份没命中活动组，不能据此断言活动没了 —— 同参数下 checkin 仍可能成功。
      return {
        status: "error",
        message: `detail 回 code:2：活动组 ${group} 在这套身份参数下没读到，请核对「活动组代码」或身份参数；`
          + "这不代表签到一定失败，点「执行」仍会尝试 checkin",
      };
    }
    if (detail.kind === "ok") {
      const extra = [
        detail.checkedInToday ? "今日已签" : "今日未签",
        detail.continuousDays ? `连续 ${detail.continuousDays} 天` : "",
        detail.totalAmount ? `累计 ${detail.totalAmount} 额度` : "",
      ].filter(Boolean).join("，");
      return {
        status: "ok",
        message: `登录态有效：账号 ${uid}，${tail}；${extra}`,
      };
    }
    if (detail.kind === "rate") {
      return { status: "rate_limited", message: `只读校验被限流：${detail.message || "429"}` };
    }
    return {
      status: "error",
      message: `只读校验失败：${detail.message || detail.kind || "未知响应"}`,
    };
  },
};
