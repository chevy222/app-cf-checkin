import * as api from "./api.js";

// 豆包工作（doubao.com）签到工具。
//
// 流程刻意做成"预检 → 上报 → 签到 → 复核"，而不是"直接打签到接口"：
//   · 预检（detail）先看今天签没签，已签就一次请求收工，不发多余的写请求；
//   · 复核再把上游的 checked_in 落到前台，避免"请求发出去了"被当成"额度到账了"。
//
// 这家有一条与另外四家都不同的硬约束：**没有 refresh_token 自动续期**。
// Cookie 里的 LARK_SUITE_ACCESS_TOKEN 大约 5–6 天就过期，过期只能人工重抓。
// 所以凭据里放了一个只读的「到期时间」，并且 401/710012001 一律报 login_required，
// 不重试、不吞掉 —— 让它在卡片上一直红着，比每天安静地失败要好。
//
// 上游方言（翻成内核状态）：
//   code:0 + data.checked_in=true + idempotent:false → claimed（本次新领到）
//   code:0 + data.checked_in=true + idempotent:true  → already（今天早就签过）
//   detail daily_checkin.checked_in_today=true       → already（预检直接收工）
//   710012001 / HTTP 401 / 403                       → login_required（不重试）
//   710010702                                        → pending（今天还没开门，换窗口再来）
//   code:2 / campaign not found                      → inactive（活动换季，要改配置）
//   710022004 / HTTP 429                             → rate_limited
//   HTTP 408 / 5xx / 网络失败                         → waiting（请求可能已生效，下一轮复核）
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
      required: true,
      default: "work",
      options: [
        { value: "work", label: "工作端（aid=497858，免签名，detail 已实测）" },
        { value: "client", label: "客户端（aid=1044603，checkin 已实测）" },
      ],
      help: "默认已预填，不用动。两套都来自本机成功抓包：默认的「工作端」在 2026-10-21 实测 detail 返回 code:0；"
        + "若宿主机出口 IP 被上游按另一套活动拦截，切到「客户端」再试一轮。",
    },
    {
      key: "campaignGroup",
      label: "活动组代码",
      type: "text",
      required: true,
      default: GROUP_FALLBACK,
      help: "已预填当前值，通常不用动。上游换季时会返回 code:2 campaign not found，"
        + "届时把这个值改成新的（工具也会尝试用 launch 自动发现一次）。",
    },
    {
      key: "deviceId",
      label: "device_id（可选）",
      type: "text",
      placeholder: "抓包里的 device_id，留空则不发",
      help: "同一台设备的值应固定。留空时服务端按其他参数识别，通常也能通过；"
        + "若切换身份组合后仍报设备不一致，再填这一项。",
    },
    {
      key: "webId",
      label: "web_id（可选）",
      type: "text",
      placeholder: "抓包里的 web_id / tea_uuid，留空则不发",
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
      help: "用于补 msToken / a_bogus / fp 等签名参数：同名参数会覆盖默认值。"
        + "默认的「工作端」链路不需要签名；只有切到「客户端」且被拦时才需要贴。",
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

  // 最坏情况：detail 1 + launch 1 + detail 1 + report 1 + checkin 1 + 复核 detail 1 = 6。
  // 声明 8 而不是 6：这家的请求形状还在实测期，多留两次重试余量，
  // 免得"预检换季 → 发现新组 → 复核"这条路径被预算判成装不下、整轮顺延。
  steps: [
    {
      id: "checkin",
      label: "每日签到",
      cost: 8,
      async run(ctx) {
        const group = String(ctx.config.campaignGroup || "").trim() || GROUP_FALLBACK;
        const notes = [];

        let detail = await api.readDetail(ctx, group);

        if (detail.kind === "login") {
          return {
            status: "login_required",
            message: `登录态已失效（${detail.message || "401/710012001"}）：请重新抓取完整 Cookie`,
            credits: 0,
          };
        }
        if (detail.kind === "rate") {
          return { status: "rate_limited", message: `预检被限流：${detail.message || "429"}`, credits: 0 };
        }
        if (detail.kind === "pending") {
          return {
            status: "pending",
            message: "今日签到尚未开放（710010702）：上游按自然日分批开窗，下一轮再来",
            credits: 0,
          };
        }
        if (detail.kind === "risk") {
          return {
            status: "error",
            message: `预检被上游判定为人机验证/风控：${detail.message || "无详情"}`
              + "（Worker 出口 IP 可能受限，这不是凭据问题）",
            credits: 0,
          };
        }

        if (detail.kind === "notfound") {
          // 活动组换季：先用 launch 找一次新组。找到也必须用 detail 复核过才采信，
          // 不能拿"原文里捞出来的字符串"当事实。
          const discovered = await api.discoverGroup(ctx);
          if (discovered) {
            const retry = await api.readDetail(ctx, discovered);
            if (retry.kind === "ok") {
              notes.push(`活动组已换季：${group} → ${discovered}`);
              detail = retry;
            } else {
              notes.push(`发现候选活动组 ${discovered}，但复核未通过`);
            }
          } else {
            notes.push(`活动组 ${group} 报 campaign not found（可能是换季），仍尝试签到`);
          }
        } else if (detail.kind !== "ok") {
          notes.push(`预检未完成（${detail.kind}: ${detail.message || "无详情"}），直接尝试签到`);
        } else if (!detail.hasDaily) {
          notes.push(`活动组 ${group} 里没有 daily_signin 任务`);
        }

        // 已签的判定放在换季复核之后：launch 找到的新组可能今天已经签过，
        // 这一步要能看见它，否则会白补一次幂等 checkin。
        if (detail.kind === "ok" && detail.checkedInToday) {
          const extras = [
            detail.continuousDays ? `连续 ${detail.continuousDays} 天` : "",
            detail.totalAmount !== null ? `累计 ${detail.totalAmount} 额度` : "",
          ].filter(Boolean).join("，");
          return {
            status: "already",
            message: `今日已签到${extras ? `（${extras}）` : ""}，没有重复发签到请求`,
            credits: 0,
          };
        }

        // 预检通过且今天没签 → 补一条落地页事件。best-effort，失败不影响后面。
        await api.reportLanding(ctx);

        const claim = await api.checkin(ctx, detail.kind === "ok" ? detail.group : group);

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
          // 超时不等于失败：签到是写请求，很可能已经在服务端生效了。
          // 报 error 会让人立刻去重抓 Cookie，报 waiting 才是这儿的真相。
          return {
            status: "waiting",
            message: "签到请求超时或上游 5xx：可能已经在服务端生效，下一轮用预检复核",
            credits: 0,
          };
        }
        if (claim.kind === "unconfirmed") {
          return {
            status: "waiting",
            message: `${claim.message || "签到未被确认"}：不当作成功，下一轮再复核`,
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

        // 到这里才是"本次真的签上了"。复核只是补证：detail 偶发不可用时照样算成功，
        // 因为 checkin 的响应本身就是服务端对"今天已签"的直接陈述。
        let verified = "";
        try {
          const recheck = await api.readDetail(ctx, claim.scene);
          if (recheck.kind === "ok" && recheck.checkedInToday) {
            verified = recheck.totalAmount !== null ? `，复核已签，累计 ${recheck.totalAmount} 额度` : "，复核已签";
          } else if (recheck.kind === "ok") {
            verified = "（复核时 detail 仍显示未签，可能有延迟）";
          }
        } catch { /* 复核失败不影响已经拿到的成功应答 */ }

        const extras = [
          claim.rewardAmount ? `+${claim.rewardAmount} 额度` : "本次到账 0",
          claim.continuousDays ? `连续 ${claim.continuousDays} 天` : "",
          claim.checkinDate ? claim.checkinDate : "",
        ].filter(Boolean).join("，");

        return {
          status: "claimed",
          message: `签到成功：${extras}${verified}${notes.length ? `；${notes.join("；")}` : ""}`,
          credits: claim.rewardAmount,
        };
      },
    },
  ],

  // 「测试」按钮：只读 detail，一次签到都不发。
  async validate(ctx) {
    const group = String(ctx.config.campaignGroup || "").trim() || GROUP_FALLBACK;
    const detail = await api.readDetail(ctx, group);

    if (detail.kind === "login") {
      return { status: "login_required", message: `登录态已失效：${detail.message || "401/710012001"}，请重新抓取完整 Cookie` };
    }
    if (detail.kind === "rate") return { status: "rate_limited", message: `预检被限流：${detail.message || "429"}` };
    if (detail.kind === "pending") {
      return { status: "pending", message: "登录态有效，但今天还没开放（710010702）：属于正常现象" };
    }
    if (detail.kind === "notfound") {
      return {
        status: "inactive",
        message: `活动组 ${group} 报 campaign not found：可能已换季，或这个号不在投放范围`,
      };
    }
    if (detail.kind === "risk") {
      return { status: "error", message: `被判定为人机验证/风控：${detail.message || "无详情"}（不是凭据问题）` };
    }
    if (detail.kind !== "ok") return { status: "error", message: `预检失败：${detail.message || "未知响应"}` };

    if (!detail.hasDaily) {
      return { status: "inactive", message: "登录态有效，但活动组里没有每日签到任务" };
    }
    const bits = [
      detail.checkedInToday ? "今日已签到" : "今日尚未签到",
      detail.continuousDays ? `连续 ${detail.continuousDays} 天` : "",
      detail.totalAmount !== null ? `累计 ${detail.totalAmount} 额度` : "",
    ].filter(Boolean).join("，");
    return { status: "ok", message: `登录态有效：${bits}` };
  },
};
