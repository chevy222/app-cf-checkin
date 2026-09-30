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
  // 账号标识有两种来源，必须正好有一种：
  //   uidField —— 标识就是用户填的某个字段（企业版员工编号、许可证 key 这类明面标识）
  //   uidOf    —— 标识藏在凭据里，得从 JWT 解出来（三家真实形态：让人抄一遍 sub 只会抄出错别字）
  // 三家在用的全是 uidOf，但 uidField 分支不是死代码：内核与界面都仍有专门分支处理它，
  // 工具作者按「加新工具」那条路走时它是契约的一半。
  if (tool.uidField && tool.uidOf) bad("uidField 与 uidOf 只能声明一个");
  if (!tool.uidField && !tool.uidOf) bad("必须声明 uidField 或 uidOf");
  if (tool.uidOf && typeof tool.uidOf !== "function") bad("uidOf 必须是函数");
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
