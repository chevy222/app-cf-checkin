import { truncate } from "./text.js";
import { getJson, listUids, lockKey, requireKv, toolKey } from "./store.js";
import { applyCredPatch, getAccount, loadSchedIndex, commitSchedEntries, schedOf } from "./accounts.js";
import { isOff, loadFlags } from "./flags.js";
import { trackedFetch } from "./budget.js";
import { makeTrace } from "./trace.js";
import { clearProgress, configComplete, dayOf, isDue, loadProgress, missingConfigFields, saveProgress } from "./scheduler.js";
import { secretValuesOf, scrubSecrets, writeRunLog, writeTrace } from "./logs.js";
import { nowSec } from "./time.js";

const LOCK_TTL = 90;
const SETTLED = new Set(["claimed", "already", "inactive", "ok"]);
const SUCCESS = new Set(["claimed"]);
// 上游"还没把奖励下发出来"的重试间隔。不走 minIntervalSec，也不许被 resumable 豁免：
// pending 没有任何"活干到一半"的含义，把它归进可接续是对的（否则当天再也不重试），
// 但可接续的豁免是给"接着做完"用的，于是 pending 顺带免掉了全部节流，
// 从活动下发窗口一路每 30 分钟打一次上游 —— 一个账号一天 28 次纯查询。
// 在风控视角下"无害的重复查询"和"刷接口"是同一件事，所以给它一个单独且更宽的闸。
const PENDING_RETRY_SEC = 3600;
// 没领到东西、下一轮该接着做的状态。
// pending 也在这一列：它是"上游还没把活动下发出来"（Qoder 每天 10 点前后就是这状态），
// 属于正常等待，不是故障。把它当 error 会让红条在健康的日子里亮起来，
// 而把它当 already 会让当天再也不重试 —— 两个方向都不对，只有"可接续"是对的。
const CONTINUABLE = new Set(["deferred", "skipped", "pending", "waiting"]);
// waiting 与 pending 必须分开，不能合并成一个词：
//   pending —— **上游还没开始**（活动窗口没到）。它按账号被 PENDING_RETRY_SEC 拽慢一小时，
//              那是给"纯查询"设的风控护栏（见上一段注释）。
//   waiting —— **上游已经在推进**（旅行在途），只需要等它走完。不受任何节流，下一轮就看。
// 两者都不是 SETTLED（当天不收工），差别只在"下一次什么时候看"，所以是两个词。

// 这里不设任何"每轮固定开销"的预留量：KV 不占外部请求额度（见 budget.js 文件头），
// 而"预留"最容易出错 —— KV 撞顶的表现只是那一次 KV 调用失败（safe()/catch 会吞掉），
// 不会作废整轮；真正会抛异常作废整轮的只有外部 fetch，而 fetch 全部发生在步骤
// 内部、由 step.cost 预约。

// 总体状态由步骤结果推导，工具不参与。
// rate_limited 必须显式列出，否则会掉进 already —— 界面把"被频控"报成"今天已领过"，
// 而且 retryAt 因状态不匹配根本不会写，退避阶梯整个失效。
export function aggregate(results) {
  const statuses = results.map((r) => r.status);
  // 整轮一步都没真做（全部复用上一轮的进度）时报"成功领取"是假信号：
  // 那些凭据与积分是上一轮挣的，这次上游一个请求都没收到。"今日已领"才是实话。
  if (results.length > 0 && results.every((r) => r.reused)) return "already";
  if (statuses.includes("login_required")) return "login_required";
  if (statuses.includes("rate_limited")) return "rate_limited";

  const settled = results.filter((r) => SETTLED.has(r.status));
  const errors = results.filter((r) => r.status === "error");
  const unfinished = results.filter((r) => CONTINUABLE.has(r.status));

  // 步骤自己就能报 partial（一轮没做完、还剩一些），整体必须如实是 partial：
  // 报 claimed 会当天上闩、剩下的再也不领；报 error 又像是全失败。
  if (statuses.includes("partial")) return "partial";
  // waiting 排在 pending 之前：它是"上游正在推进、下一轮就再看"，不该被 pending 那条
  // 按账号设的一小时闸拽住（commitSched 只看账号状态）。有 waiting 就先报 waiting。
  if (statuses.includes("waiting")) return errors.length ? "partial" : "waiting";
  if (statuses.includes("pending") && settled.length === 0 && errors.length === 0) return "pending";

  if (unfinished.length === 0) {
    if (errors.length) return settled.length ? "partial" : "error";
    if (results.some((r) => SUCCESS.has(r.status))) return "claimed";
    // 全部步骤都"今天已结"时还要分出「活动未开」与「今日已领」：两者都该上闩，
    // 但界面上是完全不同的两件事 —— 一个是今天不用管，一个是今天已经拿到。
    // 少了这一条，inactive 会被压成 already，首页那 11 个状态就白分了。
    if (statuses.includes("inactive")) return "inactive";
    // 未识别的状态一律按失败处理：宁可多跑一次，不可少跑一次。
    return results.every((r) => SETTLED.has(r.status)) ? "already" : "error";
  }
  return errors.length ? "partial" : unfinished.every((r) => r.status === "pending") ? "pending" : "deferred";
}

function backoffSec(ladder, strikes) {
  if (!ladder || ladder.length === 0) return 0;
  return ladder[Math.min(strikes - 1, ladder.length - 1)] * 60;
}

function summarize(results) {
  const parts = results.filter((r) => !r.reused && r.message).map((r) => `${r.label}：${r.message}`);
  return parts.length ? parts.join("；") : "无可执行步骤";
}

async function runOneAccount({ env, budget, tool, uid, config, day, now, trigger }) {
  const kv = requireKv(env);
  const bare = (status, message) => ({ uid, status, message, steps: [], sched: null });

  // 锁、进度、凭据三次读放在同一个 try 里：KV 真不可用时只跳过这个账号 ——
  // 只包住取锁一处，紧随其后的进度读会以同样方式再抛，整轮照样炸。
  let account;
  let progress;
  try {
    const key = lockKey(tool.id, uid);
    if (await kv.get(key)) return { ...bare("skipped", "已有运行在途"), quiet: true };
    await kv.put(key, String(now), { expirationTtl: LOCK_TTL });
    progress = await loadProgress(env, tool, uid, day);
    account = await getAccount(env, tool.id, uid);
  } catch (error) {
    return bare("deferred", `KV 暂不可用：${truncate(String((error && error.message) || error), 80)}`);
  }

  // 损坏或已被删除的记录：不合成假账号、不写任何状态。
  // 旧版会把 listAccounts 造出的占位记录当真账号跑一遍，再把 broken 标记固化进存储。
  // broken 标记是给观测层用的：这条记录必须在运行日志里露头，否则用户只能靠猜发现它坏了。
  if (!account) return { ...bare("error", "记录无法解析，请在界面删除后重新添加"), broken: true };

  // 凭据脱敏放在这里，而不是放在写日志的那一步：同一个 message 有五个出口
  // （进度键、运行日志正文、运行日志 metadata、手动执行的响应 HTML、
  //  scheduled 的 console.log 与 /api/tick 返回值），
  // 只在落盘那一个出口洗，另外四个照样把票据原样带出去。
  let secrets = secretValuesOf(tool, account);
  const stale = [];                 // 被轮换掉的旧串：上游可能把它回显进 message，得继续洗
  const persistedCred = {};         // 本轮已经落盘过的凭据字段，防止同一步的返回值被反复写回
  // 请求记录：挂到 ctx.fetch 上，工具完全不知道它的存在（工具一行都不用改）
  const trace = makeTrace();
  const ctx = { account, config, tool, env, kv, budget, now, day, trigger, fetch: trackedFetch(budget, tool.hosts, trace) };
  const results = [];
  let stopped = false;
  // 收尾时要报"这个账号花了多少"，所以先拍下起点。后面的差值才是它的用量
  const httpBefore = budget.used;

  for (const step of tool.steps) {
    // 每一步都先建一条记录（**包括复用与顺延的**）：这样"这一步为什么没有请求"在详情页
    // 看得出来，而不是整行凭空消失 —— 静默正是最容易让人以为"它跑过了"的那类假象。
    trace.enter(step.id);
    if (progress.done[step.id]) {
      results.push({ id: step.id, label: step.label, ...progress.done[step.id], reused: true, over: 0 });
      continue;
    }
    if (stopped) {
      results.push({ id: step.id, label: step.label, status: "skipped", message: "前置步骤未通过，未发起请求", over: 0 });
      continue;
    }
    const unmet = (step.dependsOn || []).filter((dep) => !SETTLED.has((progress.done[dep] || {}).status));
    if (unmet.length) {
      results.push({ id: step.id, label: step.label, status: "skipped", message: `依赖未满足：${unmet.join(", ")}`, over: 0 });
      continue;
    }
    // 装不下就整步顺延：半途被掐断比不跑更糟，因为上游可能已部分生效。
    // 判据是纯外部 HTTP：step.cost 就是这一步的上游请求上界。
    // 不要在这里为"收尾写入"预留什么 —— 收尾全是 KV，各走 1000 那份额度（常量已删，理由见文件头）。
    if (!budget.fits(step.cost)) {
      // 不可达只有一种：单步成本超过整个上限，任何一轮都装不下。
      // 判据不能加余量 —— 那会把"本轮装不下、下轮装得下"的正常顺延误报成配置错误。
      const unreachable = step.cost > budget.limit;
      results.push({
        id: step.id, label: step.label, status: "deferred", over: 0, unreachable,
        message: unreachable
          ? `步骤成本 ${step.cost} 接近单轮上限 ${budget.limit}，永远排不进，请调小 cost 或拆分步骤`
          : `预算不足（余 ${budget.left()}，需 ${step.cost}），留到下一轮`,
      });
      stopped = true;
      continue;
    }

    const before = budget.used;
    // 旧串必须在步骤开跑之前拍下来。续期发生在步骤内部，而三家 api.js 都会就地改写
    // ctx.account.cred（好让紧接着的下一步用新串）—— 等于内核事后拿到的 previous 已经是新值。
    // 那时再去 outcome.cred 里对比，被换掉的旧串就不在集合里了，而上游最爱回显的
    // 恰恰是"你刚才带来的那把票"，于是旧票据会明文进运行日志（KV 存 30 天、详情页可点看）。
    const secretsBefore = secretValuesOf(tool, account);
    let outcome;
    try {
      outcome = await step.run(ctx);
    } catch (error) {
      outcome = { status: "error", message: String((error && error.message) || error) };
    }
    // 凭据轮换：三家的续期接口都会换出一次性的新串。步骤把新值放在 outcome.cred 里交回来，
    // 内核先并进内存（下一步要用），再**当场**落盘 —— 攒到本轮收尾才写的话，
    // 中间任何一次掐死都会把新旧两张串同时烧掉。
    let rotated = null;
    if (outcome && outcome.cred && typeof outcome.cred === "object") {
      const patched = Object.entries(outcome.cred).filter(([, value]) => typeof value === "string" && value !== "");
      if (patched.length) {
        for (const [field, value] of patched) account.cred[field] = value;
        rotated = Object.fromEntries(patched);
      }
    }
    // 两种轮换都收：就地改写的、只回传 outcome.cred 的。丢掉的值永久留在本轮的脱敏集合里
    const secretsNow = secretValuesOf(tool, account);
    for (const value of secretsBefore) if (!secretsNow.includes(value)) stale.push(value);
    secrets = secretsNow.concat(stale);
    // cost 只是估算。实际超出估算要显式记下来，否则"估偏低"会被静默吸收，
    // 直到某轮第 51 次请求把整轮炸掉 —— 那时已经查不出是谁多花的。
    const over = Math.max(0, budget.used - before - step.cost);

    const record = {
      status: outcome && outcome.status ? outcome.status : "error",
      // 工具不许把响应体原样塞进 message；内核在这里截断并洗掉凭据，
      // 免得一次上游 401 就把票据原文带进进度键、响应页与平台日志
      message: truncate(scrubSecrets((outcome && outcome.message) || "步骤未返回结果", secrets), 200),
      credits: outcome && Number.isFinite(outcome.credits) ? outcome.credits : 0,
    };
    if (rotated) {
      // 同一个新串可能被后续每一步重复带回来（WorkBuddy 就是这样：续期发生在第一步，
      // 而每一步都把 ctx.rotated 附上）。不去重的话 6 个步骤会写 6 次同样的 KV ——
      // 单步 2 笔，6 步就是 12 笔，全是 KV 配额（不再占外部请求额度，但仍值得省）
      const fresh = Object.fromEntries(Object.entries(rotated).filter(([field, value]) => persistedCred[field] !== value));
      if (Object.keys(fresh).length) {
        let saved = false;
        try {
          saved = !!(await applyCredPatch(env, tool, uid, fresh));
        } catch { /* 下面按写回失败处理 */ }
        if (saved) Object.assign(persistedCred, fresh);
        // 写不回去 = 下一轮手里的旧串可能已被上游作废。这句话必须出现在日志里，
        // 否则用户看到的是"某天开始就一直 login_required"，查不到是从哪一轮断的
        record.message = `${record.message}${saved ? "（已换新凭据）" : "（新凭据写回失败，旧串可能已作废，可能要重新录入）"}`;
      }
    }
    results.push({ id: step.id, label: step.label, ...record, over });

    // 只有真正做完的步骤才进进度表。rate_limited / error / deferred 都是瞬时的，
    // 记成"已完成"会让下一轮直接复用、永远不再重试。
    // （曾经还顺手 push 一个 progress.order 数组，但全站没有任何消费者 —— 2026-10-02 删除。）
    if (SETTLED.has(record.status)) progress.done[step.id] = record;
    if (record.status === "login_required") stopped = true;
  }

  const status = aggregate(results);
  const allDone = results.length > 0 && results.every((r) => SETTLED.has(r.status));

  // 进度只在「本轮要停下的那一刻」写一次，不是每步都写：每步都写会让一个账号多花
  // 6 笔 KV。代价是这一轮被意外掐死时进度是旧的，
  // 下一轮重复跑几步 —— 靠"每步必须可安全重入"兜住，方向是宁可重复、不可跳过。
  // 这里不再问账本 —— 调度索引是系统的记忆，写不进去会把"谁做过什么"整轮抹掉，
  // 排在后面的账号就再也没机会被排上来；而 KV 有自己的额度，不参与外部请求闸门。
  try {
    if (allDone) await clearProgress(env, tool, uid);
    else await saveProgress(env, tool, uid, progress);
  } catch { /* 进度写失败最多让下一轮多做几步幂等请求，不该让本轮报错 */ }

  return {
    uid,
    account,
    label: account.label,
    status,
    message: summarize(results),
    // 积分只算本轮真做的那些步：复用来的积分再报一次，日志里就是凭空翻倍
    credits: results.reduce((sum, r) => sum + (r.reused ? 0 : (r.credits || 0)), 0),
    steps: results.map((r) => ({ id: r.id, status: r.status, message: r.message, reused: !!r.reused, over: r.over || 0, unreachable: !!r.unreachable, calls: trace.callsOf(r.id).length })),
    // 本账号这一轮真实花掉的外部请求数。取的是差值而不是 budget.used ——
    // 后者是整轮累计，混进单条日志就成了"这账号花了整轮那么多请求"，
    // 越到后面的账号数字越离谱。列表页那一列显示的就是它。
    http: budget.used - httpBefore,
    sched: {
      didWork: results.some((r) => !r.reused && !CONTINUABLE.has(r.status) && r.status !== "partial"),
      allDone,
      status,
      // partial 也算"有活没干完"：本轮只领了一部分，下一轮要立刻接着领，
      // 不该被 minIntervalSec 再挡 30 分钟
      resumable: !allDone && status !== "login_required"
        && results.some((r) => (CONTINUABLE.has(r.status) || r.status === "partial") && !r.reused),
    },
    // 请求记录本体。publicResult 只挑固定字段，所以它不会进 /api/tick 的返回值，
    // 只在 logOutcome 里被取走写进独立的 KV 键。
    trace,
  };
}

// 只写调度索引，绝不写 acct 记录 —— 那会用本轮开头的旧快照覆盖用户刚提交的凭据
function commitSched(index, tool, uid, result, day, now) {
  if (!result.sched) return;
  const cur = schedOf(index.entries[uid]);
  const s = result.sched;
  const strikes = s.status === "rate_limited" ? cur.rateStrikes + 1 : 0;
  index.entries[uid] = {
    ...cur,
    lastStatus: s.status,
    lastStatusDate: day,
    lastAt: s.didWork ? now : cur.lastAt,
    attempts: s.didWork ? (cur.attemptsDate === day ? cur.attempts : 0) + 1 : cur.attempts,
    attemptsDate: s.didWork ? day : cur.attemptsDate,
    rateStrikes: strikes,
    retryAt: s.status === "rate_limited" ? now + backoffSec(tool.schedule.backoff, strikes)
      : s.status === "pending" ? now + PENDING_RETRY_SEC : 0,
    resumable: s.resumable,
    // 紧凑的步骤摘要顺手存进索引：工具页渲染色块时已经读过这条索引了，
    // 若改为从运行日志逐账号取，就是 N 次 get
    lastSteps: (result.steps || []).map((r) => `${r.id}:${r.status}${r.reused ? ":r" : ""}`),
  };
}

const publicResult = (r) => ({
  uid: r.uid, label: r.label, status: r.status,
  message: r.message, credits: r.credits || 0, steps: r.steps || [],
  // 本账号这一轮的外部请求数，列表页那一列显示的就是它
  http: r.http || 0,
});

async function safe(fn) {
  try { await fn(); } catch { /* 观测与索引写入失败不该让本轮报错 */ }
}

// 坏记录也得在运行日志里露头，否则它在这套观测里彻底隐形：它进不了调度索引（没有可解析的
// 记录可写），红条又是从调度索引算的，于是用户只能靠猜到工具页上去翻那一行小字。
// 空 cred 的壳子就够了 —— 这条消息是内核写的，本来不含凭据。
async function logOutcome(env, { now, tool, result, view, budget, trigger }) {
  if (!result.account && !result.broken) return;
  // 日志时间用实际执行时刻而不是 cron 计划时刻：同一轮多个账号依次执行，
  // 时间戳应有先后差异；调度与逻辑日仍用传入的 now（scheduledTime）。
  const atMs = Date.now();
  // 无进展的轮次不写运行日志：旅行途中、配置未完成、预算顺延等每 30 分钟一条会刷屏。
  // didWork=false 且 credits=0 表示这一轮没有任何实际进展。
  // trace 仍写：详情页需要区分"这次没打上游"与"记录不存在"。
  const noProgress = result.sched && !result.sched.didWork && (result.credits || 0) === 0;
  if (!noProgress) {
    await safe(() => writeRunLog(env, {
      now: Math.floor(atMs / 1000), tool,
      account: result.account || { cred: {} },
      result: { ...view, label: view.label || view.uid },
      budget, trigger,
    }));
  }
  // 请求记录写进**独立的键**（列表页不读它，所以列表成本一分不涨）。
  // 即使一次交互都没有也写：这样详情页能区分"这次运行真的没打上游"与"记录不存在"。
  await safe(() => writeTrace(env, {
    at: atMs, tool,
    account: result.account || { cred: {} },
    uid: result.uid, trigger, steps: view.steps, trace: result.trace,
  }));
}

// 只提交这次真正改过的 uid（合并写回的理由见 accounts.js）
function picked(index, uids) {
  const out = {};
  for (const uid of uids) if (index.entries[uid]) out[uid] = index.entries[uid];
  return out;
}

export async function runTick({ env, budget, tools, trigger = "cron", now = nowSec() }) {
  const plan = [];
  let ran = 0;
  // 停用标记只读一次、贯穿本轮。放在循环里逐工具读就是"工具数"笔，
  // 而工具数会随加第 4 个工具一起涨。
  // 这一笔是 KV，不再参与 fits() —— 它有自己的额度，读得起。
  const flags = await loadFlags(env);

  for (const tool of tools) {
    // 停用判据放在最前：停用中的工具**一笔 KV 都不该花**。
    // 排在读配置、列账号之后的话，为了知道"它停着"已经花掉了那些。
    if (isOff(flags, tool.id)) {
      plan.push({ tool: tool.id, skipped: "已停用", accounts: [] });
      continue;
    }
    // 准入闸只看外部 HTTP：这轮还剩多少额度决定这一轮还能不能开下一个账号。
    if (budget.left() <= 0) {
      plan.push({ tool: tool.id, skipped: "外部请求额度已用尽", accounts: [] });
      continue;
    }
    const kv = requireKv(env);
    const config = await getJson(kv, toolKey(tool.id), {});
    if (!configComplete(tool, config)) {
      plan.push({ tool: tool.id, skipped: "配置未完成", accounts: [] });
      continue;
    }

    const uids = await listUids(kv, tool.id);
    const index = await loadSchedIndex(env, tool.id);
    const day = dayOf(tool, now);
    // 到期判定全部走内存里的调度索引：每工具固定 1 次 list + 1 次 get，与账号数无关。
    // 到期队列按"最久没被服务"排序，不是按 uid 字典序。
    // 字典序配上全局预算闸 = 排在末尾的账号永远饿死：WorkBuddy 一个账号最坏 31 次外部请求，
    // 上限 50 只装得下 1 个，而前两个每轮都以 partial 收（resumable 豁免节流，立刻再来），
    // 于是它们每轮把额度吃干、第三个永远排在闸外 —— 它连一条调度索引都拿不到，
    // 表现是红条不亮、首页进度不计入、/runs 里查无此人，用户只能逐个点进工具页才发现。
    // 按 lastAt 升序：被挤出门外的账号下一轮就是队首；从没跑过的账号 lastAt=0，第一跳就跑。
    const due = uids
      .filter((uid) => isDue(tool, index.entries[uid], day, now))
      .sort((a, b) => (schedOf(index.entries[a]).lastAt || 0) - (schedOf(index.entries[b]).lastAt || 0));
    if (due.length === 0) {
      plan.push({ tool: tool.id, skipped: "无到期账号", accounts: [] });
      continue;
    }

    const results = [];
    const touched = [];
    for (const uid of due) {
      // 账号级顺延：一分钱外部请求都不花，留给下一个账号。
      //
      // 这一层只问"还有没有外部请求额度"；具体够不够跑完这个账号的某一步，
      // 由 runOneAccount 里每一步的 fits(step.cost) 逐句判定 —— 判据更准，
      // 且 KV 开销（它有自己的额度）不会让一个账号拒掉另一个账号。
      if (budget.left() <= 0) {
        results.push({ uid, status: "deferred", message: "本轮外部请求额度已用尽，留到下一轮", steps: [] });
        continue;
      }
      const result = await runOneAccount({ env, budget, tool, uid, config, day, now, trigger });
      const view = publicResult(result);
      results.push(view);
      commitSched(index, tool, uid, result, day, now);
      if (result.sched) touched.push(uid);
      await logOutcome(env, { now, tool, result, view, budget, trigger });
      if (!result.quiet) ran += 1;
    }

    await safe(() => commitSchedEntries(env, tool.id, picked(index, touched)));

    plan.push({ tool: tool.id, accounts: results });
  }

  const summary = { now, trigger, ran, budget: { used: budget.used, limit: budget.limit, left: budget.left(), over: budget.over }, plan };
  // 不写整轮汇总日志（使用者明确决定）：账号级日志每条都在，汇总只是重复视图；
  // cron 每 30 分钟一轮，汇总记录只会把列表刷屏。要把握"这轮整体情况"，
  // 看 /api/tick 的返回值（手动触发时）与每账号的运行日志。
  // （曾每工具每轮写一个 v1:heartbeat:<tool> 心跳键，但全站没有任何读取点 —— 纯白烧
  //   KV 额度，2026-10-02 删除。）
  // 旧版本写的 v1:tick: 键在 30 天内仍会出现在日志列表里，读侧保留它们的渲染。
  return summary;
}

// 「立即执行」：跳过到期判定的时间闸（人既然点了就是要现在跑），但预算、锁、进度复用照旧。
// 不跳预算是必须的 —— 手动连点不该把整次调用撞穿外部请求的 50 硬顶。
//
// 唯一不跳的是"工具配置没填"：那不是节流，是前置条件。缺项时这家站点根本没有可用的接入点
// 与超时值，cron 会整个跳过这个工具，手动却照跑就等于拿残缺的配置去打上游。
//
// 停用中的工具同样拒绝：界面上「执行」按钮已经隐藏了，但**隐藏不等于权限**——
// 直接敲 URL 不该绕过开关。这里必须在打任何上游请求之前就返回。
export async function runAccountNow({ env, budget, tool, uid, trigger = "manual", now = nowSec() }) {
  if (isOff(await loadFlags(env), tool.id)) {
    return {
      uid, label: uid, status: "error", credits: 0, steps: [],
      message: `「${tool.name}」已停用，已拒绝执行。要恢复请到总览页把它的开关打开。`,
    };
  }
  const kv = requireKv(env);
  const config = await getJson(kv, toolKey(tool.id), {});
  const missing = missingConfigFields(tool, config);
  if (missing.length) {
    return {
      uid, label: uid, status: "error", credits: 0, steps: [],
      message: `工具配置未完成，已拒绝执行（缺：${missing.join("、")}）。cron 同样会跳过这个工具，请先到「工具配置」补齐。`,
    };
  }
  const day = dayOf(tool, now);
  const index = await loadSchedIndex(env, tool.id);
  const result = await runOneAccount({ env, budget, tool, uid, config, day, now, trigger });
  commitSched(index, tool, uid, result, day, now);
  await safe(() => commitSchedEntries(env, tool.id, result.sched ? { [uid]: index.entries[uid] } : {}));
  const view = publicResult(result);
  await logOutcome(env, { now, tool, result, view, budget, trigger });
  return view;
}

// 「测试」：只验凭据能不能用，不领取、不写状态、不写运行日志。
// 工具没实现 validate 就不该有这个按钮 —— 由注册表在渲染前判断。
//
// 但有一件事必须写：validate 里如果发生了续期（Trae 的 ensureToken 就会），
// 旧的 refresh_token 已经被这次调用消耗掉了。不写回的话，"点一下测试"
// 就会把一个好账号点成 login_required —— 这是最容易自己踩死自己的按钮。
// 这里不做"模块记得返回 cred"的约定，而是直接对比调用前后的凭据差异：
// 忘了也会被自动兜住。
export async function validateAccount({ env, budget, tool, uid, now = nowSec() }) {
  if (typeof tool.validate !== "function") return { status: "error", message: "该工具未提供连接测试" };
  const kv = requireKv(env);
  const config = await getJson(kv, toolKey(tool.id), {});
  const account = await getAccount(env, tool.id, uid);
  if (!account) return { status: "error", message: "记录无法解析，请在界面删除后重新添加" };
  const before = Object.entries(account.cred).filter(([key]) => key !== "label");
  const snapshot = Object.fromEntries(before);
  const ctx = { account, config, tool, env, kv, budget, now, day: dayOf(tool, now), trigger: "validate", fetch: trackedFetch(budget, tool.hosts) };
  let outcome;
  try {
    outcome = await tool.validate(ctx);
  } catch (error) {
    outcome = { status: "error", message: String((error && error.message) || error) };
  }

  // 把测试期间换出来的新凭据落盘（只合并声明过的字段，理由见 accounts.js）
  const changed = Object.fromEntries(
    Object.entries(account.cred).filter(([key, value]) => snapshot[key] !== undefined && snapshot[key] !== value),
  );
  let persisted = false;
  if (Object.keys(changed).length) persisted = !!(await applyCredPatch(env, tool, uid, changed).catch(() => null));

  const secrets = secretValuesOf(tool, account).concat(Object.values(changed));
  return {
    status: outcome && outcome.status ? outcome.status : "error",
    // 测试结果直接显示在页面上，而 validate 拿得到账号凭据本身 —— 同一道清洗，同一个理由
    message: truncate(scrubSecrets((outcome && outcome.message) || "未返回结果", secrets), 200)
      + (Object.keys(changed).length ? (persisted ? "（本次测试顺带续了期，新凭据已写回）" : "（本次测试换出的新凭据**没能写回**，旧串已用过，请尽快重新录入）") : ""),
  };
}
