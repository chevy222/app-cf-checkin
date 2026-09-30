import * as api from "./api.js";

// Qoder 签到工具。
//
// 这一层只声明"我是谁、我有哪些字段、我分几步、我几点醒"，不碰调度、不碰 KV、不碰界面。
// 加第 4、5 个工具时内核不需要改一行 —— 这个文件的存在本身就是那条承诺的证据。
//
// 上游方言（都翻成内核的 11 个状态，见 api.js）：
//   活动 actionType=CLAIM_BENEFIT，claimStatus ∈ CLAIMABLE / CLAIMED / 别的
//   领取成功 = HTTP 200 且 data.status==="CLAIMED"，金额在 data.benefit.amount（0 合法）
//   data.replayed = 上游认这次是幂等重放
//   设备身份头缺失/过期 → HTTP 200 + 空列表，不报错（最难查的一种坏法）

// 每轮最多领几个活动。这是自设上界，不是上游的限制：
// 一次调用只有 45 个子请求的预算（内核自设值，平台硬顶 50），而"领几个"取决于当天有几个
// CLAIMABLE —— 数量不由我们决定。所以这一步的 cost 必须是"最坏情况"，
// 而最坏情况又取决于允许一轮领几个：不设上界的话 cost 就没法声明，
// 预算判定也就没法工作。多出来的下一轮接着领（步骤未完成会标记成可接续，不受 30 分钟间隔阻挡）。
const CLAIMS_PER_ROUND = 3;

export default {
  id: "qoder",
  name: "Qoder",
  order: 10,
  summary: "每天领取 IDE 活动额度（campaigns → claim）",

  // 工具级：对这家站点的所有账号生效。设备身份是"一台机器"的身份，不属于任何单个账号，
  // 所以它是 config 而不是 creds —— 一台机器上的多个账号共用一份。
  config: [
    {
      key: "clientType",
      label: "Cosy-ClientType",
      type: "text",
      required: true,
      default: "10",
      help: "必须为 10：缺这个头活动列表直接返回空",
    },
    {
      key: "machineToken",
      label: "Cosy-MachineToken",
      type: "textarea",
      required: true,
      secret: true,
      offline: "tools/extract/qoder-device.ps1",
      help: "线下脚本产出；过期时上游不报错，只是活动列表变空",
    },
    { key: "machineCode", label: "Cosy-MachineCode", type: "textarea", required: true, secret: true, offline: "tools/extract/qoder-device.ps1" },
    { key: "machineId", label: "Cosy-MachineId", type: "text", required: true, offline: "tools/extract/qoder-device.ps1" },
    { key: "machineType", label: "Cosy-MachineType", type: "text", placeholder: "如 windows" },
    { key: "machineOS", label: "Cosy-MachineOS", type: "text", placeholder: "如 10.0.26100" },
    { key: "machineHostname", label: "Cosy-MachineHostname", type: "text" },
    { key: "version", label: "Cosy-Version", type: "text", placeholder: "如 0.1.43" },
  ],

  // 账号级。两个 token 都是 secret；expiresAt 由续期写回，界面只读不收输入
  creds: [
    {
      key: "accessToken",
      label: "Access Token",
      type: "textarea",
      required: true,
      secret: true,
      pattern: "^[^\\s]+$",
      patternMessage: "令牌里不能有空格（粘贴时别带上换行或 + 号被吃掉的痕迹）",
      offline: "tools/extract/qoder-device.ps1",
      help: "账号标识（uid）就从这张 JWT 的 sub 里解出来，不用另外填",
    },
    {
      key: "refreshToken",
      label: "Refresh Token",
      type: "textarea",
      required: true,
      secret: true,
      pattern: "^[^\\s]+$",
      patternMessage: "令牌里不能有空格",
      offline: "tools/extract/qoder-device.ps1",
      help: "每次续期都会换新串，内核当场写回；旧串用过一次即废",
    },
    { key: "expiresAt", label: "令牌到期时间", type: "datetime", readonly: true },
  ],

  // uid 从凭据里算，不让人抄第二遍（抄错就是另一个键名）
  uidOf: (ctx) => api.uidFromToken(ctx.values),

  schedule: {
    // 这家的"今天"跟着它自己的活动窗口走：上游按 UTC+8 每天 10:00 前后重新下发活动，
    // 所以逻辑日也在 10:00 翻。不要让计数器按北京零点翻、再把"10 点后才跑"交给
    // cron 表达式表达 —— 同一个事实写在两个地方，迟早对不上。
    resetHour: 10,
    notBeforeHour: 10,     // 10 点之前去打只是白烧子请求
    minIntervalSec: 1800,
    maxDaily: 20,
    backoff: [],           // 这家没有限频方言（429/9074 都不出现），退避阶梯留空
  },

  hosts: api.qoderHosts,

  // 最坏情况：读列表 1 + 认证失败时（续期 1 + 重读 1）+ 领 N 个 = 3 + N。
  // cost 是"这一步最坏要花多少"，不是"通常花多少" —— 低估会让预算判定给出假通行证。
  // 走一遍 401 → 续期 → 重试 → 领 3 个，内核算出 over=1，所以是 3 + N 而不是 2 + N。
  steps: [
    {
      id: "claim",
      label: "领取额度",
      cost: 3 + CLAIMS_PER_ROUND,
      async run(ctx) {
        const list = await api.readCampaigns(ctx);
        if (list.loginRequired) return { status: "login_required", message: list.message, credits: 0, cred: list.rotated };
        if (list.error) return { status: "error", message: list.error, credits: 0, cred: list.rotated };

        // 上游对三种完全不同的情况都回 HTTP 200 + 空列表：活动真结束了、这个号不在资格范围内、
        // 设备身份（Cosy 头）过期。所以空列表不能报成"今日已领取" —— 那会让设备身份过期
        // 坏上几周都不被发现。这里报 inactive，并把三种可能一次说清。
        if (list.benefits === 0) {
          return {
            status: "inactive",
            message: "活动列表为空：可能今天没下发活动、这个账号不在资格范围内，"
              + "或者「工具配置」里的设备身份（Cosy-MachineToken/Code/Id）已过期 —— 上游对这几种都回空列表，分不开",
            credits: 0,
            cred: list.rotated,
          };
        }

        if (list.claimable.length === 0) {
          if (list.claimedToday.length) {
            return { status: "already", message: `今日已领取（${list.claimedToday.length} 个活动）`, credits: 0, cred: list.rotated };
          }
          const listed = list.pendingList.map((c) => `${c.campaignKey || c.campaignId}=${c.claimStatus}`).join("、").slice(0, 120);
          return { status: "pending", message: `活动未下发到位${listed ? `：${listed}` : ""}`, credits: 0, cred: list.rotated };
        }

        const batch = list.claimable.slice(0, CLAIMS_PER_ROUND);
        const outcomes = [];
        for (const campaign of batch) outcomes.push(await api.claimOne(ctx, campaign));

        const failed = outcomes.filter((o) => o.status !== "claimed");
        // 任何一步带 rotated 都要交回内核落盘（旧串已经作废，攒着不写就是把账号写死）
        const rotated = outcomes.reduce((acc, o) => (o.rotated ? { ...acc, ...o.rotated } : acc), list.rotated || {});
        const credits = outcomes.reduce((sum, o) => sum + (o.credits || 0), 0);
        const replayed = outcomes.filter((o) => o.replayed).length;

        const note = [
          credits ? `+${credits} 额度` : "本次到账 0",
          replayed ? `其中 ${replayed} 个上游判为幂等重放` : "",
          list.claimable.length > batch.length ? `还有 ${list.claimable.length - batch.length} 个待领` : "",
        ].filter(Boolean).join("，");

        if (failed.length === outcomes.length) {
          return { status: "error", message: `${failed.length}/${outcomes.length} 个活动领取失败：${failed[0].message}`, credits: 0, cred: rotated };
        }
        const status = list.claimable.length > batch.length
          ? "partial"                     // 一轮没领完，下一轮接着领
          : failed.length
            ? "partial"                   // 领到一部分，剩下的下轮再来
            : "claimed";
        return { status, message: `${outcomes.length - failed.length}/${outcomes.length} 个活动领取成功，${note}`, credits, cred: rotated };
      },
    },
  ],

  // 「测试」按钮：只读活动列表，一次领取都不发。
  async validate(ctx) {
    const list = await api.readCampaigns(ctx);
    if (list.loginRequired) return { status: "login_required", message: list.message };
    if (list.error) return { status: "error", message: list.error };
    if (list.benefits === 0) {
      // 能走到这里说明登录态是好的（401/403 已在上面分出去了），
      // 所以空列表的原因只剩"没下发 / 不在范围内 / 设备身份过期"
      return { status: "inactive", message: "登录态有效，但活动列表为空：今天没下发、账号不在资格范围内，或设备身份已过期（上游对这几种都回空列表）" };
    }
    return {
      status: "ok",
      message: `登录态有效：${list.benefits} 个额度活动，其中 ${list.claimable.length} 个可领、${list.claimedToday.length} 个今日已领`,
    };
  },
};
