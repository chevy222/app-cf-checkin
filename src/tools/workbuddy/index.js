import * as api from "./api.js";
import { fmtCST, parseWindowEnd } from "../../core/time.js";

// WorkBuddy 签到工具。
//
// 这一家的形状与另两家完全不同：不是一个"领取"动作，而是 7 件互相有顺序依赖的事。
// 7 件事必须分轮跑：全塞进一次调用的话，单账号一轮最坏 31 次上游调用，
// 2 个账号串在同一次调用里就 62 次，必然撞穿免费版 50 次外部请求/调用的硬顶。撞顶之后冒出来的
// 症状是假的「可能登录态失效，请重新登录」，很多人因此天天重贴凭据，
// 而真正的原因是配额。
//
// 所以下面每个 cost 都是上界而不是均值，内核按 (账号 × 步骤) 排队：
// 装不下就整步顺延到下一轮，已完成的部分不重做。
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
    notBeforeHour: 0,    // 零点第一轮就跑，越早领越好
    minIntervalSec: 1800,
    maxDaily: 20,
    backoff: [10, 30],   // 只兜住偶发限频，让它下一轮再来
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
          const claimed = await api.claimTravel(ctx);
          const reward = api.num(api.dig(claimed.payload, "reward_credit"));
          if (claimed.status < 400 && reward !== null) {
            // 领到就 return，**不**在同一趟里接着派新行程 —— 这是有意的选择。
            // 代价：该步最坏从 3 次请求涨到 4 次（cost 4），曾一度顶到单轮上限。
            // 换来的是"派发最多晚一轮 cron（*/30，即 ≤30 分钟）"：领奖后 travel 变 idle，
            // 下一轮读到 idle 会正常派出。行程周期以小时计，少掉的那一趟并不存在 ——
            // 一天能派几趟由行程时长和 daily_limit 决定，与派发时刻无关。
            // 若要恢复成同一趟里派发，必须先把这步的 cost 改对，否则账本算低。
            //
            // 注意"领失败也不派"是**必须保留**的：一失败就当 idle 会立刻派下一趟，
            // 把这次已到站的礼物顶掉，等于白丢。
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
      // 上界用本地常量，不跟着 max_open_count 变：预约必须是最坏情况的上界，
      // 而上游给的上限我们无法预知（cost 是准入判据，算低会让账本真的花超）
      cost: 1 + OPENS_PER_ROUND,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const quota = await api.readQuota(ctx);
        const affordable = api.num(api.dig(quota.payload, "affordable")) || 0;
        if (affordable === 0) return { status: "ok", message: "能量不够开盲盒", credits: 0, cred: ctx.rotated };

        // 一轮开几个由上游的 max_open_count 决定（前端读的就是这个字段，不是 affordable）。
        // 缺失时回落到本地常量：宁可少开几个，也不能因为读不到上限就放开手——
        // 这个接口没有幂等键，每调一次服务端真扣 10 点能量，多开就是白花。
        const cap = api.num(api.dig(quota.payload, "max_open_count")) || OPENS_PER_ROUND;
        const want = Math.min(affordable, cap);
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
      // 1 读列表 + 最多 1 次批量 accept + 最多 1 次回读确认 + 最多 3 次 claim
      cost: 3 + TASKS_PER_ROUND,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const listed = await api.readTasks(ctx);
        if (api.isAuthFail(listed)) return { status: "login_required", message: "任务列表被拒", credits: 0, cred: ctx.rotated };
        const tasks = api.dig(listed.payload, "tasks") || [];

        // 状态机按 accept_status 分流，2026-10-01 在页面上实测过 18 个任务的真实取值：
        //   not_accepted 未接领 → accept
        //   in_progress / accepted  进行中或已接领但没做完 → 等，本轮什么都不做
        //   completed 已完成待领奖 → claim
        //   claimed 已领 → 跳过
        // 旧实现只判 `!== "claimed"`，把 completed（已完成待领）当成"还没领"去发 accept，
        // 上游对已完成任务再接领一律 400 invalid request，任务奖励就永远卡在"完成但没领"。
        //
        // has_reward 仍要看：black_cat 这类任务是 in_progress 且 reward_credit=0，
        // 光看状态会把它算进来。
        //
        // 时间窗与锁也要看（2026-10-01 实测：Buddy_App_QQ 到 10-10、Expert_lighthouse 到 11-13）：
        // · locked=true 是"还没到上线时间"（链式任务每天零点解一环），打了也是白打；
        // · valid_end 已过期的任务不该再去 claim —— 那是我们不想做的上游交互，
        //   而且症状会是 400，用户看不出是"过期了"还是"任务坏了"。
        // 这两种都只跳过、如实说明，不当成失败。
        const nowMs = ctx.now * 1000;
        const blocked = [];
        const usable = tasks.filter((task) => {
          if (task.locked === true) {
            blocked.push(`${task.task_code}（未到上线时间${task.valid_start ? `，${String(task.valid_start).slice(0, 10)} 解锁` : ""}）`);
            return false;
          }
          const endsAt = parseWindowEnd(task.valid_end);
          if (endsAt !== null && endsAt < nowMs) {
            blocked.push(`${task.task_code}（${fmtCST(Math.floor(endsAt / 1000))} 已过期）`);
            return false;
          }
          return true;
        });

        const ready = usable.filter((task) => task.accept_status === "completed" && task.has_reward);
        const pending = usable.filter((task) => task.accept_status === "not_accepted" && task.has_reward);
        const blockNote = blocked.length ? `，跳过 ${blocked.length} 个不可领的任务：${blocked.join("、")}` : "";

        // 接领是"预告"性质的：领奖还要等任务真的完成，发 accept 只是开通。
        // 一次批量发完（有上界），不为它们记积分 —— 积分要等 claim 之后才有。
        //
        // 不信任 200：顶层 code=0 只说明这个请求被接受，逐项结果在 data.results[].status。
        // 更要紧的是上游存在"请求成功但没登记"的形态，所以再回读一次任务列表，
        // 用 accept_status 的真实变化来确认 —— 宁可报"可能没登记上"，也不谎报已接领：
        // 谎报会让下一轮看不出该重试什么。
        let acceptedNote = "";
        if (pending.length > 0) {
          const batch = pending.slice(0, TASKS_PER_ROUND);
          const accepted = await api.acceptTasks(ctx, batch.map((task) => task.task_code));
          if (accepted.status >= 400) {
            const code = api.codeOf(accepted.payload);
            const msg = String((accepted.payload && (accepted.payload.msg ?? accepted.payload.message)) ?? "");
            // 缺前置是"新账号必撞"的形态：报错原文只有 task_code，对使用者没有行动价值。
            // 不自动补 —— 领养 Buddy 是一整条业务链路，误操作上游状态的代价比说清代价大。
            const hint = api.prerequisiteHint(msg);
            acceptedNote = `，接领失败 HTTP ${accepted.status}${code !== null ? ` code=${code}` : ""}`
              + `${hint ? ` —— ${hint}` : msg ? ` ${msg}` : ""}`;
          } else {
            const perItem = api.acceptResults(accepted.payload);
            const rejected = perItem ? perItem.filter((row) => !row.ok) : [];
            if (rejected.length) {
              const detail = rejected.map((row) => {
                const hint = api.prerequisiteHint(row.message);
                return `${row.code || "?"} ${hint || row.message || "未登记"}`;
              }).join("、");
              acceptedNote = `，接领部分失败：${detail}`;
            } else if (perItem) {
              acceptedNote = `，已接领 ${perItem.length} 个新任务（等完成后才能领）`;
            } else {
              // 上游没给逐项结果：只能靠回读确认，否则就如实说不确定
              const after = await api.readTasks(ctx);
              const nowCodes = new Set(batch.map((task) => task.task_code));
              const landed = (api.dig(after.payload, "tasks") || [])
                .filter((task) => nowCodes.has(task.task_code) && task.accept_status !== "not_accepted").length;
              acceptedNote = landed === batch.length
                ? `，已接领 ${landed} 个新任务（等完成后才能领）`
                : `，接领后回读只确认了 ${landed}/${batch.length} 个，其余可能没登记上`;
            }
          }
        }

        if (ready.length === 0) {
          return { status: "ok", message: `没有待领的任务奖励${blockNote}${acceptedNote}`, credits: 0, cred: ctx.rotated };
        }

        // 可领数量必须有上界：不封顶的话一轮能打出 1 + T 次调用，T 由上游决定
        const batch = ready.slice(0, TASKS_PER_ROUND);
        let claimedCount = 0;
        let credits = 0;
        const failed = [];
        for (const task of batch) {
          const result = await api.claimTask(ctx, task.task_code);
          if (result.status >= 400) {
            // 失败原因必须进 message —— 这是这条运行日志唯一的诊断出口，
            // 只写"全部失败"的话，401（凭据要重录）和 404（任务已下架）在界面上长得一样
            const code = api.codeOf(result.payload);
            const msg = String((result.payload && (result.payload.msg ?? result.payload.message)) ?? "");
            failed.push(`${task.task_code} HTTP ${result.status}${code !== null ? ` code=${code}` : ""}${msg ? ` ${msg}` : ""}`.trim());
            continue;
          }
          // 积分与能量从响应里读，不从任务列表里猜：页面实测响应形状是
          // { already_claimed, credit, energy, badge, share_uuid }。
          // already_claimed=true 表示别的端已经领过，这时上游不再发奖，
          // 照实报 0 而不是把列表里的 reward_credit 算进来（那是虚账）。
          if (api.dig(result.payload, "already_claimed") === true) {
            failed.push(`${task.task_code} 上游报已领过`);
            continue;
          }
          claimedCount += 1;
          credits += api.num(api.dig(result.payload, "credit")) || 0;
        }
        const failNote = failed.length ? `，失败：${failed.join("；")}` : "";
        if (claimedCount === 0) return { status: "error", message: `${batch.length} 个任务领取全部失败${failNote}`, credits: 0, cred: ctx.rotated };
        const left = ready.length - claimedCount;
        return {
          status: left > 0 ? "partial" : "claimed",
          message: `领到 ${claimedCount} 个任务奖励 +${credits}${failNote}${blockNote}${acceptedNote}${left > 0 ? `，还有 ${left} 个下一轮领` : ""}`,
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
          // 报 ok（界面显示"正常"）而不是 inactive（"活动未开"）：活动本身开着，
          // 只是连签天数没到 —— 一个月里绝大多数天都在 7 天以下，这是常态，
          // 与"没有抽奖机会""没有待领的任务奖励"同类。使用者明确指出"活动未开"是误导。
          return { status: "ok", message: `连签 ${days} 天，还没到任何兑换档`, credits: 0, cred: ctx.rotated };
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
