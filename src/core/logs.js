import { getJson, requireKv } from "./store.js";
import { maskSecret, truncate } from "./text.js";

const RUN_PREFIX = "v1:run:";
const TICK_PREFIX = "v1:tick:";
// 请求记录（每一步的上游交互）单独一个前缀、与 runKey **完全同构**：拿到日志键换个前缀
// 就是它的键，不需要在 metadata 里多存一个键名。列表页只 list v1:run: 前缀，天然看不到它。
const TRACE_PREFIX = "v1:trace:";
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
//   （旧版本还写过 v1:tick:<反转毫秒> 的整轮汇总，已停写；键名解析保留到 30 天过渡期结束）
// 工具段放在时间段之前，"按工具筛"才能是一次带前缀的 list（时间在前的话只能扫全量再过滤，
// 而扫全量必然有页数上限，筛得窄的历史就永远读不到）。
const runKey = (ms, toolId, uid) => `${RUN_PREFIX}${toolId}:${revOf(ms)}:${uid}`;
const traceKey = (ms, toolId, uid) => `${TRACE_PREFIX}${toolId}:${revOf(ms)}:${uid}`;

const isLogKey = (key) => String(key).startsWith(RUN_PREFIX) || String(key).startsWith(TICK_PREFIX);
export const isRunKey = (key) => String(key).startsWith(RUN_PREFIX);
const isTraceKey = (key) => String(key).startsWith(TRACE_PREFIX);
// 日志键 → 请求记录键。前缀之外的部分一模一样（工具、反转毫秒、uid），所以直接换前缀。
export const traceKeyOf = (logKey) => TRACE_PREFIX + String(logKey).slice(RUN_PREFIX.length);

// 从键名解析出这一条的身份与时刻：kind / tool / uid / at(ms)。
// 界面上的"这是谁的哪一轮"一律取自键名而不是 metadata —— 键名是我们自己写的、必然正确，
// metadata 只是省子请求的摘要，缺了它这一行也该认得出是谁。
function partsOf(key) {
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
// 它含数字，不命中第二条；长度够，也不命中第一条。这正是"按长度设门槛"会漏掉的那一类。
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
  // 不要加"40 字符以上连续 base64"之类的泛化正则 —— 它会把合法的长回调地址
  // （/callback/<60 字符 path>/status 这种中间没有点号的连续段）整段吃掉，
  // 而排查"回调没生效"恰恰需要看那串。泛化猜测的收益不抵代价。
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
    // 这个数进 metadata（而不是等详情页再读正文）——列表页有这一列，
    // 而列表页只读 metadata。
    http: entry.http || 0,
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
    // 账号级的读数（不是整轮累计）：列表页那一列显示它
    http: result.http,
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
    // 本账号这一轮的外部请求数，与整轮累计的账本快照。
    // 两个都要：前者回答"这条记录花了多少"，后者回答"这次调用总共花了多少"。
    usage: { http: result.http || 0 },
    budget: {
      used: budget.used, limit: budget.limit,
      left: budget.left(), over: budget.over,
    },
    // 步骤明细属于账号日志，汇总键里没有
    steps: (result.steps || []).map((s) => ({
      id: s.id, status: s.status, reused: !!s.reused, over: s.over || 0, unreachable: !!s.unreachable,
      message: scrubSecrets(s.message, secrets),
      // 这一步真实发生的上游交互次数。详情页「看请求 (N)」的 N 就是它：
      // 放在正文里，详情页不用为它多读一个键；列表页不读正文，成本不变。
      calls: s.calls || 0,
    })),
  };
  await kv.put(runKey(at, tool.id, result.uid), JSON.stringify(body), {
    expirationTtl: LOG_TTL_SEC,
    metadata: meta,
  });
}

// 每个来源只取一页：键序就是时间倒序，所以每源的头 limit 条已经是该源的最新 limit 条，
// 归并排序后截取就是全局最新 limit 条。成本上界 = 工具数（旧版本的 v1:tick: 汇总键
// 在 30 天过渡期内还会多一页，过期后自动消失），与日志总量无关。
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

// 请求记录：每一步的上游交互（请求原文 + 响应原文）。
//
// **独立键**，理由见 TRACE_PREFIX 那段：原始 JSON 一旦塞进 run 键的正文/metadata，
// 列表页（只读 metadata）与详情页都要为它付体积，而它只在"要深入排查"时才被打开。
//
// 落在这一步做脱敏，与 writeRunLog 同一个出口 —— 而**结构与字段一个不动**，
// 只把"值里出现过的凭据串"替换掉（请求头的掩码在 trace.js 里已经做过）。
// 逐字段洗而不是整串 JSON 洗：整串洗时，凭据里只要有一个引号就会把外层 JSON 拆坏。
//
// 即使一次请求都没有也写：这样页面上能区分"这次运行真的没打上游"与"记录不存在"，
// 两者是完全不同的结论。
export async function writeTrace(env, { at, tool, account, uid, trigger, steps, trace }) {
  if (!trace || !Array.isArray(steps)) return null;
  const secrets = secretValuesOf(tool, account);
  const payload = {
    kind: "trace",
    at,
    tool: tool.id,
    toolName: tool.name,
    uid,
    trigger,
    // 超出总量上限、没记下来的交互数。必须报出来，否则"看起来是完整的"就是假象。
    dropped: trace.dropped || 0,
    steps: steps.map((step) => ({
      id: step.id,
      status: step.status,
      reused: !!step.reused,
      calls: trace.callsOf(step.id).map((call) => {
        const out = { ...call };
        for (const field of ["reqBody", "resBody", "bodyError"]) {
          if (typeof out[field] === "string") out[field] = scrubSecrets(out[field], secrets);
        }
        return out;
      }),
    })),
  };
  const key = traceKey(at, tool.id, uid);
  await requireKv(env).put(key, JSON.stringify(payload), { expirationTtl: LOG_TTL_SEC });
  return key;
}

// 只允许读请求记录键：与 readRunLog 同理，拿 acct / step 前缀来读会把凭据渲到页面上
export async function readTrace(env, key) {
  const text = String(key ?? "");
  if (!isTraceKey(text) || text.includes("..")) return null;
  return getJson(requireKv(env), text, null);
}

// 清空某个工具的运行日志。返回 { deleted, traces, more }。
//
// 范围必须按工具前缀圈定，不能扫全库再删"看起来像日志"的键：
// 全库扫要翻到页数上限（KV 每页 1000 键），而日志分布在 30 天里、条数无上界，
// 扫不全就等于"删了一部分却说是全清"。按前缀 list 是完整的。
//
// toolId 必填且必须来自注册表（router 已校验）——不接受"清空全部"，
// 那是一个会误伤全库的操作，不该由一个筛选按钮提供。
//
// more=true 表示这个预算里删不完，需要用户再点一次。KV 没有批量删除，
// 每条日志一次 delete —— 而 delete 走 KV 自己的额度（每天 1000 次），
// 不占外部请求那 50，所以这个上界比"50 个子请求"宽松得多。
// 但一次调用里删太多会让这一轮跑很久，所以仍要设个上界，
// 并且**必须如实报剩余**：假装一次能清完 8000 条，结果就是界面说"已清空"而库里还剩几千条。
export const CLEAR_BUDGET = 28;   // 每轮最多 2 次 list + 28 次 delete，留出收尾写入的余量
export async function clearRunLog(env, toolId) {
  const kv = requireKv(env);
  // 日志与请求记录**一起清**：留着请求记录的孤儿键会让"清空"名不副实，
  // 而它们 30 天后才会自己过期。两者按前缀各圈一段，删除量合并计。
  const prefixes = [`${RUN_PREFIX}${toolId}:`, `${TRACE_PREFIX}${toolId}:`];
  let deleted = 0;
  let traces = 0;
  // KV 是最终一致性的：delete 之后立即 list，已删的键可能还在结果里。
  // 不记已删的键名就会重复计数——界面上只有 1 条却报"删了 14 条"。
  // Set 只在本次调用内有效，不会跨请求残留。
  const seen = new Set();
  // 每轮都从头 list：键在减少，下一次拿到的就是还没删的那批。
  // 用游标翻页是错的 —— 刚删掉的键会让 cursor 指向的位置失效。
  while (deleted + traces < CLEAR_BUDGET) {
    const batch = [];
    for (const prefix of prefixes) {
      const page = await kv.list({ prefix, limit: CLEAR_BUDGET });
      for (const entry of page.keys || []) {
        const name = entry.name;
        if (seen.has(name)) continue;               // 上一轮已删（KV 还没传播），跳过
        if (isLogKey(name) || isTraceKey(name)) batch.push(name);
      }
    }
    if (batch.length === 0) return { deleted, traces, more: false };
    for (const key of batch) {
      if (deleted + traces >= CLEAR_BUDGET) return { deleted, traces, more: true };
      seen.add(key);
      await kv.delete(key);
      if (isTraceKey(key)) traces += 1; else deleted += 1;
    }
  }
  // 预算正好用完：再各 list 一次确认还有没有剩的（这两次只花 2 个子请求）。
  // 这里也要跳过 seen：否则刚删的键还没传播，会误判 more=true。
  let more = false;
  for (const prefix of prefixes) {
    const rest = await kv.list({ prefix, limit: 1 });
    for (const entry of rest.keys || []) {
      if (!seen.has(entry.name)) { more = true; break; }
    }
    if (more) break;
  }
  return { deleted, traces, more };
}
