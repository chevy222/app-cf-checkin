import * as api from "./api.js";

// Trae 签到工具。
// 方言要点（都在 api.js 里逐条处理，这里只负责声明形状）：
//   签到与额度在 api.trae.cn，换票与用户信息在 api.trae.com.cn，两边的鉴权头不一样
//   业务码 code===0 / message 含 success → 领到；/已(签到|领取|领过|签过)/ → 今天已领
//   code 9074 或 429 或「频繁/太多」→ 被频控，走跨轮退避阶梯
//   enable === false → 这个号没被灰到；checked_in → 今天已领
//   x-device-id 必须是真实 16 位 Aha 号，随手填的会每天稳定 9074

export default {
  id: "trae",
  name: "Trae",
  order: 20,
  summary: "每天签到领额度包积分",

  config: [
    {
      key: "clientId",
      label: "ClientID",
      type: "text",
      required: true,
      default: api.traeDefaults.clientId,
      help: "Trae 官方客户端跟着版本发布的公开标识，**所有用户都是同一个**，不是你的凭据。"
        + "已预填好，通常不用动；上游换客户端版本时这里要跟着改。",
    },
    {
      key: "appVersion",
      label: "客户端版本",
      type: "text",
      required: true,
      default: api.traeDefaults.appVersion,
      help: "决定 User-Agent 与 IDEVersion，上游按它做兼容判断。已预填好，通常不用动；"
        + "Trae 出了新版（签到报「请求已过期」多半是这个原因）才需要改。",
    },
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
      // 8–16 位。不要收紧到 16 位：会让用户手上现有的 8–15 位账号**录不进去**
      // （唯一的症状是表单红字，与上游无关）。没有证据说明这一家固定 16 位。
      pattern: "^\\d{8,16}$",
      patternMessage: "必须是 8–16 位数字的 Aha 设备号",
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
    maxDaily: 20,
    // 跨轮退避（分钟）：内核把它写在 retryAt 上，不在进程内睡眠
    backoff: [30, 60, 120, 240, 360],
  },

  hosts: api.traeHosts,

  // 最坏一轮：换票 1 + 状态 1 + [票被提前判死: 强制换票 1 + 重读状态 1] + 领取 1 + 额度包 1 = 6。
  // 预约低了不会报错，只会把越界的机会留给后面几步，所以宁可报高。
  steps: [
    {
      id: "checkin",
      label: "签到领积分",
      cost: 6,
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
            return { status: "login_required", message: `签到状态被拒（HTTP ${status.status}），续期也救不回来`, credits: 0, cred };
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

        const claimed = await api.claimOnce(ctx, token);
        if (claimed.authFailed) return { status: "login_required", message: `领取时被拒（HTTP ${claimed.status}），登录态已失效`, credits: 0, cred };
        const outcome = api.translateClaim(claimed);
        if (outcome.status === "error" && claimed.code === null && !claimed.msg) {
          return { status: "error", message: outcome.message, credits: 0, cred };
        }
        if (outcome.status === "rate_limited") {
          return { status: "rate_limited", message: `${outcome.message}（按退避阶梯稍后再试）`, credits: 0, cred };
        }

        // 领取成功后调额度包接口算余额；claim 返回的 credits 有就显示本次 +N
        const gained = outcome.credits || 0;
        const usage = await api.readUsage(ctx, token);
        const tail = usage.error || usage.authFailed ? "（额度包读取失败）" : `，额度包剩余 ${usage.remaining}`;
        return {
          status: outcome.status,
          message: `${outcome.message}${gained ? `，本次 +${gained}` : ""}${tail}`,
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
