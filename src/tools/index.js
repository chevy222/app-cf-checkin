import qoder from "./qoder/index.js";
import trae from "./trae/index.js";
import workbuddy from "./workbuddy/index.js";

// 加工具只改这一个文件：import + 放进数组。内核与界面都不许出现按 id 分支的代码。
//
// 字段 key 的两条保留字：不得用 "pwd"（会和表单携带访问口令的隐藏字段同名，
// 导致口令被当成工具凭据写进 KV），也不得用 "label"（界面层的通用备注名字段）。
//
// 顺序由 order 决定（界面与调度都按它排），这里的书写顺序不作为依据。
const REGISTERED = [qoder, trae, workbuddy];

// 启动期自检：宁可部署时直接报错，也不要等到有人打开首页才 500 且信息毫无指向
for (const tool of REGISTERED) {
  const bad = (msg) => {
    throw new Error(`工具注册表不完整：${tool && tool.id} — ${msg}`);
  };
  if (!tool || !tool.id || !tool.name) bad("缺少 id 或 name");
  if (!Array.isArray(tool.steps) || tool.steps.length === 0) bad("steps 必须是非空数组");
  if (tool.steps.some((s) => !s.id || !Number.isFinite(s.cost) || s.cost <= 0)) bad("每个步骤必须有 id 与正数 cost");
  // 缺了这条，忘记写 run 的工具要等到第一次调度才炸，而且报错信息毫无指向
  if (tool.steps.some((s) => typeof s.run !== "function")) bad("每个步骤必须实现 run()");
  if (!Array.isArray(tool.schedule.backoff)) bad("schedule.backoff 必须是数组");
  if (!Array.isArray(tool.creds)) bad("必须声明 creds 数组");
  // 账号标识只有一个来源：uidOf —— 一个"拿到表单值、算出账号身份"的函数。
  // 内核不认识任何具体站点，没法凭空知道"这个工具的账号叫什么"，所以只能由工具回答。
  // 三家在用的都是 uidOf：Qoder 与 WorkBuddy 解 JWT 的 sub（0 次子请求），
  // Trae 问一次 GetUserInfo（1 次子请求）。
  if (!tool.uidOf) bad("必须声明 uidOf（函数：拿到表单值，返回账号标识）");
  if (typeof tool.uidOf !== "function") bad("uidOf 必须是函数");
  if (!tool.schedule) bad("必须声明 schedule");
  if ([...tool.config || [], ...tool.creds].some((f) => f.key === "pwd" || f.key === "label")) {
    bad("字段 key 不得使用保留字 pwd / label");
  }
}

export const TOOLS = [...REGISTERED].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

export function findTool(id) {
  const wanted = String(id ?? "");
  return TOOLS.find((tool) => tool.id === wanted) || null;
}
