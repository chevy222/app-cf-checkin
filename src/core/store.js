const SCHEMA = "v1";

const kvOf = (env) => (env && env.CHECKIN_KV) || null;

// 缺绑定要大声失败：静默降级会让人以为平台在跑，其实什么都没存
export function requireKv(env) {
  const kv = kvOf(env);
  if (!kv) throw new Error("缺少 KV 绑定：CHECKIN_KV");
  return kv;
}

export const acctKey = (tool, uid) => `${SCHEMA}:acct:${tool}:${uid}`;
export const acctPrefix = (tool) => `${SCHEMA}:acct:${tool}:`;
export const toolKey = (tool) => `${SCHEMA}:tool:${tool}`;
// 调度状态索引：每工具一键，与 acct 键互不交集（见 accounts.js 的说明）
export const schedIdxKey = (tool) => `${SCHEMA}:schedidx:${tool}`;
export const stepKey = (tool, uid) => `${SCHEMA}:step:${tool}:${uid}`;
export const lockKey = (tool, uid) => `${SCHEMA}:lock:${tool}:${uid}`;
// 曾经有 v1:heartbeat:<tool>（每轮写"这轮跑了几个账号"），但全站没有任何读取点，
// 纯粹白烧 KV 额度 —— 2026-10-02 连同写入一起删除。
// 工具停用标记。**单键存全部工具**，不是每工具一个键：后者读一次要 N 次 get，
// 而首页与每一轮都只需要"哪些工具停着"这一个事实
export const flagsKey = () => `${SCHEMA}:flags`;

export async function getJson(kv, key, fallback) {
  const raw = await kv.get(key);
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function putJson(kv, key, value) {
  return kv.put(key, JSON.stringify(value));
}

// list 只回键名。数数量时用 listUids 就够了，一次调用覆盖 1000 个键；
// 需要字段内容时才逐条 get —— 那条路径是线性的，别用在不必要的地方（见 accounts.countAccounts）
export async function listUids(kv, tool) {
  const prefix = acctPrefix(tool);
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const entry of page.keys) out.push(entry.name.slice(prefix.length));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}
