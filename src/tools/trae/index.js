import * as api from "./api.js";

// Trae 签到工具。
// 方言要点（都在 api.js 里逐条处理，这里只负责声明形状）：
//   所有接口都在 api.trae.cn，但换票/用户信息用 x-cloudide-token，签到/额度用 Cloud-IDE-JWT
//   业务码 code 0 / message 含 success → 领到；code 9095 /「已(签到|领取|领过|签过)」→ 今天已领
//   code 9074 / 429 /「频繁」「太多」→ 被频控，走跨轮退避阶梯
//   code 1001/1002 与 HTTP 401/403 同款处置 —— 强制换票重试一次（死票可能裹在 200 里）
//   enable === false → 这个号没被灰到；checked_in → 今天已领
//   x-device-id 必须是真实 8–20 位 Aha 号，随手填的会每天稳定 9074
//   ClientID 与版本号（1.107.1 / 3.3.104）已按真实抓包写死，不暴露给用户

export default {
  id: "trae",
  name: "Trae",
  order: 20,
  summary: "每天签到领额度包积分",

  config: [
    { key: "timeoutMs", label: "请求超时（毫秒）", type: "text", placeholder: "15000" },
    { key: "refreshAheadSec", label: "提前续期秒数", type: "text", placeholder: "259200（72 小时）" },
  ],

  creds: [
    {
      key: "accessToken",
      label: "Access Token",
      type: "textarea",
      required: true,
      secret: true,
      pattern: "^[^\\s]+$",
      patternMessage: "令牌里不能有空格",
      offline: "线下脚本换取（见说明页）",
      help: "uid 由它调 GetUserInfo 取得；这把票失效就得重新取一次",
    },
    {
      key: "refreshToken",
      label: "Refresh Token",
      type: "textarea",
      required: true,
      secret: true,
      pattern: "^[^\\s]+$",
      patternMessage: "令牌里不能有空格（注意别把 + 号丢了）",
      offline: "线下脚本换取（见说明页）",
      help: "每次续期都会换出新串，内核当场写回；旧串用过一次即废",
    },
    {
      key: "ahaDeviceId",
      label: "Aha 设备号",
      type: "text",
      required: true,
      // 8–20 位（2026-10-16 放宽上限）。不要收紧下界：会让用户手上现有的 8–15 位
      // 账号**录不进去**（唯一的症状是表单红字，与上游无关）；上限也不该卡在 16 ——
      // 参考项目在真实客户端上见到的注册号是 12–20 位，16 只是当时的观察值、不是规则。
      pattern: "^\\d{8,20}$",
      patternMessage: "必须是 8–20 位数字的 Aha 设备号",
      offline: "与 access token 同一次线下取值里拿到",
      help: "签到风控按它判定：随手编一个（哪怕格式看着对）会每天稳定返回「服务器繁忙」，看着像限频其实是设备号错了",
    },
    { key: "expiresAt", label: "令牌到期时间", type: "datetime", readonly: true },
  ],

  // Trae 的 UserID 不在 JWT 里，只能问 GetUserInfo 一次。这里会花一次子请求，
  // 换来的是"存进 KV 的键名就是上游认的那个号"。
  uidOf: (ctx) => api.uidFromToken(ctx),

  schedule: {
    resetHour: 0,          // 上游按北京零点判"今天签没签"
    notBeforeHour: 0,      // 零点第一轮就跑，越早领越好
    minIntervalSec: 1800,
    // 每天最多尝试 3 次 = 首跑 + 2 次重试；用尽那一轮内核在消息尾巴补「今日重试结束」。
    // 限频（9074）不占这个额度 —— 它走下面的退避阶梯，别被 3 次闸掐死。
    maxDaily: 3,
    // 跨轮退避（分钟）：内核把它写在 retryAt 上，不在进程内睡眠
    backoff: [30, 60, 120, 240, 360],
  },

  hosts: api.traeHosts,

  // 常规一轮：换票 1 + 状态 1 + 领取 1 + 额度包 1 = 4。
  // 状态/领取被鉴权拒绝后的强制换票是异常路径，不算在常规 cost 里（over 了只标记不中断）。
  steps: [
    {
      id: "checkin",
      label: "签到领积分",
      cost: 4,
      async run(ctx) {
        const ensured = await api.ensureToken(ctx);
        if (ensured.error) return { status: "login_required", message: ensured.error, credits: 0, cred: null };
        let cred = ensured.rotated || null;
        let token = ensured.token;

        let status = await api.readStatus(ctx, token);
        if (status.authFailed) {
          // 这把票被上游提前判死了：强制换一次再读一遍，只一次
          const again = await api.ensureToken(ctx, { force: true });
          if (again.error || !again.rotated) {
            // 强制续期的真因必须带出来：只报「救不回来」的话，这一次和任何一次普通失效
            // 长得一模一样 —— 用户没法据此判断该重录取凭据（10101）还是等上游恢复（5xx）
            const why = again.error || again.warn;
            // 票可能死在业务码里（HTTP 200 + code 1001）：别把「已被上游判死」说成「HTTP 200」
            const seen = status.bizCode ? `code ${status.bizCode}` : `HTTP ${status.status}`;
            return { status: "login_required", message: `签到状态被拒（${seen}），续期也救不回来${why ? `：${why}` : ""}`, credits: 0, cred };
          }
          cred = again.rotated;
          token = again.token;
          status = await api.readStatus(ctx, token);
          if (status.authFailed) return { status: "login_required", message: "签到状态查询被拒，登录态确认失效", credits: 0, cred };
        }
        if (status.error) return { status: "error", message: status.error, credits: 0, cred };
        if (status.enable === false) return { status: "inactive", message: "签到功能对这个账号未启用", credits: 0, cred };
        if (status.checkedIn) {
          return { status: "already", message: `今日已签到${status.credits ? `，当前签到积分 ${status.credits}` : ""}`, credits: 0, cred };
        }

        // 领取。鉴权被拒有两种形态：HTTP 401/403，或票死在两次调用之间、上游回业务码
        // 1001/1002（可能裹在 200 里）。两者与状态侧同款处置：强制换一次票再领一遍，
        // 只一次 —— 参考实现里它们同属 AUTH_FAIL_CODES，唯一正确的处置都是换票重试。
        let claimed = await api.claimOnce(ctx, token);
        let outcome = api.translateClaim(claimed);
        if (claimed.authFailed || outcome.status === "login_required") {
          const seen = claimed.authFailed ? `HTTP ${claimed.status}` : `code ${claimed.code}`;
          const again = await api.ensureToken(ctx, { force: true });
          if (again.error || !again.rotated) {
            // 真因同状态侧：again.error/warn 里是换票接口给翻过的人话（10101 等）
            const why = again.error || again.warn;
            return { status: "login_required", message: `领取被拒（${seen}），续期也救不回来${why ? `：${why}` : ""}`, credits: 0, cred };
          }
          cred = again.rotated;
          token = again.token;
          claimed = await api.claimOnce(ctx, token);
          outcome = api.translateClaim(claimed);
          if (claimed.authFailed || outcome.status === "login_required") {
            return { status: "login_required", message: `领取被拒（${seen}），强制续期后仍被拒，登录态确认失效`, credits: 0, cred };
          }
        }
        if (outcome.status === "rate_limited") {
          return { status: "rate_limited", message: `${outcome.message}（按退避阶梯稍后再试）`, credits: 0, cred };
        }
        // error 与 already 都必须在这里收住，不能继续往下走：下面那段会读额度包、
        // 并按 status.credits 报一句「签到 +N」。但这两个状态下这次一分都没领到 ——
        // 早退条件曾经只覆盖"code 与 msg 都缺失"，于是上游的业务错误
        // （40012「请求已过期」等）会被写成一条看起来签成了的日志，积分列还记上
        // status.credits，那是一笔从未发生的账。积分只属于 claimed（见下一段）。
        if (outcome.status !== "claimed") {
          return { status: outcome.status, message: outcome.message, credits: 0, cred };
        }

        // 领取成功后调额度包接口算余额。文案跟 workbuddy 对齐：「签到 +N，额度包剩余 M」。
        // 积分直接用 status 接口返回的 credits（签到前查询时已拿到），不看 claim 的返回
        // （claim 响应里的 credits 时有时无，不稳定；status 的 credits 是当前签到积分，稳定可用）
        const gained = status.credits || 0;
        const usage = await api.readUsage(ctx, token);
        const tail = usage.error || usage.authFailed ? "（额度包读取失败）" : `，额度包剩余 ${usage.remaining}`;
        return {
          status: outcome.status,
          message: `签到 +${gained}${tail}`,
          credits: gained,
          cred,
        };
      },
    },
  ],

  // 「测试」按钮：只换票 + 读签到状态，不发领取
  async validate(ctx) {
    const ensured = await api.ensureToken(ctx);
    if (ensured.error) return { status: "login_required", message: ensured.error };
    const token = ensured.token;
    const status = await api.readStatus(ctx, token);
    if (status.authFailed) return { status: "login_required", message: `状态查询被拒（HTTP ${status.status}）` };
    if (status.error) return { status: "error", message: status.error };
    if (status.enable === false) return { status: "inactive", message: "签到功能对这个账号未启用" };
    const usage = await api.readUsage(ctx, token);
    const tail = usage.error || usage.authFailed ? "" : `；额度包剩余 ${usage.remaining}`;
    return { status: "ok", message: `登录态有效：${status.checkedIn ? "今日已签到" : "今日未签到"}${status.credits ? `，积分 ${status.credits}` : ""}${tail}` };
  },
};
