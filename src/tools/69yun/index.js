import * as api from "./api.js";

// 69 云（SSPanel 机场）签到工具。
//
// 与其他三家的本质区别：鉴权是 Cookie Session，不是 Bearer Token。
// 每次签到先拿存的 Cookie 试，被 3xx 重定向就说明失效了，重新走一遍登录流程，
// 新 Cookie 通过 cred 回写机制存进 KV（跟 Qoder 的 accessToken 续期同构）。
//
// 「3xx 即失效」这个判据成立的前提是请求带 redirect: "manual" —— 自动跟随会把
// 登录页的 200 当成签到响应，解析不出 JSON 就报一个和真实原因无关的错。
// 下游每一次签到请求都必须带这个参数（api.js 里已写死，勿删）。
// 该判据已实测确认：2026-10-04 无 Cookie 打 /user/checkin 得到 302 → /auth/login。
//
// 登录流程只有 POST /auth/login 一笔，**没有"先 GET 登录页"、也没有"再轮询 /user"**
// （两者均于 2026-10-04 经实测删除，理由见 api.js 的 login() 注释）。
// POST 登录不可省：它是唯一能换出新 Cookie 的地方，省掉它 Cookie 一失效
// 账号就只能进 login_required 等人工重录。
//
// 上游方言（都翻成内核的状态）：
//   POST /user/checkin  ret=1 → 签到成功（claimed）
//   POST /user/checkin  ret=0 → 今日已签到（already）
//   POST /user/checkin  3xx   → Cookie 失效，重新登录后再试一次
//   登录 429                  → 被限频（rate_limited，按 schedule.backoff 退避）
//   登录 5xx / 轮询异常 / session 一直不就绪 → 上游的问题（waiting，等下一轮，不亮红条）
//   登录 ret!==1 且 4xx        → 凭据不行（login_required，要用户重录）

export default {
  id: "69yun",
  name: "69 云",
  order: 40,
  summary: "每天签到领取机场流量",

  // 工具级配置：只有超时。域名写死在 api.js（就这一个机场）。
  config: [
    {
      key: "timeoutMs",
      label: "请求超时（毫秒）",
      type: "text",
      placeholder: "30000",
      help: "留空即用 30000（30 秒）。机场响应可能比 IDE 接口慢，不建议低于 10000",
    },
  ],

  // 账号级凭据。
  // cookie 是 readonly+secret：不在表单里出现，由登录流程自动写回 KV。
  // 跟 Qoder 的 accessToken 一样，用户不需要手动碰它。
  creds: [
    {
      key: "email",
      label: "邮箱",
      type: "text",
      required: true,
      help: "登录 69 云用的邮箱，同时作为账号的唯一键",
    },
    {
      key: "password",
      label: "密码",
      type: "password",
      required: true,
      secret: true,
      help: "登录密码。Cookie 失效时用它重新登录",
    },
    {
      key: "cookie",
      label: "会话 Cookie",
      type: "textarea",
      readonly: true,
      secret: true,
      help: "登录后自动保存，无需手动填写。失效时会自动用邮箱密码重新登录",
    },
  ],

  // uid 直接用邮箱。sanitizeUid 会剥掉 @，但邮箱的本地+域名组合后仍然唯一。
  uidOf: (ctx) => String(ctx.values.email || "").trim(),

  schedule: {
    // 机场签到 0 点刷新，没有特定发放窗口（跟 Trae/WorkBuddy 一样）。
    resetHour: 0,
    notBeforeHour: 0,
    minIntervalSec: 1800,
    maxDaily: 10,
    // 退避阶梯，**单位是分钟**（内核的 backoffSec 会 ×60，别写成秒）。
    // 只有上游回 429（真限频）时步骤才产出 rate_limited，而内核也只在那个状态下读它。
    // cron 是 30 分钟一轮，所以前两档在下一轮醒来时早已过期 —— 实际节奏由 30 分钟那档
    // 与 cron 共同决定；留着前两档是为了 cron 变密时不必再动这里。
    backoff: [5, 10, 30],
  },

  hosts: api.yun69Hosts,

  // 最坏情况 cost = 4（逐笔数得出来）：
  //   1（checkin 被 3xx）+ 1（POST 登录）+ 1（再 checkin）= 3
  // 声明 4 = 3 + 1 笔**保守余量**。留着它是因为**往小了改才是危险方向**：
  // cost 是开跑前的静态准入判据（budget.fits），低于真实上界会发出一张装不下的
  // 假票；而多预约一次只是让调度少排一个账号。正常情况（Cookie 有效）只花 1 次。
  //
  // 2026-10-04：8 → 7 删掉「GET /auth/login 拿初始 session cookie」（实测 Set-Cookie 恒 null）；
  // 7 → 4 删掉「轮询 GET /user 验 session 就绪」（实测首击 200、无传播延迟，详见 api.js）。
  //
  // 别把 maxDaily 也当成"一天打几次"来改：稳态下 already ∈ SETTLED，
  // isDue 的第一道闸（scheduler.js）当天就不再排这个账号，一天实际只打 1 次签到。
  // maxDaily 只在"当天一次都没走到 SETTLED"（连着 waiting/error）时才有意义。
  steps: [
    {
      id: "checkin",
      label: "签到领流量",
      cost: 4,
      async run(ctx) {
        const existingCookie = ctx.account.cred.cookie || "";
        let cookie = existingCookie;
        let rotated = null;

        // 有 Cookie 就先试一次
        if (cookie) {
          const result = await api.checkin(ctx, cookie);
          if (!result.authFailed) {
            return wrap(result, rotated);
          }
          // 3xx = Cookie 失效， fall through 到重新登录
        }

        // 重新登录
        const login = await api.login(ctx);
        if (login.error) {
          // 三种失败的去向完全不同，不能混：
          //   rate      —— 被限频，排 retryAt 走 schedule.backoff（内核只在这个状态下读它）
          //   transient —— 上游自己的问题：不亮红条（重录密码没用），也不谎报「限频」，
          //                报 waiting 等下一轮
          //   auth      —— 凭据真不行，要用户重录
          if (login.kind === "rate") {
            return { status: "rate_limited", message: login.error, credits: 0, cred: null };
          }
          if (login.kind === "transient") {
            return { status: "waiting", message: login.error, credits: 0, cred: null };
          }
          return {
            status: "login_required",
            message: login.error,
            credits: 0,
            cred: null,
          };
        }
        cookie = login.cookie;
        rotated = { cookie };
        // rotated 只表示"新串拿到了"，落盘由内核做（runner.js 的凭据轮换段）。
        // 写回失败时内核会在日志 message 后追加「（新凭据写回失败…）」，
        // 但这一步的 status 仍是 claimed —— 用户看到的是"签到成功"，
        // 而 Cookie 没存上，下一轮又要重新登录一遍（多花 3 笔：登录 + 再签到 + 试签到）。
        // 这是内核对三家的统一处理，不在本工具里另开分支：
        // 要判"写回有没有成"，得看运行日志详情里那句话，不看则无从察觉。

        // 登录成功后再签到一次。**中间不需要任何"验 session 就绪"的步骤** ——
        // 2026-10-04 实测：登录响应一解析完立刻打签到，首击就是 HTTP 200（194ms，
        // ret=0），没有所谓的传播延迟。原来那 3 次 GET /user 轮询是在解一个不存在的问题，
        // 而且它问的是"登录态还在吗"，用的却是和签到无关的页面 ——
        // 签到端点自己就是更好的探针：200 = cookie 有效，3xx = 失效。
        const result = await api.checkin(ctx, cookie);
        if (result.authFailed) {
          // 首击就 3xx：既然实测没有传播延迟，这就是真的异常（不是"等等就好"）。
          // 如实报 error，不粉饰成"等待中"——用户能看出这轮不对劲，而 waiting 会静静混过去。
          return {
            status: "error",
            message: "重新登录后签到仍被重定向，session 可能异常",
            credits: 0,
            cred: rotated,
          };
        }
        return wrap(result, rotated);
      },
    },
  ],

  // 「测试」按钮：只登录，不发签到请求。验证邮箱密码是否正确。
  async validate(ctx) {
    const login = await api.login(ctx);
    if (login.error) {
      // 与步骤同口径：限频与上游故障都不是"凭据不行"。测试是手动点的，
      // 所以把原文带出来、让用户看到"这次为什么没测成"最有用。
      if (login.kind === "rate") return { status: "rate_limited", message: login.error };
      if (login.kind === "transient") return { status: "error", message: login.error };
      return { status: "login_required", message: login.error };
    }
    // 必须**就地改写** ctx.account.cred，不能把 cookie 放进返回值：
    // validateAccount 的落盘判据是「调用前后 account.cred 的差异」
    // （runner.js 的 validateAccount），它根本不看 outcome.cred ——
    // 返回 { cookie } 的话新 Cookie 会被直接丢掉，而下面这句话还会撒谎。
    // 三家都是就地 Object.assign（Trae ensureToken / Qoder authorized /
    // WorkBuddy refresh），这里跟着同构。SSPanel 登录多半会覆盖 session，
    // 不写回的话旧 Cookie 可能当场作废，下一轮必然又是 3xx。
    ctx.account.cred.cookie = login.cookie;
    // 不写「已保存」——写没保存由内核决定，它会在后面自动追加
    // 「（本次测试顺带续了期，新凭据已写回）」或「（没能写回…）」。自己写等于抢它的话。
    return { status: "ok", message: "登录成功" };
  },
};

// 把 api.checkin 的返回翻成内核方言，同时带上 cred 回写。
function wrap(result, rotated) {
  if (result.timeout) {
    // 超时：请求可能已到达上游并执行成功，不能当 error（亮红条、让用户改密码没用）。
    // 归 waiting：下一轮上游会返回 ret=0（已签到）或正常签到，两种情况最终结果都正确。
    return { status: "waiting", message: "签到请求超时，下一轮再确认结果", credits: 0, cred: rotated };
  }
  if (result.error) {
    return { status: "error", message: result.error, credits: 0, cred: rotated };
  }
  // claimed / already 都不带 credits（机场签到的流量在 msg 里，不是数字字段）
  return { status: result.status, message: result.message, credits: 0, cred: rotated };
}
