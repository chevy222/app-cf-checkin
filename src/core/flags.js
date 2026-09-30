import { flagsKey, getJson, putJson, requireKv } from "./store.js";
import { nowSec } from "./time.js";

// 工具停用标记（每工具一个独立开关，不是"全部停用"——用户明确拒绝过后者）。
//
// 存在单键 v1:flags 里而不是 v1:flag:<tool>：每工具一键的话，
// 读一次是 N 次 get，而首页与每一轮都只需要"哪些工具停着"这一个事实。
//
// 停用时**绝不删** step / schedidx / acct / lock：重新打开后当天进度照旧，续跑即可。
// 停用期间 lastAt 不推进，于是 §runner 的公平队列（按 lastAt 升序）会自然把它顶到队首，
// 不需要为恢复额外写任何代码 —— 那是 LRU 排序的免费性质。
export async function loadFlags(env) {
  const saved = await getJson(requireKv(env), flagsKey(), null);
  return saved && typeof saved === "object" ? saved : {};
}

export const isOff = (flags, toolId) => !!(flags && flags[toolId] && flags[toolId].off);

// 切换停用：读一份最新的 flags 再合并写回，别用调用方手里那份旧快照整份覆盖
// （与 commitSchedEntries 同一个理由：并发切换会把另一个工具的状态抹掉）。
export async function setToolOff(env, toolId, off) {
  const kv = requireKv(env);
  const current = await loadFlags(env);
  await putJson(kv, flagsKey(), { ...current, [toolId]: { off: !!off, at: nowSec() } });
  return !!off;
}
