import { getJson, requireKv } from "./store.js";
import { maskSecret, truncate } from "./text.js";

const RUN_PREFIX = "v1:run:";
const TICK_PREFIX = "v1:tick:";
const LOG_TTL_DAYS = 30;
const LOG_TTL_SEC = LOG_TTL_DAYS * 86400;
// KV 的 metadata 上限 1024 字节，留出余量：列表页靠它渲染，不该被截断成半条
const META_MESSAGE_MAX = 180;
// KV 只会按键名字典序往前翻，而日志要的是"最新 N 条"。把毫秒时间戳取反写进键名，
// 键序就变成时间倒序，第一页就是最近的 —— 否则翻页翻到的永远是最老的。
const REV_BASE = 1e13;
const revOf = (ms) => String(REV_BASE - Number(ms)).padStart(13, "0");

// 键名形状：
//   v1:run:<tool>:<反转毫秒>:<uid>   账号级
//   v1:tick:<反转毫秒>               本轮汇总
// 工具段放在时间段之前，"按工具筛"才能是一次带前缀的 list（时间在前的话只能扫全量再过滤，
// 而扫全量必然有页数上限，筛得窄的历史就永远读不到）。
const runKey = (ms, toolId, uid) => `${RUN_PREFIX}${toolId}:${revOf(ms)}:${uid}`;
const tickKey = (ms) => `${TICK_PREFIX}${revOf(ms)}`;

export const isLogKey = (key) => String(key).startsWith(RUN_PREFIX) || String(key).startsWith(TICK_PREFIX);

// 从键名解析出这一条的身份与时刻：kind / tool / uid / at(ms)。
// 界面上的"这是谁的哪一轮"一律取自键名而不是 metadata —— 键名是我们自己写的、必然正确，
// metadata 只是省子请求的摘要，缺了它这一行也该认得出是谁。
export function partsOf(key) {
  const text = String(key ?? "");
  if (text.startsWith(TICK_PREFIX)) {
    return { kind: "tick", tool: "*", uid: null, at: REV_BASE - Number(text.slice(TICK_PREFIX.length)) };
  }
  if (text.startsWith(RUN_PREFIX)) {
    const seg = text.slice(RUN_PREFIX.length).split(":");
    const rev = seg[1];
    return { kind: "run", tool: seg[0], uid: seg.slice(2).join(":"), at: REV_BASE - Number(rev) };
  }
  return { kind: null, tool: null, uid: null, at: NaN };
}

// ── 凭据脱敏 ──
//
// 内核不认识具体站点，但它知道两件事：哪些字段被工具声明成 secret，以及账号记录里这些
// 字段的当前值。所以落盘前拿"值"反向扫一遍文本，比猜 token 正则可靠。
//
// 「哪些值算敏感」必须由字段声明说了算，不能按长度猜：按长度会放过 5 位的短信验证码
// （WorkBuddy 正是这种形态），而不设长度门槛又会把 select 的枚举值（"pro"）当成秘密去
// 整串替换，把正常诊断文案洗烂。
export function secretValuesOf(tool, account) {
  const cred = (account && account.cred) || {};
  const keys = ((tool && tool.creds) || []).filter((field) => field.secret).map((field) => field.key);
  return [...new Set(keys.map((key) => cred[key]).filter((value) => typeof value === "string" && value !== ""))];
}

// 一个值可能以原文、URL 编码、base64（含 URL-safe 无填充）三种形态被工具打进 message。
// base64 只在能编码时才算（btoa 对非 Latin1 字符会抛）。
const formsOf = (value) => {
  const forms = new Set([value, encodeURIComponent(value)]);
  try {
    const b64 = btoa(value);
    forms.add(b64);
    forms.add(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  } catch { /* 非 Latin1，跳过 base64 形态 */ }
  return [...forms].filter((form) => form.length > 0);
};

// 熵门槛：不是"长度够就洗"，而是"没信息量的值不洗"。
//
// 为什么要门槛：`secret` 是**字段声明**说了算的，而工具作者会误把枚举值标成 secret
// （套餐档位、模式开关这类）。不设门槛时，值 "pro" 会让 message 里每一次出现
// "pro" 都变成 8 个黑点 —— 诊断文案被洗烂，而那个值本身根本不是秘密。
//
// 判据是"短且像英文单词"，不是"纯字母"：8 位纯字母的密码（abcdefgh）是有信息量的，
// 放过它就等于开一个真实的泄漏口。所以门槛只吃**短**的那些：
//   · 长度 < 4    —— "1" 出现在 "HTTP 401" 里、"ok" 出现在 "status=ok" 里。
//                   洗它等于毁掉诊断信息。真实凭据没有 3 个字符的。
//   · 长度 <= 6 且全是字母 —— 这个长度段的纯字母几乎只有模式名与档位名：
//                   pro / free / team / basic / trial / admin。
//                   7 位往上（abcdefgh）就可能是密码了，重新变成要洗。
// 短信验证码那种「短但含数字」的形态（WorkBuddy 是 5 位）必须照洗：
// 它含数字，不命中第二条；长度够，也不命中第一条。这正是"按长度设门槛"会漏掉的那一类 ——
// 早先的版本靠长度过滤，5 位码整个漏出去过。
const isLowEntropy = (value) => value.length < 4 || (value.length <= 6 && /^[A-Za-z]+$/.test(value));

export function scrubSecrets(text, secretValues) {
  let out = String(text ?? "");
  for (const value of secretValues) {
    const secret = String(value);
    if (isLowEntropy(secret)) continue;
    for (const form of formsOf(secret)) {
      if (out.includes(form)) out = out.split(form).join(maskSecret(value));
    }
  }
  // 只留 JWT 这一条形状兜底：前缀固定，误伤概率低。
  // 之前还有一条"40 字符以上连续 base64"的泛化正则，实测会把合法的长回调地址
  // （/callback/<60 字符 path>/status 这种中间没有点号的连续段）整段吃掉，
  // 而排查"回调没生效"恰恰需要看那串 —— 泛化猜测的收益不抵代价，删掉。
  return out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]{4,}/g, "eyJ••••••••");
}

function metaOf(entry) {
  const secrets = entry.secrets || [];
  return {
    kind: entry.kind, at: entry.at, tool: entry.tool, uid: entry.uid || null,
    // label 是用户自由输入，把票据粘进备注名是很自然的行为，所以它也得过一遍
    label: truncate(scrubSecrets(entry.label || "", secrets), 60) || null,
    status: entry.status,
    message: truncate(scrubSecrets(entry.message, secrets), META_MESSAGE_MAX),
    credits: entry.credits || 0,
    ran: entry.ran, due: entry.due, used: entry.used, limit: entry.limit,
  };
}

// 摘要进 metadata ⇒ 列表页一次 list 就能渲染，不需要逐条 get 正文。
// 正文（步骤明细、预算分解）只在详情页读一次。
export async function writeRunLog(env, { now, tool, account, result, budget, trigger }) {
  const kv = requireKv(env);
  const secrets = secretValuesOf(tool, account);
  const at = now * 1000;
  const meta = metaOf({
    kind: "run", at, tool: tool.id, uid: result.uid, label: result.label,
    status: result.status, message: result.message, credits: result.credits, secrets,
  });
  const body = {
    kind: "run",
    at,
    tool: tool.id,
    toolName: tool.name,
    uid: result.uid,
    label: meta.label,
    trigger,
    status: result.status,
    // 正文留全量（内核已截到 200），metadata 才是给列表用的短摘要
    message: scrubSecrets(result.message, secrets),
    credits: result.credits || 0,
    budget: { used: budget.used, limit: budget.limit, left: budget.left(), over: budget.over },
    // 步骤明细属于账号日志，汇总键里没有
    steps: (result.steps || []).map((s) => ({
      id: s.id, status: s.status, reused: !!s.reused, over: s.over || 0, unreachable: !!s.unreachable,
      message: scrubSecrets(s.message, secrets),
    })),
  };
  await kv.put(runKey(at, tool.id, result.uid), JSON.stringify(body), {
    expirationTtl: LOG_TTL_SEC,
    metadata: meta,
  });
}

// 本轮汇总只留结构与计数，不留任何自由文本：账号级的 message 一旦进这里，
// 就得再洗一遍全文，而"压根不写"比"写了再洗"可靠得多。
// 要看过程去账号级日志，每条 run 键都在。
const leanPlan = (plan) => plan.map((p) => ({
  tool: p.tool,
  skipped: p.skipped || null,
  accounts: (p.accounts || []).map((a) => ({ uid: a.uid, status: a.status, credits: a.credits || 0 })),
}));

export async function writeTickLog(env, { now, trigger, plan, budget, ran }) {
  const kv = requireKv(env);
  const at = now * 1000;
  const body = { kind: "tick", at, trigger, ran, budget: { used: budget.used, limit: budget.limit, over: budget.over }, plan: leanPlan(plan) };
  const meta = metaOf({
    kind: "tick", at, tool: "*", status: ran > 0 ? "ok" : "skipped",
    message: body.plan.map((p) => `${p.tool}：${p.skipped || `${p.accounts.length} 个账号`}`).join("；"),
    ran, due: body.plan.reduce((n, p) => n + p.accounts.length, 0),
    used: budget.used, limit: budget.limit,
  });
  await kv.put(tickKey(at), JSON.stringify(body), {
    expirationTtl: LOG_TTL_SEC,
    metadata: meta,
  });
}

// 每个来源只取一页：键序就是时间倒序，所以每源的头 limit 条已经是该源的最新 limit 条，
// 归并排序后截取就是全局最新 limit 条。成本上界 = 工具数 + 1（汇总键），与日志总量无关。
//
// 代价：从注册表撤掉一个工具，它的历史日志不再出现在「全部」里（30 天自然过期）。
// 全量翻页在这里帮不上忙 —— 翻的是最老的那头。
export async function listRunLog(env, { limit = 20, toolId = null, toolIds = [] } = {}) {
  const kv = requireKv(env);
  const prefixes = (toolId ? [toolId] : toolIds).map((id) => `${RUN_PREFIX}${id}:`);
  if (!toolId) prefixes.push(TICK_PREFIX);
  const merged = [];
  for (const prefix of prefixes) {
    const page = await kv.list({ prefix, limit });
    for (const entry of page.keys) {
      const parts = partsOf(entry.name);
      if (!Number.isFinite(parts.at)) continue;   // 手工塞进 KV 的畸形键不该把整页拖崩
      merged.push({ key: entry.name, ...parts, meta: entry.metadata || null });
    }
  }
  merged.sort((a, b) => b.at - a.at);
  return merged.slice(0, limit);
}

// 只允许读日志键：拿 acct / schedidx / step 前缀来读会把凭据渲到页面上
export async function readRunLog(env, key) {
  const text = String(key ?? "");
  if (!isLogKey(text) || text.includes("..")) return null;
  return getJson(requireKv(env), text, null);
}
