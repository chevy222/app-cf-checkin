import { coerceFields, countAccounts, deleteAccount, getAccount, listAccounts, loadSchedIndex, sanitizeUid, saveAccount } from "./accounts.js";
import { isOff, loadFlags, setToolOff } from "./flags.js";
import { getJson, putJson, requireKv, toolKey } from "./store.js";
import { clearRunLog, listRunLog, readRunLog, scrubSecrets } from "./logs.js";
import { truncate } from "./text.js";
import { trackedFetch } from "./budget.js";
import { htmlRes, jsonRes, redirectRes } from "./http.js";
import { findTool, TOOLS } from "../tools/index.js";
import { link } from "../ui/layout.js";
import { renderHome } from "../ui/pages/home.js";
import { renderHelp } from "../ui/pages/help.js";
import { renderAccountForm, renderTool, renderToolConfig } from "../ui/pages/tool.js";
import { renderRunDetail, renderRuns, renderRunsClearConfirm } from "../ui/pages/runs.js";
import { renderNotFound } from "../ui/pages/gate.js";
import { runAccountNow, runTick, validateAccount } from "./runner.js";

const LABEL_FIELD = { key: "label", label: "备注名", help: "只给界面看，随便起，用来在列表和日志里认出这个账号" };

function notFound(pwd) {
  return htmlRes(renderNotFound(pwd), 404);
}

function flashFrom(url) {
  const flag = url.searchParams.get("done");
  if (flag === "saved") return { kind: "info", text: "已保存。" };
  if (flag === "deleted") return { kind: "info", text: "已删除。" };
  // 清空日志的回执必须报真实数字，且说清"没删完"这件事 —— 一次调用只有 50 个
  // 子请求，删不完是常态。谎报"已清空"比删不掉更糟。
  // 判据用 cleared 而不是 done：跳转参数里 cleared 是"确实删过"的信号，
  // deleted/saved 那两个是固定文案、没有数字可带。
  if (url.searchParams.get("cleared") !== null) {
    const n = Number(url.searchParams.get("cleared")) || 0;
    const more = url.searchParams.get("more") === "1";
    return {
      kind: more ? "warn" : "info",
      text: more
        ? `已删除 ${n} 条，这个预算只够删这么多（一次调用 50 个子请求）。再点一次「清空」继续删剩下的。`
        : `已删除 ${n} 条运行日志。`,
    };
  }
  // 开关切换的回执要说清是哪一家、变成了什么状态。跳转参数里只放工具 id 与 0/1，
  // 名字现查注册表 —— 免得一个纯展示用的查询串成为第二个事实来源。
  const toggled = url.searchParams.get("toggled");
  if (toggled) {
    const tool = findTool(toggled);
    if (tool) {
      return url.searchParams.get("off") === "1"
        ? { kind: "warn", text: `「${tool.name}」已停用：不再参与调度，账号与进度都原样留着，重新打开即可接着做。` }
        : { kind: "info", text: `「${tool.name}」已恢复，下一轮起重新参与调度。` };
    }
  }
  return null;
}

// 表单里 label 是界面层的通用字段，不属于工具的 cred，存之前拆出来
function splitLabel(values) {
  const { label, ...cred } = values;
  return { label, cred };
}

// 首页与 /api/state 只要数量：每工具一次 list，不随账号数线性花钱
// 首页要的东西全部走"每工具一次索引读 + 一次日志 list"，不随账号数增长
async function schedMap(env, toolId) {
  const index = await loadSchedIndex(env, toolId);
  return index.entries;
}

async function homePage(env, pwd, flash, budget) {
  const counts = {};
  const sched = {};
  for (const tool of TOOLS) {
    counts[tool.id] = await countAccounts(env, tool.id);
    sched[tool.id] = await schedMap(env, tool.id);
  }
  const flags = await loadFlags(env);
  const runs = await listRunLog(env, { limit: 12, toolIds: TOOLS.map((t) => t.id) });
  return htmlRes(renderHome({ pwd, tools: TOOLS, counts, sched, runs, flash, budget, flags }));
}

async function toolPage(env, pwd, tool, flash) {
  const { accounts, total } = await listAccounts(env, tool.id);
  const sched = await schedMap(env, tool.id);
  const flags = await loadFlags(env);
  return htmlRes(renderTool({ pwd, tool, accounts, total, sched, flash, flags }));
}

async function runsPage(ctx) {
  const wanted = ctx.url.searchParams.get("tool");
  const toolId = wanted && wanted !== "all" ? wanted : null;
  // 不带 toolId 时要按注册表逐个工具取一页再归并（logs.js 里解释了为什么不能扫全量）
  const entries = await listRunLog(ctx.env, { limit: 30, toolId, toolIds: TOOLS.map((t) => t.id) });
  return htmlRes(renderRuns({ pwd: ctx.pwd, tools: TOOLS, entries, active: { tool: toolId || "" }, flash: ctx.flash }));
}

async function runDetailPage(ctx, key) {
  const entry = await readRunLog(ctx.env, key);
  return htmlRes(renderRunDetail({ pwd: ctx.pwd, tools: TOOLS, entry, key, missing: !entry }));
}

// 清空日志的确认页。GET 只读，不改世界 —— 破坏性操作的入口页必须是 GET，
// 真正的删除在下面的 POST 上。tool 由 router 按注册表校验过，非法 id 到不了这里。
async function runsClearPage(ctx, tool) {
  // 只读工具自己的那一页来估个数：清空范围与列表筛选范围一致，用户能对上数
  const entries = await listRunLog(ctx.env, { limit: 30, toolId: tool.id, toolIds: [] });
  return htmlRes(renderRunsClearConfirm({ pwd: ctx.pwd, tools: TOOLS, tool, count: entries.length }));
}

// 删除走 POST：GET 不该改变世界。执行完重定向回该工具的日志页，
// cleared=N 让页面自己说出删了几条（真实数字，不猜）。
async function runsClearDo(ctx, tool) {
  const { deleted, more } = await clearRunLog(ctx.env, tool.id);
  return redirectRes(link("/runs", ctx.pwd, { tool: tool.id, cleared: String(deleted), more: more ? "1" : "0" }));
}

function accountFields(tool) {
  return [LABEL_FIELD, ...tool.creds];
}

function accountForm(ctx, tool, extra) {
  const { status, ...rest } = extra;
  return htmlRes(renderAccountForm({
    pwd: ctx.pwd, tool, fields: accountFields(tool),
    values: {}, existing: {}, errors: {}, title: `新增 ${tool.name} 账号`,
    ...rest,
  }), status || 200);
}

async function accountNewPage(ctx, tool) {
  return accountForm(ctx, tool, {});
}

// 账号标识从哪来：只有一个来源 —— 工具自己给的 uidOf 函数。
// 内核不认识任何具体站点，所以它没法凭空知道"这个工具的账号叫什么"；
// 让每个工具自己回答，是唯一能做到"加工具零改动"的方式。
// 三家在用的都是 uidOf（Qoder/WorkBuddy 解 JWT 的 sub，Trae 问一次 GetUserInfo）。
//
// 为什么不让用户自己抄一遍 uid：抄错就是另一个键名，账号记录会原地孤立
// 且不报错（旧 qoder 用会轮换的 refresh_token 兜底算 uid，续一次期就换了个键）。
// 宁可多花一次子请求（Trae 打一次 GetUserInfo），也不让人手抄。
//
// uidOf 可以只返回 uid，也可以返回 {uid, cred}：后者允许它把解出来的派生字段
// （比如令牌的到期时间）一并存进去。不这么做的话新账号没有 expiresAt，
// 第一次运行就得白换一次票。
async function resolveUid(ctx, tool, values) {
  const config = await getJson(requireKv(ctx.env), toolKey(tool.id), {});
  const fetched = trackedFetch(ctx.budget, tool.hosts);
  try {
    const found = await tool.uidOf({ values, config, tool, env: ctx.env, budget: ctx.budget, fetch: fetched });
    const shape = typeof found === "string" || !found ? { uid: found } : found;
    return { uid: sanitizeUid(shape.uid), cred: shape.cred && typeof shape.cred === "object" ? shape.cred : null };
  } catch (error) {
    // 上游的报错原文可能把刚粘进来的票据回显出来，而这段文字会被渲到表单上
    const secrets = Object.values(values).filter((value) => typeof value === "string" && value !== "");
    return { uid: "", error: truncate(scrubSecrets(String((error && error.message) || error), secrets), 200) };
  }
}

async function accountEditPage(ctx, tool, uid) {
  const account = await getAccount(ctx.env, tool.id, uid);
  if (!account) return notFound(ctx.pwd);
  return accountForm(ctx, tool, {
    uid, title: `编辑 ${tool.name} 账号`,
    values: { label: account.label || "", ...account.cred },
    existing: account.cred,
  });
}

async function accountCreate(ctx, tool) {
  const fields = accountFields(tool);
  const { values, errors } = coerceFields(fields, ctx.form);
  // 算不出 uid 时把错误挂在哪个字段上：uid 是从凭据解出来的，所以挂在
  // "第一个必填的凭据字段"上 —— 对三家来说都是那个令牌字段，语义正确。
  const uidKey = (tool.creds.find((field) => field.required && !field.readonly) || {}).key;

  // 先验字段再算 uid：uidOf 可能要打一次上游（Trae），格式都不对的提交不该花那份预算
  if (Object.keys(errors).length) {
    return accountForm(ctx, tool, {
      values, errors, title: `新增 ${tool.name} 账号`, status: 400,
      flash: { kind: "bad", text: "保存失败：请修正下面标红的项目。" },
    });
  }

  const derived = await resolveUid(ctx, tool, values);
  const uid = derived.uid;
  if (derived.error) {
    // 标识算不出来 = 这个号根本存不了。错误挂在凭据字段上，而不是凭空造一个键存进去
    if (!errors[uidKey]) errors[uidKey] = `取账号标识失败：${derived.error}`;
    return accountForm(ctx, tool, {
      values, errors, title: `新增 ${tool.name} 账号`, status: 400,
      flash: { kind: "bad", text: "保存失败：这张凭据里取不出账号标识（详见下方）。" },
    });
  }
  if (!uid) {
    if (!errors[uidKey]) errors[uidKey] = "无法从该字段得出账号标识，请检查格式";
    return accountForm(ctx, tool, {
      values, errors, title: `新增 ${tool.name} 账号`, status: 400,
      flash: { kind: "bad", text: "保存失败：请修正下面标红的项目。" },
    });
  }
  if (await getAccount(ctx.env, tool.id, uid)) {
    return accountForm(ctx, tool, {
      values, uid, title: `新增 ${tool.name} 账号`, status: 409,
      errors: { [uidKey]: `账号 ${uid} 已存在，请改用编辑` },
    });
  }

  // uidOf 顺手解出来的派生字段（令牌到期时间等）随这次一起存。
  // 它们是 readonly 字段，coerceFields 从表单里收不到，只能走这条路进来。
  if (derived.cred) Object.assign(values, derived.cred);
  const { label, cred } = splitLabel(values);
  await saveAccount(ctx.env, tool.id, { uid, values: cred, label });
  return redirectRes(link(`/tool/${tool.id}`, ctx.pwd, { done: "saved" }));
}

async function accountUpdate(ctx, tool, uid) {
  const account = await getAccount(ctx.env, tool.id, uid);
  if (!account) return notFound(ctx.pwd);

  const fields = accountFields(tool);
  const { values, errors } = coerceFields(fields, ctx.form, { editing: true });

  // uid 是 KV 键名的一部分，建立后不可改。而 uid 是从凭据解出来的，所以用户能
  // "改"它的唯一途径就是换一张票据 —— 那不是改标识，是拿别人的凭据顶着旧 uid 跑，
  // 于是界面显示的名字与真实身份再也不一致，系统还不会告诉你。
  //
  // 只在"这次真的动了凭据"时才重新算 uid：敏感字段留空本来就是"保持原值"，
  // 而算 uid 可能要打上游（Trae 是 GetUserInfo）。不加这个条件，
  // 票据一过期，用户连改个备注名都会被"取不出账号标识"挡住。
  const credKeys = new Set((tool.creds || []).map((field) => field.key));
  const credTouched = Object.keys(values).some((key) => credKeys.has(key));
  const derived = !credTouched ? { uid, cred: null } : await resolveUid(ctx, tool, { ...account.cred, ...values });
  const uidKeyName = (tool.creds.find((field) => field.required && !field.readonly) || {}).key;
  if (derived.error) {
    errors[uidKeyName] = `校验账号标识失败：${derived.error}`;
  } else if (derived.uid && derived.uid !== uid) {
    errors[uidKeyName] = `这张凭据属于账号 ${derived.uid}，与本页要编辑的 ${uid} 不是同一个。要录另一个号请用「新增账号」`;
  }

  if (Object.keys(errors).length) {
    return accountForm(ctx, tool, {
      uid, title: `编辑 ${tool.name} 账号`, status: 409,
      values: { label: account.label || "", ...account.cred, ...values },
      existing: account.cred, errors,
      flash: { kind: "bad", text: "保存失败：请修正下面标红的项目。" },
    });
  }

  if (derived.cred) Object.assign(values, derived.cred);   // 同 accountCreate：只读派生字段走这条路
  const { label, cred } = splitLabel(values);
  await saveAccount(ctx.env, tool.id, { uid, values: cred, label, existing: account });
  return redirectRes(link(`/tool/${tool.id}`, ctx.pwd, { done: "saved" }));
}

// 无条件删：损坏的记录取不出来，但键必须能删掉，否则它会一直挡在这个工具上
async function accountDelete(ctx, tool, uid) {
  await deleteAccount(ctx.env, tool.id, uid);
  return redirectRes(link(`/tool/${tool.id}`, ctx.pwd, { done: "deleted" }));
}

// 手动执行与测试共用页面那本账：手动连点不该把整次调用撞穿 50 的硬顶。
// 结果里的 message 已在内核侧洗掉凭据（runner 的 runOneAccount），这里可以直接显示。
async function runNowHandler(ctx, tool, uid) {
  const result = await runAccountNow({ env: ctx.env, budget: ctx.budget, tool, uid, trigger: "manual" });
  return renderToolWithFlash(ctx, tool, { kind: ["error", "login_required"].includes(result.status) ? "bad" : "info", text: `${uid} → ${result.status}：${result.message}` });
}

async function validateHandler(ctx, tool, uid) {
  const result = await validateAccount({ env: ctx.env, budget: ctx.budget, tool, uid });
  return renderToolWithFlash(ctx, tool, { kind: result.status === "ok" || result.status === "claimed" ? "info" : "bad", text: `测试 ${uid}：${result.status} — ${result.message}` });
}

async function renderToolWithFlash(ctx, tool, flash) {
  const { accounts, total } = await listAccounts(ctx.env, tool.id);
  const sched = await schedMap(ctx.env, tool.id);
  const flags = await loadFlags(ctx.env);
  return htmlRes(renderTool({ pwd: ctx.pwd, tool, accounts, total, sched, flash, flags }));
}

// 开关切换。表单里带 pwd，状态变更走 POST —— 与全站其它变更一致，页面里没有一行 JS。
// 停用不删任何调度数据（step / schedidx / acct / lock 全部原样留着），
// 所以重新打开时当天进度照旧、接着做即可。
async function toolToggle(ctx, tool) {
  const next = !isOff(await loadFlags(ctx.env), tool.id);
  await setToolOff(ctx.env, tool.id, next);
  return redirectRes(link("/", ctx.pwd, { toggled: tool.id, off: next ? "1" : "0" }));
}

async function configPage(ctx, tool) {
  const values = await getJson(requireKv(ctx.env), toolKey(tool.id), {});
  return htmlRes(renderToolConfig({ pwd: ctx.pwd, tool, values, errors: {}, flash: ctx.flash }));
}

async function configSave(ctx, tool) {
  const existing = await getJson(requireKv(ctx.env), toolKey(tool.id), {});
  const { values, errors } = coerceFields(tool.config, ctx.form, { editing: true });
  if (Object.keys(errors).length) {
    return htmlRes(renderToolConfig({
      pwd: ctx.pwd, tool, values: { ...existing, ...values }, errors,
      flash: { kind: "bad", text: "保存失败：请修正下面标红的项目。" },
    }));
  }
  await putJson(requireKv(ctx.env), toolKey(tool.id), { ...existing, ...values });
  return redirectRes(link(`/tool/${tool.id}/settings`, ctx.pwd, { done: "saved" }));
}

async function apiState(env, budget) {
  const counts = {};
  for (const tool of TOOLS) counts[tool.id] = await countAccounts(env, tool.id);
  const flags = await loadFlags(env);
  return jsonRes({
    ok: true,
    stage: 5,
    budget: budget ? { used: budget.used, limit: budget.limit, left: budget.left() } : null,
    tools: TOOLS.map((tool) => ({
      id: tool.id, name: tool.name, steps: tool.steps.length, accounts: counts[tool.id],
      off: isOff(flags, tool.id),
    })),
  });
}

// 手动跑一轮并返回结构化结果：顺延、断点续跑、退避这些行为不靠读日志猜，
// 直接看这一份 JSON。
async function apiTick(ctx) {
  const summary = await runTick({ env: ctx.env, budget: ctx.budget, tools: TOOLS, trigger: "manual" });
  return jsonRes({ ok: true, ...summary });
}

const NEW_ACCOUNT = /^\/account\/new$/;
const RUN_DETAIL = /^\/runs\/([^/]+)$/;
// 首段捕获组不是工具 id 的路由，不能拿去注册表校验
const NO_TOOL_ROUTES = new Set([RUN_DETAIL]);

const ROUTES = [
  ["GET", /^\/$/, (ctx) => homePage(ctx.env, ctx.pwd, ctx.flash, ctx.budget)],
  ["GET", /^\/help$/, (ctx) => htmlRes(renderHelp({ pwd: ctx.pwd, tools: TOOLS }))],
  ["GET", /^\/runs$/, (ctx) => runsPage(ctx)],
  // 路径必须是 /runs/<tool>/clear 而不是 /runs/clear：捕获组里的 tool 才会过注册表校验。
  // 也因此不会与 RUN_DETAIL（/runs/([^/]+)$）抢路由 —— 后者只匹配单段。
  ["GET", /^\/runs\/([^/]+)\/clear$/, (ctx, tool) => runsClearPage(ctx, tool)],
  ["POST", /^\/runs\/([^/]+)\/clear$/, (ctx, tool) => runsClearDo(ctx, tool)],
  ["GET", RUN_DETAIL, (ctx, key) => runDetailPage(ctx, key)],
  ["GET", /^\/api\/state$/, (ctx) => apiState(ctx.env, ctx.budget)],
  ["GET", /^\/api\/tick$/, (ctx) => apiTick(ctx)],
  ["POST", /^\/api\/tick$/, (ctx) => apiTick(ctx)],
  ["GET", /^\/tool\/([^/]+)$/, (ctx, tool) => toolPage(ctx.env, ctx.pwd, tool, ctx.flash)],
  ["POST", /^\/tool\/([^/]+)\/toggle$/, (ctx, tool) => toolToggle(ctx, tool)],
  ["GET", /^\/tool\/([^/]+)\/settings$/, (ctx, tool) => configPage(ctx, tool)],
  ["POST", /^\/tool\/([^/]+)\/settings$/, (ctx, tool) => configSave(ctx, tool)],
  ["GET", NEW_ACCOUNT, (ctx) => (ctx.tool ? accountNewPage(ctx, ctx.tool) : notFound(ctx.pwd))],
  ["POST", /^\/account\/([^/]+)\/new$/, (ctx, tool) => accountCreate(ctx, tool)],
  ["GET", /^\/account\/([^/]+)\/([^/]+)\/edit$/, (ctx, tool, uid) => accountEditPage(ctx, tool, uid)],
  ["POST", /^\/account\/([^/]+)\/([^/]+)\/edit$/, (ctx, tool, uid) => accountUpdate(ctx, tool, uid)],
  ["POST", /^\/account\/([^/]+)\/([^/]+)\/delete$/, (ctx, tool, uid) => accountDelete(ctx, tool, uid)],
  ["POST", /^\/account\/([^/]+)\/([^/]+)\/run$/, (ctx, tool, uid) => runNowHandler(ctx, tool, uid)],
  ["POST", /^\/account\/([^/]+)\/([^/]+)\/validate$/, (ctx, tool, uid) => validateHandler(ctx, tool, uid)],
];

export async function dispatch(request, url, env, pwd, form, budget) {
  const method = request.method.toUpperCase();

  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const match = pattern.exec(url.pathname);
    if (!match) continue;

    let params;
    try {
      params = match.slice(1).map(decodeURIComponent);
    } catch {
      return notFound(pwd); // 畸形百分号编码（如 %zz）不该变成 500
    }

    // flash 放进 ctx 而不是按位置传：路由捕获组数量不同，按位置传会静默错位
    const ctx = { request, url, env, pwd, form, budget, flash: flashFrom(url), tool: null };

    // 工具 id 必须先过注册表，否则提交者能借它往 KV 写任意前缀的键。
    // 只有 /account/new 这一个无捕获组的路由才从查询串取 tool，别的路径上它不该参与判定。
    const wanted = params.length && !NO_TOOL_ROUTES.has(pattern)
      ? params[0]
      : (pattern === NEW_ACCOUNT ? url.searchParams.get("tool") : null);
    if (wanted) {
      const tool = findTool(wanted);
      if (!tool) return notFound(pwd);
      ctx.tool = tool;
    }

    // 处理器实参的形状只有一种约定：工具路由 = (ctx, 已解析的 tool, tool 之后的捕获组…)；
    // 非工具路由 = (ctx, 捕获组…)。
    // 不要把两种路由统一写成 params[1] —— 那会把 /runs/<key> 的键名吞掉
    // （第一个捕获组被 tool 槽位吃掉），详情页于是永远渲染成"记录不存在"。
    if (NO_TOOL_ROUTES.has(pattern)) return handler(ctx, ...params);
    return params.length ? await handler(ctx, ctx.tool, ...params.slice(1)) : await handler(ctx);
  }

  return notFound(pwd);
}
