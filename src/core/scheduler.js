import { getJson, putJson, requireKv, stepKey } from "./store.js";
import { schedOf } from "./accounts.js";
import { CST_OFFSET, logicalDay } from "./time.js";

// 跑完就算数的状态：今天不再重复排队
const SETTLED = new Set(["claimed", "already", "inactive", "ok"]);

// 缺哪些必填的工具级配置。判"能不能跑"和"为什么不能跑"共用这一处，
// 免得文案自己拼一遍字段、和真正的门槛判断走岔。
export function missingConfigFields(tool, config) {
  return (tool.config || [])
    .filter((field) => field.required && String((config || {})[field.key] ?? "").trim() === "")
    .map((field) => field.label || field.key);
}

export function configComplete(tool, config) {
  return missingConfigFields(tool, config).length === 0;
}

export function cstHour(sec) {
  return new Date((sec + CST_OFFSET) * 1000).getUTCHours();
}

export const dayOf = (tool, sec) => logicalDay(tool.schedule.resetHour, sec);

// 四道 AND 闸。缺任何一条都会导致重复领取或白烧配额，所以判定全部集中在这里，工具不许自己判断。
//
// minIntervalSec 只用来防"反复重试同一个失败账号"。它不该挡住"接着做今天没做完的活" ——
// 后者根本不是重试，上游只会看到幂等应答。resumable 标志由 runner 在每轮结束时置，
// 判定时无需额外读进度键（那会多花子请求）。
export function isDue(tool, entry, day, now) {
  const schedule = tool.schedule;
  if (cstHour(now) < (schedule.notBeforeHour ?? 0)) return false;

  const sched = schedOf(entry);
  if (sched.lastStatusDate === day && SETTLED.has(sched.lastStatus)) return false;
  if (sched.retryAt > now) return false;
  if (!sched.resumable && sched.lastAt && now - sched.lastAt < (schedule.minIntervalSec ?? 0)) return false;
  // 可接续的轮次不受 maxDaily 约束：那是在把已经开了头的活做完，不是又一次尝试
  if (!sched.resumable && sched.attemptsDate === day && sched.attempts >= (schedule.maxDaily ?? Infinity)) return false;
  return true;
}

// 步骤进度按「逻辑日」记账：跨天即视为全未做。
// 用 tick 开始时算好的 day，绝不在运行中途重算 —— 否则 23:59 开始的那轮会把
// 属于 D 日的领取记到 D+1 日名下，第二天白丢一次。
export async function loadProgress(env, tool, uid, day) {
  const saved = await getJson(requireKv(env), stepKey(tool.id, uid), null);
  if (!saved || saved.day !== day) return { day, done: {}, order: [] };
  return { day: saved.day, done: saved.done && typeof saved.done === "object" ? saved.done : {}, order: saved.order || [] };
}

export function saveProgress(env, tool, uid, progress) {
  return putJson(requireKv(env), stepKey(tool.id, uid), progress);
}

export function clearProgress(env, tool, uid) {
  return requireKv(env).delete(stepKey(tool.id, uid));
}
