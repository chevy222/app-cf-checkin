import * as api from "./api.js";

// WorkBuddy 签到工具。
//
// 这一家的形状与另两家完全不同：不是一个"领取"动作，而是 7 件互相有顺序依赖的事。
// 旧实现把它们全塞进一次调用，且完全不数子请求 —— 单账号一轮最坏 30+ 次上游调用，
// 2–3 个账号串在同一次调用里必然撞穿免费版 50 次/调用的硬顶。旧代码那句
// 「可能登录态失效，请重新登录」就是撞顶之后冒出来的假症状，
// 很多人因此天天重贴凭据，而真正的原因是配额。
//
// 新内核按 (账号 × 步骤) 排队：每步声明自己的**最坏**开销，装不下就整步顺延到下一轮，
// 已完成的部分不重做。所以下面每个 cost 都是上界，不是均值。
const DRAWS_PER_ROUND = 5;
const OPENS_PER_ROUND = 5;
const TASKS_PER_ROUND = 3;

export default {
  id: "workbuddy",
  name: "WorkBuddy",
  order: 30,
  summary: "每日签到 + 成长中心（旅行 / 抽奖 / 盲盒 / 任务 / 能量 / 连签兑换）",

  config: [
    { key: "timeoutMs", label: "请求超时（毫秒）", type: "text", placeholder: "30000" },
    { key: "refreshAheadSec", label: "提前续期秒数", type: "text", placeholder: "604800（7 天）" },
  ],

  creds: [
    {
      key: "accessToken",
      label: "Access Token",
      type: "textarea",
      required: true,
      secret: true,
      offline: "验证码换票走线下 PowerShell，界面不发验证码",
      help: "新版桌面端可能给的是 {\"$wbEncrypted\":1,\"envelope\":\"…\"} 包装，内核会自动展开",
    },
    {
      key: "refreshToken",
      label: "Refresh Token",
      type: "textarea",
      required: true,
      secret: true,
      offline: "验证码换票走线下 PowerShell，界面不发验证码",
      help: "换出来的新串会被当场写回；旧串用过一次即废",
    },
    { key: "expiresAt", label: "令牌到期时间", type: "datetime", readonly: true },
  ],

  uidOf: (ctx) => api.uidFromToken(ctx.values),

  schedule: {
    resetHour: 0,        // 上游按北京零点判"今天签没签"，我们不在本地重算日子
    notBeforeHour: 8,    // 旧方案的运行时间
    minIntervalSec: 1800,
    maxDaily: 20,
    backoff: [10, 30],   // 旧实现连 429 都不判；这里只兜住偶发限频，让它下一轮再来
  },

  hosts: api.workbuddyHosts,

  steps: [
    {
      id: "checkin",
      label: "每日签到",
      cost: 4,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const status = await api.readStatus(ctx);
        const judged = api.judgeStatus(status);
        if (judged.verdict !== "claimable") {
          return { status: judged.verdict, message: judged.message, credits: 0, cred: ctx.rotated };
        }
        const verdict = api.judgeClaim(await api.submitCheckin(ctx));
        if (verdict.status !== "claimed") return { ...verdict, cred: ctx.rotated };

        // 领完再读一次状态：领取接口只回 credit，连签天数要另问
        const after = await api.readStatus(ctx);
        const streak = api.num(api.dig(after.payload, "streak_days"));
        return {
          status: "claimed",
          message: `签到 +${verdict.credits}${streak !== null ? `，连签 ${streak} 天` : ""}`,
          credits: verdict.credits,
          cred: ctx.rotated,
        };
      },
    },
    {
      id: "travel",
      label: "旅行：领到站礼物并派新行程",
      cost: 4,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        // 只读一次状态：state / record_id / daily_limit_reached 都在这份响应里。
        // 分三次读会把这一步的 cost 从 4 顶到 6，而 cost 是预算判定的依据
        const first = await api.readTravelStatus(ctx);
        if (api.isAuthFail(first)) return { status: "login_required", message: "旅行状态被拒", credits: 0, cred: ctx.rotated };
        const state = api.dig(first.payload, "state");

        if (state === "arrived") {
          const recordId = api.dig(first.payload, "record_id");
          const claimed = await api.claimTravel(ctx, recordId);
          const reward = api.num(api.dig(claimed.payload, "reward_credit"));
          if (claimed.status < 400 && reward !== null) {
            // 领到就 return，**不**在同一趟里接着派新行程 —— 这是有意的。
            // 旧实现（worker.js:590）是 `travel = "idle"` 后一路走到 config+depart，
            // 代价是该步最坏从 3 次请求涨到 4 次，cost:4 顶到 5。恢复它要先改 cost，
            // 否则账本算低，正是 §P0-2 那类缺陷。
            // 不恢复的代价只有"派发最多晚一轮 cron（*/30，即 ≤30 分钟）"：
            // 领奖后 travel 变 idle，下一轮读到 idle 会正常派出。行程周期以小时计，
            // 少掉的那一趟并不存在 —— 一天能派几趟由行程时长和 daily_limit 决定，与派发时刻无关。
            // 注意"领失败也不派"是**必须保留**的：旧代码那句注释说得很清楚，
            // 一失败就当 idle 会立刻派下一趟，把这次已到站的礼物顶掉，等于白丢。
            return { status: "claimed", message: `到站礼物 +${reward}`, credits: reward, cred: ctx.rotated };
          }
          return { status: "error", message: `到站礼物领取失败（HTTP ${claimed.status}），本次不派新行程`, credits: 0, cred: ctx.rotated };
        }
        if (state === "traveling") return { status: "ok", message: "旅行途中，等到站", credits: 0, cred: ctx.rotated };
        if (api.dig(first.payload, "daily_limit_reached")) {
          return { status: "inactive", message: "今日旅行次数已用尽", credits: 0, cred: ctx.rotated };
        }
        const config = await api.readTravelConfig(ctx);
        const locations = api.dig(config.payload, "locations") || [];
        if (!locations.length) return { status: "error", message: "旅行配置里没有可选地点", credits: 0, cred: ctx.rotated };
        const depart = await api.departTravel(ctx, locations[0].id);
        if (depart.status >= 400) return { status: "error", message: `派新行程失败（HTTP ${depart.status}）`, credits: 0, cred: ctx.rotated };
        return { status: "ok", message: `已派新行程 → ${locations[0].name || locations[0].id}`, credits: 0, cred: ctx.rotated };
      },
    },
    {
      id: "lottery",
      label: "抽奖",
      cost: 1 + DRAWS_PER_ROUND,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const chances = await api.readChances(ctx);
        if (api.isAuthFail(chances)) return { status: "login_required", message: "抽奖次数查询被拒", credits: 0, cred: ctx.rotated };
        const balance = api.num(api.dig(chances.payload, "balance")) || 0;
        if (balance === 0) return { status: "ok", message: "没有抽奖机会", credits: 0, cred: ctx.rotated };

        const want = Math.min(balance, DRAWS_PER_ROUND);
        let drew = 0;
        let credits = 0;
        for (let i = 0; i < want; i += 1) {
          const drawn = await api.drawOnce(ctx, i);
          if (drawn.status >= 400) break;
          const granted = api.firstCredit(drawn.payload, null);
          credits += api.num(granted) || 0;
          drew += 1;
        }
        if (drew === 0) return { status: "error", message: `有 ${balance} 次机会但第一发就没成（响应异常）`, credits: 0, cred: ctx.rotated };
        const left = balance - drew;
        return {
          status: left > 0 ? "partial" : "claimed",
          message: `抽 ${drew} 次 +${credits}${left > 0 ? `，还剩 ${left} 次下一轮抽` : ""}`,
          credits,
          cred: ctx.rotated,
        };
      },
    },
    {
      id: "blindbox",
      label: "开盲盒",
      cost: 1 + OPENS_PER_ROUND,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const quota = await api.readQuota(ctx);
        const affordable = api.num(api.dig(quota.payload, "affordable")) || 0;
        if (affordable === 0) return { status: "ok", message: "能量不够开盲盒", credits: 0, cred: ctx.rotated };

        // 这个接口**没有任何幂等字段**，每调一次服务端就扣 10 点能量，
        // 所以一轮开几个是真金白银的决策：上界 5 个，中断最多损失这 5 发的机会
        const want = Math.min(affordable, OPENS_PER_ROUND);
        let opened = 0;
        let credits = 0;
        for (let i = 0; i < want; i += 1) {
          const result = await api.openBlindbox(ctx);
          if (result.status >= 400 || api.codeOf(result.payload) !== 0) break;
          const items = api.dig(result.payload, "results") || [];
          // firstCredit 不是冗余：上游把积分挂在 data 层、item 层、instance 层、
          // template 层都可能，只读 item.credit 时能量已经扣了、积分却报 0
          credits += items.map((item) => api.firstCredit(result.payload, item)).reduce((a, b) => a + b, 0);
          opened += 1;
        }
        if (opened === 0) return { status: "error", message: `有 ${affordable} 个额度但第一发就没成（响应异常）`, credits: 0, cred: ctx.rotated };
        const left = affordable - opened;
        return {
          status: left > 0 ? "partial" : "claimed",
          message: `开 ${opened} 个 +${credits}${left > 0 ? `，还能开 ${left} 个下一轮再开` : ""}`,
          credits,
          cred: ctx.rotated,
        };
      },
    },
    {
      id: "tasks",
      label: "领任务奖励",
      cost: 1 + TASKS_PER_ROUND,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const listed = await api.readTasks(ctx);
        if (api.isAuthFail(listed)) return { status: "login_required", message: "任务列表被拒", credits: 0, cred: ctx.rotated };
        const tasks = api.dig(listed.payload, "tasks") || [];
        const eligible = tasks.filter((task) => {
          const progress = task.progress || {};
          const target = api.num(progress.target);
          const current = api.num(progress.current) || 0;
          // 给了 0 就是 0：旧实现写 `progress.target || 1`，于是 "0/0" 的任务
          // 永远被当成已完成，每天白发一次 accept
          return (target === null ? 1 : target) <= current && task.accept_status !== "claimed" && task.has_reward;
        });
        if (eligible.length === 0) return { status: "ok", message: "没有待领的任务奖励", credits: 0, cred: ctx.rotated };

        // 旧实现对可领任务数量没有上界，一轮能打出 1 + T 次调用，T 由上游决定
        const batch = eligible.slice(0, TASKS_PER_ROUND);
        let claimedCount = 0;
        let credits = 0;
        for (const task of batch) {
          const accepted = await api.acceptTask(ctx, task.task_code);
          if (accepted.status >= 400) continue;
          claimedCount += 1;
          credits += api.num(task.reward_credit) || 0;
        }
        if (claimedCount === 0) return { status: "error", message: `${batch.length} 个任务领取全部失败`, credits: 0, cred: ctx.rotated };
        const left = eligible.length - claimedCount;
        return {
          status: left > 0 ? "partial" : "claimed",
          message: `领到 ${claimedCount} 个任务奖励 +${credits}${left > 0 ? `，还有 ${left} 个下一轮领` : ""}`,
          credits,
          cred: ctx.rotated,
        };
      },
    },
    {
      id: "energy",
      label: "读能量与连签",
      cost: 2,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const [energy, streak] = await Promise.all([api.readEnergy(ctx), api.readStreak(ctx)]);
        const balance = api.num(api.dig(energy.payload, "balance"));
        const days = api.num(api.dig(api.dig(streak.payload, "streak"), "days"));
        if (balance === null && days === null) return { status: "error", message: "能量与连签都读不到（响应异常）", credits: 0, cred: ctx.rotated };
        // 这一步只负责"看一眼"，但它是下一步 redeem 的前置：
        // 步骤之间不共享业务对象（内核只记状态与积分），所以 redeem 会自己重读连签天数
        return { status: "ok", message: `能量 ${balance ?? "?"}，连签 ${days ?? "?"} 天`, credits: 0, cred: ctx.rotated };
      },
    },
    {
      id: "redeem",
      label: "连签兑换",
      cost: 1 + api.workbuddyRedeemTiers.length,
      dependsOn: ["energy"],
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const streak = await api.readStreak(ctx);
        const days = api.num(api.dig(api.dig(streak.payload, "streak"), "days")) || 0;
        const unlocked = api.workbuddyRedeemTiers.filter((row) => days >= row.days);
        if (unlocked.length === 0) {
          return { status: "inactive", message: `连签 ${days} 天，还没到任何兑换档`, credits: 0, cred: ctx.rotated };
        }

        let credits = 0;
        let redeemed = 0;
        const notes = [];
        for (const row of unlocked) {
          const result = await api.redeemTier(ctx, row.tier);
          // 409 = 这一档已经换过，403 = 天数不够 —— 两种都是"正常无事"，不是失败
          if (result.status === 409 || result.status === 403) { notes.push(`${row.tier} 已换或不够`); continue; }
          if (result.status >= 400 || api.codeOf(result.payload) !== 0) { notes.push(`${row.tier} 失败`); continue; }
          const granted = api.firstCredit(result.payload, null);
          credits += granted;
          redeemed += 1;
          notes.push(`${row.tier} +${granted}`);
        }
        return {
          status: redeemed ? "claimed" : "ok",
          message: `${redeemed} 档兑换：${notes.join("、")}`,
          credits,
          cred: ctx.rotated,
        };
      },
    },
  ],

  // 「测试」按钮：只读签到状态与活动开关，一次写操作都不发
  async validate(ctx) {
    const guarded = await guard(ctx);
    if (guarded) return { status: guarded.status, message: guarded.message };
    const judged = api.judgeStatus(await api.readStatus(ctx));
    if (judged.verdict === "claimable") return { status: "ok", message: "登录态有效，今日尚未签到" };
    return { status: judged.verdict === "already" ? "ok" : judged.verdict, message: judged.message };
  },
};

// 动手之前先确认这把票还能用。换出来的新串挂在 ctx.rotated 上，
// 由这一步的返回值带回内核当场落盘 —— 旧串已经被这次调用消耗掉了。
async function guard(ctx) {
  const result = await api.ensureAuth(ctx);
  if (result.rotated) ctx.rotated = result.rotated;
  if (result.error) {
    return {
      status: result.authFailed ? "login_required" : "error",
      message: result.error,
      credits: 0,
      cred: result.rotated || null,
    };
  }
  return null;
}
