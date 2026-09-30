import { acctKey, acctPrefix, getJson, putJson, requireKv, schedIdxKey } from "./store.js";
import { listUids } from "./store.js";
import { nowSec } from "./time.js";

const MAX_FIELD_LEN = 8192;
const MAX_UID_LEN = 64;
const MAX_LABEL_LEN = 60;

// uid 会拼进 KV 键名，所以只留安全字符；清空则拒绝，否则会写出以冒号结尾的退化键。
// 注意：它会剥字符并截断，所以「用户输入的席位号」与「实际 uid」可能不同 ——
// 因此 uid 一旦生成就不可改，编辑时若改动会被拒（见 router 的 accountUpdate）。
export function sanitizeUid(raw) {
  return String(raw ?? "").trim().slice(0, MAX_UID_LEN).replace(/[^A-Za-z0-9._-]/g, "");
}

// 只认 schema 里声明过的 key，表单里多出来的字段一律丢弃 —— 否则提交者能往账号记录里塞任意字段。
// 字段 key 不得用 pwd / label：pwd 会和表单里携带口令的隐藏字段同名，
// 导致访问口令被当成工具凭据写进 KV；label 是界面层的通用备注名字段。
//
// 「留空」的三种语义必须各归各位，否则会静默改写用户已存的数据：
//   敏感字段         留空 = 保持原值
//   非敏感可选字段   留空 = 明确清空（写成空串）
//   select（编辑时） 留空 = 保持原值，绝不回落到 default
export function coerceFields(fields, form, { editing = false } = {}) {
  const values = {};
  const errors = {};

  for (const field of fields) {
    const label = field.label || field.key;
    // 只读字段由内核或续期轮换写入，表单里提交什么都不收 —— 否则用户能伪报"令牌剩 N 天"
    if (field.readonly) continue;
    const raw = String(form.get(field.key) ?? "").trim();

    if (field.type === "select") {
      if (raw === "") {
        if (editing) continue;
        if (field.default !== undefined) values[field.key] = String(field.default);
        else if (field.required) errors[field.key] = `「${label}」是必选项`;
        continue;
      }
      const allowed = (field.options || []).map((opt) => String(typeof opt === "object" ? opt.value : opt));
      if (allowed.includes(raw)) values[field.key] = raw;
      else errors[field.key] = `「${label}」的值不在允许范围内`;
      continue;
    }

    if (raw.length > MAX_FIELD_LEN) {
      errors[field.key] = `「${label}」超过 ${MAX_FIELD_LEN} 字符上限`;
      continue;
    }
    if (raw === "") {
      if (editing && !field.required && !field.secret) values[field.key] = "";
      else if (field.required && !(editing && field.secret)) errors[field.key] = `「${label}」是必填项`;
      continue;
    }
    if (field.pattern && !new RegExp(field.pattern).test(raw)) {
      errors[field.key] = field.patternMessage || `「${label}」格式不对`;
      continue;
    }
    values[field.key] = raw;
  }

  return { values, errors };
}

const wellFormed = (rec) => !!rec && typeof rec === "object" && !!rec.cred && typeof rec.cred === "object";

// 账号记录只存凭据与备注名。调度状态在 v1:schedidx:* 里，两边永不交集 ——
// 这样调度器回写状态时不可能覆盖用户刚改的凭据（阶段 2 审核的 P0-2）。
//
// 损坏记录要出现在列表里：否则它既看不见又删不掉，会把整个工具永久卡死。
//
// 逐条 get 是这张表的硬成本（非敏感的字段值就在记录里），所以必须给上界：
// 一次调用只有 50 个子请求，1 list + N get 在 N=49 时整页 500。这里默认只取前 20 条，
// 剩下的用 total 如实告诉用户"还有多少个没显示"。账号只有 2–3 个时这条永远不触发，
// 它挡的是"某天手滑加了五十个号"这种把界面永久变砖的情况。
export const ACCOUNT_LIST_CAP = 20;

export async function listAccounts(env, toolId, cap = ACCOUNT_LIST_CAP) {
  const kv = requireKv(env);
  const uids = await listUids(kv, toolId);
  const out = [];
  for (const uid of uids.slice(0, cap)) {
    const rec = await getJson(kv, acctKey(toolId, uid), null);
    out.push(wellFormed(rec) ? { uid, ...rec } : { uid, label: null, cred: {}, createdAt: 0, updatedAt: 0, broken: true });
  }
  out.sort((a, b) => String(a.label || a.uid).localeCompare(String(b.label || b.uid), "zh-CN"));
  return { accounts: out, total: uids.length };
}

// 只要数量时用这个：一次 list 就够，不必逐条 get。
export async function countAccounts(env, toolId) {
  return (await listUids(requireKv(env), toolId)).length;
}

// ── 凭据轮换的回写 ──
//
// 三家的续期接口都会换出新的 refresh_token（旧的用过一次可能就作废）：不写回去，
// 下一轮拿着旧串去打，账号会静默死掉，而且是从界面上看不出来的那种死法。
//
// 所以"调度器永不写 acct 记录"这条纪律要收窄成"**不会用本轮开头的旧快照整份覆盖**"：
//   ① 重新读一份新鲜记录（不是拿本轮开头那份改）；
//   ② 只合并工具在 creds 里声明过的字段，且只收非空字符串；
//   ③ label / createdAt / 没参与轮换的凭据字段，一律从新鲜记录原样带过去。
// 这样同一轮里用户刚提交的别的字段不会被抹掉，工具也不可能借这条路写任意字段。
// 代价：1 次 get + 1 次 put，只在真有轮换时发生 —— 由步骤的 cost 自行认领。
export async function applyCredPatch(env, tool, uid, patch) {
  const allowed = new Set(((tool.creds || []).map((field) => field.key)));
  const changes = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (allowed.has(key) && typeof value === "string" && value !== "") changes[key] = value;
  }
  if (Object.keys(changes).length === 0) return null;
  const kv = requireKv(env);
  const fresh = await getJson(kv, acctKey(tool.id, uid), null);
  if (!wellFormed(fresh)) return null;   // 记录坏了或已被删：不凭空造一条回来
  const next = { ...fresh, cred: { ...fresh.cred, ...changes }, updatedAt: nowSec() };
  await putJson(kv, acctKey(tool.id, uid), next);
  return { uid, ...next };
}

export async function getAccount(env, toolId, uid) {
  const kv = requireKv(env);
  const rec = await getJson(kv, acctKey(toolId, uid), null);
  return wellFormed(rec) ? { uid, ...rec } : null;
}

export async function saveAccount(env, toolId, { uid, values, label, existing }) {
  // 空 uid 会拼出以冒号结尾的畸形键（v1:acct:qoder:），既读不回来也删不掉。
  // 路由那条路径有 sanitizeUid 兜着，但工具作者直接调这里时不会有任何提示。
  const safeUid = sanitizeUid(uid);
  if (!safeUid) throw new Error("saveAccount 需要非空 uid");
  const kv = requireKv(env);
  const record = {
    label: String(label ?? "").trim().slice(0, MAX_LABEL_LEN) || null,
    cred: { ...(existing && existing.cred ? existing.cred : {}), ...values },
    createdAt: existing && existing.createdAt ? existing.createdAt : nowSec(),
    updatedAt: nowSec(),
  };
  await putJson(kv, acctKey(toolId, safeUid), record);
  return record;
}

export async function deleteAccount(env, toolId, uid) {
  const kv = requireKv(env);
  await kv.delete(acctKey(toolId, uid));
  // 顺手清掉调度索引里的残留条目，否则它会一直占位
  const index = await loadSchedIndex(env, toolId);
  if (index.entries[uid]) {
    delete index.entries[uid];
    await putJson(kv, schedIdxKey(toolId), index);
  }
}

// ── 调度状态：每工具一个索引键 ──
//
// 为什么不塞进账号记录：
//   1. 到期判定要读全部账号。塞在账号记录里就是 1 list + N get，48 个账号 49 次调用，
//      离免费版 50 的子请求硬顶只差 1 —— 阶段 2 审核实测撞穿。
//   2. 调度器每轮都要回写状态。与凭据同键意味着读-改-写会覆盖用户刚提交的凭据。
//
// 拆开后每工具每轮固定 1 次读 + 1 次写，与账号数无关；调度器也不再碰 acct 键。
const SCHED_FIELDS = ["lastStatus", "lastStatusDate", "lastAt", "attempts", "attemptsDate", "retryAt", "rateStrikes", "resumable", "lastSteps"];

const SCHED_DEFAULTS = {
  lastStatus: null, lastStatusDate: null, lastAt: 0,
  attempts: 0, attemptsDate: null, retryAt: 0, rateStrikes: 0, resumable: false, lastSteps: [],
};

// 只拷贝已知字段：不要 {...默认, ...旧值}，否则历史版本写过的字段会复活成假数据
export function schedOf(entry) {
  const out = { ...SCHED_DEFAULTS };
  const src = entry || {};
  for (const key of SCHED_FIELDS) if (src[key] !== undefined) out[key] = src[key];
  return out;
}

export async function loadSchedIndex(env, toolId) {
  const saved = await getJson(requireKv(env), schedIdxKey(toolId), null);
  const entries = saved && typeof saved === "object" && saved.entries && typeof saved.entries === "object" ? saved.entries : {};
  return { day: (saved && saved.day) || null, entries };
}

// 写回调度状态：先重读一份新鲜索引，只覆盖这次真正改过的那几个 uid。
//
// 为什么不是"内存里改完整份再写回"：那套前提（cron 间隔 30 分钟、同一账号有锁，
// 所以不存在并发写）在阶段 3 的手动执行按钮上线后就不成立了 —— 两个不同账号各点一次
// 「执行」会同时持有整份索引的旧快照，后写的那一份会把前一个账号的条目整条抹掉，
// 于是那个账号今天到底跑没跑过就丢了。多花一次 get 换"只改自己那几个 uid"。
// KV 没有原子原语，这不能把窗口关到零，但能从"整个账号运行期"缩到"一读一写之间"。
export async function commitSchedEntries(env, toolId, entries) {
  const changed = Object.entries(entries || {});
  if (changed.length === 0) return;
  const kv = requireKv(env);
  const fresh = await loadSchedIndex(env, toolId);
  for (const [uid, entry] of changed) fresh.entries[uid] = entry;
  await putJson(kv, schedIdxKey(toolId), fresh);
}
