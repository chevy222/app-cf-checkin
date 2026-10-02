var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/core/text.js
var encoder = new TextEncoder();
var HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}
__name(escapeHtml, "escapeHtml");
function safeEqual(a, b) {
  const left = encoder.encode(String(a ?? ""));
  const right = encoder.encode(String(b ?? ""));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}
__name(safeEqual, "safeEqual");
function maskSecret(value) {
  const text = String(value ?? "");
  if (text.length === 0) return "";
  if (text.length <= 12) return "\u2022".repeat(8);
  return `${text.slice(0, 4)}${"\u2022".repeat(8)}${text.slice(-4)}`;
}
__name(maskSecret, "maskSecret");
function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\u2026` : text;
}
__name(truncate, "truncate");

// src/core/gateway.js
var MAX_BODY = 64 * 1024;
var FORM_TYPE = "application/x-www-form-urlencoded";
async function readForm(request) {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith(FORM_TYPE)) return null;
  const rawLength = request.headers.get("content-length");
  if (rawLength === null) return null;
  const length = Number(rawLength);
  if (!Number.isFinite(length) || length > MAX_BODY) return null;
  const text = await request.text();
  return text.length > MAX_BODY ? null : new URLSearchParams(text);
}
__name(readForm, "readForm");
async function authenticate(request, url, env) {
  const expected = env && typeof env.PASSWORD === "string" ? env.PASSWORD : "";
  if (expected === "") return { verdict: "unconfigured", pwd: "", form: null };
  const isPost = request.method.toUpperCase() === "POST";
  const form = isPost ? await readForm(request) : null;
  if (isPost && form === null) return { verdict: "bad_body", pwd: "", form: null };
  const candidates = [];
  const fromQuery = url.searchParams.get("pwd");
  if (fromQuery) candidates.push(fromQuery);
  const fromHeader = request.headers.get("x-pwd");
  if (fromHeader) candidates.push(fromHeader);
  const fromForm = form && form.get("pwd");
  if (fromForm) candidates.push(fromForm);
  const winner = candidates.find((candidate) => safeEqual(candidate, expected));
  if (!winner) return { verdict: "reject", pwd: "", form: null };
  return { verdict: "ok", pwd: winner, form };
}
__name(authenticate, "authenticate");

// src/core/http.js
var SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  // 界面零 JavaScript：default-src 'none' 顺带禁掉脚本，样式必须内联所以放开 unsafe-inline
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
function htmlRes(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS }
  });
}
__name(htmlRes, "htmlRes");
function jsonRes(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS }
  });
}
__name(jsonRes, "jsonRes");
function redirectRes(location) {
  return new Response(null, {
    status: 303,
    headers: { location, ...SECURITY_HEADERS }
  });
}
__name(redirectRes, "redirectRes");

// src/core/store.js
var SCHEMA = "v1";
var kvOf = /* @__PURE__ */ __name((env) => env && env.CHECKIN_KV || null, "kvOf");
function requireKv(env) {
  const kv = kvOf(env);
  if (!kv) throw new Error("\u7F3A\u5C11 KV \u7ED1\u5B9A\uFF1ACHECKIN_KV");
  return kv;
}
__name(requireKv, "requireKv");
var acctKey = /* @__PURE__ */ __name((tool, uid) => `${SCHEMA}:acct:${tool}:${uid}`, "acctKey");
var acctPrefix = /* @__PURE__ */ __name((tool) => `${SCHEMA}:acct:${tool}:`, "acctPrefix");
var toolKey = /* @__PURE__ */ __name((tool) => `${SCHEMA}:tool:${tool}`, "toolKey");
var schedIdxKey = /* @__PURE__ */ __name((tool) => `${SCHEMA}:schedidx:${tool}`, "schedIdxKey");
var stepKey = /* @__PURE__ */ __name((tool, uid) => `${SCHEMA}:step:${tool}:${uid}`, "stepKey");
var lockKey = /* @__PURE__ */ __name((tool, uid) => `${SCHEMA}:lock:${tool}:${uid}`, "lockKey");
var flagsKey = /* @__PURE__ */ __name(() => `${SCHEMA}:flags`, "flagsKey");
async function getJson(kv, key, fallback) {
  const raw = await kv.get(key);
  if (raw === null || raw === void 0) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
__name(getJson, "getJson");
function putJson(kv, key, value) {
  return kv.put(key, JSON.stringify(value));
}
__name(putJson, "putJson");
async function listUids(kv, tool) {
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
__name(listUids, "listUids");

// src/core/time.js
var CST_OFFSET = 8 * 3600;
var nowSec = /* @__PURE__ */ __name(() => Math.floor(Date.now() / 1e3), "nowSec");
function cstDate(sec) {
  return new Date((sec + CST_OFFSET) * 1e3).toISOString().slice(0, 10);
}
__name(cstDate, "cstDate");
function fmtCST(sec) {
  if (!Number.isFinite(sec)) return "\u2014";
  return new Date((sec + CST_OFFSET) * 1e3).toISOString().replace("T", " ").slice(0, 16);
}
__name(fmtCST, "fmtCST");
function fmtCSTSec(sec) {
  if (!Number.isFinite(sec)) return "\u2014";
  return new Date((sec + CST_OFFSET) * 1e3).toISOString().replace("T", " ").slice(0, 19);
}
__name(fmtCSTSec, "fmtCSTSec");
function logicalDay(resetHour, sec) {
  return cstDate(sec - (Number(resetHour) || 0) * 3600);
}
__name(logicalDay, "logicalDay");
function parseWindowEnd(value) {
  if (!value || typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
__name(parseWindowEnd, "parseWindowEnd");

// src/core/accounts.js
var MAX_FIELD_LEN = 8192;
var MAX_UID_LEN = 64;
var MAX_LABEL_LEN = 60;
function sanitizeUid(raw) {
  return String(raw ?? "").trim().slice(0, MAX_UID_LEN).replace(/[^A-Za-z0-9._-]/g, "");
}
__name(sanitizeUid, "sanitizeUid");
function coerceFields(fields, form, { editing = false } = {}) {
  const values = {};
  const errors = {};
  for (const field of fields) {
    const label = field.label || field.key;
    if (field.readonly) continue;
    const raw = String(form.get(field.key) ?? "").trim();
    if (field.type === "select") {
      if (raw === "") {
        if (editing) continue;
        if (field.default !== void 0) values[field.key] = String(field.default);
        else if (field.required) errors[field.key] = `\u300C${label}\u300D\u662F\u5FC5\u9009\u9879`;
        continue;
      }
      const allowed = (field.options || []).map((opt) => String(typeof opt === "object" ? opt.value : opt));
      if (allowed.includes(raw)) values[field.key] = raw;
      else errors[field.key] = `\u300C${label}\u300D\u7684\u503C\u4E0D\u5728\u5141\u8BB8\u8303\u56F4\u5185`;
      continue;
    }
    if (raw.length > MAX_FIELD_LEN) {
      errors[field.key] = `\u300C${label}\u300D\u8D85\u8FC7 ${MAX_FIELD_LEN} \u5B57\u7B26\u4E0A\u9650`;
      continue;
    }
    if (raw === "") {
      if (editing && !field.required && !field.secret) values[field.key] = "";
      else if (field.default !== void 0) values[field.key] = String(field.default);
      else if (field.required && !(editing && field.secret)) errors[field.key] = `\u300C${label}\u300D\u662F\u5FC5\u586B\u9879`;
      continue;
    }
    if (field.pattern && !new RegExp(field.pattern).test(raw)) {
      errors[field.key] = field.patternMessage || `\u300C${label}\u300D\u683C\u5F0F\u4E0D\u5BF9`;
      continue;
    }
    values[field.key] = raw;
  }
  return { values, errors };
}
__name(coerceFields, "coerceFields");
var wellFormed = /* @__PURE__ */ __name((rec) => !!rec && typeof rec === "object" && !!rec.cred && typeof rec.cred === "object", "wellFormed");
var ACCOUNT_LIST_CAP = 20;
async function listAccounts(env, toolId, cap = ACCOUNT_LIST_CAP) {
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
__name(listAccounts, "listAccounts");
async function countAccounts(env, toolId) {
  return (await listUids(requireKv(env), toolId)).length;
}
__name(countAccounts, "countAccounts");
async function applyCredPatch(env, tool, uid, patch) {
  const allowed = new Set((tool.creds || []).map((field) => field.key));
  const changes = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (allowed.has(key) && typeof value === "string" && value !== "") changes[key] = value;
  }
  if (Object.keys(changes).length === 0) return null;
  const kv = requireKv(env);
  const fresh = await getJson(kv, acctKey(tool.id, uid), null);
  if (!wellFormed(fresh)) return null;
  const next = { ...fresh, cred: { ...fresh.cred, ...changes }, updatedAt: nowSec() };
  await putJson(kv, acctKey(tool.id, uid), next);
  return { uid, ...next };
}
__name(applyCredPatch, "applyCredPatch");
async function getAccount(env, toolId, uid) {
  const kv = requireKv(env);
  const rec = await getJson(kv, acctKey(toolId, uid), null);
  return wellFormed(rec) ? { uid, ...rec } : null;
}
__name(getAccount, "getAccount");
async function saveAccount(env, toolId, { uid, values, label, existing }) {
  const safeUid = sanitizeUid(uid);
  if (!safeUid) throw new Error("saveAccount \u9700\u8981\u975E\u7A7A uid");
  const kv = requireKv(env);
  const record = {
    label: String(label ?? "").trim().slice(0, MAX_LABEL_LEN) || null,
    cred: { ...existing && existing.cred ? existing.cred : {}, ...values },
    createdAt: existing && existing.createdAt ? existing.createdAt : nowSec(),
    updatedAt: nowSec()
  };
  await putJson(kv, acctKey(toolId, safeUid), record);
  return record;
}
__name(saveAccount, "saveAccount");
async function deleteAccount(env, toolId, uid) {
  const kv = requireKv(env);
  await kv.delete(acctKey(toolId, uid));
  const index = await loadSchedIndex(env, toolId);
  if (index.entries[uid]) {
    delete index.entries[uid];
    await putJson(kv, schedIdxKey(toolId), index);
  }
}
__name(deleteAccount, "deleteAccount");
var SCHED_FIELDS = ["lastStatus", "lastStatusDate", "lastAt", "attempts", "attemptsDate", "retryAt", "rateStrikes", "resumable", "lastSteps"];
var SCHED_DEFAULTS = {
  lastStatus: null,
  lastStatusDate: null,
  lastAt: 0,
  attempts: 0,
  attemptsDate: null,
  retryAt: 0,
  rateStrikes: 0,
  resumable: false,
  lastSteps: []
};
function schedOf(entry) {
  const out = { ...SCHED_DEFAULTS };
  const src = entry || {};
  for (const key of SCHED_FIELDS) if (src[key] !== void 0) out[key] = src[key];
  return out;
}
__name(schedOf, "schedOf");
async function loadSchedIndex(env, toolId) {
  const saved = await getJson(requireKv(env), schedIdxKey(toolId), null);
  const entries = saved && typeof saved === "object" && saved.entries && typeof saved.entries === "object" ? saved.entries : {};
  return { day: saved && saved.day || null, entries };
}
__name(loadSchedIndex, "loadSchedIndex");
async function commitSchedEntries(env, toolId, entries) {
  const changed = Object.entries(entries || {});
  if (changed.length === 0) return;
  const kv = requireKv(env);
  const fresh = await loadSchedIndex(env, toolId);
  for (const [uid, entry] of changed) fresh.entries[uid] = entry;
  await putJson(kv, schedIdxKey(toolId), fresh);
}
__name(commitSchedEntries, "commitSchedEntries");

// src/core/flags.js
async function loadFlags(env) {
  const saved = await getJson(requireKv(env), flagsKey(), null);
  return saved && typeof saved === "object" ? saved : {};
}
__name(loadFlags, "loadFlags");
var isOff = /* @__PURE__ */ __name((flags, toolId) => !!(flags && flags[toolId] && flags[toolId].off), "isOff");
async function setToolOff(env, toolId, off) {
  const kv = requireKv(env);
  const current = await loadFlags(env);
  await putJson(kv, flagsKey(), { ...current, [toolId]: { off: !!off, at: nowSec() } });
  return !!off;
}
__name(setToolOff, "setToolOff");

// src/core/logs.js
var RUN_PREFIX = "v1:run:";
var TICK_PREFIX = "v1:tick:";
var TRACE_PREFIX = "v1:trace:";
var LOG_TTL_DAYS = 30;
var LOG_TTL_SEC = LOG_TTL_DAYS * 86400;
var META_MESSAGE_MAX = 180;
var REV_BASE = 1e13;
var revOf = /* @__PURE__ */ __name((ms) => String(REV_BASE - Number(ms)).padStart(13, "0"), "revOf");
var runKey = /* @__PURE__ */ __name((ms, toolId, uid) => `${RUN_PREFIX}${toolId}:${revOf(ms)}:${uid}`, "runKey");
var traceKey = /* @__PURE__ */ __name((ms, toolId, uid) => `${TRACE_PREFIX}${toolId}:${revOf(ms)}:${uid}`, "traceKey");
var isLogKey = /* @__PURE__ */ __name((key) => String(key).startsWith(RUN_PREFIX) || String(key).startsWith(TICK_PREFIX), "isLogKey");
var isRunKey = /* @__PURE__ */ __name((key) => String(key).startsWith(RUN_PREFIX), "isRunKey");
var isTraceKey = /* @__PURE__ */ __name((key) => String(key).startsWith(TRACE_PREFIX), "isTraceKey");
var traceKeyOf = /* @__PURE__ */ __name((logKey) => TRACE_PREFIX + String(logKey).slice(RUN_PREFIX.length), "traceKeyOf");
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
__name(partsOf, "partsOf");
function secretValuesOf(tool, account) {
  const cred = account && account.cred || {};
  const keys = (tool && tool.creds || []).filter((field) => field.secret).map((field) => field.key);
  return [...new Set(keys.map((key) => cred[key]).filter((value) => typeof value === "string" && value !== ""))];
}
__name(secretValuesOf, "secretValuesOf");
var formsOf = /* @__PURE__ */ __name((value) => {
  const forms = /* @__PURE__ */ new Set([value, encodeURIComponent(value)]);
  try {
    const b64 = btoa(value);
    forms.add(b64);
    forms.add(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  } catch {
  }
  return [...forms].filter((form) => form.length > 0);
}, "formsOf");
var isLowEntropy = /* @__PURE__ */ __name((value) => value.length < 4 || value.length <= 6 && /^[A-Za-z]+$/.test(value), "isLowEntropy");
function scrubSecrets(text, secretValues) {
  let out = String(text ?? "");
  for (const value of secretValues) {
    const secret = String(value);
    if (isLowEntropy(secret)) continue;
    for (const form of formsOf(secret)) {
      if (out.includes(form)) out = out.split(form).join(maskSecret(value));
    }
  }
  return out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]{4,}/g, "eyJ\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022");
}
__name(scrubSecrets, "scrubSecrets");
function metaOf(entry) {
  const secrets = entry.secrets || [];
  return {
    kind: entry.kind,
    at: entry.at,
    tool: entry.tool,
    uid: entry.uid || null,
    // label 是用户自由输入，把票据粘进备注名是很自然的行为，所以它也得过一遍
    label: truncate(scrubSecrets(entry.label || "", secrets), 60) || null,
    status: entry.status,
    message: truncate(scrubSecrets(entry.message, secrets), META_MESSAGE_MAX),
    credits: entry.credits || 0,
    // 这个数进 metadata（而不是等详情页再读正文）——列表页有这一列，
    // 而列表页只读 metadata。
    http: entry.http || 0
  };
}
__name(metaOf, "metaOf");
async function writeRunLog(env, { now, tool, account, result, budget, trigger }) {
  const kv = requireKv(env);
  const secrets = secretValuesOf(tool, account);
  const at = now * 1e3;
  const meta = metaOf({
    kind: "run",
    at,
    tool: tool.id,
    uid: result.uid,
    label: result.label,
    status: result.status,
    message: result.message,
    credits: result.credits,
    secrets,
    // 账号级的读数（不是整轮累计）：列表页那一列显示它
    http: result.http
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
      used: budget.used,
      limit: budget.limit,
      left: budget.left(),
      over: budget.over
    },
    // 步骤明细属于账号日志，汇总键里没有
    steps: (result.steps || []).map((s) => ({
      id: s.id,
      status: s.status,
      reused: !!s.reused,
      over: s.over || 0,
      unreachable: !!s.unreachable,
      message: scrubSecrets(s.message, secrets),
      // 这一步真实发生的上游交互次数。详情页「看请求 (N)」的 N 就是它：
      // 放在正文里，详情页不用为它多读一个键；列表页不读正文，成本不变。
      calls: s.calls || 0
    }))
  };
  await kv.put(runKey(at, tool.id, result.uid), JSON.stringify(body), {
    expirationTtl: LOG_TTL_SEC,
    metadata: meta
  });
}
__name(writeRunLog, "writeRunLog");
async function listRunLog(env, { limit = 20, toolId = null, toolIds = [] } = {}) {
  const kv = requireKv(env);
  const prefixes = (toolId ? [toolId] : toolIds).map((id) => `${RUN_PREFIX}${id}:`);
  if (!toolId) prefixes.push(TICK_PREFIX);
  const merged = [];
  for (const prefix of prefixes) {
    const page = await kv.list({ prefix, limit });
    for (const entry of page.keys) {
      const parts = partsOf(entry.name);
      if (!Number.isFinite(parts.at)) continue;
      merged.push({ key: entry.name, ...parts, meta: entry.metadata || null });
    }
  }
  merged.sort((a, b) => b.at - a.at);
  return merged.slice(0, limit);
}
__name(listRunLog, "listRunLog");
async function readRunLog(env, key) {
  const text = String(key ?? "");
  if (!isLogKey(text) || text.includes("..")) return null;
  return getJson(requireKv(env), text, null);
}
__name(readRunLog, "readRunLog");
async function writeTrace(env, { at, tool, account, uid, trigger, steps, trace }) {
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
    steps: steps.map((step2) => ({
      id: step2.id,
      status: step2.status,
      reused: !!step2.reused,
      calls: trace.callsOf(step2.id).map((call4) => {
        const out = { ...call4 };
        for (const field of ["reqBody", "resBody", "bodyError"]) {
          if (typeof out[field] === "string") out[field] = scrubSecrets(out[field], secrets);
        }
        return out;
      })
    }))
  };
  const key = traceKey(at, tool.id, uid);
  await requireKv(env).put(key, JSON.stringify(payload), { expirationTtl: LOG_TTL_SEC });
  return key;
}
__name(writeTrace, "writeTrace");
async function readTrace(env, key) {
  const text = String(key ?? "");
  if (!isTraceKey(text) || text.includes("..")) return null;
  return getJson(requireKv(env), text, null);
}
__name(readTrace, "readTrace");
var CLEAR_BUDGET = 28;
async function clearRunLog(env, toolId) {
  const kv = requireKv(env);
  const prefixes = [`${RUN_PREFIX}${toolId}:`, `${TRACE_PREFIX}${toolId}:`];
  let deleted = 0;
  let traces = 0;
  while (deleted + traces < CLEAR_BUDGET) {
    const batch = [];
    for (const prefix of prefixes) {
      const page = await kv.list({ prefix, limit: CLEAR_BUDGET });
      for (const entry of page.keys || []) {
        if (isLogKey(entry.name) || isTraceKey(entry.name)) batch.push(entry.name);
      }
    }
    if (batch.length === 0) return { deleted, traces, more: false };
    for (const key of batch) {
      if (deleted + traces >= CLEAR_BUDGET) return { deleted, traces, more: true };
      await kv.delete(key);
      if (isTraceKey(key)) traces += 1;
      else deleted += 1;
    }
  }
  let more = false;
  for (const prefix of prefixes) {
    const rest = await kv.list({ prefix, limit: 1 });
    if ((rest.keys || []).length > 0) more = true;
  }
  return { deleted, traces, more };
}
__name(clearRunLog, "clearRunLog");

// src/core/trace.js
var TRACE_BODY_MAX = 32 * 1024;
var TRACE_TOTAL_MAX = 128 * 1024;
var SAFE_REQ_HEADERS = /* @__PURE__ */ new Set(["content-type", "referer", "origin", "user-agent", "accept"]);
function maskHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = String(name).toLowerCase();
    if (lower === "authorization") {
      const scheme = String(value).split(/\s+/)[0] || "";
      out[name] = scheme ? `${scheme} ***` : "***";
    } else if (lower === "cookie") {
      out[name] = "***";
    } else if (SAFE_REQ_HEADERS.has(lower)) {
      out[name] = String(value);
    }
  }
  return out;
}
__name(maskHeaders, "maskHeaders");
function capText(value) {
  const text = value === void 0 || value === null ? "" : String(value);
  if (text.length <= TRACE_BODY_MAX) return { text, truncated: null };
  return { text: text.slice(0, TRACE_BODY_MAX), truncated: { kept: TRACE_BODY_MAX, total: text.length } };
}
__name(capText, "capText");
function makeTrace() {
  const steps = [];
  let current = null;
  let used = 0;
  let dropped = 0;
  return {
    // **每一步都调一次**，包括复用与顺延的 —— 这样"这一步为什么没有请求"在页面上看得出来，
    // 而不是整行凭空消失（那正是最容易让人以为没跑的一类静默）。
    enter(id) {
      current = { id, calls: [] };
      steps.push(current);
    },
    callsOf(id) {
      const step2 = steps.find((s) => s.id === id);
      return step2 ? step2.calls : [];
    },
    // 超出总量上限、被丢掉的那几次交互。掉了几次要报出来，否则"记录看起来是完整的"。
    get dropped() {
      return dropped;
    },
    record({ method, url, headers, reqBody, status, ms, resBody, bodyError }) {
      if (!current) return;
      if (used >= TRACE_TOTAL_MAX) {
        dropped += 1;
        return;
      }
      const req = capText(reqBody);
      const res = capText(resBody);
      used += req.text.length + res.text.length;
      const call4 = {
        n: current.calls.length + 1,
        method,
        url,
        reqHeaders: maskHeaders(headers),
        status,
        ms
      };
      if (reqBody !== void 0 && reqBody !== null) {
        call4.reqBody = req.text;
        if (req.truncated) call4.reqTruncated = req.truncated;
      }
      if (bodyError) {
        call4.bodyError = bodyError;
      } else {
        call4.resBody = res.text;
        if (res.truncated) call4.resTruncated = res.truncated;
      }
      current.calls.push(call4);
    }
  };
}
__name(makeTrace, "makeTrace");
async function recordExchange(trace, { url, method, headers, body, response, ms }) {
  const reqBody = typeof body === "string" ? body : body === void 0 || body === null ? void 0 : `\uFF08\u975E\u6587\u672C\u8BF7\u6C42\u4F53\uFF1A${typeof body}\uFF09`;
  try {
    const text = await response.clone().text();
    trace.record({ method, url: url.href, headers, reqBody, status: response.status, ms, resBody: text });
  } catch (error) {
    trace.record({
      method,
      url: url.href,
      headers,
      reqBody,
      status: response.status,
      ms,
      bodyError: String(error && error.message || error)
    });
  }
}
__name(recordExchange, "recordExchange");

// src/core/budget.js
var DEFAULT_LIMIT = 50;
function budgetFrom(env) {
  const configured = Number(env && env.BUDGET_SUBREQUESTS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LIMIT;
}
__name(budgetFrom, "budgetFrom");
function makeBudget(limit) {
  const state = { used: 0, over: 0 };
  return {
    limit,
    // 外部 HTTP 次数（参与 fits 闸门）
    get used() {
      return state.used;
    },
    // 实际超出自设上限多少（步骤 cost 估偏低时才会发生），供上层报警
    get over() {
      return state.over;
    },
    left() {
      return limit - state.used;
    },
    // 开工前的判定：这一笔加进去还装得下吗
    fits(n) {
      return state.used + n <= limit;
    },
    charge(n = 1) {
      state.used += n;
      if (state.used > limit) state.over = state.used - limit;
      return state.used <= limit;
    }
  };
}
__name(makeBudget, "makeBudget");
function trackedFetch(budget, hosts, trace = null) {
  const allowed = hosts && hosts.length ? new Set(hosts) : null;
  return /* @__PURE__ */ __name(async function fetchTracked(input, init) {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (!allowed) throw new Error("\u8BE5\u5DE5\u5177\u7684\u51FA\u53E3\u767D\u540D\u5355\u662F\u7A7A\u7684\uFF0C\u5DF2\u62D2\u7EDD\u4E00\u5207\u51FA\u7AD9\u8BF7\u6C42");
    if (!allowed.has(url.hostname)) {
      throw new Error(`\u7981\u6B62\u7684\u8BF7\u6C42\u57DF\u540D ${url.hostname}\uFF08\u8BE5\u5DE5\u5177\u53EA\u5141\u8BB8 ${[...allowed].join(", ")}\uFF09`);
    }
    if (!budget.fits(1)) throw new Error("\u672C\u8F6E\u5916\u90E8\u8BF7\u6C42\u989D\u5EA6\u5DF2\u7528\u5C3D\uFF0C\u505C\u6B62\u53D1\u8D77\u8BF7\u6C42");
    budget.charge(1);
    const startedAt = Date.now();
    const response = await fetch(input, init);
    if (trace) {
      await recordExchange(trace, {
        url,
        method: init && init.method || "GET",
        headers: init && init.headers,
        body: init && init.body,
        response,
        ms: Date.now() - startedAt
      });
    }
    return response;
  }, "fetchTracked");
}
__name(trackedFetch, "trackedFetch");

// src/core/jwt.js
function readJwtClaims(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const payload = decodeSegment(parts[1]);
  if (!payload) return null;
  try {
    const claims = JSON.parse(payload);
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}
__name(readJwtClaims, "readJwtClaims");
function decodeSegment(segment) {
  const aligned = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = aligned + "=".repeat((4 - aligned.length % 4) % 4);
  try {
    const binary = atob(padded);
    return new TextDecoder("utf-8").decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}
__name(decodeSegment, "decodeSegment");
function subjectOf(token) {
  const claims = readJwtClaims(token);
  if (!claims) return "";
  const candidate = [claims.sub, claims.uid, claims.user_id, claims.userId, claims.id].find((value) => value !== void 0 && value !== null && String(value).trim() !== "");
  return candidate === void 0 ? "" : String(candidate).trim();
}
__name(subjectOf, "subjectOf");
function expiresAtOf(token) {
  const claims = readJwtClaims(token);
  const exp = Number(claims && claims.exp);
  return Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : 0;
}
__name(expiresAtOf, "expiresAtOf");

// src/tools/qoder/api.js
var HOST = "openapi.qoder.com.cn";
var BASE = `https://${HOST}`;
var CAMPAIGNS = "/sash/api/v1/me/campaigns";
var REFRESH = "/api/v1/deviceToken/refresh";
var USER_AGENT = "Qoder/claim";
var timeoutMs = /* @__PURE__ */ __name((config) => {
  const raw = Number(config.timeoutMs);
  return Number.isFinite(raw) && raw > 0 ? raw : 3e4;
}, "timeoutMs");
function deviceHeaders(config) {
  const headers = { "Cosy-ClientType": String(config.clientType || "10") };
  const map = {
    "Cosy-MachineToken": config.machineToken,
    "Cosy-MachineCode": config.machineCode,
    "Cosy-MachineType": config.machineType,
    "Cosy-MachineOS": config.machineOS || "x86_64_windows",
    "Cosy-MachineHostname": config.machineHostname || "pc",
    "Cosy-MachineId": config.machineId,
    "Cosy-Version": config.version
  };
  for (const [name, value] of Object.entries(map)) if (value) headers[name] = String(value);
  return headers;
}
__name(deviceHeaders, "deviceHeaders");
async function call(ctx, { path, method = "GET", body, token }) {
  const headers = { Accept: "application/json", "User-Agent": USER_AGENT, ...deviceHeaders(ctx.config) };
  if (body !== void 0) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await ctx.fetch(BASE + path, {
    method,
    headers,
    body: body === void 0 ? void 0 : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs(ctx.config))
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
  }
  return { status: response.status, payload, text };
}
__name(call, "call");
var unwrap = /* @__PURE__ */ __name((payload) => payload && typeof payload === "object" && "data" in payload ? payload.data : payload, "unwrap");
async function refreshToken(ctx) {
  const result = await call(ctx, { path: REFRESH, method: "POST", body: { refresh_token: ctx.account.cred.refreshToken } });
  const data = unwrap(result.payload);
  const token = data && (data.token || data.accessToken || data.access_token);
  if (result.status !== 200 || !token) return null;
  return {
    accessToken: String(token),
    // 上游可能不发新串；发空串当没发处理（否则空串写回 KV，下一轮必然认证失败）
    refreshToken: String(data && (data.refreshToken || data.refresh_token) || ctx.account.cred.refreshToken)
    // 不返回 expiresAt：这家续期靠上游的 401 触发，不做"提前 N 天主动换票"，
    // 所以本地到期时间没有决策价值；而 dt-- 形态的令牌解不出 exp，猜一个日期只会误导。
    // creds 里也没声明它，写回时会被内核按白名单拒掉。
  };
}
__name(refreshToken, "refreshToken");
async function authorized(ctx, { path, method = "GET", body }) {
  const token = ctx.account.cred.accessToken;
  let result = await call(ctx, { path, method, body, token });
  if (result.status !== 401 && result.status !== 403) return { result };
  const rotated = await refreshToken(ctx);
  if (!rotated) return { result, authFailed: true };
  Object.assign(ctx.account.cred, rotated);
  result = await call(ctx, { path, method, body, token: rotated.accessToken });
  if (result.status === 401 || result.status === 403) return { result, authFailed: true, rotated };
  return { result, rotated };
}
__name(authorized, "authorized");
async function readCampaigns(ctx) {
  const { result, authFailed, rotated } = await authorized(ctx, { path: CAMPAIGNS });
  if (authFailed) {
    return { loginRequired: true, message: `\u767B\u5F55\u6001\u5931\u6548\uFF08HTTP ${result.status}\uFF09\uFF0C\u7EED\u671F\u540E\u4ECD\u88AB\u62D2\uFF0C\u9700\u8981\u91CD\u65B0\u5F55\u5165\u51ED\u636E`, rotated: rotated || null };
  }
  if (result.status !== 200) {
    return { error: `\u6D3B\u52A8\u5217\u8868\u67E5\u8BE2\u5931\u8D25\uFF1AHTTP ${result.status} ${truncate(result.text, 120)}`, rotated: rotated || null };
  }
  const payload = result.payload;
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.campaigns)) {
    return { error: "\u6D3B\u52A8\u5217\u8868\u54CD\u5E94\u7ED3\u6784\u5F02\u5E38\uFF08\u6CA1\u6709 campaigns \u6570\u7EC4\uFF09", rotated: rotated || null };
  }
  const benefits = payload.campaigns.filter((c) => c && c.actionType === "CLAIM_BENEFIT");
  const claimable = benefits.filter((c) => c.claimStatus === "CLAIMABLE");
  const now = ctx.now;
  const within = /* @__PURE__ */ __name((c) => (c.startAt ? Number(c.startAt) : 0) <= now && (c.endAt ? now < Number(c.endAt) : true), "within");
  const claimedToday = benefits.filter((c) => c.claimStatus === "CLAIMED" && within(c));
  const pendingList = benefits.filter((c) => c.claimStatus !== "CLAIMABLE" && c.claimStatus !== "CLAIMED");
  return {
    claimable: claimable.filter(within),
    claimedToday,
    pendingList,
    total: payload.campaigns.length,
    benefits: benefits.length,
    rotated: rotated || null
  };
}
__name(readCampaigns, "readCampaigns");
async function claimOne(ctx, campaign) {
  const path = `${CAMPAIGNS}/${encodeURIComponent(campaign.campaignId)}/claim`;
  const { result, authFailed, rotated } = await authorized(ctx, { path, method: "POST", body: {} });
  if (authFailed) return { status: "login_required", message: `\u9886\u53D6\u65F6\u767B\u5F55\u6001\u5931\u6548\uFF08HTTP ${result.status}\uFF09\uFF0C\u7EED\u671F\u540E\u4ECD\u88AB\u62D2`, rotated: rotated || null };
  if (result.status !== 200) {
    return { status: "error", message: `\u9886\u53D6 ${campaign.campaignId} \u5931\u8D25\uFF1AHTTP ${result.status} ${truncate(result.text, 100)}`, rotated: rotated || null };
  }
  const data = unwrap(result.payload);
  if (!data || typeof data !== "object" || data.status !== "CLAIMED") {
    return { status: "error", message: `\u9886\u53D6\u54CD\u5E94\u4E0D\u662F CLAIMED\uFF1A${truncate(JSON.stringify(data ?? result.payload), 100)}`, rotated: rotated || null };
  }
  const raw = data.benefit && data.benefit.amount;
  const credits = Number.isFinite(Number(raw)) ? Number(raw) : 0;
  return {
    status: "claimed",
    // replayed 是上游在告诉我们"这次是幂等重放"。必须如实上报并与"新领到"分开，
    // 否则重跑一轮会被记成"新领到了额度"
    replayed: Boolean(data.replayed),
    credits,
    rotated: rotated || null
  };
}
__name(claimOne, "claimOne");
var qoderHosts = [HOST];
function uidFromToken(values) {
  const uid = subjectOf(values.accessToken);
  if (uid) return uid;
  const fallback = String(values.uid || "").trim();
  if (!fallback) {
    throw new Error("\u8FD9\u5F20 access token \u4E0D\u662F JWT\uFF08\u65B0\u7248\u5BA2\u6237\u7AEF\u7684\u8BBE\u5907\u4EE4\u724C\uFF09\uFF0C\u89E3\u4E0D\u51FA\u8D26\u53F7\u6807\u8BC6 \u2014\u2014 \u8BF7\u5728\u300C\u8D26\u53F7\u6807\u8BC6\u300D\u680F\u7ED9\u5B83\u8D77\u4E2A\u56FA\u5B9A\u4EE3\u53F7\uFF08\u5982 main\uFF09\uFF0C\u5EFA\u53F7\u540E\u4E0D\u8981\u518D\u6539");
  }
  return fallback;
}
__name(uidFromToken, "uidFromToken");

// src/tools/qoder/index.js
var CLAIMS_PER_ROUND = 3;
var qoder_default = {
  id: "qoder",
  name: "Qoder",
  order: 10,
  // 描述是给使用者看的一句话，不写接口名。campaigns → claim 是内部两步调用，
  // 摆在卡片上对不了解上游的人没有任何意思（campaigns 是什么只能去问客服）。
  summary: "\u6BCF\u5929\u9886\u53D6 IDE \u6D3B\u52A8\u8D60\u9001\u7684\u989D\u5EA6",
  // 工具级：对这家站点的所有账号生效。设备身份是"一台机器"的身份，不属于任何单个账号，
  // 所以它是 config 而不是 creds —— 一台机器上的多个账号共用一份。
  config: [
    {
      key: "clientType",
      label: "Cosy-ClientType",
      type: "text",
      required: true,
      default: "10",
      help: "\u5FC5\u987B\u4E3A 10\uFF08\u5DF2\u9884\u586B\uFF09\uFF1A\u7F3A\u8FD9\u4E2A\u5934\u6D3B\u52A8\u5217\u8868\u76F4\u63A5\u8FD4\u56DE\u7A7A\u3002\u9664\u975E\u4E0A\u6E38\u6539\u4E86\u534F\u8BAE\uFF0C\u5426\u5219\u4E0D\u7528\u52A8\u3002"
    },
    {
      key: "machineToken",
      label: "Cosy-MachineToken",
      type: "textarea",
      required: true,
      secret: true,
      offline: "tools/extract/qoder-device.ps1",
      help: "\u7EBF\u4E0B\u811A\u672C\u4EA7\u51FA\uFF1B\u8FC7\u671F\u65F6\u4E0A\u6E38\u4E0D\u62A5\u9519\uFF0C\u53EA\u662F\u6D3B\u52A8\u5217\u8868\u53D8\u7A7A"
    },
    { key: "machineCode", label: "Cosy-MachineCode", type: "textarea", required: true, secret: true, offline: "tools/extract/qoder-device.ps1" },
    { key: "machineId", label: "Cosy-MachineId", type: "text", required: true, offline: "tools/extract/qoder-device.ps1" },
    { key: "machineType", label: "Cosy-MachineType", type: "text", placeholder: "\u5982 windows" },
    { key: "machineOS", label: "Cosy-MachineOS", type: "text", placeholder: "\u5982 10.0.26100" },
    { key: "machineHostname", label: "Cosy-MachineHostname", type: "text" },
    { key: "version", label: "Cosy-Version", type: "text", placeholder: "\u5982 0.1.43" },
    // 请求超时。留空即用 30000（api.js 里兜底），与另两家的同名配置口径一致。
    // 不设超时时，上游挂起会一直占着调用，而账号锁 90 秒就过期了。
    { key: "timeoutMs", label: "\u8BF7\u6C42\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", type: "text", placeholder: "30000" }
  ],
  // 账号级。两个 token 都是 secret。
  // 不声明 expiresAt：Qoder 的续期完全由上游的 401/403 触发（见 api.js 的 authorized），
  // 没有"提前 N 天主动换票"这条规则，所以本地到期时间对换期没有任何决策价值。
  // 而设备令牌（dt-- 形态）解不出 exp、原脚本那种"+14 天"兜底又是猜的 ——
  // 摆一个永远空着或写着假日期的只读字段，不如不声明。
  creds: [
    {
      key: "accessToken",
      label: "Access Token",
      type: "textarea",
      required: true,
      secret: true,
      pattern: "^[^\\s]+$",
      patternMessage: "\u4EE4\u724C\u91CC\u4E0D\u80FD\u6709\u7A7A\u683C\uFF08\u7C98\u8D34\u65F6\u522B\u5E26\u4E0A\u6362\u884C\u6216 + \u53F7\u88AB\u5403\u6389\u7684\u75D5\u8FF9\uFF09",
      offline: "tools/extract/qoder-device.ps1",
      help: "\u662F eyJ \u5F00\u5934\u7684\u957F\u4E32\uFF08JWT\uFF09\u65F6\uFF0C\u8D26\u53F7\u6807\u8BC6\u4ECE\u5B83\u7684 sub \u81EA\u5DF1\u89E3\uFF1B\u662F dt-- \u5F00\u5934\u7684\u77ED\u4E32\uFF08\u65B0\u7248\u5BA2\u6237\u7AEF\u7684\u8BBE\u5907\u4EE4\u724C\uFF09\u65F6\uFF0C\u8981\u9760\u4E0B\u9762\u7684\u300C\u8D26\u53F7\u6807\u8BC6\u300D\u680F"
    },
    {
      key: "uid",
      label: "\u8D26\u53F7\u6807\u8BC6",
      type: "text",
      required: false,
      pattern: "^[A-Za-z0-9._-]{1,64}$",
      patternMessage: "\u53EA\u5141\u8BB8\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u3001\u6A2A\u7EBF\uFF0C\u6700\u957F 64",
      help: "\u4EC5\u5F53 Access Token \u4E0D\u662F JWT \u65F6\u624D\u9700\u8981\u586B\uFF1A\u7ED9\u5B83\u8D77\u4E2A\u56FA\u5B9A\u4EE3\u53F7\uFF08\u5982 main\uFF09\u3002\u5B83\u662F\u8D26\u53F7\u7684\u952E\u540D\uFF0C\u5EFA\u53F7\u540E\u4E0D\u8981\u518D\u6539 \u2014\u2014 \u6539\u4E86\u7B49\u4E8E\u53E6\u8D77\u4E00\u4E2A\u8D26\u53F7"
    },
    {
      key: "refreshToken",
      label: "Refresh Token",
      type: "textarea",
      required: true,
      secret: true,
      pattern: "^[^\\s]+$",
      patternMessage: "\u4EE4\u724C\u91CC\u4E0D\u80FD\u6709\u7A7A\u683C",
      offline: "tools/extract/qoder-device.ps1",
      help: "\u6BCF\u6B21\u7EED\u671F\u90FD\u4F1A\u6362\u65B0\u4E32\uFF0C\u5185\u6838\u5F53\u573A\u5199\u56DE\uFF1B\u65E7\u4E32\u7528\u8FC7\u4E00\u6B21\u5373\u5E9F"
    }
  ],
  // uid 从凭据里算（JWT 的 sub），新客户端的设备令牌解不出时退到手填代号
  uidOf: /* @__PURE__ */ __name((ctx) => uidFromToken(ctx.values), "uidOf"),
  schedule: {
    // 这家的"今天"跟着它自己的活动窗口走：上游按 UTC+8 每天 10:00 前后重新下发活动，
    // 所以逻辑日也在 10:00 翻。不要让计数器按北京零点翻、再把"10 点后才跑"交给
    // cron 表达式表达 —— 同一个事实写在两个地方，迟早对不上。
    resetHour: 10,
    notBeforeHour: 10,
    // 10 点之前去打只是白烧子请求
    minIntervalSec: 1800,
    maxDaily: 20,
    backoff: []
    // 这家没有限频方言（429/9074 都不出现），退避阶梯留空
  },
  hosts: qoderHosts,
  // 最坏情况：读列表 1 + 认证失败时（续期 1 + 重读 1）+ 领 N 个 = 3 + N。
  // cost 是"这一步最坏要花多少"，不是"通常花多少" —— 低估会让预算判定给出假通行证。
  // 走一遍 401 → 续期 → 重试 → 领 3 个，内核算出 over=1，所以是 3 + N 而不是 2 + N。
  steps: [
    {
      id: "claim",
      label: "\u9886\u53D6\u989D\u5EA6",
      cost: 3 + CLAIMS_PER_ROUND,
      async run(ctx) {
        const list = await readCampaigns(ctx);
        if (list.loginRequired) return { status: "login_required", message: list.message, credits: 0, cred: list.rotated };
        if (list.error) return { status: "error", message: list.error, credits: 0, cred: list.rotated };
        if (list.benefits === 0) {
          return {
            status: "inactive",
            message: "\u6D3B\u52A8\u5217\u8868\u4E3A\u7A7A\uFF1A\u53EF\u80FD\u4ECA\u5929\u6CA1\u4E0B\u53D1\u6D3B\u52A8\u3001\u8FD9\u4E2A\u8D26\u53F7\u4E0D\u5728\u8D44\u683C\u8303\u56F4\u5185\uFF0C\u6216\u8005\u300C\u5DE5\u5177\u914D\u7F6E\u300D\u91CC\u7684\u8BBE\u5907\u8EAB\u4EFD\uFF08Cosy-MachineToken/Code/Id\uFF09\u5DF2\u8FC7\u671F \u2014\u2014 \u4E0A\u6E38\u5BF9\u8FD9\u51E0\u79CD\u90FD\u56DE\u7A7A\u5217\u8868\uFF0C\u5206\u4E0D\u5F00",
            credits: 0,
            cred: list.rotated
          };
        }
        if (list.claimable.length === 0) {
          if (list.claimedToday.length) {
            return { status: "already", message: `\u4ECA\u65E5\u5DF2\u9886\u53D6\uFF08${list.claimedToday.length} \u4E2A\u6D3B\u52A8\uFF09`, credits: 0, cred: list.rotated };
          }
          const listed = list.pendingList.map((c) => `${c.campaignKey || c.campaignId}=${c.claimStatus}`).join("\u3001").slice(0, 120);
          return { status: "pending", message: `\u6D3B\u52A8\u672A\u4E0B\u53D1\u5230\u4F4D${listed ? `\uFF1A${listed}` : ""}`, credits: 0, cred: list.rotated };
        }
        const batch = list.claimable.slice(0, CLAIMS_PER_ROUND);
        const outcomes = [];
        for (const campaign of batch) outcomes.push(await claimOne(ctx, campaign));
        const failed = outcomes.filter((o) => o.status !== "claimed");
        const rotated = outcomes.reduce((acc, o) => o.rotated ? { ...acc, ...o.rotated } : acc, list.rotated || {});
        const credits = outcomes.reduce((sum, o) => sum + (o.credits || 0), 0);
        const replayed = outcomes.filter((o) => o.replayed).length;
        const note2 = [
          credits ? `+${credits} \u989D\u5EA6` : "\u672C\u6B21\u5230\u8D26 0",
          replayed ? `\u5176\u4E2D ${replayed} \u4E2A\u4E0A\u6E38\u5224\u4E3A\u5E42\u7B49\u91CD\u653E` : "",
          list.claimable.length > batch.length ? `\u8FD8\u6709 ${list.claimable.length - batch.length} \u4E2A\u5F85\u9886` : ""
        ].filter(Boolean).join("\uFF0C");
        if (failed.length === outcomes.length) {
          return { status: "error", message: `${failed.length}/${outcomes.length} \u4E2A\u6D3B\u52A8\u9886\u53D6\u5931\u8D25\uFF1A${failed[0].message}`, credits: 0, cred: rotated };
        }
        const status = list.claimable.length > batch.length ? "partial" : failed.length ? "partial" : "claimed";
        return { status, message: `${outcomes.length - failed.length}/${outcomes.length} \u4E2A\u6D3B\u52A8\u9886\u53D6\u6210\u529F\uFF0C${note2}`, credits, cred: rotated };
      }
    }
  ],
  // 「测试」按钮：只读活动列表，一次领取都不发。
  async validate(ctx) {
    const list = await readCampaigns(ctx);
    if (list.loginRequired) return { status: "login_required", message: list.message };
    if (list.error) return { status: "error", message: list.error };
    if (list.benefits === 0) {
      return { status: "inactive", message: "\u767B\u5F55\u6001\u6709\u6548\uFF0C\u4F46\u6D3B\u52A8\u5217\u8868\u4E3A\u7A7A\uFF1A\u4ECA\u5929\u6CA1\u4E0B\u53D1\u3001\u8D26\u53F7\u4E0D\u5728\u8D44\u683C\u8303\u56F4\u5185\uFF0C\u6216\u8BBE\u5907\u8EAB\u4EFD\u5DF2\u8FC7\u671F\uFF08\u4E0A\u6E38\u5BF9\u8FD9\u51E0\u79CD\u90FD\u56DE\u7A7A\u5217\u8868\uFF09" };
    }
    return {
      status: "ok",
      message: `\u767B\u5F55\u6001\u6709\u6548\uFF1A${list.benefits} \u4E2A\u989D\u5EA6\u6D3B\u52A8\uFF0C\u5176\u4E2D ${list.claimable.length} \u4E2A\u53EF\u9886\u3001${list.claimedToday.length} \u4E2A\u4ECA\u65E5\u5DF2\u9886`
    };
  }
};

// src/tools/trae/api.js
var OAUTH_HOST = "api.trae.com.cn";
var CLAIM_HOST = "api.trae.cn";
var EXCHANGE = "/cloudide/api/v3/trae/oauth/ExchangeToken";
var USER_INFO = "/cloudide/api/v3/trae/GetUserInfo";
var STATUS = "/trae/api/v2/ug/checkin_credits/status";
var CLAIM = "/trae/api/v2/ug/checkin_credits/claim";
var USAGE = "/trae/api/v2/pay/ide_user_ent_usage";
var DEFAULT_CLIENT_ID = "en1oxy7wnw8j9n";
var DEFAULT_APP_VERSION = "1.107.1";
var CLIENT_SECRET_PLACEHOLDER = "-";
var TOKEN_LIFETIME_FALLBACK = 14 * 86400;
var timeoutMs2 = /* @__PURE__ */ __name((config) => {
  const raw = Number(config.timeoutMs);
  return Number.isFinite(raw) && raw > 0 ? raw : 15e3;
}, "timeoutMs");
async function post(ctx, path, host, headers, body) {
  const response = await ctx.fetch(`https://${host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs2(ctx.config))
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return { status: response.status, payload, text };
}
__name(post, "post");
async function exchangeToken(ctx, refreshToken2) {
  const result = await post(ctx, EXCHANGE, OAUTH_HOST, { "User-Agent": `Trae/${ctx.config.appVersion || DEFAULT_APP_VERSION}` }, {
    ClientID: ctx.config.clientId || DEFAULT_CLIENT_ID,
    RefreshToken: refreshToken2,
    ClientSecret: CLIENT_SECRET_PLACEHOLDER,
    UserID: ""
  });
  if (result.status >= 400 && result.status < 500) return { authFailed: true, status: result.status };
  if (result.status !== 200 || !result.payload) return { error: `\u6362\u7968\u5931\u8D25\uFF1AHTTP ${result.status}` };
  const inner = result.payload.Result || {};
  const token = inner.Token;
  if (!token) return { authFailed: true, status: 200 };
  const rawExp = Number(inner.TokenExpireAt);
  const expiresAt = Number.isFinite(rawExp) && rawExp > 0 ? rawExp > 1e12 ? Math.floor(rawExp / 1e3) : Math.floor(rawExp) : ctx.now + Number(inner.TokenExpireDuration || TOKEN_LIFETIME_FALLBACK);
  return {
    cred: {
      accessToken: String(token),
      refreshToken: String(inner.RefreshToken || refreshToken2),
      expiresAt: String(expiresAt)
    }
  };
}
__name(exchangeToken, "exchangeToken");
function claimHeaders(ctx, token) {
  const appVersion = ctx.config.appVersion || DEFAULT_APP_VERSION;
  return {
    Authorization: `Cloud-IDE-JWT ${token}`,
    "x-device-id": String(ctx.account.cred.ahaDeviceId || ""),
    "x-device-type": "Windows",
    "x-os-version": "10.0.19045",
    "x-app-version": appVersion,
    "X-User-Region": "CN",
    "User-Agent": `Trae/${appVersion}`
  };
}
__name(claimHeaders, "claimHeaders");
async function ensureToken(ctx, { force = false } = {}) {
  const cred = ctx.account.cred;
  if (!cred.expiresAt) {
    const fromJwt = expiresFromToken(cred.accessToken);
    if (fromJwt) cred.expiresAt = String(fromJwt);
  }
  const remaining = Number(cred.expiresAt || 0) - ctx.now;
  const ahead = Number(ctx.config.refreshAheadSec || 259200);
  if (!force && remaining > 0 && remaining > ahead) return { token: cred.accessToken, expired: false };
  const exchanged = await exchangeToken(ctx, cred.refreshToken);
  if (exchanged.cred) {
    Object.assign(cred, exchanged.cred);
    return { token: exchanged.cred.accessToken, rotated: exchanged.cred };
  }
  if (remaining <= 0) {
    return { error: `\u767B\u5F55\u6001\u5DF2\u8FC7\u671F\u4E14\u7EED\u671F\u5931\u8D25\uFF08HTTP ${exchanged.status ?? "-"}\uFF09\uFF0C\u9700\u8981\u91CD\u65B0\u53D6\u4E00\u6B21\u51ED\u636E`, authFailed: true };
  }
  return { token: cred.accessToken, warn: exchanged.error || "\u7EED\u671F\u672A\u6210\u529F\uFF0C\u672C\u6B21\u6CBF\u7528\u65E7\u7968" };
}
__name(ensureToken, "ensureToken");
var httpAuthFail = /* @__PURE__ */ __name((result) => result.status === 401 || result.status === 403, "httpAuthFail");
async function readStatus(ctx, token) {
  const result = await post(ctx, STATUS, CLAIM_HOST, claimHeaders(ctx, token), { req_source: 1 });
  if (httpAuthFail(result)) return { authFailed: true, status: result.status };
  if (result.status >= 400) return { error: `\u7B7E\u5230\u72B6\u6001\u67E5\u8BE2\u5931\u8D25\uFF1AHTTP ${result.status}` };
  const body = result.payload || {};
  return { checkedIn: body.checked_in === true, credits: body.credits, enable: body.enable };
}
__name(readStatus, "readStatus");
async function claimOnce(ctx, token) {
  const result = await post(ctx, CLAIM, CLAIM_HOST, claimHeaders(ctx, token), { req_source: 1 });
  if (httpAuthFail(result)) return { authFailed: true, status: result.status };
  const body = result.payload || {};
  const code = body.code === void 0 || body.code === null ? null : Number(body.code);
  const msg = String(body.message || "");
  return { code, msg, credits: body.credits, status: result.status, body };
}
__name(claimOnce, "claimOnce");
async function readUsage(ctx, token) {
  const result = await post(ctx, USAGE, CLAIM_HOST, claimHeaders(ctx, token), {});
  if (httpAuthFail(result)) return { authFailed: true };
  if (result.status >= 400) return { error: `\u989D\u5EA6\u5305\u67E5\u8BE2\u5931\u8D25\uFF1AHTTP ${result.status}` };
  const packs = result.payload && result.payload.user_entitlement_pack_list || [];
  let limit = 0;
  let used = 0;
  for (const pack of packs) {
    const quota = (pack.entitlement_base_info || {}).quota || {};
    const usage = pack.usage || {};
    limit += Number(quota.credits_limit) || 0;
    used += Number(quota.credits_amount ?? usage.credits_amount) || 0;
  }
  return { limit, used, remaining: limit - used, packs: packs.length };
}
__name(readUsage, "readUsage");
function translateClaim({ code, msg, credits }) {
  const low = msg.toLowerCase();
  if (code === 9074 || code === 429 || msg.includes("\u9891\u7E41") || msg.includes("\u592A\u591A") || low.includes("too frequent")) {
    return { status: "rate_limited", message: msg || `\u670D\u52A1\u5668\u7E41\u5FD9\uFF08code ${code}\uFF09`, credits: 0 };
  }
  if (low.includes("already") || /已(签到|领取|领过|签过)/.test(msg)) {
    return { status: "already", message: msg || "\u4ECA\u65E5\u5DF2\u7B7E\u5230", credits: Number(credits) || 0 };
  }
  if (code === 0 || low.includes("success")) {
    return { status: "claimed", message: msg || "\u7B7E\u5230\u6210\u529F", credits: Number(credits) || 0 };
  }
  if (code === null && !msg) return { status: "error", message: "\u7B7E\u5230\u54CD\u5E94\u7ED3\u6784\u5F02\u5E38\uFF08\u6CA1\u8FD4\u56DE code/message\uFF09\uFF0C\u5DF2\u6309\u5931\u8D25\u5904\u7406", credits: 0 };
  return { status: "error", message: `${msg || `code ${code}`}`, credits: 0 };
}
__name(translateClaim, "translateClaim");
async function uidFromToken2(ctx) {
  const token = ctx.values.accessToken;
  if (!token) throw new Error("\u5148\u628A Access Token \u7C98\u8FDB\u6765\uFF0C\u8D26\u53F7\u6807\u8BC6\u8981\u4ECE\u5B83\u8EAB\u4E0A\u53D6");
  const result = await ctx.fetch(`https://${OAUTH_HOST}${USER_INFO}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cloudide-token": token,
      "User-Agent": `Trae/${ctx.config.appVersion || DEFAULT_APP_VERSION}`
    },
    body: JSON.stringify({ ReqSource: "IDE", IDEVersion: ctx.config.appVersion || DEFAULT_APP_VERSION }),
    signal: AbortSignal.timeout(timeoutMs2(ctx.config))
  });
  const text = await result.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const inner = payload && payload.Result || payload || {};
  const uid = String(inner.UserID ?? "").trim();
  if (!uid) {
    throw new Error(`\u53D6\u4E0D\u5230\u8D26\u53F7\u6807\u8BC6\uFF1AGetUserInfo \u6CA1\u6709\u8FD4\u56DE UserID\uFF08HTTP ${result.status}\uFF09\u3002\u8FD9\u628A Access Token \u53EF\u80FD\u5DF2\u7ECF\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u53D6\u503C\u518D\u7C98\u4E00\u6B21`);
  }
  const expiresAt = expiresFromToken(token);
  return expiresAt ? { uid, cred: { expiresAt: String(expiresAt) } } : uid;
}
__name(uidFromToken2, "uidFromToken");
var expiresFromToken = /* @__PURE__ */ __name((token) => expiresAtOf(readJwtClaims(token)), "expiresFromToken");
var traeHosts = [OAUTH_HOST, CLAIM_HOST];
var traeDefaults = { clientId: DEFAULT_CLIENT_ID, appVersion: DEFAULT_APP_VERSION };

// src/tools/trae/index.js
var trae_default = {
  id: "trae",
  name: "Trae",
  order: 20,
  summary: "\u6BCF\u5929\u7B7E\u5230\u9886\u989D\u5EA6\u5305\u79EF\u5206",
  config: [
    {
      key: "clientId",
      label: "ClientID",
      type: "text",
      required: true,
      default: traeDefaults.clientId,
      help: "Trae \u5B98\u65B9\u5BA2\u6237\u7AEF\u8DDF\u7740\u7248\u672C\u53D1\u5E03\u7684\u516C\u5F00\u6807\u8BC6\uFF0C**\u6240\u6709\u7528\u6237\u90FD\u662F\u540C\u4E00\u4E2A**\uFF0C\u4E0D\u662F\u4F60\u7684\u51ED\u636E\u3002\u5DF2\u9884\u586B\u597D\uFF0C\u901A\u5E38\u4E0D\u7528\u52A8\uFF1B\u4E0A\u6E38\u6362\u5BA2\u6237\u7AEF\u7248\u672C\u65F6\u8FD9\u91CC\u8981\u8DDF\u7740\u6539\u3002"
    },
    {
      key: "appVersion",
      label: "\u5BA2\u6237\u7AEF\u7248\u672C",
      type: "text",
      required: true,
      default: traeDefaults.appVersion,
      help: "\u51B3\u5B9A User-Agent \u4E0E IDEVersion\uFF0C\u4E0A\u6E38\u6309\u5B83\u505A\u517C\u5BB9\u5224\u65AD\u3002\u5DF2\u9884\u586B\u597D\uFF0C\u901A\u5E38\u4E0D\u7528\u52A8\uFF1BTrae \u51FA\u4E86\u65B0\u7248\uFF08\u7B7E\u5230\u62A5\u300C\u8BF7\u6C42\u5DF2\u8FC7\u671F\u300D\u591A\u534A\u662F\u8FD9\u4E2A\u539F\u56E0\uFF09\u624D\u9700\u8981\u6539\u3002"
    },
    { key: "timeoutMs", label: "\u8BF7\u6C42\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", type: "text", placeholder: "15000" },
    { key: "refreshAheadSec", label: "\u63D0\u524D\u7EED\u671F\u79D2\u6570", type: "text", placeholder: "259200\uFF0872 \u5C0F\u65F6\uFF09" }
  ],
  creds: [
    {
      key: "accessToken",
      label: "Access Token",
      type: "textarea",
      required: true,
      secret: true,
      pattern: "^[^\\s]+$",
      patternMessage: "\u4EE4\u724C\u91CC\u4E0D\u80FD\u6709\u7A7A\u683C",
      offline: "\u7EBF\u4E0B\u811A\u672C\u6362\u53D6\uFF08\u89C1\u8BF4\u660E\u9875\uFF09",
      help: "uid \u7531\u5B83\u8C03 GetUserInfo \u53D6\u5F97\uFF1B\u8FD9\u628A\u7968\u5931\u6548\u5C31\u5F97\u91CD\u65B0\u53D6\u4E00\u6B21"
    },
    {
      key: "refreshToken",
      label: "Refresh Token",
      type: "textarea",
      required: true,
      secret: true,
      pattern: "^[^\\s]+$",
      patternMessage: "\u4EE4\u724C\u91CC\u4E0D\u80FD\u6709\u7A7A\u683C\uFF08\u6CE8\u610F\u522B\u628A + \u53F7\u4E22\u4E86\uFF09",
      offline: "\u7EBF\u4E0B\u811A\u672C\u6362\u53D6\uFF08\u89C1\u8BF4\u660E\u9875\uFF09",
      help: "\u6BCF\u6B21\u7EED\u671F\u90FD\u4F1A\u6362\u51FA\u65B0\u4E32\uFF0C\u5185\u6838\u5F53\u573A\u5199\u56DE\uFF1B\u65E7\u4E32\u7528\u8FC7\u4E00\u6B21\u5373\u5E9F"
    },
    {
      key: "ahaDeviceId",
      label: "Aha \u8BBE\u5907\u53F7",
      type: "text",
      required: true,
      // 8–16 位。不要收紧到 16 位：会让用户手上现有的 8–15 位账号**录不进去**
      // （唯一的症状是表单红字，与上游无关）。没有证据说明这一家固定 16 位。
      pattern: "^\\d{8,16}$",
      patternMessage: "\u5FC5\u987B\u662F 8\u201316 \u4F4D\u6570\u5B57\u7684 Aha \u8BBE\u5907\u53F7",
      offline: "\u4E0E access token \u540C\u4E00\u6B21\u7EBF\u4E0B\u53D6\u503C\u91CC\u62FF\u5230",
      help: "\u7B7E\u5230\u98CE\u63A7\u6309\u5B83\u5224\u5B9A\uFF1A\u968F\u624B\u7F16\u4E00\u4E2A\uFF08\u54EA\u6015\u683C\u5F0F\u770B\u7740\u5BF9\uFF09\u4F1A\u6BCF\u5929\u7A33\u5B9A\u8FD4\u56DE\u300C\u670D\u52A1\u5668\u7E41\u5FD9\u300D\uFF0C\u770B\u7740\u50CF\u9650\u9891\u5176\u5B9E\u662F\u8BBE\u5907\u53F7\u9519\u4E86"
    },
    { key: "expiresAt", label: "\u4EE4\u724C\u5230\u671F\u65F6\u95F4", type: "datetime", readonly: true }
  ],
  // Trae 的 UserID 不在 JWT 里，只能问 GetUserInfo 一次。这里会花一次子请求，
  // 换来的是"存进 KV 的键名就是上游认的那个号"。
  uidOf: /* @__PURE__ */ __name((ctx) => uidFromToken2(ctx), "uidOf"),
  schedule: {
    resetHour: 0,
    // 上游按北京零点判"今天签没签"
    notBeforeHour: 0,
    // 零点第一轮就跑，越早领越好
    minIntervalSec: 1800,
    maxDaily: 20,
    // 跨轮退避（分钟）：内核把它写在 retryAt 上，不在进程内睡眠
    backoff: [30, 60, 120, 240, 360]
  },
  hosts: traeHosts,
  // 最坏一轮（走一遍算出来的，不是推算）：换票 1 + 状态 1 + [票被提前判死: 强制换票 1 + 重读状态 1]
  //   + 领取 1 + 额度包 1 = 6。预约低了不会报错，只会把越界的机会留给后面几步，所以宁可报高。
  steps: [
    {
      id: "checkin",
      label: "\u7B7E\u5230\u9886\u79EF\u5206",
      cost: 6,
      async run(ctx) {
        const ensured = await ensureToken(ctx);
        if (ensured.error) return { status: "login_required", message: ensured.error, credits: 0, cred: null };
        let cred = ensured.rotated || null;
        let token = ensured.token;
        let status = await readStatus(ctx, token);
        if (status.authFailed) {
          const again = await ensureToken(ctx, { force: true });
          if (again.error || !again.rotated) {
            return { status: "login_required", message: `\u7B7E\u5230\u72B6\u6001\u88AB\u62D2\uFF08HTTP ${status.status}\uFF09\uFF0C\u7EED\u671F\u4E5F\u6551\u4E0D\u56DE\u6765`, credits: 0, cred };
          }
          cred = again.rotated;
          token = again.token;
          status = await readStatus(ctx, token);
          if (status.authFailed) return { status: "login_required", message: "\u7B7E\u5230\u72B6\u6001\u67E5\u8BE2\u88AB\u62D2\uFF0C\u767B\u5F55\u6001\u786E\u8BA4\u5931\u6548", credits: 0, cred };
        }
        if (status.error) return { status: "error", message: status.error, credits: 0, cred };
        if (status.enable === false) return { status: "inactive", message: "\u7B7E\u5230\u529F\u80FD\u5BF9\u8FD9\u4E2A\u8D26\u53F7\u672A\u542F\u7528", credits: 0, cred };
        if (status.checkedIn) {
          return { status: "already", message: `\u4ECA\u65E5\u5DF2\u7B7E\u5230${status.credits ? `\uFF0C\u5F53\u524D\u7B7E\u5230\u79EF\u5206 ${status.credits}` : ""}`, credits: 0, cred };
        }
        const claimed = await claimOnce(ctx, token);
        if (claimed.authFailed) return { status: "login_required", message: `\u9886\u53D6\u65F6\u88AB\u62D2\uFF08HTTP ${claimed.status}\uFF09\uFF0C\u767B\u5F55\u6001\u5DF2\u5931\u6548`, credits: 0, cred };
        const outcome = translateClaim(claimed);
        if (outcome.status === "error" && claimed.code === null && !claimed.msg) {
          return { status: "error", message: outcome.message, credits: 0, cred };
        }
        if (outcome.status === "rate_limited") {
          return { status: "rate_limited", message: `${outcome.message}\uFF08\u6309\u9000\u907F\u9636\u68AF\u7A0D\u540E\u518D\u8BD5\uFF09`, credits: 0, cred };
        }
        let gained = outcome.credits || 0;
        let current = null;
        let before = null;
        if (!gained && outcome.status === "claimed") {
          const after = await readStatus(ctx, token);
          if (!after.error && !after.authFailed) {
            const pre = Number(status.credits);
            const post2 = Number(after.credits);
            if (Number.isFinite(post2)) current = post2;
            if (Number.isFinite(pre)) before = pre;
            if (Number.isFinite(pre) && Number.isFinite(post2)) gained = Math.max(0, post2 - pre);
          }
        }
        const credited = outcome.status !== "claimed" ? "" : gained > 0 ? `\uFF0C\u672C\u6B21 +${gained}` : current !== null ? `\uFF0C\u672C\u6B21\u5230\u8D26\u4E0A\u6E38\u672A\u56DE\uFF1B\u5F53\u524D\u7B7E\u5230\u79EF\u5206 ${current}\uFF08\u9886\u53D6\u524D ${before === null ? "\u672A\u7ED9" : before}\uFF09` : "\uFF0C\u672C\u6B21\u5230\u8D26\u4E0A\u6E38\u672A\u56DE\uFF08\u9886\u53D6\u4E0E\u72B6\u6001\u63A5\u53E3\u90FD\u6CA1\u7ED9\u79EF\u5206\uFF09";
        const usage = await readUsage(ctx, token);
        const tail = usage.error || usage.authFailed ? "\uFF08\u989D\u5EA6\u5305\u8BFB\u53D6\u5931\u8D25\uFF09" : `\uFF0C\u989D\u5EA6\u5305\u5269\u4F59 ${usage.remaining}`;
        return {
          status: outcome.status,
          message: `${outcome.message}${credited}${tail}`,
          credits: gained,
          cred
        };
      }
    }
  ],
  // 「测试」按钮：只换票 + 读签到状态，不发领取
  async validate(ctx) {
    const ensured = await ensureToken(ctx);
    if (ensured.error) return { status: "login_required", message: ensured.error };
    const token = ensured.token;
    const status = await readStatus(ctx, token);
    if (status.authFailed) return { status: "login_required", message: `\u72B6\u6001\u67E5\u8BE2\u88AB\u62D2\uFF08HTTP ${status.status}\uFF09` };
    if (status.error) return { status: "error", message: status.error };
    if (status.enable === false) return { status: "inactive", message: "\u7B7E\u5230\u529F\u80FD\u5BF9\u8FD9\u4E2A\u8D26\u53F7\u672A\u542F\u7528" };
    const usage = await readUsage(ctx, token);
    const tail = usage.error || usage.authFailed ? "" : `\uFF1B\u989D\u5EA6\u5305\u5269\u4F59 ${usage.remaining}`;
    return { status: "ok", message: `\u767B\u5F55\u6001\u6709\u6548\uFF1A${status.checkedIn ? "\u4ECA\u65E5\u5DF2\u7B7E\u5230" : "\u4ECA\u65E5\u672A\u7B7E\u5230"}${status.credits ? `\uFF0C\u79EF\u5206 ${status.credits}` : ""}${tail}` };
  }
};

// src/tools/workbuddy/api.js
var HOST2 = "copilot.tencent.com";
var STATUS2 = "/v2/billing/meter/checkin-activity-status";
var CHECKIN = "/v2/billing/meter/daily-checkin";
var REFRESH2 = "/v2/plugin/auth/token/refresh";
var GROWTH = "/v2/activity/growth";
var TRAVEL_STATUS = `${GROWTH}/buddy/travel/status`;
var TRAVEL_CLAIM = `${GROWTH}/buddy/travel/claim`;
var TRAVEL_CONFIG = `${GROWTH}/buddy/travel/config`;
var TRAVEL_DEPART = `${GROWTH}/buddy/travel/depart`;
var LOTTERY_CHANCES = `${GROWTH}/lottery/chances`;
var LOTTERY_DRAW = `${GROWTH}/lottery/draw`;
var QUOTA = `${GROWTH}/buddy/quota`;
var OPEN = `${GROWTH}/buddy/open`;
var TASKS = `${GROWTH}/tasks`;
var TASK_ACCEPT = "/activity/growth/tasks/accept";
var STREAK = `${GROWTH}/streak`;
var REDEEM = `${GROWTH}/redeem`;
var REDEEM_TIERS = [{ tier: "7d", days: 7 }, { tier: "14d", days: 14 }, { tier: "28d", days: 28 }];
function unwrapToken(raw) {
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text.startsWith("{")) return text;
    try {
      return unwrapToken(JSON.parse(text));
    } catch {
      return text;
    }
  }
  if (raw && typeof raw === "object") {
    if (raw["$wbEncrypted"] === 1 && typeof raw.envelope === "string") return raw.envelope.trim();
    if (typeof raw.accessToken === "string") return raw.accessToken.trim();
    if (typeof raw.token === "string") return raw.token.trim();
  }
  return "";
}
__name(unwrapToken, "unwrapToken");
var timeoutMs3 = /* @__PURE__ */ __name((config) => {
  const raw = Number(config.timeoutMs);
  return Number.isFinite(raw) && raw > 0 ? raw : 3e4;
}, "timeoutMs");
function dig(node, key, depth = 0) {
  if (!node || typeof node !== "object" || depth > 4) return null;
  if (Object.prototype.hasOwnProperty.call(node, key) && node[key] !== null && node[key] !== void 0) return node[key];
  for (const wrap2 of ["data", "result", "resp", "response"]) {
    if (node[wrap2] && typeof node[wrap2] === "object") {
      const found = dig(node[wrap2], key, depth + 1);
      if (found !== null && found !== void 0) return found;
    }
  }
  return null;
}
__name(dig, "dig");
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
__name(num, "num");
function firstCredit(body, item) {
  for (const [obj, key] of [
    [body, "credit_amount"],
    [body, "credit_granted"],
    [body, "reward_credit"],
    [item, "credit"],
    [item && item.instance, "credit"],
    [item && item.template, "credit"]
  ]) {
    const n = num(dig(obj, key));
    if (n) return n;
  }
  return 0;
}
__name(firstCredit, "firstCredit");
function drawCredit(payload) {
  for (const key of ["credit_amount", "credit", "reward_credit"]) {
    const n = num(dig(payload, key));
    if (n) return n;
  }
  return 0;
}
__name(drawCredit, "drawCredit");
function blindboxItemLabel(item) {
  const instance = item && item.instance || {};
  const template = item && item.template || {};
  const name = instance.name ?? template.name;
  if (typeof name !== "string" || !name.trim()) return "";
  const rarity = instance.rarity ?? template.rarity;
  return rarity ? `${name.trim()}(${rarity})` : name.trim();
}
__name(blindboxItemLabel, "blindboxItemLabel");
function prizeNameOf(payload) {
  const raw = dig(payload, "prize_name") ?? dig(payload, "name");
  return typeof raw === "string" && raw.trim() ? raw.trim() : "";
}
__name(prizeNameOf, "prizeNameOf");
var codeOf = /* @__PURE__ */ __name((body) => body && body.code !== void 0 && body.code !== null ? num(body.code) : null, "codeOf");
async function call2(ctx, path, { method = "POST", body, auth = true, extraHeaders } = {}) {
  const cred = ctx.account.cred;
  const headers = { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "WorkBuddy" };
  if (auth) {
    const token = unwrapToken(cred.accessToken);
    if (!token) throw new Error("Access Token \u89E3\u4E0D\u51FA\u53EF\u7528\u5185\u5BB9\uFF08\u53EF\u80FD\u662F\u5305\u88C5\u683C\u5F0F\u53D8\u4E86\uFF09\uFF0C\u91CD\u65B0\u53D6\u503C\u7C98\u8D34");
    headers.Authorization = `Bearer ${token}`;
    headers["X-User-Id"] = String(ctx.account.uid);
  }
  Object.assign(headers, extraHeaders || {});
  const response = await ctx.fetch(`https://${HOST2}${path}`, {
    method,
    headers,
    // 只有显式给了 body 才发体。JSON.stringify({}) 会发出字面 {}，两者对上游是不同的请求
    body: body === void 0 ? void 0 : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs3(ctx.config))
  });
  const text = await response.text();
  let payload = null;
  let malformed = false;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      malformed = true;
    }
  }
  return { status: response.status, payload, text, malformed };
}
__name(call2, "call");
var isAuthFail = /* @__PURE__ */ __name((result) => result.status === 401 || result.status === 403, "isAuthFail");
async function refresh(ctx) {
  const raw = unwrapToken(ctx.account.cred.refreshToken);
  if (!raw) return { error: "\u6CA1\u6709\u53EF\u7528\u7684 Refresh Token" };
  const result = await call2(ctx, REFRESH2, {
    auth: false,
    extraHeaders: { "X-Refresh-Token": raw, "X-Auth-Refresh-Source": "plugin" },
    body: {}
  });
  const token = dig(result.payload, "access_token") ?? dig(result.payload, "accessToken");
  if (result.status >= 400 || !token) {
    return { error: `\u7EED\u671F\u5931\u8D25\uFF08HTTP ${result.status}\uFF09`, authFailed: isAuthFail(result) };
  }
  const rotated = {
    accessToken: String(token),
    refreshToken: String(dig(result.payload, "refresh_token") ?? dig(result.payload, "refreshToken") ?? raw),
    expiresAt: String(num(dig(result.payload, "expires_in")) ? ctx.now + num(dig(result.payload, "expires_in")) : expiresAtOf(String(token)) || ctx.now + 7 * 86400)
  };
  Object.assign(ctx.account.cred, rotated);
  return { rotated };
}
__name(refresh, "refresh");
async function ensureAuth(ctx) {
  const expiresAt = num(ctx.account.cred.expiresAt) || 0;
  const ahead = num(ctx.config.refreshAheadSec) || 7 * 86400;
  if (ctx.renewAttempted && expiresAt > ctx.now) return {};
  if (expiresAt - ctx.now > ahead) return {};
  ctx.renewAttempted = true;
  const done = await refresh(ctx);
  if (done.error && expiresAt <= ctx.now) return done;
  return done.error ? { warn: done.error } : { rotated: done.rotated };
}
__name(ensureAuth, "ensureAuth");
var readStatus2 = /* @__PURE__ */ __name((ctx) => call2(ctx, STATUS2), "readStatus");
var submitCheckin = /* @__PURE__ */ __name((ctx) => call2(ctx, CHECKIN), "submitCheckin");
var readStreak = /* @__PURE__ */ __name((ctx) => call2(ctx, STREAK, { method: "GET", body: void 0 }), "readStreak");
var readChances = /* @__PURE__ */ __name((ctx) => call2(ctx, LOTTERY_CHANCES, { method: "GET", body: void 0 }), "readChances");
var readQuota = /* @__PURE__ */ __name((ctx) => call2(ctx, QUOTA, { method: "GET", body: void 0 }), "readQuota");
var readTasks = /* @__PURE__ */ __name((ctx) => call2(ctx, TASKS, { method: "GET", body: void 0 }), "readTasks");
var readTravelStatus = /* @__PURE__ */ __name((ctx) => call2(ctx, TRAVEL_STATUS, { method: "GET", body: void 0 }), "readTravelStatus");
var readTravelConfig = /* @__PURE__ */ __name((ctx) => call2(ctx, TRAVEL_CONFIG, { method: "GET", body: void 0 }), "readTravelConfig");
function idemKey(scope) {
  const uuid = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${scope}-${uuid}`;
}
__name(idemKey, "idemKey");
var drawOnce = /* @__PURE__ */ __name((ctx) => call2(ctx, LOTTERY_DRAW, { body: { client_token: idemKey("draw") } }), "drawOnce");
async function openBlindbox(ctx) {
  return call2(ctx, OPEN, { body: { count: 1 } });
}
__name(openBlindbox, "openBlindbox");
var claimTravel = /* @__PURE__ */ __name((ctx) => call2(ctx, TRAVEL_CLAIM, { body: {} }), "claimTravel");
var departTravel = /* @__PURE__ */ __name((ctx, locationId) => call2(ctx, TRAVEL_DEPART, { body: { location_id: locationId } }), "departTravel");
function classifyDepartFailure(depart) {
  const raw = (depart.payload && (depart.payload.msg ?? depart.payload.message)) ?? depart.text ?? "";
  const msg = String(raw);
  if (depart.status === 429 || /daily limit/i.test(msg)) return { kind: "limit" };
  if (/already traveling/i.test(msg)) return { kind: "traveling" };
  if (/location not available/i.test(msg)) return { kind: "location" };
  return { kind: "unknown", message: `HTTP ${depart.status}${msg ? ` ${truncate(msg, 100)}` : ""}` };
}
__name(classifyDepartFailure, "classifyDepartFailure");
var acceptTasks = /* @__PURE__ */ __name((ctx, taskCodes) => call2(ctx, TASK_ACCEPT, { body: { task_codes: taskCodes } }), "acceptTasks");
function acceptResults(payload) {
  const rows = dig(payload, "results");
  if (!Array.isArray(rows)) return null;
  return rows.map((row) => {
    const taskCode = typeof row?.task_code === "string" ? row.task_code : String(row?.code ?? "");
    const flag = row?.status ?? row?.result;
    const rawCode = dig(row, "code");
    const code = rawCode === null || rawCode === void 0 ? null : num(rawCode);
    const ok = flag === "ok" || code === 0;
    const known = ok || flag !== void 0 && flag !== null || code !== null;
    return { code: taskCode, ok, known, message: String(row?.message ?? row?.msg ?? "") };
  });
}
__name(acceptResults, "acceptResults");
var PREREQ_CN = {
  first_buddy: "\u9700\u8981\u5148\u9886\u517B\u7B2C\u4E00\u53EA Buddy\uFF08\u5728\u6210\u957F\u4E2D\u5FC3\u9996\u9875\u9886\u517B\uFF09\uFF0C\u9886\u5B8C\u8FD9\u9879\u4EFB\u52A1\u624D\u80FD\u63A5\u9886"
};
function prerequisiteHint(text) {
  const raw = String(text ?? "");
  const hit = raw.match(/prerequisite not met:\s*([A-Za-z0-9_.\-]+)/i);
  if (!hit) return null;
  const key = hit[1];
  return PREREQ_CN[key] || `\u4E0A\u6E38\u8BF4\u7F3A\u524D\u7F6E\uFF1A${key}\uFF08\u672C\u5E73\u53F0\u6682\u4E0D\u8BA4\u8BC6\u8FD9\u9879\uFF0C\u5148\u53BB\u6210\u957F\u4E2D\u5FC3\u9875\u9762\u624B\u52A8\u786E\u8BA4\uFF09`;
}
__name(prerequisiteHint, "prerequisiteHint");
var claimTask = /* @__PURE__ */ __name((ctx, taskCode) => call2(ctx, `/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, { method: "POST", body: void 0 }), "claimTask");
var redeemTier = /* @__PURE__ */ __name((ctx, tier) => call2(ctx, REDEEM, { body: { tier, client_token: idemKey("redeem") } }), "redeemTier");
function streakFacts(payload, { withToday = false } = {}) {
  const out = [];
  if (withToday) {
    const today = num(dig(payload, "today_credit") ?? dig(payload, "daily_credit"));
    if (today !== null) out.push(`\u4ECA\u65E5 +${today}`);
  }
  if (dig(payload, "is_streak_day") === true) out.push("\u4ECA\u5929\u662F\u8FDE\u7B7E\u5956\u52B1\u65E5");
  const streak = num(dig(payload, "streak_days"));
  if (streak !== null) out.push(`\u8FDE\u7B7E ${streak} \u5929`);
  const total = num(dig(payload, "total_credits"));
  if (total !== null) out.push(`\u7D2F\u8BA1 ${total} \u79EF\u5206`);
  return out;
}
__name(streakFacts, "streakFacts");
function judgeStatus(result) {
  if (isAuthFail(result)) return { verdict: "login_required", message: `\u7B7E\u5230\u72B6\u6001\u88AB\u62D2\uFF08HTTP ${result.status}\uFF09` };
  if (result.status >= 400) return { verdict: "error", message: `\u7B7E\u5230\u72B6\u6001\u67E5\u8BE2\u5931\u8D25\uFF1AHTTP ${result.status}` };
  if (dig(result.payload, "active") === false) {
    const name = dig(result.payload, "activity_name");
    return { verdict: "inactive", message: `\u7B7E\u5230\u6D3B\u52A8\u672A\u5F00\u542F${typeof name === "string" && name.trim() ? `\uFF08${name.trim()}\uFF09` : ""}` };
  }
  if (dig(result.payload, "today_checked_in") === true) {
    return {
      verdict: "already",
      message: ["\u4ECA\u65E5\u5DF2\u7B7E\u5230", ...streakFacts(result.payload, { withToday: true })].join("\uFF0C"),
      credits: 0,
      streak: num(dig(result.payload, "streak_days"))
    };
  }
  return { verdict: "claimable" };
}
__name(judgeStatus, "judgeStatus");
function judgeClaim(result) {
  if (isAuthFail(result)) return { status: "login_required", message: `\u9886\u53D6\u88AB\u62D2\uFF08HTTP ${result.status}\uFF09`, credits: 0 };
  const body = result.payload;
  const code = codeOf(body);
  const msg = String((body && (body.msg ?? body.message)) ?? "");
  const already = body === null || code === 10001 || msg.includes("\u5DF2\u7B7E");
  if (already && result.status >= 400 && code === null) {
    return { status: "error", message: `\u9886\u53D6\u5931\u8D25\uFF1AHTTP ${result.status} ${msg}`.trim(), credits: 0 };
  }
  if (already) return { status: "already", message: msg || "\u4ECA\u65E5\u5DF2\u7B7E\u5230\uFF08\u670D\u52A1\u7AEF\u5224\u5B9A\u5DF2\u9886\uFF09", credits: 0 };
  const credit = num(dig(body, "credit"));
  if (credit !== null) return { status: "claimed", message: msg || "\u7B7E\u5230\u6210\u529F", credits: credit };
  if (code !== null && code !== 0) return { status: "error", message: msg || `\u7B7E\u5230\u8FD4\u56DE code=${code}`, credits: 0 };
  return {
    status: "error",
    message: `\u7B7E\u5230\u54CD\u5E94\u91CC\u6CA1\u6709 credit \u5B57\u6BB5${result.malformed ? "\uFF08\u54CD\u5E94\u4E0D\u662F JSON\uFF09" : ""}\uFF0C\u5DF2\u6309\u5931\u8D25\u5904\u7406`,
    credits: 0
  };
}
__name(judgeClaim, "judgeClaim");
function uidFromToken3(values) {
  const text = unwrapToken(values.accessToken);
  if (!text) throw new Error("\u5148\u628A Access Token \u7C98\u8FDB\u6765");
  const uid = subjectOf(text);
  if (!uid) {
    throw new Error("\u8FD9\u5F20 Access Token \u89E3\u4E0D\u51FA\u8D26\u53F7\u6807\u8BC6\uFF08sub\uFF09\uFF1A\u8981\u4E48\u4E0D\u662F\u6807\u51C6 JWT\uFF0C\u8981\u4E48\u5305\u88C5\u683C\u5F0F\u53D8\u4E86\uFF0C\u8BF7\u91CD\u65B0\u53D6\u503C\u7C98\u8D34");
  }
  return { uid, cred: { expiresAt: String(expiresAtOf(text) || 0) } };
}
__name(uidFromToken3, "uidFromToken");
var workbuddyHosts = [HOST2];
var workbuddyRedeemTiers = REDEEM_TIERS;

// src/tools/workbuddy/index.js
var DRAWS_PER_ROUND = 5;
var OPENS_PER_ROUND = 5;
var TASKS_PER_ROUND = 3;
var DEPART_ATTEMPTS = 2;
var NO_ACCEPT_TASKS = /* @__PURE__ */ new Set(["wb_wechat_oa_subscribe_task"]);
var workbuddy_default = {
  id: "workbuddy",
  name: "WorkBuddy",
  order: 30,
  summary: "\u6BCF\u65E5\u7B7E\u5230 + \u6210\u957F\u4E2D\u5FC3\uFF08\u65C5\u884C / \u76F2\u76D2 / \u62BD\u5956 / \u8FDE\u7B7E\u5151\u6362 / \u4EFB\u52A1\uFF09",
  config: [
    { key: "timeoutMs", label: "\u8BF7\u6C42\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", type: "text", placeholder: "30000" },
    { key: "refreshAheadSec", label: "\u63D0\u524D\u7EED\u671F\u79D2\u6570", type: "text", placeholder: "604800\uFF087 \u5929\uFF09" }
  ],
  creds: [
    {
      key: "accessToken",
      label: "Access Token",
      type: "textarea",
      required: true,
      secret: true,
      offline: "\u9A8C\u8BC1\u7801\u6362\u7968\u8D70\u7EBF\u4E0B PowerShell\uFF0C\u754C\u9762\u4E0D\u53D1\u9A8C\u8BC1\u7801",
      help: '\u65B0\u7248\u684C\u9762\u7AEF\u53EF\u80FD\u7ED9\u7684\u662F {"$wbEncrypted":1,"envelope":"\u2026"} \u5305\u88C5\uFF0C\u5185\u6838\u4F1A\u81EA\u52A8\u5C55\u5F00'
    },
    {
      key: "refreshToken",
      label: "Refresh Token",
      type: "textarea",
      required: true,
      secret: true,
      offline: "\u9A8C\u8BC1\u7801\u6362\u7968\u8D70\u7EBF\u4E0B PowerShell\uFF0C\u754C\u9762\u4E0D\u53D1\u9A8C\u8BC1\u7801",
      help: "\u6362\u51FA\u6765\u7684\u65B0\u4E32\u4F1A\u88AB\u5F53\u573A\u5199\u56DE\uFF1B\u65E7\u4E32\u7528\u8FC7\u4E00\u6B21\u5373\u5E9F"
    },
    { key: "expiresAt", label: "\u4EE4\u724C\u5230\u671F\u65F6\u95F4", type: "datetime", readonly: true }
  ],
  uidOf: /* @__PURE__ */ __name((ctx) => uidFromToken3(ctx.values), "uidOf"),
  schedule: {
    resetHour: 0,
    // 上游按北京零点判"今天签没签"，我们不在本地重算日子
    notBeforeHour: 0,
    // 零点第一轮就跑，越早领越好
    minIntervalSec: 1800,
    maxDaily: 20,
    backoff: [10, 30]
    // 只兜住偶发限频，让它下一轮再来
  },
  hosts: workbuddyHosts,
  steps: [
    {
      id: "checkin",
      label: "\u6BCF\u65E5\u7B7E\u5230",
      cost: 4,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const status = await readStatus2(ctx);
        const judged = judgeStatus(status);
        if (judged.verdict !== "claimable") {
          return { status: judged.verdict, message: judged.message, credits: 0, cred: ctx.rotated };
        }
        const verdict = judgeClaim(await submitCheckin(ctx));
        if (verdict.status !== "claimed") return { ...verdict, cred: ctx.rotated };
        const after = await readStatus2(ctx);
        return {
          status: "claimed",
          message: [`\u7B7E\u5230 +${verdict.credits}`, ...streakFacts(after.payload)].join("\uFF0C"),
          credits: verdict.credits,
          cred: ctx.rotated
        };
      }
    },
    {
      id: "travel",
      label: "\u65C5\u884C\uFF1A\u9886\u5230\u7AD9\u793C\u7269\u5E76\u6D3E\u65B0\u884C\u7A0B",
      // 最坏：1 读状态 + 1 领奖 + 1 读配置 + 2 派发（第一个地点不可用时换下一个再试）
      cost: 5,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const first = await readTravelStatus(ctx);
        if (isAuthFail(first)) return { status: "login_required", message: "\u65C5\u884C\u72B6\u6001\u88AB\u62D2", credits: 0, cred: ctx.rotated };
        const state = dig(first.payload, "state");
        if (state === "arrived") {
          const claimed = await claimTravel(ctx);
          const reward = num(dig(claimed.payload, "reward_credit"));
          if (claimed.status >= 400 || reward === null) {
            return { status: "error", message: `\u5230\u7AD9\u793C\u7269\u9886\u53D6\u5931\u8D25\uFF08HTTP ${claimed.status}\uFF09\uFF0C\u672C\u6B21\u4E0D\u6D3E\u65B0\u884C\u7A0B`, credits: 0, cred: ctx.rotated };
          }
          const departed2 = await departNext(ctx);
          if (departed2.error) return { status: "error", message: `\u5230\u7AD9\u793C\u7269 +${reward}\uFF0C\u4F46${departed2.error}`, credits: reward, cred: ctx.rotated };
          if (departed2.limit) return { status: "inactive", message: `\u5230\u7AD9\u793C\u7269 +${reward}\uFF0C\u4ECA\u65E5\u65C5\u884C\u6B21\u6570\u5DF2\u7528\u5C3D`, credits: reward, cred: ctx.rotated };
          if (departed2.inflight) return { status: "waiting", message: `\u5230\u7AD9\u793C\u7269 +${reward}\uFF0C\u5DF2\u5728\u65C5\u9014\u4E2D`, credits: reward, cred: ctx.rotated };
          return { status: "waiting", message: `\u5230\u7AD9\u793C\u7269 +${reward}\uFF0C\u65B0\u884C\u7A0B\u5DF2\u6D3E \u2192 ${departed2.place}${departed2.hours ? `\uFF08${departed2.hours} \u5C0F\u65F6\u540E\u56DE\uFF09` : ""}`, credits: reward, cred: ctx.rotated };
        }
        if (state === "traveling") return { status: "waiting", message: "\u65C5\u884C\u9014\u4E2D\uFF0C\u7B49\u5230\u7AD9", credits: 0, cred: ctx.rotated };
        if (dig(first.payload, "daily_limit_reached")) {
          return { status: "inactive", message: "\u4ECA\u65E5\u65C5\u884C\u6B21\u6570\u5DF2\u7528\u5C3D", credits: 0, cred: ctx.rotated };
        }
        const departed = await departNext(ctx);
        if (departed.error) return { status: "error", message: departed.error, credits: 0, cred: ctx.rotated };
        if (departed.limit) return { status: "inactive", message: "\u4ECA\u65E5\u65C5\u884C\u6B21\u6570\u5DF2\u7528\u5C3D", credits: 0, cred: ctx.rotated };
        if (departed.inflight) return { status: "waiting", message: "\u5DF2\u5728\u65C5\u9014\u4E2D", credits: 0, cred: ctx.rotated };
        return { status: "waiting", message: `\u5DF2\u6D3E\u65B0\u884C\u7A0B \u2192 ${departed.place}${departed.hours ? `\uFF08${departed.hours} \u5C0F\u65F6\u540E\u56DE\uFF09` : ""}`, credits: 0, cred: ctx.rotated };
      }
    },
    {
      id: "blindbox",
      label: "\u5F00\u76F2\u76D2",
      // cost 是**预约**：这一步向预算申请的外部请求上界 = 1 次读额度 + OPENS_PER_ROUND 次开盒。
      // 它必须与函数里 want 的上界**同口径** —— want 也是三者取最小，其中一项就是
      // OPENS_PER_ROUND，所以这里的 6 是真话。改这里之前先读函数里那段变量说明。
      cost: 1 + OPENS_PER_ROUND,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const quota = await readQuota(ctx);
        const affordable = num(dig(quota.payload, "affordable")) || 0;
        if (affordable === 0) return { status: "ok", message: "\u80FD\u91CF\u4E0D\u591F\u5F00\u76F2\u76D2", credits: 0, cred: ctx.rotated };
        const cap = num(dig(quota.payload, "max_open_count")) || OPENS_PER_ROUND;
        const want = Math.min(affordable, cap, OPENS_PER_ROUND);
        let opened = 0;
        let credits = 0;
        const labels = [];
        for (let i = 0; i < want; i += 1) {
          const result = await openBlindbox(ctx);
          if (result.status >= 400 || codeOf(result.payload) !== 0) break;
          const items = dig(result.payload, "results") || [];
          credits += items.map((item) => firstCredit(result.payload, item)).reduce((a, b) => a + b, 0);
          for (const item of items) {
            const label = blindboxItemLabel(item);
            if (label) labels.push(label);
          }
          opened += 1;
        }
        if (opened === 0) return { status: "error", message: `\u6709 ${affordable} \u4E2A\u989D\u5EA6\u4F46\u7B2C\u4E00\u53D1\u5C31\u6CA1\u6210\uFF08\u54CD\u5E94\u5F02\u5E38\uFF09`, credits: 0, cred: ctx.rotated };
        const left = affordable - opened;
        return {
          status: left > 0 ? "partial" : "claimed",
          message: `\u5F00 ${opened} \u4E2A +${credits}${labels.length ? `\uFF1A${labels.join("\u3001")}` : ""}${left > 0 ? `\uFF0C\u8FD8\u80FD\u5F00 ${left} \u4E2A\u4E0B\u4E00\u8F6E\u518D\u5F00` : ""}`,
          credits,
          cred: ctx.rotated
        };
      }
    },
    {
      id: "lottery",
      label: "\u62BD\u5956",
      cost: 1 + DRAWS_PER_ROUND,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const chances = await readChances(ctx);
        if (isAuthFail(chances)) return { status: "login_required", message: "\u62BD\u5956\u6B21\u6570\u67E5\u8BE2\u88AB\u62D2", credits: 0, cred: ctx.rotated };
        const balance = num(dig(chances.payload, "balance")) || 0;
        if (balance === 0) return { status: "ok", message: "\u6CA1\u6709\u62BD\u5956\u673A\u4F1A", credits: 0, cred: ctx.rotated };
        const want = Math.min(balance, DRAWS_PER_ROUND);
        let drew = 0;
        let credits = 0;
        const named = [];
        let blank = 0;
        for (let i = 0; i < want; i += 1) {
          const drawn = await drawOnce(ctx);
          const code = codeOf(drawn.payload);
          if (drawn.status >= 400 || code !== null && code !== 0) break;
          const granted = drawCredit(drawn.payload);
          if (granted) {
            credits += granted;
          } else {
            const name = prizeNameOf(drawn.payload);
            if (name) named.push(name);
            else blank += 1;
          }
          drew += 1;
        }
        if (drew === 0) return { status: "error", message: `\u6709 ${balance} \u6B21\u673A\u4F1A\u4F46\u7B2C\u4E00\u53D1\u5C31\u6CA1\u6210\uFF08\u54CD\u5E94\u5F02\u5E38\uFF09`, credits: 0, cred: ctx.rotated };
        const left = balance - drew;
        const bits = [];
        if (named.length) bits.push(`\u4E0A\u6E38\u53EA\u56DE\u5956\u540D\uFF1A${named.join("\u3001")}`);
        if (blank) bits.push(`${blank} \u6B21\u4E0A\u6E38\u6CA1\u56DE\u7ED3\u679C`);
        const note2 = bits.length ? `\uFF08${bits.join("\uFF1B")}\uFF09` : "";
        return {
          status: left > 0 ? "partial" : "claimed",
          message: `\u62BD ${drew} \u6B21${credits ? ` +${credits}` : ""}${note2}${left > 0 ? `\uFF0C\u8FD8\u5269 ${left} \u6B21\u4E0B\u4E00\u8F6E\u62BD` : ""}`,
          credits,
          cred: ctx.rotated
        };
      }
    },
    {
      id: "redeem",
      label: "\u8FDE\u7B7E\u5151\u6362",
      cost: 1 + workbuddyRedeemTiers.length,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const streak = await readStreak(ctx);
        const days = num(dig(dig(streak.payload, "streak"), "days")) || 0;
        const unlocked = workbuddyRedeemTiers.filter((row) => days >= row.days);
        if (unlocked.length === 0) {
          return { status: "ok", message: `\u8FDE\u7EED\u4F7F\u7528 ${days} \u5929\uFF0C\u8FD8\u6CA1\u5230\u4EFB\u4F55\u5151\u6362\u6863`, credits: 0, cred: ctx.rotated };
        }
        let credits = 0;
        let redeemed = 0;
        const notes = [];
        for (const row of unlocked) {
          const result = await redeemTier(ctx, row.tier);
          if (result.status === 409 || result.status === 403) {
            notes.push(`${row.tier} \u5DF2\u6362\u6216\u4E0D\u591F`);
            continue;
          }
          if (result.status >= 400 || codeOf(result.payload) !== 0) {
            notes.push(`${row.tier} \u5931\u8D25`);
            continue;
          }
          const granted = firstCredit(result.payload, null);
          credits += granted;
          redeemed += 1;
          notes.push(`${row.tier} +${granted}`);
        }
        return {
          status: redeemed ? "claimed" : "ok",
          message: `${redeemed} \u6863\u5151\u6362\uFF1A${notes.join("\u3001")}`,
          credits,
          cred: ctx.rotated
        };
      }
    },
    {
      id: "tasks",
      label: "\u9886\u4EFB\u52A1\u5956\u52B1",
      // 1 读列表 + 最多 1 次批量 accept + 最多 1 次回读确认 + 最多 3 次 claim
      cost: 3 + TASKS_PER_ROUND,
      async run(ctx) {
        const guarded = await guard(ctx);
        if (guarded) return guarded;
        const listed = await readTasks(ctx);
        if (isAuthFail(listed)) return { status: "login_required", message: "\u4EFB\u52A1\u5217\u8868\u88AB\u62D2", credits: 0, cred: ctx.rotated };
        const tasks = dig(listed.payload, "tasks") || [];
        const nowMs = ctx.now * 1e3;
        const blocked = [];
        const usable = tasks.filter((task) => {
          if (task.locked === true) {
            blocked.push(`${task.task_code}\uFF08\u672A\u5230\u4E0A\u7EBF\u65F6\u95F4${task.valid_start ? `\uFF0C${String(task.valid_start).slice(0, 10)} \u89E3\u9501` : ""}\uFF09`);
            return false;
          }
          const endsAt = parseWindowEnd(task.valid_end);
          if (endsAt !== null && endsAt < nowMs) {
            blocked.push(`${task.task_code}\uFF08${fmtCST(Math.floor(endsAt / 1e3))} \u5DF2\u8FC7\u671F\uFF09`);
            return false;
          }
          return true;
        });
        const ready = usable.filter((task) => task.accept_status === "completed" && task.has_reward);
        const notAccepted = usable.filter((task) => task.accept_status === "not_accepted" && task.has_reward);
        const pending = notAccepted.filter((task) => !NO_ACCEPT_TASKS.has(task.task_code));
        const blockNote = blocked.length ? `\uFF0C\u8DF3\u8FC7 ${blocked.length} \u4E2A\u4E0D\u53EF\u9886\u7684\u4EFB\u52A1\uFF1A${blocked.join("\u3001")}` : "";
        const skipAccept = notAccepted.filter((task) => NO_ACCEPT_TASKS.has(task.task_code)).map((task) => task.task_code);
        const skipNote = skipAccept.length ? `\uFF0C\u4E0D\u8D70\u63A5\u9886\uFF1A${skipAccept.join("\u3001")}\uFF08\u8981\u5148\u5237\u65B0\u8BA2\u9605\u72B6\u6001\uFF0C\u672C\u5DE5\u5177\u4E0D\u505A\u90A3\u4E00\u6B65\uFF09` : "";
        let acceptedNote = "";
        if (pending.length > 0) {
          const batch2 = pending.slice(0, TASKS_PER_ROUND);
          const accepted = await acceptTasks(ctx, batch2.map((task) => task.task_code));
          if (accepted.status >= 400) {
            const code = codeOf(accepted.payload);
            const msg = String((accepted.payload && (accepted.payload.msg ?? accepted.payload.message)) ?? "");
            const hint = prerequisiteHint(msg);
            acceptedNote = `\uFF0C\u63A5\u9886\u5931\u8D25 HTTP ${accepted.status}${code !== null ? ` code=${code}` : ""}${hint ? ` \u2014\u2014 ${hint}` : msg ? ` ${msg}` : ""}`;
          } else {
            const perItem = acceptResults(accepted.payload);
            const rejected = perItem ? perItem.filter((row) => row.known && !row.ok) : [];
            const unknown = perItem ? perItem.filter((row) => !row.known) : [];
            if (rejected.length || unknown.length) {
              const parts = [];
              if (rejected.length) {
                parts.push(`\u63A5\u9886\u90E8\u5206\u5931\u8D25\uFF1A${rejected.map((row) => {
                  const hint = prerequisiteHint(row.message);
                  return `${row.code || "?"} ${hint || row.message || "\u4E0A\u6E38\u6CA1\u7ED9\u539F\u56E0"}`;
                }).join("\u3001")}`);
              }
              if (unknown.length) {
                parts.push(`\u63A5\u9886\u7ED3\u679C\u65E0\u6CD5\u5224\u5B9A\uFF08\u4E0A\u6E38\u8FD4\u56DE\u7684\u5F62\u72B6\u4E0D\u8BA4\u8BC6\uFF0C\u4E0D\u5F53\u4F5C\u5931\u8D25\uFF09\uFF1A${unknown.map((row) => row.code || "?").join("\u3001")}`);
              }
              acceptedNote = `\uFF0C${parts.join("\uFF1B")}`;
            } else if (perItem) {
              acceptedNote = `\uFF0C\u5DF2\u63A5\u9886 ${perItem.length} \u4E2A\u65B0\u4EFB\u52A1\uFF08\u7B49\u5B8C\u6210\u540E\u624D\u80FD\u9886\uFF09`;
            } else {
              const after = await readTasks(ctx);
              const nowCodes = new Set(batch2.map((task) => task.task_code));
              const landed = (dig(after.payload, "tasks") || []).filter((task) => nowCodes.has(task.task_code) && task.accept_status !== "not_accepted").length;
              acceptedNote = landed === batch2.length ? `\uFF0C\u5DF2\u63A5\u9886 ${landed} \u4E2A\u65B0\u4EFB\u52A1\uFF08\u7B49\u5B8C\u6210\u540E\u624D\u80FD\u9886\uFF09` : `\uFF0C\u63A5\u9886\u540E\u56DE\u8BFB\u53EA\u786E\u8BA4\u4E86 ${landed}/${batch2.length} \u4E2A\uFF0C\u5176\u4F59\u53EF\u80FD\u6CA1\u767B\u8BB0\u4E0A`;
            }
          }
        }
        if (ready.length === 0) {
          return { status: "ok", message: `\u6CA1\u6709\u5F85\u9886\u7684\u4EFB\u52A1\u5956\u52B1${blockNote}${acceptedNote}${skipNote}`, credits: 0, cred: ctx.rotated };
        }
        const batch = ready.slice(0, TASKS_PER_ROUND);
        let claimedCount = 0;
        let credits = 0;
        const failed = [];
        for (const task of batch) {
          const result = await claimTask(ctx, task.task_code);
          if (result.status >= 400) {
            const code = codeOf(result.payload);
            const msg = String((result.payload && (result.payload.msg ?? result.payload.message)) ?? "");
            failed.push(`${task.task_code} HTTP ${result.status}${code !== null ? ` code=${code}` : ""}${msg ? ` ${msg}` : ""}`.trim());
            continue;
          }
          if (dig(result.payload, "already_claimed") === true) {
            failed.push(`${task.task_code} \u4E0A\u6E38\u62A5\u5DF2\u9886\u8FC7`);
            continue;
          }
          claimedCount += 1;
          credits += num(dig(result.payload, "credit")) || 0;
        }
        const failNote = failed.length ? `\uFF0C\u5931\u8D25\uFF1A${failed.join("\uFF1B")}` : "";
        if (claimedCount === 0) return { status: "error", message: `${batch.length} \u4E2A\u4EFB\u52A1\u9886\u53D6\u5168\u90E8\u5931\u8D25${failNote}`, credits: 0, cred: ctx.rotated };
        const left = ready.length - claimedCount;
        return {
          status: left > 0 ? "partial" : "claimed",
          message: `\u9886\u5230 ${claimedCount} \u4E2A\u4EFB\u52A1\u5956\u52B1 +${credits}${failNote}${blockNote}${acceptedNote}${skipNote}${left > 0 ? `\uFF0C\u8FD8\u6709 ${left} \u4E2A\u4E0B\u4E00\u8F6E\u9886` : ""}`,
          credits,
          cred: ctx.rotated
        };
      }
    }
  ],
  // 「测试」按钮：只读签到状态与活动开关，一次写操作都不发
  async validate(ctx) {
    const guarded = await guard(ctx);
    if (guarded) return { status: guarded.status, message: guarded.message };
    const judged = judgeStatus(await readStatus2(ctx));
    if (judged.verdict === "claimable") return { status: "ok", message: "\u767B\u5F55\u6001\u6709\u6548\uFF0C\u4ECA\u65E5\u5C1A\u672A\u7B7E\u5230" };
    return { status: judged.verdict === "already" ? "ok" : judged.verdict, message: judged.message };
  }
};
async function departNext(ctx) {
  const config = await readTravelConfig(ctx);
  const locations = dig(config.payload, "locations") || [];
  if (!locations.length) return { error: "\u65C5\u884C\u914D\u7F6E\u91CC\u6CA1\u6709\u53EF\u9009\u5730\u70B9" };
  const rejected = [];
  for (const place of locations.slice(0, DEPART_ATTEMPTS)) {
    const depart = await departTravel(ctx, place.id);
    if (depart.status < 400) {
      const loc = dig(depart.payload, "location") || {};
      return {
        place: typeof loc.name === "string" && loc.name.trim() || place.name || place.id,
        hours: num(dig(depart.payload, "duration_hours")) ?? num(loc.duration_hours)
      };
    }
    const why = classifyDepartFailure(depart);
    if (why.kind === "limit") return { limit: true };
    if (why.kind === "traveling") return { inflight: true };
    if (why.kind === "location") {
      rejected.push(place.name || place.id);
      continue;
    }
    return { error: `\u6D3E\u65B0\u884C\u7A0B\u5931\u8D25\uFF1A${why.message}` };
  }
  return { error: `\u6D3E\u65B0\u884C\u7A0B\u5931\u8D25\uFF1A${rejected.join("\u3001")} \u90FD\u4E0D\u53EF\u7528` };
}
__name(departNext, "departNext");
async function guard(ctx) {
  const result = await ensureAuth(ctx);
  if (result.rotated) ctx.rotated = result.rotated;
  if (result.error) {
    return {
      status: result.authFailed ? "login_required" : "error",
      message: result.error,
      credits: 0,
      cred: result.rotated || null
    };
  }
  return null;
}
__name(guard, "guard");

// src/tools/69yun/api.js
var HOST3 = "69yun69.com";
var BASE2 = `https://${HOST3}`;
var LOGIN_PAGE = "/auth/login";
var USER_PAGE = "/user";
var CHECKIN2 = "/user/checkin";
var USER_AGENT2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
var SESSION_BACKOFF_MS = [500, 1e3, 1500];
var timeoutMs4 = /* @__PURE__ */ __name((config) => {
  const raw = Number(config.timeoutMs);
  return Number.isFinite(raw) && raw > 0 ? raw : 15e3;
}, "timeoutMs");
function extractCookies(response) {
  const pairs = [];
  if (response.headers.getSetCookie) {
    for (const cookie of response.headers.getSetCookie()) {
      const nameValue = cookie.split(";")[0];
      if (nameValue && nameValue.includes("=")) pairs.push(nameValue);
    }
  } else {
    const header = response.headers.get("set-cookie");
    if (header) {
      for (const part of header.split(/,\s*(?=[a-zA-Z0-9_-]+\s*=)/)) {
        const nameValue = part.split(";")[0];
        if (nameValue && nameValue.includes("=")) pairs.push(nameValue);
      }
    }
  }
  return pairs;
}
__name(extractCookies, "extractCookies");
function cookieString(pairs) {
  return pairs.join("; ");
}
__name(cookieString, "cookieString");
function mergeCookies(existing, newPairs) {
  const map = /* @__PURE__ */ new Map();
  for (const pair of existing) {
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.substring(0, eq).trim(), pair);
  }
  for (const pair of newPairs) {
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.substring(0, eq).trim(), pair);
  }
  return Array.from(map.values());
}
__name(mergeCookies, "mergeCookies");
async function call3(ctx, { path, method = "GET", body, cookie, contentType, referer, redirect }) {
  const headers = {
    "User-Agent": USER_AGENT2,
    Accept: "application/json, text/plain, */*"
  };
  if (cookie && cookie.length) headers.Cookie = cookieString(cookie);
  if (contentType) headers["Content-Type"] = contentType;
  if (referer) headers.Referer = referer;
  if (method === "POST") headers.Origin = BASE2;
  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs4(ctx.config))
  };
  if (body !== void 0) init.body = body;
  if (redirect) init.redirect = redirect;
  const response = await ctx.fetch(BASE2 + path, init);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
  }
  return { status: response.status, payload, text, cookies: extractCookies(response) };
}
__name(call3, "call");
async function login(ctx) {
  const email = ctx.account.cred.email;
  const password = ctx.account.cred.password;
  if (!email || !password) return { error: "\u8D26\u53F7\u7F3A\u5C11\u90AE\u7BB1\u6216\u5BC6\u7801", kind: "auth" };
  const init = await call3(ctx, { path: LOGIN_PAGE, referer: BASE2, redirect: "manual" });
  let cookies = init.cookies;
  const login2 = await call3(ctx, {
    path: LOGIN_PAGE,
    method: "POST",
    body: JSON.stringify({ email, passwd: password, remember_me: "on", code: "" }),
    contentType: "application/json",
    cookie: cookies,
    referer: BASE2 + LOGIN_PAGE,
    redirect: "manual"
  });
  if (login2.status !== 200 || !login2.payload || login2.payload.ret !== 1) {
    const msg = login2.payload && login2.payload.msg ? login2.payload.msg : `HTTP ${login2.status} ${truncate(login2.text, 80)}`;
    const kind = login2.status === 429 ? "rate" : login2.status >= 500 || login2.status >= 300 && login2.status < 400 ? "transient" : "auth";
    return { error: `\u767B\u5F55\u5931\u8D25\uFF1A${msg}`, kind };
  }
  cookies = mergeCookies(cookies, login2.cookies);
  if (cookies.length === 0) return { error: "\u767B\u5F55\u6210\u529F\u4F46\u672A\u83B7\u53D6\u5230 Cookie", kind: "transient" };
  for (let i = 0; i < SESSION_BACKOFF_MS.length; i++) {
    await new Promise((r) => setTimeout(r, SESSION_BACKOFF_MS[i]));
    const verify = await call3(ctx, {
      path: USER_PAGE,
      cookie: cookies,
      referer: BASE2 + LOGIN_PAGE,
      redirect: "manual"
    });
    if (verify.status === 200 || verify.status === 304) {
      return { cookie: cookieString(cookies) };
    }
    if (verify.status >= 300 && verify.status < 400 && i < SESSION_BACKOFF_MS.length - 1) continue;
    if (verify.status >= 400) {
      return { error: `\u4F1A\u8BDD\u9A8C\u8BC1\u5F02\u5E38\uFF1AHTTP ${verify.status}`, kind: "transient" };
    }
  }
  return { error: `\u767B\u5F55\u6210\u529F\u4F46 session \u59CB\u7EC8\u672A\u5C31\u7EEA\uFF08\u8F6E\u8BE2 ${SESSION_BACKOFF_MS.length} \u6B21\uFF09`, kind: "transient" };
}
__name(login, "login");
var TRAFFIC_RE = /获得了\s*([\d.]+)\s*(TB|GB|MB|KB|PB)\b/i;
var RANK_RE = /尊贵的\s*([^，,。]+)/;
function resultLine(msg) {
  const line = String(msg || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
  return line.replace(/[.。…]+$/, "");
}
__name(resultLine, "resultLine");
async function checkin(ctx, cookie) {
  const result = await call3(ctx, {
    path: CHECKIN2,
    method: "POST",
    cookie: cookie ? cookie.split("; ").filter(Boolean) : [],
    referer: BASE2 + USER_PAGE,
    redirect: "manual"
  });
  if (result.status >= 300 && result.status < 400) {
    return { authFailed: true };
  }
  if (result.status !== 200) {
    return { error: `\u7B7E\u5230\u8BF7\u6C42\u5931\u8D25\uFF1AHTTP ${result.status} ${truncate(result.text, 80)}` };
  }
  if (!result.payload) {
    return { error: `\u7B7E\u5230\u54CD\u5E94\u4E0D\u662F JSON\uFF1A${truncate(result.text, 80)}` };
  }
  const ret = result.payload.ret;
  const msg = result.payload.msg || "";
  if (ret === 1) {
    const line = resultLine(msg);
    const traffic = line.match(TRAFFIC_RE);
    const rank = line.match(RANK_RE);
    const amount = traffic ? `${traffic[1]}${traffic[2].toUpperCase()}` : "";
    return {
      status: "claimed",
      message: amount ? `\u7B7E\u5230 +${amount}${rank ? `\uFF08${rank[1].trim()}\uFF09` : ""}` : line || "\u7B7E\u5230\u6210\u529F"
    };
  }
  if (ret === 0) {
    const line = resultLine(msg);
    const rank = line.match(RANK_RE);
    return {
      status: "already",
      message: rank ? `\u4ECA\u65E5\u5DF2\u7B7E\u5230\uFF08${rank[1].trim()}\uFF09` : line || "\u4ECA\u65E5\u5DF2\u7B7E\u5230"
    };
  }
  return { status: "error", message: `\u7B7E\u5230\u8FD4\u56DE ret=${ret}\uFF1A${resultLine(msg)}` };
}
__name(checkin, "checkin");
var yun69Hosts = [HOST3];

// src/tools/69yun/index.js
var yun_default = {
  id: "69yun",
  name: "69 \u4E91",
  order: 40,
  summary: "\u6BCF\u5929\u7B7E\u5230\u9886\u53D6\u673A\u573A\u6D41\u91CF",
  // 工具级配置：只有超时。域名写死在 api.js（就这一个机场）。
  config: [
    {
      key: "timeoutMs",
      label: "\u8BF7\u6C42\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09",
      type: "text",
      placeholder: "15000",
      help: "\u7559\u7A7A\u5373\u7528 15000\u3002\u673A\u573A\u54CD\u5E94\u53EF\u80FD\u6BD4 IDE \u63A5\u53E3\u6162\uFF0C\u4E0D\u5EFA\u8BAE\u4F4E\u4E8E 10000"
    }
  ],
  // 账号级凭据。
  // cookie 是 readonly+secret：不在表单里出现，由登录流程自动写回 KV。
  // 跟 Qoder 的 accessToken 一样，用户不需要手动碰它。
  creds: [
    {
      key: "email",
      label: "\u90AE\u7BB1",
      type: "text",
      required: true,
      help: "\u767B\u5F55 69 \u4E91\u7528\u7684\u90AE\u7BB1\uFF0C\u540C\u65F6\u4F5C\u4E3A\u8D26\u53F7\u7684\u552F\u4E00\u952E"
    },
    {
      key: "password",
      label: "\u5BC6\u7801",
      type: "password",
      required: true,
      secret: true,
      help: "\u767B\u5F55\u5BC6\u7801\u3002Cookie \u5931\u6548\u65F6\u7528\u5B83\u91CD\u65B0\u767B\u5F55"
    },
    {
      key: "cookie",
      label: "\u4F1A\u8BDD Cookie",
      type: "textarea",
      readonly: true,
      secret: true,
      help: "\u767B\u5F55\u540E\u81EA\u52A8\u4FDD\u5B58\uFF0C\u65E0\u9700\u624B\u52A8\u586B\u5199\u3002\u5931\u6548\u65F6\u4F1A\u81EA\u52A8\u7528\u90AE\u7BB1\u5BC6\u7801\u91CD\u65B0\u767B\u5F55"
    }
  ],
  // uid 直接用邮箱。sanitizeUid 会剥掉 @，但邮箱的本地+域名组合后仍然唯一。
  uidOf: /* @__PURE__ */ __name((ctx) => String(ctx.values.email || "").trim(), "uidOf"),
  schedule: {
    // 机场签到 0 点刷新，没有特定发放窗口（跟 Trae/WorkBuddy 一样）。
    resetHour: 0,
    notBeforeHour: 0,
    minIntervalSec: 1800,
    maxDaily: 10,
    // 退避阶梯，**单位是分钟**（内核的 backoffSec 会 ×60，别写成秒）。
    // 只有上游回 429（真限频）时步骤才产出 rate_limited，而内核也只在那个状态下读它。
    // cron 是 30 分钟一轮，所以前两档在下一轮醒来时早已过期 —— 实际节奏由 30 分钟那档
    // 与 cron 共同决定；留着前两档是为了 cron 变密时不必再动这里。
    backoff: [5, 10, 30]
  },
  hosts: yun69Hosts,
  // 最坏情况 cost = 7（逐笔数得出来）：
  //   1（checkin 被 3xx）+ 1（GET 登录页）+ 1（POST 登录）+ 3（轮询 session）+ 1（再 checkin）
  // 声明 8 = 7 + 1 笔**保守余量**，那 1 笔没有对应的具体代码路径 —— 轮询在最后一次仍是
  // 3xx 时直接落尾部的 return，不多发请求；Set-Cookie 分几次下发也都在同一个响应里。
  // 留着它是因为**往小了改才是危险方向**：低于真实上界会让 fits() 发出一张装不下的
  // 假票，而多预约一次只是让调度少排一个账号。正常情况（Cookie 有效）只花 1 次。
  steps: [
    {
      id: "checkin",
      label: "\u7B7E\u5230\u9886\u6D41\u91CF",
      cost: 8,
      async run(ctx) {
        const existingCookie = ctx.account.cred.cookie || "";
        let cookie = existingCookie;
        let rotated = null;
        if (cookie) {
          const result2 = await checkin(ctx, cookie);
          if (!result2.authFailed) {
            return wrap(result2, rotated);
          }
        }
        const login2 = await login(ctx);
        if (login2.error) {
          if (login2.kind === "rate") {
            return { status: "rate_limited", message: login2.error, credits: 0, cred: null };
          }
          if (login2.kind === "transient") {
            return { status: "waiting", message: login2.error, credits: 0, cred: null };
          }
          return {
            status: "login_required",
            message: login2.error,
            credits: 0,
            cred: null
          };
        }
        cookie = login2.cookie;
        rotated = { cookie };
        const result = await checkin(ctx, cookie);
        if (result.authFailed) {
          return {
            status: "error",
            message: "\u91CD\u65B0\u767B\u5F55\u540E\u7B7E\u5230\u4ECD\u88AB\u91CD\u5B9A\u5411\uFF0Csession \u53EF\u80FD\u5F02\u5E38",
            credits: 0,
            cred: rotated
          };
        }
        return wrap(result, rotated);
      }
    }
  ],
  // 「测试」按钮：只登录，不发签到请求。验证邮箱密码是否正确。
  async validate(ctx) {
    const login2 = await login(ctx);
    if (login2.error) {
      if (login2.kind === "rate") return { status: "rate_limited", message: login2.error };
      if (login2.kind === "transient") return { status: "error", message: login2.error };
      return { status: "login_required", message: login2.error };
    }
    ctx.account.cred.cookie = login2.cookie;
    return { status: "ok", message: "\u767B\u5F55\u6210\u529F" };
  }
};
function wrap(result, rotated) {
  if (result.error) {
    return { status: "error", message: result.error, credits: 0, cred: rotated };
  }
  return { status: result.status, message: result.message, credits: 0, cred: rotated };
}
__name(wrap, "wrap");

// src/tools/index.js
var REGISTERED = [qoder_default, trae_default, workbuddy_default, yun_default];
function checkToolContract(tool) {
  const bad = /* @__PURE__ */ __name((msg) => {
    throw new Error(`\u5DE5\u5177\u6CE8\u518C\u8868\u4E0D\u5B8C\u6574\uFF1A${tool && tool.id} \u2014 ${msg}`);
  }, "bad");
  if (!tool || !tool.id || !tool.name) bad("\u7F3A\u5C11 id \u6216 name");
  if (!Array.isArray(tool.steps) || tool.steps.length === 0) bad("steps \u5FC5\u987B\u662F\u975E\u7A7A\u6570\u7EC4");
  if (tool.steps.some((s) => !s.id || !Number.isFinite(s.cost) || s.cost <= 0)) bad("\u6BCF\u4E2A\u6B65\u9AA4\u5FC5\u987B\u6709 id \u4E0E\u6B63\u6570 cost");
  if (tool.steps.some((s) => typeof s.run !== "function")) bad("\u6BCF\u4E2A\u6B65\u9AA4\u5FC5\u987B\u5B9E\u73B0 run()");
  if (!tool.schedule) bad("\u5FC5\u987B\u58F0\u660E schedule");
  if (!Array.isArray(tool.schedule.backoff)) bad("schedule.backoff \u5FC5\u987B\u662F\u6570\u7EC4");
  if (!Array.isArray(tool.creds)) bad("\u5FC5\u987B\u58F0\u660E creds \u6570\u7EC4");
  if (!Array.isArray(tool.hosts) || tool.hosts.length === 0) bad("\u5FC5\u987B\u58F0\u660E\u975E\u7A7A hosts \u6570\u7EC4\uFF08\u51FA\u53E3\u57DF\u540D\u767D\u540D\u5355\uFF09");
  if (!tool.uidOf) bad("\u5FC5\u987B\u58F0\u660E uidOf\uFF08\u51FD\u6570\uFF1A\u62FF\u5230\u8868\u5355\u503C\uFF0C\u8FD4\u56DE\u8D26\u53F7\u6807\u8BC6\uFF09");
  if (typeof tool.uidOf !== "function") bad("uidOf \u5FC5\u987B\u662F\u51FD\u6570");
  if ([...tool.config || [], ...tool.creds].some((f) => f.key === "pwd" || f.key === "label")) {
    bad("\u5B57\u6BB5 key \u4E0D\u5F97\u4F7F\u7528\u4FDD\u7559\u5B57 pwd / label");
  }
}
__name(checkToolContract, "checkToolContract");
for (const tool of REGISTERED) checkToolContract(tool);
var TOOLS = [...REGISTERED].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
function findTool(id) {
  const wanted = String(id ?? "");
  return TOOLS.find((tool) => tool.id === wanted) || null;
}
__name(findTool, "findTool");

// src/version.js
var VERSION = "2026-10-02:1500";

// src/ui/layout.js
var CSS = `
:root{color-scheme:light dark;
  --bg:#f6f7f9;--panel:#fff;--panel2:#fafbfc;--panel3:#f1f3f6;
  --line:#e8eaee;--line2:#dfe2e7;--text:#1a1e24;--muted:#67707b;--faint:#98a1ab;
  --accent:#c9551d;--accent-weak:#fbeee6;
  --ok:#1c7f47;--ok-bg:#e7f5ed;--info:#2b62d9;--info-bg:#e9f0fd;
  --warn:#96590a;--warn-bg:#fbf1df;--bad:#ad232c;--bad-bg:#fbe9ea;
  --neu:#5a636e;--neu-bg:#edeff1;--teal:#0f6f72;--teal-bg:#e4f2f2;
  --radius:13px;--radius-sm:8px;--shadow:0 1px 2px rgba(22,24,32,.06),0 10px 26px -14px rgba(22,24,32,.16)}
@media (prefers-color-scheme:dark){:root{color-scheme:light dark;
  --bg:#111418;--panel:#191d22;--panel2:#1d2228;--panel3:#23282f;
  --line:#2a3138;--line2:#39424c;--text:#e5e9ee;--muted:#97a1ad;--faint:#6d7783;
  --accent:#f08a4b;--accent-weak:#2b1d15;
  --ok:#4ec389;--ok-bg:#152a1f;--info:#6ea3ff;--info-bg:#152033;
  --warn:#dfa254;--warn-bg:#2b2014;--bad:#f1787f;--bad-bg:#311719;
  --neu:#96a0ac;--neu-bg:#232930;--teal:#4fb2b6;--teal-bg:#12272a;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 12px 28px -18px rgba(0,0,0,.7)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);line-height:1.55;font-size:14px;
  font-family:ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:20px 18px 72px}
a{color:var(--accent)}
code,.mono,.num{font-family:ui-monospace,"Cascadia Mono",Consolas,"Sarasa Mono SC",monospace}
code{font-size:12px;background:var(--panel3);padding:1px 5px;border-radius:4px}
.num{font-size:12.5px;white-space:nowrap}
.dim{color:var(--faint)}
.top{display:flex;align-items:center;gap:16px;background:var(--panel);border:1px solid var(--line);
  border-radius:var(--radius);padding:11px 15px;box-shadow:var(--shadow);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:8px;font-weight:650;font-size:15px;text-decoration:none;color:var(--text)}
.brand .mark{width:22px;height:22px;border-radius:6px;background:var(--accent);color:#fff;display:grid;
  place-items:center;font-size:12px;font-weight:700}
.nav{display:flex;gap:2px}
.nav a{color:var(--muted);text-decoration:none;padding:6px 12px;border-radius:var(--radius-sm);font-size:13.5px}
.nav a:hover{background:var(--panel3);color:var(--text)}
.nav a.on{background:var(--accent-weak);color:var(--accent);font-weight:600}
.top .right{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--faint);font-size:12.5px}
.h{display:flex;align-items:center;gap:10px;margin:22px 0 10px;flex-wrap:wrap}
h2{margin:0;font-size:17px;font-weight:650;letter-spacing:-.2px}
.sub{color:var(--muted);font-size:12.5px}
.spacer{margin-left:auto}
.grid{display:grid;gap:12px}
.grid.cols3{grid-template-columns:repeat(auto-fit,minmax(290px,1fr))}
.split{display:grid;grid-template-columns:minmax(0,340px) minmax(0,1fr);gap:14px;align-items:start}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);overflow:hidden;transition:border-color .15s}
/* \u60AC\u505C\u5FAE\u53CD\u9988\uFF1A\u8FB9\u6846\u4EAE\u4E00\u6863\u5C31\u591F\uFF0C\u4E0D\u52A0\u4F4D\u79FB\u548C\u9634\u5F71\u53D8\u5316 \u2014\u2014 \u5361\u7247\u662F\u4FE1\u606F\u5BB9\u5668\uFF0C\u4E0D\u662F\u6309\u94AE */
.card:hover{border-color:var(--line2)}
.card .hd{display:flex;align-items:center;gap:10px;padding:16px 16px 0}
.card .hd .id{display:flex;align-items:center;gap:9px;min-width:0}
.card .hd .t{font-weight:650;font-size:14.5px}
/* \u63CF\u8FF0\u4E0D\u622A\u65AD\u7684\u8BDD\uFF0C\u957F\u4E00\u70B9\u5C31\u4F1A\u628A\u300C\u7BA1\u7406 \u203A\u300D\u6324\u51FA\u5361\u7247\uFF08.hd \u4E0D\u6362\u884C\uFF09\u3002
   \u5305\u540D\u5B57\u548C\u63CF\u8FF0\u7684\u90A3\u5C42 div \u4E5F\u8981 min-width:0\uFF0C\u5426\u5219 flex \u5B50\u9879\u4E0D\u80AF\u7F29 */
.card .hd .id > div{min-width:0}
.card .hd .d{color:var(--faint);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* \u53EA\u4F5C\u7528\u4E8E\u6587\u5B57\u94FE\u63A5\uFF08\u5982\u300C\u7BA1\u7406 \u203A\u300D\uFF09\uFF1A\u8FD9\u6761\u89C4\u5219\u7684\u4F18\u5148\u7EA7\u9AD8\u4E8E .btn.pri\uFF0C
   \u4E0D\u6536\u7A84\u4F1A\u628A\u5361\u7247\u5934\u91CC\u4E3B\u6309\u94AE\u7684\u767D\u5B57\u8986\u76D6\u6210\u6A59\u8272 \u2014\u2014 \u6A59\u5E95\u6A59\u5B57\uFF0C\u6587\u5B57\u9690\u5F62 */
.card .hd a:not(.btn){margin-left:auto;color:var(--accent);text-decoration:none;font-size:12.5px}
.card .hd a:not(.btn):hover{text-decoration:underline}
/* \u56FE\u6807\u662F\u5185\u8054 data URI\uFF08\u89C1 icons.js \u7684\u7406\u7531\uFF1A\u5FC5\u987B\u5728\u53E3\u4EE4\u95F8\u540E\uFF09\u300264\xD764 \u7F29\u5230 22px\uFF0C
   \u4EA4\u7ED9\u6D4F\u89C8\u5668\u53CC\u7EBF\u6027\u63D2\u503C\uFF1B\u53EA\u505A\u5706\u89D2\u4E0E\u53BB\u767D\u8FB9\uFF0C\u4E0D\u52A0\u6EE4\u955C \u2014\u2014 \u56FE\u6807\u662F\u914D\u89D2\u3002 */
.ico{width:22px;height:22px;border-radius:5px;flex:none;display:block}
.card .bd{padding:14px 16px 18px}
.pane{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:16px 18px;box-shadow:var(--shadow)}
.alert{display:flex;gap:8px;align-items:flex-start;padding:11px 16px;font-size:12.5px;line-height:1.45}
.alert.bad{background:var(--bad-bg);color:var(--bad)}
.alert.warn{background:var(--warn-bg);color:var(--warn)}
.alert.info{background:var(--info-bg);color:var(--info)}
.alert svg{flex:none;margin-top:1px}
.alert a{color:inherit;text-decoration:underline}
.badge{display:inline-flex;align-items:center;gap:5px;padding:2.5px 8px 2.5px 6px;border-radius:7px;
  font-size:12px;font-weight:600;white-space:nowrap;line-height:1.5}
.badge svg{width:12px;height:12px;flex:none}
.b-claimed,.b-ok{background:var(--ok-bg);color:var(--ok)}
.b-already{background:var(--teal-bg);color:var(--teal)}
.b-inactive,.b-skipped{background:var(--neu-bg);color:var(--neu)}
.b-pending,.b-partial,.b-rate{background:var(--warn-bg);color:var(--warn)}
.b-defer,.b-wait{background:var(--info-bg);color:var(--info)}
.b-login,.b-error{background:var(--bad-bg);color:var(--bad)}
.btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;padding:6px 13px;
  border-radius:var(--radius-sm);border:1px solid var(--line2);background:var(--panel);color:var(--text);
  cursor:pointer;white-space:nowrap;text-decoration:none}
.btn:hover{background:var(--panel3)}
.btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.ghost{border-color:transparent;color:var(--accent);background:transparent;padding:6px 8px}
.btn.ghost:hover{background:var(--accent-weak)}
.btn.danger{color:var(--bad);background:transparent}
.btn.danger:hover{background:var(--bad-bg);border-color:var(--bad)}
.btn.sm{font-size:11.5px;padding:3px 9px}
.acts{display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap}
.tw{overflow-x:auto;border-radius:var(--radius)}
table.t{width:100%;min-width:640px;border-collapse:collapse;background:var(--panel);font-size:13px}
table.t th{text-align:left;font-weight:600;color:var(--muted);font-size:11.5px;letter-spacing:.3px;
  padding:11px 13px;background:var(--panel2);border-bottom:1px solid var(--line);white-space:nowrap}
table.t td{padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:middle}
table.t tr:last-child td{border-bottom:0}
.kv{display:flex;justify-content:space-between;gap:12px;padding:7px 0;font-size:13px;border-top:1px dashed var(--line)}
.kv:first-of-type{border-top:0}
/* \u9996\u9875\u5361\u7247\u7684 .bd \u4EE5\u8FDB\u5EA6\u6761\u5F00\u5934 \u2014\u2014 \u5B83\u548C .kv \u540C\u4E3A div\uFF0C:first-of-type \u547D\u4E2D\u7684\u662F
   .prog \u800C\u4E0D\u662F\u7B2C\u4E00\u6761 .kv\uFF0C\u4E0A\u9762\u7684\u89C4\u5219\u5728\u9996\u9875\u4ECE\u6765\u6CA1\u751F\u6548\u8FC7\u3002\u7528\u76F8\u90BB\u9009\u62E9\u5668\u76F4\u63A5\u8868\u8FBE\uFF1A
   \u8FDB\u5EA6\u6761\u81EA\u5E26\u4E0B\u8FB9\u8DDD\uFF0C\u7D27\u8DDF\u7684\u884C\u4E0D\u9700\u8981\u518D\u6765\u4E00\u9053\u865A\u7EBF\u3002 */
.prog + .kv{border-top:0}
.kv .k{color:var(--muted)}
.kv .v{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12.5px;text-align:right;overflow-wrap:anywhere}
/* .kv .k \u91CC\u5E26\u56FE\u6807\u65F6\u5FC5\u987B\u663E\u5F0F flex\uFF1A.ico \u662F display:block\uFF08\u4E3A\u4E86\u4E0D\u5360\u57FA\u7EBF\u4E0B\u7684\u7A7A\u9699\uFF09\uFF0C
   \u4E0D\u5957 flex \u5B83\u5C31\u4F1A\u7AD6\u5728\u6587\u5B57\u4E0A\u65B9\uFF0C\u800C\u4E0D\u662F\u50CF\u8BBE\u8BA1\u7A3F\u90A3\u6837\u6392\u5728\u540D\u5B57\u5DE6\u8FB9\u3002 */
.kv .k:has(.ico){display:flex;align-items:center;gap:9px}
.field{margin:0 0 15px}
.field label{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;margin-bottom:5px;flex-wrap:wrap}
.field .help{color:var(--muted);font-weight:400;font-size:12px;margin-top:4px;line-height:1.45}
.field input,.field textarea,.field select{width:100%;font:inherit;font-size:13px;padding:7px 10px;
  border:1px solid var(--line2);border-radius:var(--radius-sm);background:var(--panel);color:var(--text)}
.field textarea{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12px;min-height:88px;
  resize:vertical;line-height:1.5}
.field input:focus,.field textarea:focus,.field select:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-weak)}
.field.bad input,.field.bad textarea,.field.bad select{border-color:var(--bad)}
.err{color:var(--bad);font-size:12px;margin-top:4px}
.req{color:var(--bad)}
.chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1.5px 7px;border-radius:99px;
  background:var(--accent-weak);color:var(--accent);font-weight:600}
.chip.off{background:var(--warn-bg);color:var(--warn)}
/* \u5DE5\u5177\u5F00\u5173\uFF08\u62E8\u52A8\u5F0F\uFF09\u3002\u62E8\u6746\u662F\u4E00\u4E2A\u63D0\u4EA4\u6309\u94AE\uFF1Acheckbox \u70B9\u4E86\u53EA\u4F1A\u6253\u52FE\u3001\u4E0D\u4F1A\u63D0\u4EA4\u8868\u5355\uFF0C
   \u96F6 JS \u4E0B\u5B83\u6C38\u8FDC\u53D1\u4E0D\u51FA\u8BF7\u6C42\u3002\u72B6\u6001\u7531\u670D\u52A1\u7AEF\u6E32\u67D3\u6210 .on \u2014\u2014 \u8FD0\u884C\u4E2D\u4EAE\u7EFF\u3001\u6ED1\u5757\u9760\u53F3\uFF1B
   \u505C\u7528\u53D8\u7070\u3001\u6ED1\u5757\u9760\u5DE6\u3002\u70B9\u4E00\u4E0B = \u63D0\u4EA4 = \u7FFB\u8F6C\uFF0Caria-pressed \u4EA4\u7ED9\u8BFB\u5C4F\u8F6F\u4EF6\u3002
   \u6ED1\u5757 top:50% + margin-top:-7.5px \u5782\u76F4\u5C45\u4E2D\uFF0815px \u7684\u4E00\u534A\uFF0C\u5199 -9 \u4F1A\u504F\u4E0A\uFF09\uFF1B
   \u6C34\u5E73\u884C\u7A0B 17px\uFF1A\u8F68\u9053\u603B\u5BBD 38\uFF08\u542B\u4E24\u8FB9\u8FB9\u6846\uFF09\uFF0C\u6ED1\u5757 15\uFF0C\u4E24\u7AEF\u5404\u7559 2px\u3002 */
.sw{display:inline-flex;align-items:center;margin:0}
.sw-b{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;gap:8px;
  position:relative;background:none;border:0;padding:0;cursor:pointer;
  font-size:12.5px;color:var(--muted);user-select:none}
.sw-b::before{content:"";width:38px;height:21px;border-radius:99px;flex:none;
  background:var(--panel3);border:1px solid var(--line2);transition:background .15s}
.sw-b::after{content:"";position:absolute;left:3px;top:50%;margin-top:-7.5px;
  width:15px;height:15px;border-radius:99px;background:var(--panel);
  box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .15s}
.sw-b.on::before{background:var(--ok);border-color:var(--ok)}
.sw-b.on::after{transform:translateX(17px)}
.sw-b.on .sw-t{color:var(--ok);font-weight:600}
.sw-b:focus-visible::before{box-shadow:0 0 0 3px var(--accent-weak)}
.sw-t{white-space:nowrap}
/* \u9996\u9875\u5361\u7247\u91CC\u8FD9\u4E9B\u884C\u7684\u503C\u90FD\u77ED\uFF08\u5FBD\u7AE0\u3001\u65F6\u95F4\u3001\u6570\u5B57\u3001\u62E8\u6746\uFF09\uFF0C\u7A84\u5C4F\u4E5F\u4E0D\u8BB8\u8DDF\u7740 .kv \u7AD6\u6392\uFF1A
   \u6807\u7B7E\u5728\u5DE6\u3001\u503C\u9760\u53F3\uFF0C\u8DDF\u5BBD\u5C4F\u4E00\u4E2A\u6837\u3002\u957F\u503C\u7684\u884C\uFF08\u65E5\u5FD7\u8BE6\u60C5\u7684\u952E\u540D\u3001\u8BF4\u660E\u9875\u6E05\u5355\uFF09\u4ECD\u8D70\u7AD6\u6392\u3002 */
.kv.kv-row{flex-direction:row;justify-content:space-between;align-items:center}
.kv.kv-row .v{text-align:right}
/* \u5DE5\u5177\u5361\u7247\u7684\u8D26\u53F7\u8FDB\u5EA6\u6761\u3002\u4E00\u683C\u4E00\u4E2A\u8D26\u53F7\uFF1Adone \u5DF2\u7ED3\u3001bad \u5F85\u5904\u7406\u3001wait \u987A\u5EF6/\u9650\u9891\u3002
   <i> \u662F\u7A7A\u5143\u7D20\uFF0C\u6CA1\u6709\u663E\u5F0F\u5BBD\u9AD8\u5C31\u662F 0\xD70 \u2014\u2014 \u6574\u6761\u8FDB\u5EA6\u6761\u4F1A\u4EC0\u4E48\u90FD\u4E0D\u5269\u3002 */
.prog{display:flex;gap:3px;align-items:center;margin:2px 0 9px;flex-wrap:wrap}
.prog i{width:16px;height:5px;border-radius:99px;background:var(--panel3);flex:none}
.prog i.done{background:var(--ok)}
.prog i.bad{background:var(--bad)}
.prog i.wait{background:var(--warn)}
.prog .n{font-size:12px;color:var(--muted);margin-left:6px}
/* \u5DE5\u5177\u7BA1\u7406\u9875\u300C\u6B65\u9AA4\u300D\u5217\u7684\u8272\u5757\u3002\u8FD9\u5957\u7C7B\u4E00\u76F4\u5728 pages/tool.js \u91CC\u88AB\u6E32\u67D3\uFF0C\u5374\u4ECE\u6CA1\u8FDB\u8FC7\u672C\u6587\u4EF6 \u2014\u2014
   <i> \u662F\u7A7A\u5143\u7D20\uFF0C\u6CA1\u6709\u663E\u5F0F\u5BBD\u9AD8\u5C31\u662F 0\xD70\uFF0C\u6574\u5217\u4EC0\u4E48\u90FD\u770B\u4E0D\u89C1\uFF0C\u800C\u4E14\u6302\u5728 0\xD70 \u5143\u7D20\u4E0A\u7684
   title \u4E5F\u6CA1\u6709\u60AC\u505C\u9762\u79EF\uFF0C\u7B49\u4E8E"\u60AC\u505C\u770B\u6BCF\u4E00\u6B65\u5904\u7F6E"\u8FD9\u53E5\u8BDD\u662F\u5047\u7684\u3002
   \u4E0E .prog \u540C\u4E00\u4E2A\u5F62\u72B6\uFF0C\u53EA\u662F\u591A\u4E24\u79CD\u72B6\u6001\uFF08skip=\u672A\u5F00\u59CB\u3001bad=\u5931\u8D25\uFF09\u3002 */
.steps{display:flex;gap:3px;align-items:center;flex-wrap:wrap}
.steps i{width:14px;height:5px;border-radius:99px;background:var(--panel3);flex:none;cursor:help}
.steps i.ok{background:var(--ok)}
.steps i.wait{background:var(--warn)}
.steps i.skip{background:var(--neu)}
.steps i.bad{background:var(--bad)}
.note{font-size:11.5px;color:var(--muted);margin-top:4px}
/* \u8D26\u53F7\u5217\uFF1A\u540D\u5B57\u4E0E\u5907\u6CE8\u540D\u5DE6\u53F3\u6392\u5E03\uFF1Bmin-width:0 \u662F flex \u5B50\u9879\u80FD\u7701\u7565\u53F7\u6536\u7A84\u7684\u524D\u63D0 */
.acc{display:flex;align-items:center;gap:6px;min-width:0}
.acc .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
/* \u6700\u8FD1\u8FD0\u884C\u6D41\u3002\u663E\u5F0F flex \u4E0D\u662F\u4E3A\u4E86\u597D\u770B\uFF1A<a> \u9ED8\u8BA4\u662F\u884C\u5185\u5143\u7D20\uFF0C\u4E0D\u5199\u8FD9\u4E00\u6761
   N \u6761\u8BB0\u5F55\u4F1A\u9996\u5C3E\u76F8\u8FDE\u6210\u4E00\u6BB5\u6587\u5B57\u3002who \u56FA\u5B9A\u5BBD + \u7701\u7565\u53F7\uFF0Cm \u5403\u6389\u5269\u4F59\u7A7A\u95F4\uFF0C
   \u65F6\u95F4\u6233\u56E0\u6B64\u5728\u6BCF\u4E00\u884C\u7684\u540C\u4E00\u5217\u5BF9\u9F50\u3002 */
.flowitem{display:flex;gap:9px;align-items:center;padding:8px 0;text-decoration:none;color:inherit;
  border-top:1px solid var(--line);font-size:13px}
.flowitem:first-child{border-top:0}
.flowitem:hover{background:var(--panel2)}
.flowitem .who{flex:none;width:96px;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:12px;color:var(--muted)}
.flowitem .m{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12.5px;color:var(--muted)}
.flowitem .when{flex:none;font-size:11.5px;color:var(--faint);white-space:nowrap}
/* \u53C2\u6570\u83B7\u53D6\u6559\u7A0B\u3002\u5185\u5BB9\u6765\u81EA tools \u4FA7\u7684\u6570\u636E\uFF0C\u6392\u7248\u53EA\u8FD9\u4E00\u4EFD\uFF08\u89C1 tutorials.js \u7684\u8BF4\u660E\uFF09\u3002 */
.tutbox{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel2);
  padding:14px 16px;margin-bottom:16px}
.tut-intro{font-size:12.5px;line-height:1.6;color:var(--muted);margin-bottom:12px}
.tut{margin-bottom:12px}
.tut:last-child{margin-bottom:0}
.tut-h{display:flex;align-items:flex-start;gap:8px;font-size:13px;font-weight:650;line-height:1.5}
.tut-n{flex:none;width:18px;height:18px;border-radius:50%;background:var(--accent-weak);
  color:var(--accent);font-size:11px;display:grid;place-items:center;margin-top:1px}
.tut-b{font-size:12.5px;line-height:1.6;color:var(--muted);margin:6px 0 0 26px}
/* user-select:all = **\u70B9\u4E00\u4E0B\u6574\u6BB5\u5168\u9009**\u3002\u8FD9\u662F\u96F6 JS \u4E0B\u80FD\u505A\u5230\u7684\u6700\u63A5\u8FD1"\u4E00\u952E\u590D\u5236"\u7684\u5F62\u6001\uFF1A
   script \u88AB CSP \u7684 default-src 'none' \u6321\u6B7B\uFF0C\u590D\u5236\u6309\u94AE\u505A\u4E0D\u51FA\u6765\uFF0C\u800C\u8FD9\u51E0\u4E2A\u811A\u672C\u90FD\u662F
   \u6574\u6BB5\u7C98\u8FDB PowerShell \u7528\u7684\uFF0C\u672C\u6765\u4E5F\u4E0D\u9700\u8981\u53EA\u9009\u5176\u4E2D\u51E0\u884C\u3002 */
.tut-c{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11.5px;line-height:1.5;
  background:var(--panel3);border:1px solid var(--line);border-radius:var(--radius-sm);
  padding:10px 12px;margin:8px 0 0 26px;overflow-x:auto;white-space:pre;
  color:var(--text);max-height:340px;overflow-y:auto;
  user-select:all;-webkit-user-select:all;cursor:text}
.tut-c code{background:none;padding:0;font-size:inherit}
.tutbox .alert{margin:8px 0 0 26px;font-size:12px}
.tutbox .tw{margin:8px 0 0 26px}
.cmdbox{display:flex;gap:8px;align-items:center;background:var(--panel3);border:1px solid var(--line);
  border-radius:var(--radius-sm);padding:8px 10px;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:11.5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.tiny{color:var(--faint);font-size:11.5px}
/* \u4E00\u7EC4\u5C0F\u5DE5\u5177\u7C7B\uFF1A\u5404\u9875\u9762\u53CD\u590D\u5185\u8054\u7684\u90A3\u51E0\u884C\u6837\u5F0F\u6536\u8FDB\u6765\uFF08CSP \u5DF2\u653E\u884C\u5185\u8054\uFF0C\u7EAF\u4E3A\u4E00\u81F4\u6027\uFF09\u3002
   \u8FB9\u8DDD\u53E3\u5F84\u5F52\u4E00\uFF1A\u4E0A\u8FB9\u8DDD\u4E00\u5F8B .mt=12px\uFF0C\u4E0B\u8FB9\u8DDD\u7528 .mb\uFF0810px\uFF09\u3002
   \u6062\u590D\u6B63\u5E38\u6362\u884C\u53EB .flow \u800C\u4E0D\u662F .wrap \u2014\u2014 .wrap \u5DF2\u662F\u9875\u9762\u5BB9\u5668\uFF08max-width \u90A3\u6761\uFF09\uFF0C\u540C\u540D\u4F1A\u4E92\u76F8\u8BEF\u4F24\u3002 */
.m0{margin:0}
.mt{margin-top:12px}
.mb{margin:0 0 10px}
.flush{padding-top:0}
th.r,td.r{text-align:right}
.cap{font-size:14.5px;font-weight:650}
.over{color:var(--bad)}
.card .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.pre{white-space:pre-wrap;word-break:break-all}
.center{justify-content:center}
.tc{text-align:center}
.flow{white-space:normal}
/* \u7BA1\u7406\u9875\u5361\u7247\u5934\u53F3\u4FA7\u7684\u6309\u94AE\u7EC4\uFF1Amargin-left:auto \u9876\u5230\u53F3\u8FB9 */
.card .hd .acts{margin-left:auto;gap:8px}
.login{max-width:330px;margin:48px auto;text-align:center}
.login .lock{width:44px;height:44px;border-radius:12px;background:var(--panel3);color:var(--muted);
  display:grid;place-items:center;margin:0 auto 14px}
.login h1{font-size:16px;margin:0 0 4px}
.login p{color:var(--muted);font-size:12.5px;margin:0 0 16px}
.login .row{display:flex;gap:8px}
.login input{flex:1;font-family:ui-monospace,monospace;text-align:center;font-size:14px;padding:9px 11px;
  border:1px solid var(--line2);border-radius:var(--radius-sm);background:var(--panel);color:var(--text)}
.empty{text-align:center;padding:30px 20px}
.empty .mark{width:44px;height:44px;border-radius:12px;background:var(--panel3);color:var(--muted);
  display:grid;place-items:center;margin:0 auto 12px}
.ft{margin-top:28px;text-align:center;color:var(--faint);font-size:11.5px}
.ft a{color:var(--faint);text-decoration:none}
.ft a:hover{color:var(--accent)}
.ft .sep{margin:0 7px}
/* \u7A84\u5C4F\u9002\u914D\u3002\u79FB\u52A8\u7AEF\u7684\u95EE\u9898\u4E0D\u662F"\u7F29\u5C0F"\uFF0C\u800C\u662F"\u6362\u7ED3\u6784"\uFF1A
   \xB7 \u5BFC\u822A\u6A2A\u6392 5 \u9879\u5728 360px \u4E00\u5B9A\u653E\u4E0D\u4E0B \u2014\u2014 \u6298\u884C\u4F1A\u628A\u300C\u603B\u89C8\u300D\u62C6\u6210\u4E24\u5B57\uFF0C
     \u6240\u4EE5\u6539\u6210\u6574\u6761\u6A2A\u5411\u6EDA\u52A8\uFF0C\u4F4D\u7F6E\u6C38\u8FDC\u5728\u7B2C\u4E00\u9879\u3002
   \xB7 \u8868\u683C min-width 640px \u5728\u7A84\u5C4F\u5FC5\u7136\u6A2A\u5411\u6EA2\u51FA\uFF0C\u6ED1\u52A8\u80FD\u770B\u5168\u4F46\u770B\u4E0D\u51FA"\u8FD9\u662F\u5217\u8868"\uFF0C
     \u6240\u4EE5\u7A84\u5C4F\u4E0B\u6539\u6210\u5361\u7247\u5F0F\u5806\u53E0\uFF1A\u6BCF\u884C\u4E00\u5F20\u5361\uFF0C\u5B57\u6BB5\u540D\u9760 data-label \u663E\u793A\u3002
   \xB7 \u7B5B\u9009\u6309\u94AE\u7EC4\u4E0E\u64CD\u4F5C\u6309\u94AE\u7EC4\u5728\u7A84\u5C4F\u5360\u6EE1\u6574\u884C\uFF0C\u907F\u514D\u6324\u6210\u4E24\u534A\u3002 */
@media (max-width:720px){
  .wrap{padding:14px 12px 56px}
  .top{padding:10px 12px;gap:10px}
  .brand{font-size:14.5px}
  /* \u6574\u6761\u53EF\u6A2A\u5411\u6EDA\uFF0C\u4E14\u4E0D\u6362\u884C \u2014\u2014 nav \u81EA\u8EAB\u4E0D\u80FD wrap\uFF0C\u5426\u5219\u300C\u603B\u89C8\u300D\u4F1A\u88AB\u6298\u65AD */
  .nav{flex:1 1 100%;overflow-x:auto;flex-wrap:nowrap;-webkit-overflow-scrolling:touch;
    scrollbar-width:none;padding-bottom:1px}
  .nav::-webkit-scrollbar{display:none}
  .nav a{flex:none;padding:6px 10px;font-size:13px}
  .top .right{flex:1 1 100%;margin-left:0;justify-content:flex-end}
  .h{margin:18px 0 8px}
  h2{font-size:16px}
  .sub{font-size:12px}
  /* \u7B5B\u9009\u680F\u5728\u7A84\u5C4F\u72EC\u5360\u4E00\u884C\uFF0C.spacer \u7684 margin-left:auto \u4F1A\u628A\u5B83\u63A8\u504F */
  .h .acts{width:100%;justify-content:flex-start}
  .grid.cols3{grid-template-columns:1fr}
  .tutbox{padding:12px 12px}
  .tut-b,.tut-c,.tutbox .alert,.tutbox .tw{margin-left:0}
  .field textarea{min-height:120px}
  .card .hd,.card .bd,.pane{padding-left:13px;padding-right:13px}
  /* \u7BA1\u7406\u9875\u5361\u7247\u5934\u5728\u7A84\u5C4F\u6362\u884C\uFF1A\u6807\u9898\u4E00\u884C\u3001\u6309\u94AE\u7EC4\u4E00\u884C\uFF0C\u6807\u9898\u4E0D\u518D\u88AB\u4E24\u4E2A\u6309\u94AE\u6324\u6CA1 */
  .card .hd{flex-wrap:wrap}
  .card .hd .acts{flex:1 1 100%}
  /* \u8FD0\u884C\u6D41\u5728\u7A84\u5C4F\u592A\u6324\uFF1Awho \u7F29\u7A84\u3001\u65F6\u95F4\u6233\u964D\u4E00\u6863\uFF0C\u628A\u5BBD\u5EA6\u8BA9\u7ED9\u6458\u8981 */
  .flowitem .who{width:72px}
  .flowitem .when{font-size:10.5px}
  .kv{flex-direction:column;gap:2px}
  .kv .v{text-align:left}
  .login{max-width:none;margin:36px 16px}
}

/* \u7A84\u5C4F\u8868\u683C \u2192 \u5361\u7247\u3002\u7ED9\u6BCF\u683C\u52A0 data-label\uFF08\u89C1\u5404\u9875\u9762\u7684 <td>\uFF09\uFF0C
   \u7531 CSS \u751F\u6210\u5B57\u6BB5\u540D\uFF0C\u6240\u4EE5\u8868\u683C\u5728\u5BBD\u5C4F\u4E0A\u4ECD\u7136\u662F\u771F\u8868\u683C\uFF08\u6709\u8BED\u4E49\u3001\u80FD\u6A2A\u5411\u6EDA\uFF09\u3002 */
@media (max-width:720px){
  .tw{overflow-x:visible;border-radius:0}
  table.t{min-width:0;display:block}
  table.t thead{display:none}
  table.t tbody{display:block}
  table.t tr{display:block;background:var(--panel);border:1px solid var(--line);
    border-radius:var(--radius);margin:0 0 8px;padding:2px 0}
  table.t td{display:flex;align-items:baseline;gap:10px;border:0;padding:5px 12px;text-align:left}
  table.t td::before{content:attr(data-label);flex:none;width:4.5em;color:var(--muted);
    font-size:11.5px;font-weight:600}
  table.t td:empty{display:none}
  /* \u64CD\u4F5C\u5217\uFF08\u8BE6\u60C5/\u6267\u884C/\u5220\u9664\uFF09\u6CA1\u6709\u5B57\u6BB5\u540D\uFF0Cdata-label \u662F\u7A7A\u4E32\u3002
     \u5BBD\u5EA6\u7ED9 0 + \u4E0D\u663E\u793A ::before\uFF0C\u5426\u5219\u4F1A\u7559\u4E00\u5757 4.5em \u7684\u7A7A\u767D\uFF0C
     \u800C\u8FD9\u4E00\u683C\u91CC\u7684\u6309\u94AE\u672C\u6765\u5C31\u662F\u9760\u53F3\u5BF9\u9F50\u7684\u72EC\u7ACB\u64CD\u4F5C\u533A\u3002 */
  table.t td[data-label=""]{padding-left:12px;padding-right:12px}
  table.t td[data-label=""]::before{content:none;width:0}
  /* \u7A84\u5C4F\u4E0B\u64CD\u4F5C\u6309\u94AE\u72EC\u5360\u4E00\u884C\u9760\u53F3\uFF1A\u6324\u5728\u5B57\u6BB5\u540D\u540E\u9762\u4F1A\u663E\u5F97\u50CF\u67D0\u4E2A\u5B57\u6BB5\u7684\u503C */
  table.t td[data-label=""] .acts{width:100%;justify-content:flex-end}
  /* \u7ED3\u679C\u5FBD\u7AE0\u4E0E\u79EF\u5206\u8FD9\u7C7B\u300C\u503C\u300D\u8DDF\u5728\u5B57\u6BB5\u540D\u540E\u9762\uFF0C\u4E0D\u518D\u72EC\u5360\u4E00\u884C */
  table.t td .badge{font-size:11.5px}
  .num{white-space:normal}
}
@media (max-width:860px){.split{grid-template-columns:1fr}}
`;
var SPRITE = `
<svg style="display:none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<symbol id="g-check" viewBox="0 0 16 16"><path d="M3 8.4l3.2 3.2L13 4.6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-loop" viewBox="0 0 16 16"><path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.85" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M13.4 2.3v2.7h-2.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-dot" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.1" fill="currentColor"/></symbol>
<symbol id="g-ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="2.9 2.4"/></symbol>
<symbol id="g-clock" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.1" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 4.9v3.3l2.3 1.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="g-half" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 3a5 5 0 0 1 0 10z" fill="currentColor"/></symbol>
<symbol id="g-skip" viewBox="0 0 16 16"><path d="M3.6 3.8l5 4.2-5 4.2M11.8 3.8v8.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-tri" viewBox="0 0 16 16"><path d="M8 2.3l6.1 11.2H1.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 6.2v3.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.5" r=".95" fill="currentColor"/></symbol>
<symbol id="g-lock" viewBox="0 0 16 16"><rect x="3.2" y="6.9" width="9.6" height="6.9" rx="1.7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.6 6.9V5.1a2.4 2.4 0 0 1 4.8 0v1.8" fill="none" stroke="currentColor" stroke-width="1.8"/></symbol>
<symbol id="g-down" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.1" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 5v4.4M5.7 7.2L8 9.5l2.3-2.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-oct" viewBox="0 0 16 16"><path d="M5.5 1.9h5L14.1 5.5v5L10.5 14.1h-5L1.9 10.5v-5z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 4.8v3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="10.8" r=".95" fill="currentColor"/></symbol>
<symbol id="g-key" viewBox="0 0 16 16"><circle cx="5.4" cy="5.4" r="3.1" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M7.6 7.6l5.1 5.1M10.4 9.6l1.6 1.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
<symbol id="g-hour" viewBox="0 0 16 16"><path d="M4.6 2.2h6.8M4.6 13.8h6.8M5.4 2.2c0 2.5 2.6 3.4 2.6 5.8s-2.6 3.3-2.6 5.8M10.6 2.2c0 2.5-2.6 3.4-2.6 5.8s2.6 3.3 2.6 5.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</svg>`;
var STATUS3 = {
  claimed: { label: "\u6210\u529F\u9886\u53D6", glyph: "g-check" },
  already: { label: "\u4ECA\u65E5\u5DF2\u9886", glyph: "g-loop" },
  ok: { label: "\u6B63\u5E38", glyph: "g-dot" },
  inactive: { label: "\u6D3B\u52A8\u672A\u5F00", glyph: "g-ring" },
  pending: { label: "\u5F85\u4E0B\u53D1", glyph: "g-clock" },
  waiting: { label: "\u7B49\u5F85\u4E2D", glyph: "g-hour" },
  partial: { label: "\u90E8\u5206\u5B8C\u6210", glyph: "g-half" },
  skipped: { label: "\u672A\u5F00\u59CB", glyph: "g-skip" },
  rate_limited: { label: "\u9650\u9891", glyph: "g-tri" },
  login_required: { label: "\u9700\u91CD\u65B0\u767B\u5F55", glyph: "g-lock" },
  deferred: { label: "\u987A\u5EF6", glyph: "g-down" },
  error: { label: "\u5931\u8D25", glyph: "g-oct" }
};
function statusInfo(status) {
  return STATUS3[status] || { label: status || "\u672A\u77E5", glyph: "g-oct" };
}
__name(statusInfo, "statusInfo");
function link(path, pwd, extra) {
  const url = new URL(path, "https://app.invalid");
  if (pwd) url.searchParams.set("pwd", pwd);
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== void 0 && value !== null && value !== "") url.searchParams.set(key, value);
  }
  return url.pathname + url.search;
}
__name(link, "link");
function pageShell({ title, pwd, nav = "", body }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${SPRITE}
<div class="wrap">
  <div class="top">
    <a class="brand" href="${link("/", pwd)}"><span class="mark">\u7B7E</span>\u7B7E\u5230\u53F0</a>
    <nav class="nav">${nav}</nav>
    <div class="right"><span class="tiny">\u53E3\u4EE4\u5DF2\u968F\u94FE\u63A5\u643A\u5E26</span></div>
  </div>
  ${body}
  <footer class="ft">${VERSION}<span class="sep">\xB7</span><a href="https://github.com/chevy222/app-cf-checkin" target="_blank" rel="noopener">Powered by GitHub</a></footer>
</div></body></html>`;
}
__name(pageShell, "pageShell");
function navHtml(pwd, active, tools) {
  const item = /* @__PURE__ */ __name((href, text, key) => `<a class="${key === active ? "on" : ""}" href="${escapeHtml(href)}">${escapeHtml(text)}</a>`, "item");
  const links = tools.map((tool) => item(link(`/tool/${tool.id}`, pwd), tool.name, `tool:${tool.id}`));
  return item(link("/", pwd), "\u603B\u89C8", "home") + links.join("") + item(link("/help", pwd), "\u8BF4\u660E", "help");
}
__name(navHtml, "navHtml");

// src/ui/components.js
function glyph(id, size = 12) {
  return `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
}
__name(glyph, "glyph");
function badge(status, overrideLabel) {
  const info = statusInfo(status);
  return `<span class="badge b-${escapeHtml(infoClass(status))}">${glyph(info.glyph)}${escapeHtml(overrideLabel || info.label)}</span>`;
}
__name(badge, "badge");
var CLASS_BY_STATUS = {
  claimed: "claimed",
  already: "already",
  ok: "ok",
  inactive: "inactive",
  pending: "pending",
  partial: "partial",
  skipped: "skipped",
  rate_limited: "rate",
  login_required: "login",
  deferred: "defer",
  waiting: "wait",
  error: "error"
};
function infoClass(status) {
  return CLASS_BY_STATUS[status] || "error";
}
__name(infoClass, "infoClass");
function alertBox(kind, html) {
  const map = { bad: "bad", warn: "warn", info: "info" };
  const icon = kind === "info" ? "g-clock" : "g-tri";
  return `<div class="alert ${map[kind] || "info"}">${glyph(icon, 14)}<span>${html}</span></div>`;
}
__name(alertBox, "alertBox");
function sectionHead(title, sub, rightHtml) {
  return `<div class="h"><h2>${escapeHtml(title)}</h2>${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ""}${rightHtml ? `<span class="spacer"></span>${rightHtml}` : ""}</div>`;
}
__name(sectionHead, "sectionHead");
function emptyState({ title, lines, actions }) {
  return `<div class="empty"><div class="mark">${glyph("g-key", 22)}</div>
    <b class="cap">${escapeHtml(title)}</b>
    ${lines && lines.length ? `<p class="sub mt">${escapeHtml(lines.join(" "))}</p>` : ""}
    ${actions && actions.length ? `<div class="acts center mt">${actions.join("")}</div>` : ""}
  </div>`;
}
__name(emptyState, "emptyState");
function chip(text, off) {
  return `<span class="chip${off ? " off" : ""}">${escapeHtml(text)}</span>`;
}
__name(chip, "chip");
function button(href, text, style = "", small = false) {
  return `<a class="btn${style ? ` ${style}` : ""}${small ? " sm" : ""}" href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}
__name(button, "button");

// src/ui/icons.js
var ICONS = {
  qoder: "data:image/png;base64,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",
  trae: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAACNElEQVR42u2bO07DQBCGfYSUZGdnsRQKIhCIFEjUSKGlp7GgTIE7OpKGDolIHMC+gekp0tK5ok7BAcwNjDYPhzyMHwm21zuWpptE+3+7ntlE8xtGisc0zQYAWgDCYQzHwDFggGGVYrom7jOGnlyraZqmse0jvwQAX6ooOBUUQCc3CM7FvarC14KJfpZdl8d9VAvhSxDQk9oSxU/eo7qJj4L7f0JgHL36io/qwmizeMb7dRc/j2ZT2GvVXhfxswiWuoNsF5oBCAH4UNfd/30KGnL3LU0BhIBoGVyDyh8fwjGAC19fADiWAAKNAQSGxuInQQAIQIbktntb+Th8vfk/AJ3v58rH6ecjASAABIAAFAug1bsqJSoDoKweTgAIAAFQBwBvH4QnHw9hq9fdWb4yAOZiFl2ju5N8JQCsikkSlSW/8gDixMSJyppfeQD7l53w7Osp9nNt926rfCVegThRq2Ly5CtTBFdFxYnPmq9UG5yLShKfJV+5ixCeH2VaXFI+3QQJAAEgAIUCMK8vNsbxu11KFA5Ahf8KCQABIAAEoHAAcd2hjJC/IWg+gABkAEBDUoBjjecEfYOBcLUFwPBN71FZQGtqkdG0DuztzUbmgYuhhgCcyC8gSeh2CqLdX5gmhK0NAC4GG31DtbTLrYlHL8EzWOfxeeGn8w7W0EQBHEeJ4pc9hHxQD+EiaALYufzDslIyQFdV4dIZtlbt84KY3Bg5etJiU8WWOVvTGFA4M/t8quP+A1jeJ+YfM/yHAAAAAElFTkSuQmCC",
  workbuddy: "data:image/png;base64,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",
  "69yun": "data:image/png;base64,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"
};
function iconOf(tool) {
  return ICONS[tool && tool.id] || null;
}
__name(iconOf, "iconOf");
function iconImg(tool, size = 22) {
  const uri = iconOf(tool);
  if (!uri) return "";
  return `<img class="ico" src="${uri}" width="${size}" height="${size}" alt="" loading="lazy">`;
}
__name(iconImg, "iconImg");

// src/ui/pages/home.js
var SETTLED = /* @__PURE__ */ new Set(["claimed", "already", "inactive", "ok"]);
function toggleForm(pwd, tool, off) {
  return `<form method="post" action="${escapeHtml(link(`/tool/${tool.id}/toggle`, pwd))}" class="sw">
    <input type="hidden" name="pwd" value="${escapeHtml(pwd)}">
    <button type="submit" class="sw-b${off ? "" : " on"}" aria-pressed="${off ? "false" : "true"}"><span class="sw-t">${off ? "\u5DF2\u505C\u7528" : "\u8FD0\u884C\u4E2D"}</span></button>
  </form>`;
}
__name(toggleForm, "toggleForm");
function cardLine(label, value) {
  return `<div class="kv kv-row"><span class="k">${escapeHtml(label)}</span><span class="v">${value}</span></div>`;
}
__name(cardLine, "cardLine");
function renderHome({ pwd, tools, counts, sched = {}, runs = [], flash, flags = {} }) {
  const cards = tools.map((tool) => {
    const entries = sched[tool.id] || {};
    const uids = Object.keys(entries);
    const done = uids.filter((uid) => SETTLED.has(entries[uid].lastStatus)).length;
    const stuck = uids.filter((uid) => ["login_required", "error"].includes(entries[uid].lastStatus));
    const last = runs.find((r) => r.kind === "run" && r.tool === tool.id);
    const segments = uids.map((uid) => {
      const s = entries[uid].lastStatus;
      const cls = SETTLED.has(s) ? "done" : ["rate_limited", "deferred", "waiting"].includes(s) ? "wait" : s ? "bad" : "";
      return `<i class="${cls}"></i>`;
    }).join("");
    const off = isOff(flags, tool.id);
    const offAt = (flags[tool.id] || {}).at;
    const redBar = stuck.length && !off ? `<div class="alert bad">${badge("login_required", "")}<span>${stuck.length} \u4E2A\u8D26\u53F7\u9700\u8981\u5904\u7406\u3002<a href="${escapeHtml(link(`/tool/${tool.id}`, pwd))}">\u53BB\u5904\u7406 \u203A</a></span></div>` : "";
    return `<div class="card${off ? " dim" : ""}">
      ${redBar}
      <div class="hd">
        <div class="id">${iconImg(tool)}<div><div class="t">${escapeHtml(tool.name)}</div><div class="d">${escapeHtml(tool.summary || "")}</div></div></div>
        ${off ? chip(`\u5DF2\u505C\u7528 \xB7 \u5173\u4E8E ${fmtCST(offAt)}`, true) : ""}
        <a href="${escapeHtml(link(`/tool/${tool.id}`, pwd))}">\u7BA1\u7406 \u203A</a>
      </div>
      <div class="bd">
        <div class="prog">${segments}<span class="n">${done}/${uids.length || counts[tool.id] || 0} \u4ECA\u65E5\u5B8C\u6210</span></div>
        ${cardLine("\u6700\u540E\u7ED3\u679C", last ? `${badge(last.meta && last.meta.status)} <span class="dim">${escapeHtml(fmtCST(Math.floor(last.at / 1e3)))}</span>` : '<span class="dim">\u2014</span>')}
        ${cardLine("\u65E5\u754C", `\u6BCF\u5929 ${escapeHtml(String(tool.schedule.resetHour))}:00 \u7FFB\u65E5 \xB7 ${escapeHtml(String(tool.schedule.notBeforeHour))}:00 \u8D77\u53EF\u6267\u884C`)}
        ${uids.length || counts[tool.id] ? "" : cardLine("\u9700\u8981\u5904\u7406", `<a href="${escapeHtml(link(`/tool/${tool.id}`, pwd))}">\u8FD8\u6CA1\u6709\u8D26\u53F7\uFF0C\u53BB\u6DFB\u52A0 \u203A</a>`)}
        ${stuck.length ? cardLine("\u9700\u8981\u5904\u7406", `${stuck.length} \u4E2A\u8D26\u53F7${off ? "\uFF08\u505C\u7528\u4E2D\uFF0C\u6062\u590D\u540E\u4ECD\u8981\u5904\u7406\uFF09" : ""}`) : ""}
        <div class="kv kv-row"><span class="k">\u5F00\u5173</span><span class="v">${toggleForm(pwd, tool, off)}</span></div>
      </div>
    </div>`;
  });
  const feed = runs.slice(0, 12).map((entry) => {
    const m = entry.meta || {};
    const href = link(`/runs/${encodeURIComponent(entry.key)}`, pwd);
    const who = entry.kind === "tick" ? "\u6574\u8F6E\u8C03\u5EA6" : `${entry.tool}/${m.label || entry.uid}`;
    return `<a class="flowitem" href="${escapeHtml(href)}">
      <span class="who">${escapeHtml(who)}</span>${badge(m.status || "error")}
      <span class="m">${escapeHtml(m.message || "")}</span>
      <span class="when">${escapeHtml(fmtCSTSec(Math.floor(entry.at / 1e3)))}</span></a>`;
  }).join("");
  return pageShell({
    title: "\u7B7E\u5230\u53F0",
    nav: navHtml(pwd, "home", tools),
    body: (flash ? alertBox(flash.kind, escapeHtml(flash.text)) : "") + sectionHead("\u5DE5\u5177", "\u6BCF\u8F6E\u53EA\u5904\u7406\u5230\u671F\u8D26\u53F7\uFF0C\u4E00\u8F6E\u88C5\u4E0D\u4E0B\u7684\u81EA\u52A8\u987A\u5EF6\u5230\u4E0B\u4E00\u8F6E") + (tools.length === 0 ? emptyState({ title: "\u8FD8\u6CA1\u6709\u63A5\u5165\u4EFB\u4F55\u5DE5\u5177", lines: ["\u6CE8\u518C\u8868\u662F\u7A7A\u7684\u3002"] }) : `<div class="grid cols3">${cards.join("")}</div>`) + sectionHead("\u6700\u8FD1\u8FD0\u884C", "", button(link("/runs", pwd), "\u5168\u90E8\u65E5\u5FD7 \u203A")) + `<div class="card"><div class="bd">${feed || '<span class="dim">\u8FD8\u6CA1\u6709\u8FD0\u884C\u8BB0\u5F55\u3002</span>'}</div></div>`
  });
}
__name(renderHome, "renderHome");

// src/ui/pages/help.js
function renderHelp({ pwd, tools }) {
  const statuses = Object.entries(STATUS3).map(([key, info]) => `<div class="kv">
      <span class="k"><span class="badge b-${key === "rate_limited" ? "rate" : key === "login_required" ? "login" : key === "deferred" ? "defer" : key === "already" ? "already" : key === "inactive" || key === "skipped" ? "skipped" : key === "partial" || key === "pending" ? "partial" : key === "error" ? "error" : "ok"}">${glyph(info.glyph)}${escapeHtml(info.label)}</span></span>
      <span class="v dim">${escapeHtml(key)}</span>
    </div>`).join("");
  const toolsList = tools.map((tool) => `<div class="kv">
      <span class="k">${iconImg(tool, 18)}${escapeHtml(tool.name)}</span>
      <span class="v">${escapeHtml(tool.id)} \xB7 ${tool.steps.length} \u6B65 \xB7 \u7EA6 ${tool.steps.reduce((s, x) => s + x.cost, 0)} \u5B50\u8BF7\u6C42</span>
    </div>`).join("");
  return pageShell({
    title: "\u8BF4\u660E",
    nav: navHtml(pwd, "help", tools),
    body: sectionHead("\u8FD9\u662F\u4EC0\u4E48") + `<div class="pane"><p class="sub m0">\u4E00\u4E2A\u53EF\u6269\u5C55\u7684\u7B7E\u5230\u5E73\u53F0\uFF1A\u5185\u6838\u4E0D\u8BA4\u8BC6\u4EFB\u4F55\u5177\u4F53\u7AD9\u70B9\uFF0C
        \u6BCF\u4E2A\u5DE5\u5177\u662F\u4E00\u4E2A\u81EA\u5305\u542B\u6A21\u5757\uFF0C\u53EA\u58F0\u660E\u5B57\u6BB5\u3001\u6B65\u9AA4\u4E0E\u8C03\u5EA6\u7B56\u7565\u3002\u52A0\u7B2C N \u4E2A\u5DE5\u5177\u4E0D\u9700\u8981\u6539\u5185\u6838\u3001\u4E0D\u9700\u8981\u5199\u754C\u9762\u4EE3\u7801\u3002</p></div>
      ${sectionHead("\u5DF2\u6CE8\u518C\u7684\u5DE5\u5177")}
      <div class="pane">${toolsList}</div>
      ${sectionHead("\u505C\u7528\u67D0\u4E2A\u5DE5\u5177")}
      <div class="pane"><p class="sub mb">\u603B\u89C8\u9875\u6BCF\u5F20\u5DE5\u5177\u5361\u7247\u4E0A\u6709\u4E00\u4E2A\u72EC\u7ACB\u5F00\u5173\uFF0C\u53EA\u505C\u4E00\u5BB6\uFF0C\u4E0D\u5F71\u54CD\u5176\u5B83\u3002</p>
        <p class="tiny m0">\u505C\u7528\u540E\uFF1Acron \u4E0E\u300C\u7ACB\u5373\u6267\u884C\u300D\u90FD\u8DF3\u8FC7\u5B83\uFF0C\u522B\u7684\u5DE5\u5177\u7167\u5E38\uFF1B\u5361\u7247\u53D8\u6697\u5E76\u663E\u793A\u505C\u7528\u65F6\u95F4\uFF0C
        \u4F46\u300C\u4ECA\u65E5\u5B8C\u6210 / \u6700\u540E\u7ED3\u679C / \u6B65\u9AA4\u8272\u5757\u300D\u7167\u5E38\u663E\u793A\uFF0C\u65B9\u4FBF\u4F60\u770B\u51FA\u5B83\u505C\u5728\u54EA\u4E00\u6B65\u3002
        <b>\u8D26\u53F7\u3001\u51ED\u636E\u4E0E\u5F53\u5929\u8FDB\u5EA6\u4E00\u6761\u90FD\u4E0D\u5220</b> \u2014\u2014 \u91CD\u65B0\u6253\u5F00\u5C31\u4ECE\u505C\u4E0B\u7684\u90A3\u4E00\u6B65\u63A5\u7740\u505A\uFF0C\u5DF2\u5B8C\u6210\u7684\u90A3\u6B65\u4E0D\u4F1A\u91CD\u505A
        \uFF08\u91CD\u505A\u4F1A\u771F\u7684\u518D\u6253\u4E00\u6B21\u4E0A\u6E38\uFF0CWorkBuddy \u7684\u5F00\u76F2\u76D2\u6BCF\u8C03\u4E00\u6B21\u5C31\u6263 10 \u70B9\u80FD\u91CF\uFF09\u3002
        \u505C\u7528\u4E2D\u300C\u6267\u884C\u300D\u6309\u94AE\u9690\u85CF\uFF0C\u53EA\u4FDD\u7559\u300C\u6D4B\u8BD5\u300D\u300C\u7F16\u8F91\u300D\u300C\u5220\u9664\u300D\uFF1B\u76F4\u63A5\u6572 URL \u4E5F\u4F1A\u88AB\u670D\u52A1\u7AEF\u62D2\u7EDD\u3002
        \u8DE8\u8FC7\u5F53\u5929\u7684\u989D\u5EA6\u91CD\u7F6E\u65F6\u523B\uFF08\u5404\u5BB6\u4E0D\u540C\uFF09\u518D\u6253\u5F00\uFF0C\u5219\u6309\u65B0\u7684\u90A3\u4E00\u5929\u4ECE\u5934\u7B97\uFF0C\u8FD9\u662F\u672C\u6765\u7684\u884C\u4E3A\u3002
        \u8FD9\u91CC<b>\u6CA1\u6709</b>\u300C\u5168\u90E8\u505C\u7528\u300D\u603B\u5F00\u5173\u3002</p>
      </div>
      ${sectionHead("\u72B6\u6001\u8BCD\u6C47\u8868")}
      <div class="pane">${statuses}
        <p class="tiny mt">\u5F62\u72B6\u3001\u989C\u8272\u3001\u4E2D\u6587\u4E09\u91CD\u5197\u4F59\uFF1A\u53BB\u6389\u989C\u8272\u53EA\u770B\u5F62\u72B6\u4E5F\u8BFB\u5F97\u61C2\u3002\u53EA\u6709\u6302\u9501\u4E0E\u516B\u8FB9\u5F62\u9700\u8981\u4F60\u52A8\u624B\uFF0C\u5176\u4F59\u90FD\u4F1A\u81EA\u5DF1\u597D\u3002</p>
      </div>
      ${sectionHead("\u51E0\u6761\u786C\u89C4\u5219")}
      <div class="pane"><p class="sub m0">
        \u4E00\u3001\u6BCF\u4E2A\u5DE5\u5177\u4E00\u4E2A\u8BF7\u6C42\u5C42\uFF0C\u7EDD\u4E0D\u5171\u7528 header \u6784\u9020\u5668 \u2014\u2014 \u4E09\u5BB6\u7684\u9274\u6743\u65B9\u6848\u4E0E UA \u4E92\u4E0D\u76F8\u540C\uFF0C\u4E32\u5473\u5373\u4E8B\u6545\u3002<br>
        \u4E8C\u3001\u51FA\u53E3\u57DF\u540D\u767D\u540D\u5355\uFF0C\u8BF7\u6C42\u53EA\u80FD\u6253\u5230\u81EA\u5DF1\u5BB6\u3002<br>
        \u4E09\u3001\u5DE5\u5177\u4E0D\u8BB8\u81EA\u5DF1\u7B97\u300C\u4ECA\u5929\u300D\uFF0C\u4E00\u5F8B\u7528\u5185\u6838\u6CE8\u5165\u7684\u903B\u8F91\u65E5\uFF08\u5404\u5BB6\u65E5\u754C\u4E0D\u540C\uFF09\u3002<br>
        \u56DB\u3001\u6BCF\u4E2A\u6B65\u9AA4\u5FC5\u987B\u53EF\u5B89\u5168\u91CD\u5165\uFF0C\u5426\u5219\u4E0D\u8BB8\u58F0\u660E\u591A\u6B65\u9AA4 \u2014\u2014 \u65AD\u70B9\u7EED\u8DD1\u9760\u7684\u662F\u670D\u52A1\u7AEF\u5E42\u7B49\u3002<br>
        \u4E94\u3001\u654F\u611F\u503C\u53EA\u5B58 KV\u3001\u53EA\u663E\u793A\u6253\u7801\u5F62\u5F0F\u3001\u6C38\u4E0D\u8FDB\u65E5\u5FD7\uFF1B\u8BBF\u95EE\u53E3\u4EE4\u53EA\u51FA\u73B0\u5728\u94FE\u63A5\u91CC\uFF0C\u4E0D\u51FA\u73B0\u5728\u4EFB\u4F55\u53EF\u89C1\u6587\u672C\u3002
      </p></div>`
  });
}
__name(renderHelp, "renderHelp");

// src/core/scheduler.js
var SETTLED2 = /* @__PURE__ */ new Set(["claimed", "already", "inactive", "ok"]);
function missingConfigFields(tool, config) {
  return (tool.config || []).filter((field) => field.required && String((config || {})[field.key] ?? "").trim() === "").map((field) => field.label || field.key);
}
__name(missingConfigFields, "missingConfigFields");
function configComplete(tool, config) {
  return missingConfigFields(tool, config).length === 0;
}
__name(configComplete, "configComplete");
function cstHour(sec) {
  return new Date((sec + CST_OFFSET) * 1e3).getUTCHours();
}
__name(cstHour, "cstHour");
var dayOf = /* @__PURE__ */ __name((tool, sec) => logicalDay(tool.schedule.resetHour, sec), "dayOf");
function isDue(tool, entry, day, now) {
  const schedule = tool.schedule;
  if (cstHour(now) < (schedule.notBeforeHour ?? 0)) return false;
  const sched = schedOf(entry);
  if (sched.lastStatusDate === day && SETTLED2.has(sched.lastStatus)) return false;
  if (sched.retryAt > now) return false;
  if (!sched.resumable && sched.lastAt && now - sched.lastAt < (schedule.minIntervalSec ?? 0)) return false;
  if (!sched.resumable && sched.attemptsDate === day && sched.attempts >= (schedule.maxDaily ?? Infinity)) return false;
  return true;
}
__name(isDue, "isDue");
async function loadProgress(env, tool, uid, day) {
  const saved = await getJson(requireKv(env), stepKey(tool.id, uid), null);
  if (!saved || saved.day !== day) return { day, done: {} };
  return { day: saved.day, done: saved.done && typeof saved.done === "object" ? saved.done : {} };
}
__name(loadProgress, "loadProgress");
function saveProgress(env, tool, uid, progress) {
  return putJson(requireKv(env), stepKey(tool.id, uid), progress);
}
__name(saveProgress, "saveProgress");
function clearProgress(env, tool, uid) {
  return requireKv(env).delete(stepKey(tool.id, uid));
}
__name(clearProgress, "clearProgress");

// src/ui/tutorials.js
var step = /* @__PURE__ */ __name((title, body, code) => ({ title, body, code }), "step");
var note = /* @__PURE__ */ __name((kind, text) => ({ kind, text }), "note");
var TUTORIALS = {
  qoder: {
    intro: "Qoder \u670D\u52A1\u7AEF\u4ECE 2026-09-26 \u8D77\u8981\u6C42\u8BF7\u6C42\u5E26\u4E00\u6574\u5957\u8BBE\u5907\u5934\u624D\u4E0B\u53D1\u6BCF\u65E5\u6D3B\u52A8\uFF0C\u7F3A\u4E86\u5B83\u4EEC\uFF08\u5C24\u5176\u662F Cosy-ClientType: 10\uFF09\u6D3B\u52A8\u5217\u8868\u4F1A\u76F4\u63A5\u8FD4\u56DE\u7A7A\u3002Cloudflare Worker \u8DD1\u5728\u4E91\u7AEF\u3001\u6CA1\u6CD5\u6267\u884C Windows exe\uFF0C\u6240\u4EE5\u8981\u5728\u88C5\u8FC7 Qoder \u5BA2\u6237\u7AEF\u7684\u673A\u5668\u4E0A\u53D6\u4E00\u6B21\u3002",
    steps: [
      step(
        "\u5148\u8BBE Qoder \u5B89\u88C5\u76EE\u5F55",
        "\u5C31\u662F\u5305\u542B `Qoder CN.exe` \u7684\u90A3\u4E2A\u6587\u4EF6\u5939\uFF0C\u6539\u6210\u4F60\u81EA\u5DF1\u7684\u8DEF\u5F84\u3002"
      ),
      step(
        "\u6574\u6BB5\u590D\u5236\u5230 PowerShell \u56DE\u8F66",
        "\u5728\u88C5\u6709 Qoder \u684C\u9762\u7AEF\u7684 Windows \u4E0A\u6253\u5F00 **PowerShell 7**\uFF08`pwsh`\uFF0C\u5F00\u59CB\u83DC\u5355\u641C PowerShell\uFF09\u3002\u811A\u672C\u4F1A\u8BFB\u4E0A\u9762\u8BBE\u7684 `$qoderRoot`\uFF0C\u6CA1\u8BBE\u4F1A\u62A5\u9519\u63D0\u793A\u3002",
        `$qoderRoot = "D:\\Program\\Qoder CN"

& {
if (-not $qoderRoot) { throw "\u8BF7\u5148\u6267\u884C \`$qoderRoot = \`"\u4F60\u7684Qoder\u5B89\u88C5\u76EE\u5F55\`" \u8BBE\u7F6E\u8DEF\u5F84" }

# DPAPI \u89E3\u5BC6\u8F85\u52A9\uFF08\u7528\u4E8E\u89E3 Token\uFF09
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Dpapi {
    [StructLayout(LayoutKind.Sequential)] struct BLOB { public int cb; public IntPtr pb; }
    [DllImport("crypt32.dll", SetLastError=true)] static extern bool CryptUnprotectData(ref BLOB i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref BLOB o);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr m);
    public static byte[] Unprotect(byte[] data) {
        var bi = new BLOB { cb = data.Length, pb = Marshal.AllocHGlobal(data.Length) };
        Marshal.Copy(data, 0, bi.pb, data.Length);
        var bo = new BLOB();
        if (!CryptUnprotectData(ref bi, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, ref bo)) {
            Marshal.FreeHGlobal(bi.pb); throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        Marshal.FreeHGlobal(bi.pb);
        var r = new byte[bo.cb]; Marshal.Copy(bo.pb, r, 0, bo.cb); LocalFree(bo.pb); return r;
    }
}
"@

$dataDir = Join-Path $env:APPDATA "com.qodercn.app.stable"

# 1. runtime-info.exe\uFF08\u8BBE\u5907\u6807\u8BC6\uFF09
$umidExe = Join-Path $qoderRoot "resources\\umid\\runtime-info.exe"
if (-not (Test-Path $umidExe)) { throw "\u627E\u4E0D\u5230 $umidExe\uFF0C\u8BF7\u68C0\u67E5 \`$qoderRoot \u662F\u5426\u6B63\u786E" }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $umidExe; $psi.Arguments = "--account-stdin"
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
$p.StandardInput.Close() | Out-Null
$out = $p.StandardOutput.ReadToEnd()
$p.WaitForExit(40000) | Out-Null
$ri = ($out -split "\`r?\`n" | Where-Object { $_.Trim() } | Select-Object -Last 1) | ConvertFrom-Json

# 2. \u7248\u672C\u53F7
$cosyVersion = ""
$mf = Join-Path $qoderRoot "resources\\build-manifest.json"
if (Test-Path $mf) { try { $cosyVersion = [string]((Get-Content $mf -Raw | ConvertFrom-Json).productVersion) } catch {} }

# 3. machine-id
$cosyMachineId = ""
$midFile = Join-Path $dataDir "auth.machine-id"
if (Test-Path $midFile) { $cosyMachineId = (Get-Content $midFile -Raw).Trim() }

# 4. \u67B6\u6784
$arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM|arm64|aarch64") { "aarch64" } else { "x86_64" }

# 5. Token \u89E3\u5BC6\uFF08DPAPI + AES-256-GCM\uFF09
$sess = $null
$tokenNote = ""
$authFile = Join-Path $dataDir "auth.v1.dat"
$stateFile = Join-Path $dataDir "Local State"
if ((Test-Path $authFile) -and (Test-Path $stateFile)) {
    try {
        $raw = [IO.File]::ReadAllBytes($authFile)
        if ($raw.Length -ge 60 -and [Text.Encoding]::ASCII.GetString($raw, 0, 3) -eq "v10") {
            $st = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $ek = [Convert]::FromBase64String($st.os_crypt.encrypted_key)
            $key = [Dpapi]::Unprotect($ek[5..($ek.Length - 1)])
            $nonce = $raw[3..14]; $ct = $raw[15..($raw.Length - 17)]; $tag = $raw[($raw.Length - 16)..($raw.Length - 1)]
            $pt = New-Object byte[] $ct.Length
            $gcm = [System.Security.Cryptography.AesGcm]::new($key)
            $gcm.Decrypt($nonce, $ct, $tag, $pt)
            $sess = [Text.Encoding]::UTF8.GetString($pt) | ConvertFrom-Json
        }
    } catch { $tokenNote = "Token \u89E3\u5BC6\u51FA\u9519\uFF1A$($_.Exception.Message)" }
} else {
    $tokenNote = "\u627E\u4E0D\u5230 $dataDir\\auth.v1.dat \u6216 Local State\uFF0CQoder \u684C\u9762\u7AEF\u767B\u5F55\u8FC7\u5417\uFF1F"
}

# === \u8F93\u51FA\u8BBE\u5907\u6807\u8BC6 ===
Write-Host ""
Write-Host "====== \u8BBE\u5907\u6807\u8BC6\uFF08\u586B\u5230\u300C\u5DE5\u5177\u914D\u7F6E\u300D\uFF09======" -ForegroundColor Green
Write-Host "COSY_CLIENT_TYPE      = 10"
Write-Host "COSY_MACHINE_OS       = \${arch}_windows"
Write-Host "COSY_MACHINE_HOSTNAME = $env:COMPUTERNAME"
if ($cosyVersion)     { Write-Host "COSY_VERSION          = $cosyVersion" }
if ($cosyMachineId)   { Write-Host "COSY_MACHINE_ID       = $cosyMachineId" }
if ($ri.machineToken) { Write-Host "COSY_MACHINE_TOKEN    = $($ri.machineToken)" }
if ($ri.machineCode)  { Write-Host "COSY_MACHINE_CODE     = $($ri.machineCode)" }
if ($ri.machineType)  { Write-Host "COSY_MACHINE_TYPE     = $($ri.machineType)" }
Write-Host "=============================================" -ForegroundColor Green

# === \u8F93\u51FA Token ===
if ($sess -and $sess.token) {
    Write-Host ""
    Write-Host "====== \u767B\u5F55\u51ED\u636E\uFF08\u586B\u5230\u300C\u65B0\u589E\u8D26\u53F7\u300D\uFF09======" -ForegroundColor Cyan
    Write-Host "\u5DF2\u8BFB\u53D6\uFF1Acom.qodercn.app.stable\uFF08\u6709\u6548\u671F\u81F3 $($sess.expiresAt)\uFF09"
    Write-Host "TOKEN:$($sess.token)"
    Write-Host "REFRESH:$($sess.refreshToken)"
    Write-Host "=========================================" -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "\uFF08Token \u672A\u63D0\u53D6\u5230\u2014\u2014$tokenNote\uFF09" -ForegroundColor Yellow
    Write-Host "\u8BBE\u5907\u6807\u8BC6\u5DF2\u6B63\u5E38\u8F93\u51FA\uFF0C\u4E0D\u5F71\u54CD\u7B7E\u5230\u914D\u7F6E\u3002" -ForegroundColor Yellow
}
}`
      ),
      step(
        "\u628A\u4E24\u6BB5\u8F93\u51FA\u5206\u522B\u586B\u5230\u5BF9\u5E94\u4F4D\u7F6E",
        "**\u8BBE\u5907\u6807\u8BC6**\uFF08\u8F93\u51FA\u91CC\u7684 8 \u884C `COSY_*`\uFF09\u586B\u5230\u672C\u5DE5\u5177\u7684\u300C\u5DE5\u5177\u914D\u7F6E\u300D\u9875 \u2014\u2014 \u7167\u4E0B\u9762\u8868\u683C\u7B2C\u4E00\u5217\u7684\u680F\u4F4D\u540D\u586B\uFF0C\u8868\u683C\u7B2C\u4E8C\u5217\u544A\u8BC9\u4F60\u662F\u811A\u672C\u8F93\u51FA\u7684\u54EA\u4E00\u884C\uFF1B**TOKEN / REFRESH** \u586B\u5230\u300C\u65B0\u589E\u8D26\u53F7\u300D\u7684\u8868\u5355\u91CC\u3002\u82E5 TOKEN \u662F `dt--` \u5F00\u5934\u7684\u77ED\u4E32\uFF08\u65B0\u7248\u5BA2\u6237\u7AEF\u7684\u8BBE\u5907\u4EE4\u724C\uFF09\uFF0C\u8868\u5355\u4F1A\u591A\u4E00\u4E2A\u300C\u8D26\u53F7\u6807\u8BC6\u300D\u680F\uFF1A\u7ED9\u5B83\u8D77\u4E2A\u56FA\u5B9A\u4EE3\u53F7\uFF08\u5982 `main`\uFF09\u586B\u4E0A\u5373\u53EF\uFF0C\u5EFA\u53F7\u540E\u4E0D\u8981\u518D\u6539\u3002"
      )
    ],
    // 这里不放"配不上怎么办"之类的提示：上游分不开这些情况，
    // 日志里本来就会把三种可能一次列全，摆在这里只会让人以为是自己弄错了。
    //
    // 第一列写「工具配置」页里能看到的栏位名。环境变量名（COSY_*）放在说明列里 ——
    // 那是脚本的输出标签，用户是在表单里找栏位，照着 COSY_* 找会找不到。
    fields: [
      ["**Cosy-ClientType**", "\u56FA\u5B9A\u503C `10`", "\u73AF\u5883\u53D8\u91CF `COSY_CLIENT_TYPE`\u3002**\u7F3A\u8FD9\u4E2A\u6D3B\u52A8\u5217\u8868\u76F4\u63A5\u4E3A\u7A7A**"],
      ["**Cosy-MachineToken**", "runtime-info.exe", "\u73AF\u5883\u53D8\u91CF `COSY_MACHINE_TOKEN`\u3002\u8BBE\u5907\u4EE4\u724C\uFF08\u6700\u53EF\u80FD\u8FC7\u671F\u7684\u90A3\u4E2A\uFF09"],
      ["**Cosy-MachineCode**", "runtime-info.exe", "\u73AF\u5883\u53D8\u91CF `COSY_MACHINE_CODE`\u3002\u8BBE\u5907\u7F16\u7801"],
      ["**Cosy-MachineType**", "runtime-info.exe", "\u73AF\u5883\u53D8\u91CF `COSY_MACHINE_TYPE`\u3002\u8BBE\u5907\u7C7B\u578B"],
      ["**Cosy-MachineOS**", "\u7CFB\u7EDF\u67B6\u6784", "\u73AF\u5883\u53D8\u91CF `COSY_MACHINE_OS`\uFF0C\u5982 `x86_64_windows`"],
      ["**Cosy-MachineHostname**", "\u672C\u673A\u4E3B\u673A\u540D", "\u73AF\u5883\u53D8\u91CF `COSY_MACHINE_HOSTNAME`"],
      ["**Cosy-MachineId**", "`auth.machine-id`", "\u73AF\u5883\u53D8\u91CF `COSY_MACHINE_ID`"],
      ["**Cosy-Version**", "build-manifest.json", "\u73AF\u5883\u53D8\u91CF `COSY_VERSION`\u3002Qoder \u5BA2\u6237\u7AEF\u7684\u7248\u672C\u53F7"]
    ]
  },
  trae: {
    intro: "Trae \u7684\u51ED\u636E\u53EA\u80FD\u4ECE\u767B\u5F55\u56DE\u8C03\u91CC\u62FF\uFF1A\u767B\u5F55\u9875\u4F1A\u8DF3\u5230\u4E00\u4E2A `http://127.0.0.1:18080/authorize?...` \u7684\u5730\u5740\uFF08\u90A3\u4E2A\u9875\u9762\u6253\u4E0D\u5F00\u662F**\u6B63\u5E38\u7684**\uFF0C\u672C\u673A\u6CA1\u6709\u670D\u52A1\u5728\u76D1\u542C\uFF09\uFF0C\u6574\u6761 URL \u91CC\u5C31\u5E26\u7740\u4EE4\u724C\u3002\u8BBE\u5907\u53F7\u5728\u5BA2\u6237\u7AEF\u7684 `storage.json` \u91CC\uFF0C\u6700\u540E\u4E00\u6B65\u811A\u672C\u4F1A\u81EA\u52A8\u8BFB\u51FA\u6765\uFF0C\u4E0D\u7528\u5355\u72EC\u627E\u3002",
    steps: [
      step(
        "\u6253\u5F00\u767B\u5F55\u94FE\u63A5",
        "\u590D\u5236\u4E0B\u9762\u8FD9\u884C\u5230 PowerShell \u56DE\u8F66\uFF0C\u5B83\u4F1A\u76F4\u63A5\u7528\u9ED8\u8BA4\u6D4F\u89C8\u5668\u6253\u5F00 Trae \u767B\u5F55\u9875\u3002\u94FE\u63A5**\u73B0\u53D6\u73B0\u7528**\uFF0C\u6BCF\u6B21\u90FD\u4F1A\u751F\u6210\u65B0\u7684\u3002",
        `Start-Process "https://api.trae.cn/ide/v1/auth/authorize?login_version=1&auth_from=solo&login_channel=native_ide&plugin_version=0.1.43&auth_type=local&client_id=en1oxy7wnw8j9n&redirect=0&auth_callback_url=http://127.0.0.1:18080/authorize&machine_id=&device_id=&x_device_brand=PC&x_device_type=PC&x_os_version=1.0&x_app_version=0.1.43&x_app_type=stable"`
      ),
      step(
        "\u767B\u5F55\uFF0C\u7136\u540E\u590D\u5236\u90A3\u6761\u6253\u4E0D\u5F00\u7684\u5730\u5740",
        "\u7528\u624B\u673A\u53F7 + \u9A8C\u8BC1\u7801\u767B\u5F55\u3002\u767B\u5F55\u6210\u529F\u540E\u6D4F\u89C8\u5668\u4F1A\u8DF3\u5230 `http://127.0.0.1:18080/authorize?...` \u5F00\u5934\u7684\u9875\u9762\uFF0C\u663E\u793A\u300C\u65E0\u6CD5\u8BBF\u95EE\u6B64\u7F51\u7AD9\u300D\u2014\u2014 \u6B63\u5E38\u3002\u5728\u5730\u5740\u680F `Ctrl+A` \u2192 `Ctrl+C`\uFF08macOS `Cmd+A` \u2192 `Cmd+C`\uFF09\uFF0C\u628A\u8FD9\u4E00\u6574\u6761\u5B8C\u6574 URL \u590D\u5236\u4E0B\u6765\uFF08\u5F88\u957F\uFF0C\u5E26 `refreshToken=...` \u7B49\u53C2\u6570\uFF1B\u5728\u6D4F\u89C8\u5668\u91CC\u590D\u5236\u4E0D\u4F1A\u88AB\u622A\u65AD\uFF09\u3002"
      ),
      step(
        "\u8FD0\u884C\u811A\u672C\uFF1A\u81EA\u52A8\u53D6\u8BBE\u5907\u53F7 + \u89E3\u6790\u4EE4\u724C",
        "\u628A\u4E0B\u9762\u7B2C\u4E00\u884C\u7684\u5F15\u53F7\u5185\u6362\u6210\u4F60\u521A\u590D\u5236\u7684\u90A3\u6761\u5B8C\u6574 URL\uFF0C\u6574\u6BB5\u56DE\u8F66\u3002\u811A\u672C\u4F1A\u81EA\u52A8\u4ECE\u672C\u5730\u5BA2\u6237\u7AEF\u7684 storage.json \u91CC\u8BFB\u51FA Aha \u8BBE\u5907\u53F7\uFF0C\u518D\u4ECE\u56DE\u8C03 URL \u91CC\u89E3\u6790\u51FA\u4EE4\u724C\uFF0C\u4E00\u6B21\u8F93\u51FA\u4E09\u4E2A\u503C\u3002",
        `& {
# 1. \u4ECE\u672C\u5730\u5BA2\u6237\u7AEF\u53D6 Aha \u8BBE\u5907\u53F7\uFF088-16 \u4F4D\u6570\u5B57\uFF09
$deviceId = ""
$paths = @(
  "$env:APPDATA\\TRAE SOLO CN\\User\\globalStorage\\storage.json",
  "$env:APPDATA\\Trae CN\\User\\globalStorage\\storage.json",
  "$env:APPDATA\\Trae\\User\\globalStorage\\storage.json"
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    $m = Select-String -Path $p -Pattern 'iCubeAuthInfo://icube-dc:(\\d{8,16})' -AllMatches |
      ForEach-Object { $_.Matches } | Select-Object -First 1
    if ($m) { $deviceId = $m.Groups[1].Value; break }
  }
}

# 2. \u628A\u4E0B\u9762\u5F15\u53F7\u5185\u6362\u6210\u4F60\u590D\u5236\u7684\u6574\u6761 127.0.0.1 \u5F00\u5934\u7684 URL
$cb = "\u7C98\u8D34\u4F60\u590D\u5236\u7684\u6574\u6761 127.0.0.1 \u5F00\u5934\u7684 URL"

# \u4E0E\u670D\u52A1\u7AEF\u540C\u4E00\u5957\u89E3\u6790\uFF1A\u53EA\u505A\u4E00\u6B21 %XX \u89E3\u7801\uFF0C\u4E0D\u505A '+' \u2192 \u7A7A\u683C\u8F6C\u6362
# \uFF08searchParams.get \u4F1A\u628A\u5B57\u9762\u91CF '+' \u89E3\u6210\u7A7A\u683C\uFF0C\u4EE4\u724C\u91CC\u542B '+' \u4F1A\u88AB\u6084\u6084\u7834\u574F\uFF09
$u = [Uri]$cb.Trim()
# \u67E5\u8BE2\u4E32\u4E0E # \u540E\u7684\u7247\u6BB5\u90FD\u8BD5\uFF08\u6709\u7684\u6D4F\u89C8\u5668\u628A\u53C2\u6570\u653E hash \u91CC\uFF09\uFF0C.Query / .Fragment \u81EA\u5E26 ? \u4E0E # \u524D\u7F00
$raw = ($u.Query.TrimStart('?') + $u.Fragment.TrimStart('#'))
function Q($n) {
  # \u8FD9\u91CC\u5FC5\u987B\u7528\u53CC\u5F15\u53F7\uFF1A$n \u8981\u63D2\u503C\u3002(?:^|&) \u91CC\u7684 $ \u540E\u9762\u8DDF\u7684\u662F ^ \uFF0C\u4E0D\u4F1A\u88AB\u5F53\u6210 $& \u8F6C\u4E49
  $m = [regex]::Match($raw, "(?:^|&)$n=([^&]*)")
  if (-not $m.Success) { return "" }
  try { return [Uri]::UnescapeDataString($m.Groups[1].Value) } catch { return $m.Groups[1].Value }
}
function J($v) {
  if (-not $v) { return $null }
  foreach ($t in @($v, [Uri]::UnescapeDataString($v))) {
    try { $o = $t | ConvertFrom-Json; if ($o) { return $o } } catch {}
  }
  return $null
}

$jwt = J (Q "userJwt")
$rt  = Q "refreshToken"
if (-not $rt -and $jwt) { $rt = $jwt.RefreshToken }

Write-Host ""
Write-Host "====== \u586B\u5230\u300C\u65B0\u589E\u8D26\u53F7\u300D======" -ForegroundColor Cyan
Write-Host "Aha \u8BBE\u5907\u53F7  : $deviceId"
Write-Host "Access Token : $($jwt.Token)"
Write-Host "Refresh Token: $rt"
Write-Host "=================================" -ForegroundColor Cyan
if (-not $deviceId) { Write-Host "\uFF08\u6CA1\u627E\u5230\u8BBE\u5907\u53F7\u2014\u2014\u786E\u8BA4\u88C5\u8FC7 Trae \u5BA2\u6237\u7AEF\u5E76\u767B\u5F55\u8FC7\uFF09" -ForegroundColor Yellow }
if (-not $rt) { Write-Host "\uFF08\u56DE\u8C03\u91CC\u6CA1\u6709 refreshToken \u2014\u2014 \u8BF7\u786E\u8BA4\u6574\u6761 URL \u90FD\u590D\u5236\u4E86\uFF09" -ForegroundColor Yellow }
}`
      )
    ],
    notes: [
      note("warn", "**\u8BBE\u5907\u53F7\u5FC5\u987B\u662F\u771F\u5B9E\u7684\u3002** \u7B7E\u5230\u98CE\u63A7\u6309\u5B83\u5224\u5B9A\uFF0C\u968F\u624B\u7F16\u4E00\u4E2A\uFF08\u54EA\u6015 8\u201316 \u4F4D\u683C\u5F0F\u770B\u7740\u5BF9\uFF09\u4F1A\u6BCF\u5929\u7A33\u5B9A\u8FD4\u56DE 9074\u300C\u670D\u52A1\u5668\u7E41\u5FD9\u300D\u2014\u2014 \u770B\u7740\u50CF\u9650\u9891\uFF0C\u5176\u5B9E\u662F\u8BBE\u5907\u53F7\u9519\u4E86\u3002")
    ],
    // 第一列必须是**表单里能看到的字段名**，不能是平台内部的头名 ——
    // 用户按头名去找字段找不到，会以为少填了一项（这三个头与两个令牌框的关系本来就不直观）。
    fields: [
      ["**Aha \u8BBE\u5907\u53F7**", "\u7B2C 3 \u6B65\u811A\u672C\u81EA\u52A8\u4ECE\u5BA2\u6237\u7AEF `storage.json` \u8BFB\u51FA", "\u586B\u8FDB\u8868\u5355\u7684\u300CAha \u8BBE\u5907\u53F7\u300D\u90A3\u4E00\u680F\u3002\u7B7E\u5230\u65F6\u5B83\u88AB\u653E\u8FDB `x-device-id` \u5934\uFF0C8\u201316 \u4F4D\u6570\u5B57\uFF0C\u98CE\u63A7\u6309\u5B83\u5224\u5B9A"],
      ["**Access Token**", "\u767B\u5F55\u56DE\u8C03 URL \u91CC\u7684 `userJwt`", "\u6362\u7968\u4E0E\u67E5\u7528\u6237\u4FE1\u606F\u65F6\u5B83\u88AB\u653E\u8FDB `x-cloudide-token` \u5934"],
      ["**Refresh Token**", "\u767B\u5F55\u56DE\u8C03 URL \u91CC\u7684 `refreshToken`", "\u7EED\u671F\u65F6\u6362\u65B0\u7968\uFF1B**\u7B7E\u5230\u7528\u7684\u4E0D\u662F\u5B83**"],
      ["\uFF08\u4E0D\u7528\u586B\uFF09`Cloud-IDE-JWT`", "\u540C\u4E00\u4E2A `userJwt`", "\u7B7E\u5230\u4E0E\u989D\u5EA6\u67E5\u8BE2\u65F6\u5B83\u624D\u662F `Authorization` \u7684\u503C \u2014\u2014 \u6240\u4EE5\u4E0A\u9762\u4E24\u4E2A\u4EE4\u724C\u91CC\uFF0C\u53EA\u6709 Access Token \u53C2\u4E0E\u7B7E\u5230"]
    ]
  },
  workbuddy: {
    // 不提别的工具的文件名：三份教程各自独立，跨工具互相指路只会让人串台。
    intro: "\u4EE4\u724C\u8D70 WorkBuddy \u5B98\u65B9\u7684\u77ED\u4FE1\u767B\u5F55\u63A5\u53E3\u6362\u660E\u6587 Token \u2014\u2014 \u503C\u5728\u672C\u673A\u62FF\uFF0C\u4E0D\u7ECF\u8FC7 Cloudflare\u3002\u684C\u9762\u7AEF\u8F83\u65E7\u65F6\u4E5F\u53EF\u4EE5\u4E0D\u6298\u817E\u8FD9\u4E2A\u63A5\u53E3\uFF0C\u76F4\u63A5\u4ECE\u5BA2\u6237\u7AEF\u7684\u51ED\u636E\u6587\u4EF6\u91CC\u53D6\uFF08\u89C1\u4E0B\u9762\u7B2C 1 \u6B65\uFF09\u3002",
    steps: [
      step(
        "\u5148\u8BD5\u65E7\u7248\uFF1A\u4ECE\u5BA2\u6237\u7AEF\u51ED\u636E\u6587\u4EF6\u91CC\u76F4\u63A5\u53D6\uFF08\u53EF\u8DF3\u8FC7\uFF09",
        '\u6253\u5F00 `%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info`\uFF0C\u91CC\u9762\u662F JSON\uFF0C**\u65E7\u7248\u672C**\u7684 `accessToken` / `refreshToken` \u8FD8\u662F\u7EAF\u5B57\u7B26\u4E32\uFF08\u4E0D\u662F\u52A0\u5BC6\u5BF9\u8C61\uFF09\uFF0C\u590D\u5236\u8FD9\u4E24\u4E2A\u503C\u586B\u8FDB\u8868\u5355\u5373\u53EF\uFF0C\u4E0D\u7528\u53D1\u77ED\u4FE1\u3002\u65B0\u7248\u672C\u8FD9\u4E24\u4E2A\u503C\u5DF2\u88AB\u52A0\u5BC6\u6210 `{"$wbEncrypted":1,"envelope":"\u2026"}`\uFF0C\u590D\u5236\u51FA\u6765\u4E5F\u6CA1\u7528 \u2014\u2014 \u90A3\u79CD\u7248\u672C\u8D70\u7B2C 2\u30013 \u6B65\u3002',
        `$p = "$env:LOCALAPPDATA\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info"
if (Test-Path $p) {
  $j = Get-Content $p -Raw | ConvertFrom-Json
  Write-Host ""
  Write-Host "====== \u586B\u5230\u300C\u65B0\u589E\u8D26\u53F7\u300D\uFF08\u53D6\u5230\u660E\u6587\u624D\u6709\u6548\uFF09======" -ForegroundColor Cyan
  Write-Host "Access Token : $($j.accessToken)"
  Write-Host "Refresh Token: $($j.refreshToken)"
  Write-Host "==============================================" -ForegroundColor Cyan
} else {
  Write-Host "\u6CA1\u627E\u5230 $p \u2014\u2014 \u684C\u9762\u7AEF\u88C5\u8FC7\u5417\uFF1F\u6216\u7248\u672C\u8F83\u65B0\uFF0C\u8BF7\u8D70\u77ED\u4FE1\u767B\u5F55\u90A3\u4E24\u6B65\u3002" -ForegroundColor Yellow
}`
      ),
      step(
        "\u53D1\u9A8C\u8BC1\u7801",
        "\u628A `13800000000` \u6362\u6210\u4F60\u7684\u624B\u673A\u53F7\u3002\u8FD4\u56DE `code: 0` \u5373\u53D1\u9001\u6210\u529F\u3002",
        `Invoke-RestMethod -Uri "https://www.workbuddy.cn/v2/plugin/login/send-sms" \`
  -Method Post -ContentType "application/json" -Body '{"phone":"13800000000"}'`
      ),
      step(
        "\u7528\u9A8C\u8BC1\u7801\u6362 Token",
        "\u628A\u624B\u673A\u53F7\u548C `123456` \u6362\u6210\u5B9E\u9645\u6536\u5230\u7684\u9A8C\u8BC1\u7801\uFF08\u6709\u6548\u671F\u7EA6 5 \u5206\u949F\uFF09\u3002\u6267\u884C\u540E\u8F93\u51FA\u4E24\u884C\u503C\uFF0C\u590D\u5236\u4FDD\u5B58\u597D \u2014\u2014 \u4E0B\u4E00\u6B65\u8981\u586B\u3002",
        // 刻意不解 uid：uid 平台自己从令牌的 sub 解，脚本再解一遍只是让人
        // 多看一行字，还要多三行 base64 拼装（而 WorkBuddy 的票据形态会变，
        // 拼错了反而让人以为令牌坏了）。
        `& {
$r = Invoke-RestMethod -Uri "https://www.workbuddy.cn/v2/plugin/login/token" \`
  -Method Post -ContentType "application/json" \`
  -Body '{"login_method":"phone","phone":"13800000000","sms_code":"123456"}'

Write-Host ""
Write-Host "====== \u586B\u5230\u300C\u65B0\u589E\u8D26\u53F7\u300D======" -ForegroundColor Cyan
Write-Host "Access Token : $($r.data.accessToken)"
Write-Host "Refresh Token: $($r.data.refreshToken)"
Write-Host "=================================" -ForegroundColor Cyan
}`
      ),
      step(
        "\u586B\u5230\u8868\u5355",
        "\u4E24\u4E2A\u4EE4\u724C\u586B\u8FDB\u8868\u5355\u5C31\u884C \u2014\u2014 \u4EE4\u724C\u5230\u671F\u65F6\u95F4\u5E73\u53F0\u4F1A\u81EA\u52A8\u4ECE `exp` \u89E3\u51FA\u6765\u3002"
      )
    ],
    notes: [
      note("info", "\u591A\u8D26\u53F7\u65F6\u6BCF\u4E2A\u53F7\u90FD\u8981\u8D70\u4E00\u904D\uFF1A\u65E7\u7248\u5BA2\u6237\u7AEF\u4ECE\u7B2C 1 \u6B65\u7684 `.info` \u53D6\uFF0C\u65B0\u7248\u8D70\u7B2C 2\u30013 \u6B65\u53D1\u77ED\u4FE1\u3002")
    ],
    fields: [
      [
        "**Access Token**",
        "\u7B2C 1 \u6B65\uFF08`.info`\uFF09\u6216\u7B2C 3 \u6B65\uFF08\u77ED\u4FE1\uFF09\u7684 `Access Token`",
        '\u586B\u8FDB\u8868\u5355\u7684 Access Token \u90A3\u4E00\u680F\uFF0C\u5230\u671F\u65F6\u95F4\u5E73\u53F0\u81EA\u52A8\u4ECE `exp` \u89E3\u3002\u65E7\u7248\u684C\u9762\u7AEF\u51ED\u636E\u662F\u660E\u6587\u53EF\u76F4\u63A5\u7C98\uFF1B\u65B0\u7248\u662F `{"$wbEncrypted":1,"envelope":"\u2026"}` \u52A0\u5BC6\u683C\u5F0F\uFF0C\u4E0D\u80FD\u76F4\u63A5\u7C98\uFF0C\u9700\u8D70\u77ED\u4FE1\u767B\u5F55'
      ],
      ["**Refresh Token**", "\u7B2C 1 \u6B65\uFF08`.info`\uFF09\u6216\u7B2C 3 \u6B65\uFF08\u77ED\u4FE1\uFF09\u7684 `Refresh Token`", "\u586B\u8FDB Refresh Token \u90A3\u4E00\u680F\u3002\u65E7\u4E32\u7528\u8FC7\u4E00\u6B21\u5373\u5E9F\uFF0C\u7EED\u671F\u540E\u5E73\u53F0\u5F53\u573A\u5199\u56DE"]
    ]
  },
  "69yun": {
    intro: "69 \u4E91\u662F SSPanel \u67B6\u6784\u7684\u673A\u573A\uFF0C\u7B7E\u5230\u51ED\u636E\u5C31\u662F\u7F51\u7AD9\u7684\u767B\u5F55\u90AE\u7BB1\u548C\u5BC6\u7801\u2014\u2014\u4E0D\u9700\u8981\u6293\u5305\u3001\u4E0D\u9700\u8981\u5BA2\u6237\u7AEF\uFF0C\u80FD\u767B\u5F55\u7F51\u9875\u5C31\u80FD\u7B7E\u5230\u3002\u7B7E\u5230\u53F0\u4F1A\u81EA\u52A8\u4FDD\u5B58\u767B\u5F55\u540E\u7684 Cookie\uFF0C\u5931\u6548\u65F6\u7528\u90AE\u7BB1\u5BC6\u7801\u91CD\u65B0\u767B\u5F55\uFF0C\u4E0D\u9700\u8981\u624B\u52A8\u7EF4\u62A4\u3002",
    steps: [
      step(
        "\u786E\u8BA4\u80FD\u767B\u5F55 69 \u4E91\u5B98\u7F51",
        "\u5728\u6D4F\u89C8\u5668\u91CC\u6253\u5F00 https://69yun69.com\uFF0C\u7528\u4F60\u7684\u90AE\u7BB1\u5BC6\u7801\u767B\u5F55\u3002\u80FD\u8FDB\u5230\u7528\u6237\u4E2D\u5FC3\u5C31\u8BF4\u660E\u51ED\u636E\u6709\u6548\u2014\u2014\u7B7E\u5230\u53F0\u7528\u7684\u5C31\u662F\u8FD9\u5BF9\u51ED\u636E\u3002"
      ),
      step(
        "\uFF08\u53EF\u9009\uFF09\u7528 PowerShell \u9A8C\u8BC1\u767B\u5F55\u63A5\u53E3",
        "\u628A `your@email.com` \u548C `your_password` \u6362\u6210\u4F60\u81EA\u5DF1\u7684\u3002\u8F93\u51FA\u300C\u767B\u5F55\u6210\u529F\u300D\u5C31\u8BF4\u660E\u51ED\u636E\u6B63\u786E\uFF0C\u53EF\u4EE5\u76F4\u63A5\u586B\u8868\u5355\u3002\u8FD9\u4E00\u6B65\u4E0D\u662F\u5FC5\u987B\u7684\uFF0C\u53EA\u662F\u7ED9\u4E0D\u786E\u5B9A\u5BC6\u7801\u5BF9\u4E0D\u5BF9\u7684\u4EBA\u4E00\u4E2A\u5FEB\u901F\u9A8C\u8BC1\u3002",
        `& {
  $email = "your@email.com"
  $pass  = "your_password"
  $body = @{ email = $email; passwd = $pass; remember_me = "on"; code = "" } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Uri "https://69yun69.com/auth/login" \`
      -Method Post -ContentType "application/json" -Body $body
    if ($r.ret -eq 1) {
      Write-Host "\u767B\u5F55\u6210\u529F\uFF01\u628A\u90AE\u7BB1\u548C\u5BC6\u7801\u586B\u8FDB\u7B7E\u5230\u53F0\u5373\u53EF" -ForegroundColor Green
    } else {
      Write-Host "\u767B\u5F55\u5931\u8D25: $($r.msg)" -ForegroundColor Red
    }
  } catch {
    Write-Host "\u8BF7\u6C42\u5931\u8D25: $_" -ForegroundColor Red
  }
}`
      ),
      step(
        "\u586B\u5230\u8868\u5355",
        "\u90AE\u7BB1\u586B\u8FDB\u300C\u90AE\u7BB1\u300D\u680F\uFF0C\u5BC6\u7801\u586B\u8FDB\u300C\u5BC6\u7801\u300D\u680F\u3002\u300C\u4F1A\u8BDD Cookie\u300D\u90A3\u4E00\u680F\u7559\u7A7A\u5C31\u884C\u2014\u2014\u7B7E\u5230\u53F0\u7B2C\u4E00\u6B21\u7B7E\u5230\u65F6\u4F1A\u81EA\u52A8\u767B\u5F55\u5E76\u4FDD\u5B58\u3002"
      )
    ],
    notes: [
      note("info", "Cookie \u81EA\u52A8\u7BA1\u7406\uFF1A\u7B2C\u4E00\u6B21\u7B7E\u5230\u65F6\u5982\u679C\u6CA1\u6709 Cookie\uFF0C\u4F1A\u81EA\u52A8\u8D70\u767B\u5F55\u6D41\u7A0B\u5E76\u4FDD\u5B58\uFF1B\u4E4B\u540E\u6BCF\u6B21\u76F4\u63A5\u7528 Cookie\uFF0C\u5931\u6548\u65F6\u81EA\u52A8\u91CD\u65B0\u767B\u5F55\u3002")
    ],
    fields: [
      ["**\u90AE\u7BB1**", "69 \u4E91\u5B98\u7F51\u7684\u767B\u5F55\u90AE\u7BB1", "\u540C\u65F6\u4F5C\u4E3A\u8D26\u53F7\u7684\u552F\u4E00\u6807\u8BC6\uFF0C\u5EFA\u53F7\u540E\u4E0D\u8981\u6539"],
      ["**\u5BC6\u7801**", "69 \u4E91\u5B98\u7F51\u7684\u767B\u5F55\u5BC6\u7801", "Cookie \u5931\u6548\u65F6\u7528\u5B83\u91CD\u65B0\u767B\u5F55"],
      ["**\u4F1A\u8BDD Cookie**", "\u81EA\u52A8\u751F\u6210\uFF0C\u65E0\u9700\u586B\u5199", "\u767B\u5F55\u540E\u81EA\u52A8\u4FDD\u5B58\uFF0Creadonly \u5B57\u6BB5"]
    ]
  }
};
function renderTutorial(tool) {
  const t = TUTORIALS[tool.id];
  if (!t) return "";
  const esc = /* @__PURE__ */ __name((s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), "esc");
  const rich = /* @__PURE__ */ __name((s) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>"), "rich");
  const steps = t.steps.map((s, i) => `<div class="tut">
      <div class="tut-h"><span class="tut-n">${i + 1}</span>${rich(s.title)}</div>
      ${s.body ? `<p class="tut-b">${rich(s.body)}</p>` : ""}
      ${s.code ? `<pre class="tut-c">${esc(s.code)}</pre>` : ""}
    </div>`).join("");
  const copyHint = t.steps.some((s) => s.code) ? `<p class="tiny m0">\u4E0B\u9762\u6BCF\u6BB5\u811A\u672C\uFF1A\u70B9\u4E00\u4E0B\u5373\u6574\u6BB5\u9009\u4E2D\uFF0C\u518D\u6309 Ctrl/Cmd + C \u590D\u5236\u3002</p>` : "";
  const notes = (t.notes || []).map((n) => `<div class="alert ${n.kind === "warn" ? "warn" : "info"}">${rich(n.text)}</div>`).join("");
  const fields = (t.fields || []).length ? `<div class="tw"><table class="t"><thead><tr><th>\u503C</th><th>\u4ECE\u54EA\u6765</th><th>\u8BF4\u660E</th></tr></thead><tbody>${t.fields.map(([a, b, c]) => `<tr><td data-label="\u503C">${rich(a)}</td><td data-label="\u4ECE\u54EA\u6765">${rich(b)}</td><td data-label="\u8BF4\u660E">${rich(c || "\u2014")}</td></tr>`).join("")}</tbody></table></div>` : "";
  return `<div class="tutbox">
    <div class="tut-intro">${rich(t.intro)}</div>
    ${copyHint}
    ${steps}
    ${fields}
    ${notes}
  </div>`;
}
__name(renderTutorial, "renderTutorial");

// src/ui/forms.js
function control(field, { value, masked, id }) {
  const common = `id="${id}" name="${escapeHtml(field.key)}"${field.required ? ' data-required="1"' : ""}`;
  if (field.readonly) {
    const shown = field.type === "datetime" && value ? fmtCST(Number(value)) : value === void 0 || value === "" ? "\uFF08\u5C1A\u672A\u53D6\u5F97\uFF09" : String(value);
    return `<div class="kv"><span class="v mono pre">${escapeHtml(shown)}</span></div>`;
  }
  const placeholder = field.secret ? `placeholder="${escapeHtml(masked ? `\u672A\u6539\u52A8 \xB7 \u5F53\u524D ${maskSecret(masked)}` : "\u672A\u8BBE\u7F6E")}"` : `placeholder="${escapeHtml(field.placeholder || "")}"`;
  if (field.type === "select") {
    const opts = (field.options || []).map((opt) => {
      const v = String(typeof opt === "object" ? opt.value : opt);
      const l = String(typeof opt === "object" ? opt.label : opt);
      return `<option value="${escapeHtml(v)}"${v === String(value ?? field.default ?? "") ? " selected" : ""}>${escapeHtml(l)}</option>`;
    });
    const blank = field.required ? "" : `<option value="">\uFF08\u4E0D\u6539\u52A8\uFF09</option>`;
    return `<select ${common}>${blank}${opts.join("")}</select>`;
  }
  if (field.type === "textarea") {
    return `<textarea ${common} ${placeholder} ${field.secret ? "" : `spellcheck="false"`}>${field.secret ? "" : escapeHtml(value || "")}</textarea>`;
  }
  if (field.type === "password") {
    return `<input ${common} type="password" ${placeholder} value="" autocomplete="new-password">`;
  }
  const text = value !== void 0 && value !== null && value !== "" ? value : field.default !== void 0 ? field.default : "";
  return `<input ${common} type="text" ${placeholder} value="${field.secret ? "" : escapeHtml(text)}" autocomplete="off">`;
}
__name(control, "control");
function renderField(field, state) {
  const id = `f-${field.key}`;
  const badges = [
    field.secret ? chip("\u654F\u611F") : "",
    field.offline ? chip("\u9700\u7EBF\u4E0B\u53D6\u503C", true) : "",
    field.readonly ? chip("\u53EA\u8BFB", true) : ""
  ].join("");
  const requirements = [field.help, field.pattern && field.patternMessage].filter(Boolean).join(" \xB7 ");
  const help = requirements ? `<div class="help">${escapeHtml(requirements)}</div>` : "";
  const error = state.error ? `<div class="err">${escapeHtml(state.error)}</div>` : "";
  return `<div class="field${state.error ? " bad" : ""}">
    <label for="${id}">${escapeHtml(field.label || field.key)}${field.required && !field.readonly ? ' <span class="req">*</span>' : ""}${badges}</label>
    ${control(field, { value: state.value, masked: state.masked, id })}
    ${help}${error}
  </div>`;
}
__name(renderField, "renderField");
function renderForm(fields, { values = {}, existing = {}, action, errors = {}, submitLabel = "\u4FDD\u5B58", cancelHref, pwd }) {
  const body = fields.map((field) => renderField(field, {
    value: values[field.key],
    masked: existing[field.key],
    error: errors[field.key]
  })).join("");
  const hidden = pwd === void 0 ? "" : `<input type="hidden" name="pwd" value="${escapeHtml(pwd)}">`;
  const cancel = cancelHref ? `<a class="btn" href="${escapeHtml(cancelHref)}">\u53D6\u6D88</a>` : "";
  return `<form method="post" action="${escapeHtml(action)}" accept-charset="utf-8">
    ${hidden}${body}
    <div class="acts mt">
      ${cancel}<button class="btn pri" type="submit">${escapeHtml(submitLabel)}</button>
    </div>
  </form>`;
}
__name(renderForm, "renderForm");

// src/ui/pages/tool.js
function nonSecretSummary(tool, account) {
  if (account.broken) return "\u8BB0\u5F55\u5185\u5BB9\u89E3\u6790\u4E0D\u51FA\u6765\uFF0C\u5220\u6389\u5B83\u518D\u91CD\u65B0\u6DFB\u52A0";
  const parts = (tool.creds || []).filter((field) => !field.secret).map((field) => {
    const value = account.cred[field.key];
    const shown = field.type === "datetime" ? Number(value) ? fmtCST(Number(value)) : "\u2014" : value || "\u2014";
    return `${field.label} ${escapeHtml(shown)}`;
  });
  return parts.length ? parts.join(" \xB7 ") : "\u2014";
}
__name(nonSecretSummary, "nonSecretSummary");
function deleteForm(pwd, action) {
  return `<form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="pwd" value="${escapeHtml(pwd)}">
    <button class="btn sm danger" type="submit">\u5220\u9664</button>
  </form>`;
}
__name(deleteForm, "deleteForm");
function actionForm(pwd, action, label, style) {
  return `<form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="pwd" value="${escapeHtml(pwd)}">
    <button class="btn sm${style ? ` ${style}` : ""}" type="submit">${escapeHtml(label)}</button>
  </form>`;
}
__name(actionForm, "actionForm");
function stepChips(tool, entry) {
  const codes = entry && entry.lastSteps || [];
  if (codes.length === 0) return '<span class="dim">\u2014</span>';
  const chips = codes.map((code) => {
    const [id, status, flag] = String(code).split(":");
    const cls = ["claimed", "already", "ok", "inactive"].includes(status) ? "ok" : status === "deferred" ? "wait" : status === "skipped" ? "skip" : "bad";
    const label = (tool.steps.find((s) => s.id === id) || {}).label || id;
    return `<i class="${cls}" title="${escapeHtml(`${label}\uFF1A${status}${flag === "r" ? "\uFF08\u672C\u8F6E\u590D\u7528\uFF0C\u672A\u518D\u6253\u4E0A\u6E38\uFF09" : ""}`)}"></i>`;
  });
  const done = codes.filter((c) => ["claimed", "already", "ok", "inactive"].includes(String(c).split(":")[1])).length;
  return `<span class="steps">${chips.join("")}</span><div class="note"><b>${done}/${codes.length}</b> \u6B65\u5DF2\u5B8C\u6210</div>`;
}
__name(stepChips, "stepChips");
function renderTool({ pwd, tool, accounts, total, sched = {}, flash, flags = {} }) {
  const addHref = link(`/account/new?tool=${tool.id}`, pwd);
  const configHref = link(`/tool/${tool.id}/settings`, pwd);
  const off = isOff(flags, tool.id);
  const stuckAll = accounts.filter((a) => a.broken || ["login_required", "error"].includes((sched[a.uid] || {}).lastStatus));
  const needsAttention = off ? [] : stuckAll;
  const rows = accounts.map((account) => {
    const entry = sched[account.uid] || {};
    const base = `/account/${tool.id}/${encodeURIComponent(account.uid)}`;
    return `<tr>
    <td data-label="\u8D26\u53F7"><div class="acc"><span class="nm">${escapeHtml(account.label || "\uFF08\u672A\u547D\u540D\uFF09")}</span></div></td>
    <td data-label="\u7ED3\u679C">${account.broken ? badge("error", "\u8BB0\u5F55\u635F\u574F") : badge(entry.lastStatus || "skipped", entry.lastStatus ? void 0 : "\u5C1A\u672A\u8FD0\u884C")}</td>
    <td data-label="\u6B65\u9AA4">${stepChips(tool, entry)}</td>
    <td data-label="\u5B57\u6BB5">${nonSecretSummary(tool, account)}</td>
    <td class="mono dim" data-label="\u66F4\u65B0">${escapeHtml(fmtCST(account.updatedAt))}</td>
    <td data-label=""><div class="acts">
      ${account.broken || off ? "" : actionForm(pwd, `${base}/run`, "\u6267\u884C", "pri")}
      ${account.broken || typeof tool.validate !== "function" ? "" : actionForm(pwd, `${base}/validate`, "\u6D4B\u8BD5")}
      ${account.broken ? "" : button(link(`${base}/edit`, pwd), "\u7F16\u8F91", "", true)}
      ${deleteForm(pwd, link(`${base}/delete`, pwd))}
    </div></td>
  </tr>`;
  }).join("");
  const table = accounts.length === 0 ? emptyState({
    title: "\u8FD8\u6CA1\u6709\u8D26\u53F7",
    lines: ["\u70B9\u4E0B\u9762\u7684\u300C\u65B0\u589E\u8D26\u53F7\u300D\u52A0\u7B2C\u4E00\u4E2A\u3002\u8868\u5355\u662F\u6309\u8FD9\u4E2A\u5DE5\u5177\u7684\u5B57\u6BB5\u58F0\u660E\u81EA\u52A8\u751F\u6210\u7684\u3002"],
    actions: [button(addHref, "\u65B0\u589E\u8D26\u53F7", "pri")]
  }) : `<div class="tw"><table class="t"><thead><tr>
        <th>\u8D26\u53F7</th><th>\u6700\u8FD1\u7ED3\u679C</th><th>\u6B65\u9AA4</th><th>\u5B57\u6BB5</th><th>\u6700\u540E\u66F4\u65B0</th><th class="r">\u64CD\u4F5C</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
  const hidden = Math.max(0, (total ?? accounts.length) - accounts.length);
  return pageShell({
    title: tool.name,
    nav: navHtml(pwd, `tool:${tool.id}`, TOOLS),
    body: `${flash ? alertBox(flash.kind, escapeHtml(flash.text)) : ""}
      ${off ? alertBox("warn", `<b>${escapeHtml(tool.name)} \u5DF2\u505C\u7528\u3002</b>\u4E0D\u53C2\u4E0E\u8C03\u5EA6\uFF08cron \u4E0E\u624B\u52A8\u6267\u884C\u90FD\u8DF3\u8FC7\uFF09\uFF0C\u8D26\u53F7\u3001\u51ED\u636E\u4E0E\u5F53\u5929\u8FDB\u5EA6\u5168\u90E8\u539F\u6837\u4FDD\u7559\uFF1B\u91CD\u65B0\u6253\u5F00\u540E\u4ECE\u505C\u4E0B\u7684\u90A3\u4E00\u6B65\u63A5\u7740\u505A\u3002${stuckAll.length ? `\u5F53\u524D\u6709 ${stuckAll.length} \u4E2A\u8D26\u53F7\u5904\u4E8E\u5931\u8D25\u6216\u9700\u91CD\u65B0\u767B\u5F55\u72B6\u6001\uFF0C\u6062\u590D\u540E\u4ECD\u8981\u5904\u7406\u3002` : ""}`) : ""}
      ${needsAttention.length ? `<div class="card">${alertBox("bad", `<b>${needsAttention.length} \u4E2A\u8D26\u53F7\u9700\u8981\u4F60\u5904\u7406\uFF1A</b>${escapeHtml(needsAttention.map((a) => a.label || a.uid).join("\u3001"))} \u2014\u2014 \u81EA\u52A8\u91CD\u8BD5\u6CBB\u4E0D\u597D\u8FD9\u4E00\u7C7B\uFF0C\u8981\u4E48\u91CD\u65B0\u5F55\u5165\u51ED\u636E\uFF0C\u8981\u4E48\u5220\u6389\u91CD\u5EFA\u3002`)}</div>` : ""}
      <div class="card"><div class="hd"><div class="id">${iconImg(tool, 26)}<div><div class="t">${escapeHtml(tool.name)}</div><div class="d">${escapeHtml(tool.summary || "")}</div></div></div>
        <div class="acts">${button(addHref, "+ \u65B0\u589E\u8D26\u53F7", "pri")}${button(configHref, "\u5DE5\u5177\u914D\u7F6E")}</div></div>
        <div class="bd flush"><p class="tiny m0">\u5B57\u6BB5\u6765\u81EA\u8BE5\u5DE5\u5177\u7684\u58F0\u660E\uFF0C\u754C\u9762\u4E0D\u8BA4\u5177\u4F53\u5DE5\u5177\u3002\u6539\u52A8\u4E0B\u4E00\u8F6E\u8D77\u751F\u6548\u3002</p></div>
      </div>
      ${table}
      ${hidden > 0 ? `<div class="mt">${alertBox("warn", `\u5171 ${total} \u4E2A\u8D26\u53F7\uFF0C\u8FD9\u91CC\u53EA\u5217\u51FA\u524D ${accounts.length} \u4E2A\u3002\u8FD9\u4E00\u9875\u8981\u9010\u4E2A\u8BFB\u8BB0\u5F55\u624D\u80FD\u663E\u793A\u5B57\u6BB5\u503C\uFF0C\u800C KV \u7684\u5199/\u5220/list \u6BCF\u5929\u53EA\u6709 1000 \u6B21\uFF0C\u6240\u4EE5\u5217\u8868\u662F\u6709\u4E0A\u754C\u7684\uFF1B\u8981\u7BA1\u66F4\u591A\u8BF7\u5148\u628A\u8D26\u53F7\u5220\u5230\u6709\u610F\u4E49\u7684\u89C4\u6A21\u3002`)}</div>` : ""}
      <p class="tiny mt">\u300C\u6267\u884C\u300D\u8DF3\u8FC7\u5230\u671F\u5224\u5B9A\u7684\u65F6\u95F4\u95F8\uFF0C\u7ACB\u523B\u8DD1\u8FD9\u4E00\u4E2A\u8D26\u53F7\uFF08\u9884\u7B97\u3001\u5E76\u53D1\u9501\u3001\u8FDB\u5EA6\u590D\u7528\u7167\u65E7\uFF0C\u5DE5\u5177\u914D\u7F6E\u6CA1\u586B\u6216\u5DE5\u5177\u5DF2\u505C\u7528\u65F6\u4F1A\u88AB\u62D2\u7EDD\uFF09\u3002
        \u6CE8\u610F\u5B83\u771F\u7684\u4F1A\u518D\u6253\u4E00\u6B21\u4E0A\u6E38\uFF1A\u4ECA\u5929\u5DF2\u7ECF\u9886\u8FC7\u7684\u8D26\u53F7\u88AB\u70B9\u300C\u6267\u884C\u300D\uFF0C\u4E0A\u6E38\u4F1A\u6536\u5230\u7B2C\u4E8C\u6B21\u9886\u53D6\u8BF7\u6C42\u3002\u6B65\u9AA4\u8272\u5757\u60AC\u505C\u53EF\u770B\u6BCF\u4E00\u6B65\u7684\u5904\u7F6E\u3002</p>`
  });
}
__name(renderTool, "renderTool");
function renderAccountForm({ pwd, tool, fields, values, existing, errors, uid, title, flash }) {
  const cancelHref = link(`/tool/${tool.id}`, pwd);
  const action = link(uid ? `/account/${tool.id}/${encodeURIComponent(uid)}/edit` : `/account/${tool.id}/new`, pwd);
  const uidSourceLabel = "\u4FDD\u5B58\u65F6\u4ECE\u51ED\u636E\u91CC\u81EA\u52A8\u89E3\u51FA\uFF0C\u4E0D\u7528\u53E6\u5916\u586B";
  const uidRow = uid ? `<div class="kv"><span class="k">uid</span><span class="v">${escapeHtml(uid)}</span></div>` : `<div class="kv"><span class="k">uid</span><span class="v dim">${escapeHtml(uidSourceLabel)}</span></div>`;
  return pageShell({
    title,
    nav: navHtml(pwd, `tool:${tool.id}`, TOOLS),
    body: `${flash ? alertBox(flash.kind, escapeHtml(flash.text)) : ""}
      ${sectionHead(title, `\u5B57\u6BB5\u6765\u81EA ${escapeHtml(tool.name)} \u7684\u58F0\u660E\uFF0C\u754C\u9762\u4E0D\u8BA4\u5177\u4F53\u5DE5\u5177`)}
      ${renderTutorial(tool)}
      <div class="split">
        <div class="pane">
          ${uidRow}
          <div class="kv"><span class="k">\u654F\u611F\u5B57\u6BB5</span><span class="v">${fields.filter((f) => f.secret).length} \u4E2A</span></div>
          <div class="kv"><span class="k">\u9700\u7EBF\u4E0B\u53D6\u503C</span><span class="v">${fields.filter((f) => f.offline).length} \u4E2A</span></div>
          <p class="tiny mt">\u654F\u611F\u5B57\u6BB5\u4FDD\u5B58\u540E\u6574\u4E32\u9690\u85CF\uFF0812 \u4F4D\u4EE5\u5185\u5168\u9690\uFF0C\u66F4\u957F\u53EA\u9732\u524D\u540E 4 \u4F4D\uFF09\uFF1B\u7F16\u8F91\u65F6\u7559\u7A7A\u8868\u793A\u4FDD\u6301\u539F\u503C\uFF0C\u975E\u654F\u611F\u7684\u53EF\u9009\u5B57\u6BB5\u7559\u7A7A\u5219\u662F\u6E05\u7A7A\u3002\u51ED\u636E\u6C38\u4E0D\u5199\u8FDB\u65E5\u5FD7\u3002</p>
        </div>
        <div class="pane">
          ${renderForm(fields, { values, existing, errors, action, cancelHref, pwd, submitLabel: "\u4FDD\u5B58" })}
        </div>
      </div>`
  });
}
__name(renderAccountForm, "renderAccountForm");
function renderToolConfig({ pwd, tool, values, errors, flash }) {
  const missing = missingConfigFields(tool, values);
  return pageShell({
    title: `${tool.name} \xB7 \u5DE5\u5177\u914D\u7F6E`,
    nav: navHtml(pwd, `tool:${tool.id}`, TOOLS),
    body: `${flash ? alertBox(flash.kind, escapeHtml(flash.text)) : ""}
      ${sectionHead(`${tool.name} \xB7 \u5DE5\u5177\u914D\u7F6E`)}
      ${missing.length ? alertBox("warn", `\u5DE5\u5177\u914D\u7F6E\u672A\u5B8C\u6210\uFF1A\u8FD8\u7F3A ${missing.length} \u9879\uFF08${missing.join("\u3001")}\uFF09\u3002\u7F3A\u9879\u65F6\u8FD9\u4E2A\u5DE5\u5177\u4F1A\u88AB\u8C03\u5EA6\u5668\u8DF3\u8FC7\u3002`) : ""}
      ${renderTutorial(tool)}
      <div class="split">
        <div class="pane">
          <p class="sub mb">\u8FD9\u4E00\u5C42\u662F<b>\u5DE5\u5177\u7EA7</b>\u7684\uFF0C\u5BF9\u8BE5\u5DE5\u5177\u4E0B\u6240\u6709\u8D26\u53F7\u751F\u6548\uFF1B\u8D26\u53F7\u7EA7\u51ED\u636E\u5728\u300C\u7BA1\u7406\u300D\u9875\u9010\u4E2A\u586B\u3002</p>
          <p class="tiny">\u6539\u52A8\u4E0B\u4E00\u8F6E\u751F\u6548\u3002</p>
        </div>
        <div class="pane">
          ${renderForm(tool.config, { values, existing: values, errors, action: link(`/tool/${tool.id}/settings`, pwd), cancelHref: link(`/tool/${tool.id}`, pwd), pwd, submitLabel: "\u4FDD\u5B58\u914D\u7F6E" })}
        </div>
      </div>`
  });
}
__name(renderToolConfig, "renderToolConfig");

// src/ui/pages/runs.js
function filterBar(pwd, tools, active) {
  const item = /* @__PURE__ */ __name((label, value) => `<a class="btn sm${(active.tool || "") === value ? " pri" : ""}" href="${escapeHtml(link("/runs", pwd, value ? { tool: value } : null))}">${escapeHtml(label)}</a>`, "item");
  return `<div class="acts">${item("\u5168\u90E8", "")}${tools.map((t) => item(t.name, t.id)).join("")}</div>`;
}
__name(filterBar, "filterBar");
function clearForm(pwd, toolId) {
  if (!toolId) return "";
  return `<form method="post" action="${escapeHtml(link(`/runs/${encodeURIComponent(toolId)}/clear`, pwd))}">
    <button class="btn sm danger" type="submit">\u6E05\u7A7A\u65E5\u5FD7</button>
  </form>`;
}
__name(clearForm, "clearForm");
function renderRuns({ pwd, tools, entries, active = {}, flash }) {
  const rows = entries.map((entry) => {
    const meta = entry.meta || {};
    const href = link(`/runs/${encodeURIComponent(entry.key)}`, pwd);
    const who = entry.kind === "tick" ? '<span class="mono dim">\u6574\u8F6E\u8C03\u5EA6</span>' : `<span>${escapeHtml(entry.tool)}/${escapeHtml(meta.label || entry.uid)}</span>`;
    const usage = meta.http !== void 0 ? `<span class="num dim" title="\u672C\u6761\u8BB0\u5F55\u7684\u5916\u90E8\u8BF7\u6C42\u6570">${meta.http || 0}</span>` : "";
    return `<tr>
      <td class="mono dim" data-label="\u65F6\u95F4">${escapeHtml(fmtCSTSec(Math.floor(entry.at / 1e3)))}</td>
      <td data-label="\u5BF9\u8C61">${who}</td>
      <td data-label="\u7ED3\u679C">${badge(meta.status || "error")}</td>
      <td class="dim" data-label="\u6458\u8981">${escapeHtml(meta.message || "\uFF08\u65E0\u6458\u8981\uFF09")}</td>
      <td class="num dim" data-label="\u79EF\u5206">${escapeHtml(meta.credits ? `+${meta.credits}` : "")}</td>
      <td data-label="\u8BF7\u6C42">${usage}</td>
      <td class="r" data-label=""><a class="btn sm" href="${escapeHtml(href)}">\u8BE6\u60C5</a></td>
    </tr>`;
  }).join("");
  const table = entries.length === 0 ? emptyState({
    title: active.tool ? `\u8FD8\u6CA1\u6709 ${active.tool} \u7684\u8FD0\u884C\u8BB0\u5F55` : "\u8FD8\u6CA1\u6709\u8FD0\u884C\u8BB0\u5F55",
    lines: active.tool ? ["\u8FD9\u4E2A\u5DE5\u5177\u8FD8\u6CA1\u6709\u8DD1\u8FC7\uFF0C\u6216\u8005\u5B83\u7684\u8BB0\u5F55\u5DF2\u7ECF\u8FC7\u4E86 30 \u5929\u4FDD\u7559\u671F\u3002"] : ["\u8C03\u5EA6\u6BCF 30 \u5206\u949F\u9192\u4E00\u6B21\uFF0C\u8DD1\u8FC7\u7684\u8D26\u53F7\u4F1A\u5728\u8FD9\u91CC\u7559\u4E0B\u75D5\u8FF9\u3002"]
  }) : `<div class="tw"><table class="t"><thead><tr>
        <th>\u65F6\u95F4</th><th>\u5BF9\u8C61</th><th>\u7ED3\u679C</th><th>\u6458\u8981</th><th>\u79EF\u5206</th><th>\u8BF7\u6C42</th><th class="r"></th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
  return pageShell({
    title: "\u8FD0\u884C\u65E5\u5FD7",
    nav: navHtml(pwd, "runs", tools),
    body: `${flash ? alertBox(flash.kind, escapeHtml(flash.text)) : ""}
      ${sectionHead(
      "\u8FD0\u884C\u65E5\u5FD7",
      "",
      `<div class="acts">${clearForm(pwd, active.tool)}${filterBar(pwd, tools, active)}</div>`
    )}
      ${table}`
  });
}
__name(renderRuns, "renderRuns");
function renderRunsClearConfirm({ pwd, tools, tool, count }) {
  const action = link(`/runs/${encodeURIComponent(tool.id)}/clear`, pwd);
  return pageShell({
    title: "\u6E05\u7A7A\u8FD0\u884C\u65E5\u5FD7",
    nav: navHtml(pwd, "runs", tools),
    body: sectionHead(`\u6E05\u7A7A ${tool.name} \u7684\u8FD0\u884C\u65E5\u5FD7`, "", button(link("/runs", pwd, { tool: tool.id }), "\u2039 \u8FD4\u56DE\u5217\u8868")) + alertBox("warn", `\u5C06\u5220\u9664 <b>${escapeHtml(tool.name)}</b> \u540D\u4E0B\u5168\u90E8\u8FD0\u884C\u65E5\u5FD7${count ? `\uFF08\u5F53\u524D\u4E00\u9875\u80FD\u770B\u5230 ${count} \u6761\uFF09` : ""}\u3002<br>\u53EA\u5220\u8FD9\u4E00\u4E2A\u5DE5\u5177\u7684\u8BB0\u5F55\uFF0C\u53E6\u5916\u4E24\u4E2A\u5DE5\u5177\u7684\u65E5\u5FD7\u3001\u8D26\u53F7\u3001\u51ED\u636E\u3001\u5F53\u5929\u8FDB\u5EA6\u5168\u90E8\u4E0D\u52A8\u3002\u5220\u6389\u4E4B\u540E\u4E0D\u80FD\u6062\u590D\u3002`) + `<div class="pane mt"><p class="sub mb">\u4E00\u6B21\u6700\u591A\u5220 ${CLEAR_BUDGET} \u6761\u5DE6\u53F3\uFF1B\u6761\u6570\u66F4\u591A\u65F6\u5206\u51E0\u6B21\u70B9\u5C31\u884C\uFF0C\u6BCF\u6B21\u5220\u5B8C\u4F1A\u544A\u8BC9\u4F60\u8FD8\u5269\u591A\u5C11\u3002</p><div class="acts"><form method="post" action="${escapeHtml(action)}"><button class="btn danger" type="submit">\u786E\u8BA4\u6E05\u7A7A</button></form>${button(link("/runs", pwd, { tool: tool.id }), "\u53D6\u6D88")}</div></div>`
  });
}
__name(renderRunsClearConfirm, "renderRunsClearConfirm");
function stepRow(step2, key, pwd) {
  const notes = [];
  if (step2.reused) notes.push("\u590D\u7528");
  if (step2.over) notes.push(`\u8D85\u652F ${step2.over}`);
  if (step2.unreachable) notes.push("\u6210\u672C\u8D85\u4E0A\u9650");
  const traceLink = step2.calls === void 0 ? "" : `<a class="mono" href="${link(`/runs/${encodeURIComponent(key)}/trace`, pwd)}#trace-${encodeURIComponent(step2.id)}">\u770B\u8BF7\u6C42 (${step2.calls})</a>`;
  const noteText = notes.join(" \xB7 ");
  return `<tr>
    <td class="mono dim" data-label="\u6B65\u9AA4">${escapeHtml(step2.id)}</td>
    <td data-label="\u7ED3\u679C">${badge(step2.status)}</td>
    <td class="dim" data-label="\u8BF4\u660E">${escapeHtml(step2.message || "")}</td>
    <td class="num dim" data-label="\u5907\u6CE8">${escapeHtml(noteText)}${noteText && traceLink ? " \xB7 " : ""}${traceLink}</td>
  </tr>`;
}
__name(stepRow, "stepRow");
function renderRunDetail({ pwd, tools, entry, key, missing }) {
  if (missing) {
    return pageShell({
      title: "\u8BB0\u5F55\u4E0D\u5B58\u5728",
      nav: navHtml(pwd, "runs", tools),
      body: sectionHead("\u8BB0\u5F55\u4E0D\u5B58\u5728") + `<div class="pane"><p class="sub m0">\u8FD9\u6761\u8BB0\u5F55\u5DF2\u8FC7\u671F\uFF08\u4FDD\u7559 30 \u5929\uFF09\u6216\u952E\u540D\u4E0D\u5408\u6CD5\u3002</p>
           <div class="mt">${button(link("/runs", pwd), "\u56DE\u5230\u65E5\u5FD7\u5217\u8868")}</div></div>`
    });
  }
  const isTick = entry.kind === "tick";
  const head = isTick ? `<b class="cap">\u6574\u8F6E\u8C03\u5EA6</b> ${badge(entry.ran > 0 ? "ok" : "skipped", entry.ran > 0 ? `\u8DD1\u4E86 ${entry.ran} \u4E2A\u8D26\u53F7` : "\u65E0\u8D26\u53F7\u6267\u884C")}
       <span class="spacer"></span><span class="mono dim">${escapeHtml(fmtCSTSec(Math.floor(entry.at / 1e3)))} \xB7 ${escapeHtml(entry.trigger || "")}</span>` : `<b class="cap">${escapeHtml(entry.label || entry.uid)}</b> ${badge(entry.status)}
       <span class="spacer"></span><span class="mono dim">${escapeHtml(entry.tool)}/${escapeHtml(entry.uid)} \xB7 ${escapeHtml(fmtCSTSec(Math.floor(entry.at / 1e3)))} \xB7 ${escapeHtml(entry.trigger || "")}</span>`;
  const steps = isTick ? (entry.plan || []).map((p) => `<tr>
        <td class="mono dim" data-label="\u5DE5\u5177">${escapeHtml(p.tool)}</td>
        <td data-label="\u5904\u7F6E">${p.skipped ? badge("skipped", p.skipped) : badge("ok", `${p.accounts.length} \u4E2A\u8D26\u53F7`)}</td>
        <td class="dim" data-label="\u8D26\u53F7\u7ED3\u679C">${escapeHtml((p.accounts || []).map((a) => `${a.label || a.uid} ${a.status}`).join("\uFF1B"))}</td>
        <td data-label=""></td></tr>`).join("") : (entry.steps || []).map((s) => stepRow(s, key, pwd)).join("");
  const b = entry.budget || {};
  const u = entry.usage || {};
  const heads = isTick ? ["\u5DE5\u5177", "\u5904\u7F6E", "\u8D26\u53F7\u7ED3\u679C", ""] : ["\u6B65\u9AA4", "\u7ED3\u679C", "\u8BF4\u660E", "\u5907\u6CE8"];
  return pageShell({
    title: isTick ? "\u672C\u8F6E\u8C03\u5EA6\u8BE6\u60C5" : `${entry.tool} \xB7 ${entry.label || entry.uid}`,
    nav: navHtml(pwd, "runs", tools),
    body: sectionHead(isTick ? "\u672C\u8F6E\u8C03\u5EA6" : "\u8D26\u53F7\u8FD0\u884C\u8BE6\u60C5", "", button(link("/runs", pwd), "\u2039 \u8FD4\u56DE\u5217\u8868")) + `<div class="card"><div class="bd row">${head}</div>
        <div class="bd flush">
          <p class="sub m0">${escapeHtml(entry.message || "")}</p>
          ${entry.credits ? `<div class="kv"><span class="k">\u672C\u6B21\u79EF\u5206</span><span class="v">+${escapeHtml(String(entry.credits))}</span></div>` : ""}
          <div class="kv"><span class="k">\u672C\u8D26\u53F7\u5916\u90E8\u8BF7\u6C42</span><span class="v">${escapeHtml(String(u.http ?? "\u2014"))} / \u4E0A\u9650 ${escapeHtml(String(b.limit ?? "\u2014"))}${b.over ? ` \xB7 <span class="over">\u8D85\u51FA ${escapeHtml(String(b.over))}</span>` : ""}</span></div>
          <div class="kv"><span class="k">\u952E\u540D</span><span class="v dim">${escapeHtml(key)}\uFF08\u65F6\u95F4\u90A3\u6BB5\u662F\u53CD\u8F6C\u6BEB\u79D2\uFF0C\u6240\u4EE5\u952E\u5E8F\u5C31\u662F\u65F6\u95F4\u5012\u5E8F\uFF09</span></div>
        </div></div>
      ${isTick ? "" : sectionHead("\u6B65\u9AA4", "\u300C\u590D\u7528\u300D\u8868\u793A\u8FD9\u4E00\u6B65\u5728\u4E4B\u524D\u7684\u8F6E\u6B21\u5DF2\u5B8C\u6210\uFF0C\u672C\u8F6E\u6CA1\u6709\u518D\u6253\u4E0A\u6E38")}
      ${steps ? `<div class="tw"><table class="t"><thead><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${steps}</tbody></table></div>` : ""}`
  });
}
__name(renderRunDetail, "renderRunDetail");
var JSON_DISPLAY_MAX = 200 * 1024;
function isJsonText(text) {
  if (typeof text !== "string" || !/^\s*[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
__name(isJsonText, "isJsonText");
function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
__name(prettyJson, "prettyJson");
function bodyBlocks(label, text, noBodyNote) {
  if (text === void 0 || text === null) {
    return `<details class="dt"><summary>${escapeHtml(label)}</summary><pre class="mono">${escapeHtml(noBodyNote || "\uFF08\u8FD9\u4E2A\u8BF7\u6C42\u6CA1\u6709\u8BF7\u6C42\u4F53\uFF09")}</pre></details>`;
  }
  const display = isJsonText(text) && text.length <= JSON_DISPLAY_MAX ? prettyJson(text) : text;
  return `<details class="dt" open><summary>${escapeHtml(label)}</summary><pre class="mono">${escapeHtml(display)}</pre></details>`;
}
__name(bodyBlocks, "bodyBlocks");
function renderTrace({ pwd, tools, key, trace, missing }) {
  const back = button(link(`/runs/${encodeURIComponent(key)}`, pwd), "\u2039 \u8FD4\u56DE\u8FD0\u884C\u8BE6\u60C5");
  if (missing || !trace || !Array.isArray(trace.steps)) {
    return pageShell({
      title: "\u8BF7\u6C42\u8BB0\u5F55",
      nav: navHtml(pwd, "runs", tools),
      body: sectionHead("\u8BF7\u6C42\u8BB0\u5F55", "", back) + emptyState({
        title: "\u8FD9\u6B21\u8FD0\u884C\u6CA1\u6709\u8BF7\u6C42\u8BB0\u5F55",
        lines: [
          "\u53EF\u80FD\u539F\u56E0\uFF1A\u529F\u80FD\u4E0A\u7EBF\u4E4B\u524D\u7684\u65E7\u8FD0\u884C\u3001\u8BB0\u5F55\u5DF2\u8FC7\u4FDD\u7559\u671F\uFF0830 \u5929\uFF09\u3001\u6216\u952E\u540D\u4E0D\u5408\u6CD5\u3002",
          "\u8FD0\u884C\u65E5\u5FD7\u672C\u8EAB\u5728\u4E0D\u5728\uFF0C\u70B9\u4E0A\u9762\u7684\u300C\u8FD4\u56DE\u8FD0\u884C\u8BE6\u60C5\u300D\u5C31\u80FD\u786E\u8BA4\u3002"
        ]
      })
    });
  }
  const dropped = trace.dropped || 0;
  const banner = dropped ? alertBox("warn", `\u672C\u8F6E\u8D85\u51FA\u8BB0\u5F55\u4E0A\u9650\uFF0C<b>${dropped}</b> \u6B21\u4EA4\u4E92\u6CA1\u6709\u8BB0\u4E0B\u6765 \u2014\u2014 \u4E0B\u9762\u7684\u8BB0\u5F55\u770B\u8D77\u6765\u662F\u5B8C\u6574\u7684\uFF0C\u4F46\u5B83\u4E0D\u662F\u3002`) : "";
  const head = `<b class="cap">${escapeHtml(trace.toolName || trace.tool)}</b>
    <span class="spacer"></span><span class="mono dim">${escapeHtml(trace.uid || "")} \xB7 ${escapeHtml(fmtCSTSec(Math.floor(trace.at / 1e3)))} \xB7 ${escapeHtml(trace.trigger || "")}</span>`;
  const steps = trace.steps.map((step2) => {
    const calls = step2.calls || [];
    const anchor = `<a id="trace-${escapeHtml(step2.id)}"></a>`;
    const items = calls.length ? calls.map((call4) => `<div class="card">
          <div class="bd row"><b class="mono">${escapeHtml(String(call4.n))}. ${escapeHtml(call4.method)} ${escapeHtml(call4.url)}</b>
          <span class="spacer"></span><span class="mono dim">\u2192 ${escapeHtml(String(call4.status))} \xB7 ${escapeHtml(String(call4.ms))}ms</span></div>
          <div class="bd flush">
            ${call4.reqTruncated ? alertBox("warn", `\u8BF7\u6C42\u4F53\u5DF2\u622A\u65AD\uFF1A\u53EA\u4FDD\u7559 ${escapeHtml(String(call4.reqTruncated.kept))} \u5B57\u7B26\uFF08\u539F\u6587 ${escapeHtml(String(call4.reqTruncated.total))} \u5B57\u7B26\uFF09\u3002`) : ""}
            ${call4.resTruncated ? alertBox("warn", `\u54CD\u5E94\u4F53\u5DF2\u622A\u65AD\uFF1A\u53EA\u4FDD\u7559 ${escapeHtml(String(call4.resTruncated.kept))} \u5B57\u7B26\uFF08\u539F\u6587 ${escapeHtml(String(call4.resTruncated.total))} \u5B57\u7B26\uFF09\u3002`) : ""}
            ${call4.bodyError ? alertBox("warn", `\u54CD\u5E94\u4F53\u8BFB\u53D6\u5931\u8D25\uFF1A${escapeHtml(call4.bodyError)}\u3002`) : ""}
            ${bodyBlocks("\u8BF7\u6C42\u5934\uFF08\u654F\u611F\u503C\u5DF2\u63A9\u6389\uFF09", JSON.stringify(call4.reqHeaders ?? {}), "")}
            ${bodyBlocks("\u8BF7\u6C42\u4F53", call4.reqBody, "\uFF08\u8FD9\u4E2A\u8BF7\u6C42\u6CA1\u6709\u8BF7\u6C42\u4F53 \u2014\u2014 \u4E0E\u524D\u7AEF\u4E00\u81F4\uFF09")}
            ${bodyBlocks("\u54CD\u5E94\u4F53", call4.resBody, "\uFF08\u54CD\u5E94\u4F53\u662F\u7A7A\u7684\uFF09")}
          </div></div>`).join("") : `<div class="card"><div class="bd"><p class="sub m0">\u65E0\u8BF7\u6C42 \u2014\u2014 ${step2.reused ? "\u8FD9\u4E00\u6B65\u5728\u524D\u9762\u7684\u8F6E\u6B21\u5DF2\u5B8C\u6210\uFF0C\u672C\u8F6E\u590D\u7528\u4E86\u7ED3\u679C" : step2.status === "deferred" ? "\u672C\u8F6E\u9884\u7B97\u88C5\u4E0D\u4E0B\uFF0C\u6574\u6B65\u987A\u5EF6\u4E86\uFF0C\u6839\u672C\u6CA1\u6253\u4E0A\u6E38" : step2.status === "skipped" ? "\u524D\u7F6E\u6B65\u9AA4\u672A\u901A\u8FC7\uFF0C\u6CA1\u6709\u53D1\u8D77\u8BF7\u6C42" : "\u8FD9\u4E00\u6B65\u672C\u8F6E\u6CA1\u6709\u6253\u4E0A\u6E38"}\u3002</p></div></div>`;
    return sectionHead(`\u6B65\u9AA4 ${escapeHtml(step2.id)}`, "", badge(step2.status)) + anchor + items;
  }).join("");
  return pageShell({
    title: `\u8BF7\u6C42\u8BB0\u5F55 \xB7 ${trace.toolName || trace.tool}`,
    nav: navHtml(pwd, "runs", tools),
    body: sectionHead(
      "\u8BF7\u6C42\u8BB0\u5F55",
      "\u8BF7\u6C42\u4F53\u4E0E\u54CD\u5E94\u4F53\uFF1B\u51ED\u636E\u503C\u5DF2\u66FF\u6362\u6210 ***\uFF0C\u54CD\u5E94\u5934\u4E0D\u8BB0\uFF08set-cookie \u662F\u4F1A\u8BDD\u51ED\u636E\uFF09",
      back
    ) + `${banner}<div class="card"><div class="bd row">${head}</div></div>${steps}`
  });
}
__name(renderTrace, "renderTrace");

// src/ui/pages/gate.js
function renderGate() {
  return pageShell({
    title: "\u8BBF\u95EE\u9A8C\u8BC1",
    body: `<div class="login">
      <div class="lock">${glyph("g-lock", 22)}</div>
      <h1>\u6B64\u9762\u677F\u53D7\u5BC6\u7801\u4FDD\u62A4</h1>
      <p>\u8BF7\u8F93\u5165\u8BBF\u95EE\u5BC6\u7801</p>
      <form class="row" method="get" action="/">
        <input type="password" name="pwd" autocomplete="off" aria-label="\u8BBF\u95EE\u5BC6\u7801" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022">
        <button class="btn pri" type="submit">\u8FDB\u5165</button>
      </form>
      <p class="tiny mt">\u547D\u4EE4\u884C\u53EF\u6539\u7528\u8BF7\u6C42\u5934 <span class="mono">X-Pwd</span> \u63D0\u4EA4</p>
    </div>`
  });
}
__name(renderGate, "renderGate");
function renderUnconfigured() {
  return pageShell({
    title: "\u672A\u914D\u7F6E\u8BBF\u95EE\u5BC6\u7801",
    body: `<div class="card mt"><div class="bd">
      <b class="cap">\u7F3A\u5C11\u73AF\u5883\u53D8\u91CF <span class="mono">PASSWORD</span></b>
      <p class="sub mt">\u5E73\u53F0\u62D2\u7EDD\u5728\u65E0\u53E3\u4EE4\u72B6\u6001\u4E0B\u8FD0\u884C\u3002\u8BBE\u7F6E\u4E00\u4E2A\u5373\u53EF\uFF1A</p>
      <div class="cmdbox mt">npx wrangler secret put PASSWORD</div>
      <p class="tiny mt">\u672C\u5730\u5F00\u53D1\u5219\u628A\u5B83\u5199\u8FDB <span class="mono">.dev.vars</span>\uFF08\u6A21\u677F\u89C1 <span class="mono">.dev.vars.example</span>\uFF09\u3002</p>
    </div></div>`
  });
}
__name(renderUnconfigured, "renderUnconfigured");
function renderNotFound(pwd) {
  return pageShell({
    title: "\u6CA1\u6709\u8FD9\u4E2A\u9875\u9762",
    body: `<div class="pane mt tc">
      <b class="cap">\u6CA1\u6709\u8FD9\u4E2A\u9875\u9762\u3002</b>
      <p class="sub mt">\u8DEF\u5F84\u4E0D\u5B58\u5728\uFF0C\u6216\u8BE5\u5DE5\u5177\u5C1A\u672A\u6CE8\u518C\u3002</p>
      ${button(link("/", pwd), "\u56DE\u5230\u603B\u89C8", "pri")}
    </div>`
  });
}
__name(renderNotFound, "renderNotFound");
function renderFatal(message) {
  return pageShell({
    title: "\u51FA\u9519\u4E86",
    body: `<div class="card mt"><div class="bd">
      <b class="cap">\u8BF7\u6C42\u5904\u7406\u5931\u8D25</b>
      <p class="sub mt">\u8FD9\u4E00\u8F6E\u6CA1\u6709\u4EFB\u4F55\u5199\u5165\u3002</p>
      <div class="cmdbox mt flow">${escapeHtml(message)}</div>
    </div></div>`
  });
}
__name(renderFatal, "renderFatal");

// src/core/runner.js
var LOCK_TTL = 90;
var SETTLED3 = /* @__PURE__ */ new Set(["claimed", "already", "inactive", "ok"]);
var SUCCESS = /* @__PURE__ */ new Set(["claimed"]);
var PENDING_RETRY_SEC = 3600;
var CONTINUABLE = /* @__PURE__ */ new Set(["deferred", "skipped", "pending", "waiting"]);
function aggregate(results) {
  const statuses = results.map((r) => r.status);
  if (results.length > 0 && results.every((r) => r.reused)) return "already";
  if (statuses.includes("login_required")) return "login_required";
  if (statuses.includes("rate_limited")) return "rate_limited";
  const settled = results.filter((r) => SETTLED3.has(r.status));
  const errors = results.filter((r) => r.status === "error");
  const unfinished = results.filter((r) => CONTINUABLE.has(r.status));
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("waiting")) return errors.length ? "partial" : "waiting";
  if (statuses.includes("pending") && settled.length === 0 && errors.length === 0) return "pending";
  if (unfinished.length === 0) {
    if (errors.length) return settled.length ? "partial" : "error";
    if (results.some((r) => SUCCESS.has(r.status))) return "claimed";
    if (statuses.includes("inactive")) return "inactive";
    return results.every((r) => SETTLED3.has(r.status)) ? "already" : "error";
  }
  return errors.length ? "partial" : unfinished.every((r) => r.status === "pending") ? "pending" : "deferred";
}
__name(aggregate, "aggregate");
function backoffSec(ladder, strikes) {
  if (!ladder || ladder.length === 0) return 0;
  return ladder[Math.min(strikes - 1, ladder.length - 1)] * 60;
}
__name(backoffSec, "backoffSec");
function summarize(results) {
  const parts = results.filter((r) => !r.reused && r.message).map((r) => `${r.label}\uFF1A${r.message}`);
  return parts.length ? parts.join("\uFF1B") : "\u65E0\u53EF\u6267\u884C\u6B65\u9AA4";
}
__name(summarize, "summarize");
async function runOneAccount({ env, budget, tool, uid, config, day, now, trigger }) {
  const kv = requireKv(env);
  const bare = /* @__PURE__ */ __name((status2, message) => ({ uid, status: status2, message, steps: [], sched: null }), "bare");
  let account;
  let progress;
  try {
    const key = lockKey(tool.id, uid);
    if (await kv.get(key)) return { ...bare("skipped", "\u5DF2\u6709\u8FD0\u884C\u5728\u9014"), quiet: true };
    await kv.put(key, String(now), { expirationTtl: LOCK_TTL });
    progress = await loadProgress(env, tool, uid, day);
    account = await getAccount(env, tool.id, uid);
  } catch (error) {
    return bare("deferred", `KV \u6682\u4E0D\u53EF\u7528\uFF1A${truncate(String(error && error.message || error), 80)}`);
  }
  if (!account) return { ...bare("error", "\u8BB0\u5F55\u65E0\u6CD5\u89E3\u6790\uFF0C\u8BF7\u5728\u754C\u9762\u5220\u9664\u540E\u91CD\u65B0\u6DFB\u52A0"), broken: true };
  let secrets = secretValuesOf(tool, account);
  const stale = [];
  const persistedCred = {};
  const trace = makeTrace();
  const ctx = { account, config, tool, env, kv, budget, now, day, trigger, fetch: trackedFetch(budget, tool.hosts, trace) };
  const results = [];
  let stopped = false;
  const httpBefore = budget.used;
  for (const step2 of tool.steps) {
    trace.enter(step2.id);
    if (progress.done[step2.id]) {
      results.push({ id: step2.id, label: step2.label, ...progress.done[step2.id], reused: true, over: 0 });
      continue;
    }
    if (stopped) {
      results.push({ id: step2.id, label: step2.label, status: "skipped", message: "\u524D\u7F6E\u6B65\u9AA4\u672A\u901A\u8FC7\uFF0C\u672A\u53D1\u8D77\u8BF7\u6C42", over: 0 });
      continue;
    }
    const unmet = (step2.dependsOn || []).filter((dep) => !SETTLED3.has((progress.done[dep] || {}).status));
    if (unmet.length) {
      results.push({ id: step2.id, label: step2.label, status: "skipped", message: `\u4F9D\u8D56\u672A\u6EE1\u8DB3\uFF1A${unmet.join(", ")}`, over: 0 });
      continue;
    }
    if (!budget.fits(step2.cost)) {
      const unreachable = step2.cost > budget.limit;
      results.push({
        id: step2.id,
        label: step2.label,
        status: "deferred",
        over: 0,
        unreachable,
        message: unreachable ? `\u6B65\u9AA4\u6210\u672C ${step2.cost} \u63A5\u8FD1\u5355\u8F6E\u4E0A\u9650 ${budget.limit}\uFF0C\u6C38\u8FDC\u6392\u4E0D\u8FDB\uFF0C\u8BF7\u8C03\u5C0F cost \u6216\u62C6\u5206\u6B65\u9AA4` : `\u9884\u7B97\u4E0D\u8DB3\uFF08\u4F59 ${budget.left()}\uFF0C\u9700 ${step2.cost}\uFF09\uFF0C\u7559\u5230\u4E0B\u4E00\u8F6E`
      });
      stopped = true;
      continue;
    }
    const before = budget.used;
    const secretsBefore = secretValuesOf(tool, account);
    let outcome;
    try {
      outcome = await step2.run(ctx);
    } catch (error) {
      outcome = { status: "error", message: String(error && error.message || error) };
    }
    let rotated = null;
    if (outcome && outcome.cred && typeof outcome.cred === "object") {
      const patched = Object.entries(outcome.cred).filter(([, value]) => typeof value === "string" && value !== "");
      if (patched.length) {
        for (const [field, value] of patched) account.cred[field] = value;
        rotated = Object.fromEntries(patched);
      }
    }
    const secretsNow = secretValuesOf(tool, account);
    for (const value of secretsBefore) if (!secretsNow.includes(value)) stale.push(value);
    secrets = secretsNow.concat(stale);
    const over = Math.max(0, budget.used - before - step2.cost);
    const record = {
      status: outcome && outcome.status ? outcome.status : "error",
      // 工具不许把响应体原样塞进 message；内核在这里截断并洗掉凭据，
      // 免得一次上游 401 就把票据原文带进进度键、响应页与平台日志
      message: truncate(scrubSecrets(outcome && outcome.message || "\u6B65\u9AA4\u672A\u8FD4\u56DE\u7ED3\u679C", secrets), 200),
      credits: outcome && Number.isFinite(outcome.credits) ? outcome.credits : 0
    };
    if (rotated) {
      const fresh = Object.fromEntries(Object.entries(rotated).filter(([field, value]) => persistedCred[field] !== value));
      if (Object.keys(fresh).length) {
        let saved = false;
        try {
          saved = !!await applyCredPatch(env, tool, uid, fresh);
        } catch {
        }
        if (saved) Object.assign(persistedCred, fresh);
        record.message = `${record.message}${saved ? "\uFF08\u5DF2\u6362\u65B0\u51ED\u636E\uFF09" : "\uFF08\u65B0\u51ED\u636E\u5199\u56DE\u5931\u8D25\uFF0C\u65E7\u4E32\u53EF\u80FD\u5DF2\u4F5C\u5E9F\uFF0C\u53EF\u80FD\u8981\u91CD\u65B0\u5F55\u5165\uFF09"}`;
      }
    }
    results.push({ id: step2.id, label: step2.label, ...record, over });
    if (SETTLED3.has(record.status)) progress.done[step2.id] = record;
    if (record.status === "login_required") stopped = true;
  }
  const status = aggregate(results);
  const allDone = results.length > 0 && results.every((r) => SETTLED3.has(r.status));
  try {
    if (allDone) await clearProgress(env, tool, uid);
    else await saveProgress(env, tool, uid, progress);
  } catch {
  }
  return {
    uid,
    account,
    label: account.label,
    status,
    message: summarize(results),
    // 积分只算本轮真做的那些步：复用来的积分再报一次，日志里就是凭空翻倍
    credits: results.reduce((sum, r) => sum + (r.reused ? 0 : r.credits || 0), 0),
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
      resumable: !allDone && status !== "login_required" && results.some((r) => (CONTINUABLE.has(r.status) || r.status === "partial") && !r.reused)
    },
    // 请求记录本体。publicResult 只挑固定字段，所以它不会进 /api/tick 的返回值，
    // 只在 logOutcome 里被取走写进独立的 KV 键。
    trace
  };
}
__name(runOneAccount, "runOneAccount");
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
    retryAt: s.status === "rate_limited" ? now + backoffSec(tool.schedule.backoff, strikes) : s.status === "pending" ? now + PENDING_RETRY_SEC : 0,
    resumable: s.resumable,
    // 紧凑的步骤摘要顺手存进索引：工具页渲染色块时已经读过这条索引了，
    // 若改为从运行日志逐账号取，就是 N 次 get
    lastSteps: (result.steps || []).map((r) => `${r.id}:${r.status}${r.reused ? ":r" : ""}`)
  };
}
__name(commitSched, "commitSched");
var publicResult = /* @__PURE__ */ __name((r) => ({
  uid: r.uid,
  label: r.label,
  status: r.status,
  message: r.message,
  credits: r.credits || 0,
  steps: r.steps || [],
  // 本账号这一轮的外部请求数，列表页那一列显示的就是它
  http: r.http || 0
}), "publicResult");
async function safe(fn) {
  try {
    await fn();
  } catch {
  }
}
__name(safe, "safe");
async function logOutcome(env, { now, tool, result, view, budget, trigger }) {
  if (!result.account && !result.broken) return;
  const atMs = Date.now();
  await safe(() => writeRunLog(env, {
    now: Math.floor(atMs / 1e3),
    tool,
    account: result.account || { cred: {} },
    result: { ...view, label: view.label || view.uid },
    budget,
    trigger
  }));
  await safe(() => writeTrace(env, {
    at: atMs,
    tool,
    account: result.account || { cred: {} },
    uid: result.uid,
    trigger,
    steps: view.steps,
    trace: result.trace
  }));
}
__name(logOutcome, "logOutcome");
function picked(index, uids) {
  const out = {};
  for (const uid of uids) if (index.entries[uid]) out[uid] = index.entries[uid];
  return out;
}
__name(picked, "picked");
async function runTick({ env, budget, tools, trigger = "cron", now = nowSec() }) {
  const plan = [];
  let ran = 0;
  const flags = await loadFlags(env);
  for (const tool of tools) {
    if (isOff(flags, tool.id)) {
      plan.push({ tool: tool.id, skipped: "\u5DF2\u505C\u7528", accounts: [] });
      continue;
    }
    if (budget.left() <= 0) {
      plan.push({ tool: tool.id, skipped: "\u5916\u90E8\u8BF7\u6C42\u989D\u5EA6\u5DF2\u7528\u5C3D", accounts: [] });
      continue;
    }
    const kv = requireKv(env);
    const config = await getJson(kv, toolKey(tool.id), {});
    if (!configComplete(tool, config)) {
      plan.push({ tool: tool.id, skipped: "\u914D\u7F6E\u672A\u5B8C\u6210", accounts: [] });
      continue;
    }
    const uids = await listUids(kv, tool.id);
    const index = await loadSchedIndex(env, tool.id);
    const day = dayOf(tool, now);
    const due = uids.filter((uid) => isDue(tool, index.entries[uid], day, now)).sort((a, b) => (schedOf(index.entries[a]).lastAt || 0) - (schedOf(index.entries[b]).lastAt || 0));
    if (due.length === 0) {
      plan.push({ tool: tool.id, skipped: "\u65E0\u5230\u671F\u8D26\u53F7", accounts: [] });
      continue;
    }
    const results = [];
    const touched = [];
    for (const uid of due) {
      if (budget.left() <= 0) {
        results.push({ uid, status: "deferred", message: "\u672C\u8F6E\u5916\u90E8\u8BF7\u6C42\u989D\u5EA6\u5DF2\u7528\u5C3D\uFF0C\u7559\u5230\u4E0B\u4E00\u8F6E", steps: [] });
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
  return summary;
}
__name(runTick, "runTick");
async function runAccountNow({ env, budget, tool, uid, trigger = "manual", now = nowSec() }) {
  if (isOff(await loadFlags(env), tool.id)) {
    return {
      uid,
      label: uid,
      status: "error",
      credits: 0,
      steps: [],
      message: `\u300C${tool.name}\u300D\u5DF2\u505C\u7528\uFF0C\u5DF2\u62D2\u7EDD\u6267\u884C\u3002\u8981\u6062\u590D\u8BF7\u5230\u603B\u89C8\u9875\u628A\u5B83\u7684\u5F00\u5173\u6253\u5F00\u3002`
    };
  }
  const kv = requireKv(env);
  const config = await getJson(kv, toolKey(tool.id), {});
  const missing = missingConfigFields(tool, config);
  if (missing.length) {
    return {
      uid,
      label: uid,
      status: "error",
      credits: 0,
      steps: [],
      message: `\u5DE5\u5177\u914D\u7F6E\u672A\u5B8C\u6210\uFF0C\u5DF2\u62D2\u7EDD\u6267\u884C\uFF08\u7F3A\uFF1A${missing.join("\u3001")}\uFF09\u3002cron \u540C\u6837\u4F1A\u8DF3\u8FC7\u8FD9\u4E2A\u5DE5\u5177\uFF0C\u8BF7\u5148\u5230\u300C\u5DE5\u5177\u914D\u7F6E\u300D\u8865\u9F50\u3002`
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
__name(runAccountNow, "runAccountNow");
async function validateAccount({ env, budget, tool, uid, now = nowSec() }) {
  if (typeof tool.validate !== "function") return { status: "error", message: "\u8BE5\u5DE5\u5177\u672A\u63D0\u4F9B\u8FDE\u63A5\u6D4B\u8BD5" };
  const kv = requireKv(env);
  const config = await getJson(kv, toolKey(tool.id), {});
  const account = await getAccount(env, tool.id, uid);
  if (!account) return { status: "error", message: "\u8BB0\u5F55\u65E0\u6CD5\u89E3\u6790\uFF0C\u8BF7\u5728\u754C\u9762\u5220\u9664\u540E\u91CD\u65B0\u6DFB\u52A0" };
  const before = Object.entries(account.cred).filter(([key]) => key !== "label");
  const snapshot = Object.fromEntries(before);
  const ctx = { account, config, tool, env, kv, budget, now, day: dayOf(tool, now), trigger: "validate", fetch: trackedFetch(budget, tool.hosts) };
  let outcome;
  try {
    outcome = await tool.validate(ctx);
  } catch (error) {
    outcome = { status: "error", message: String(error && error.message || error) };
  }
  const changed = Object.fromEntries(
    Object.entries(account.cred).filter(([key, value]) => snapshot[key] !== void 0 && snapshot[key] !== value)
  );
  let persisted = false;
  if (Object.keys(changed).length) persisted = !!await applyCredPatch(env, tool, uid, changed).catch(() => null);
  const secrets = secretValuesOf(tool, account).concat(Object.values(changed));
  return {
    status: outcome && outcome.status ? outcome.status : "error",
    // 测试结果直接显示在页面上，而 validate 拿得到账号凭据本身 —— 同一道清洗，同一个理由
    message: truncate(scrubSecrets(outcome && outcome.message || "\u672A\u8FD4\u56DE\u7ED3\u679C", secrets), 200) + (Object.keys(changed).length ? persisted ? "\uFF08\u672C\u6B21\u6D4B\u8BD5\u987A\u5E26\u7EED\u4E86\u671F\uFF0C\u65B0\u51ED\u636E\u5DF2\u5199\u56DE\uFF09" : "\uFF08\u672C\u6B21\u6D4B\u8BD5\u6362\u51FA\u7684\u65B0\u51ED\u636E**\u6CA1\u80FD\u5199\u56DE**\uFF0C\u65E7\u4E32\u5DF2\u7528\u8FC7\uFF0C\u8BF7\u5C3D\u5FEB\u91CD\u65B0\u5F55\u5165\uFF09" : "")
  };
}
__name(validateAccount, "validateAccount");

// src/core/router.js
var LABEL_FIELD = { key: "label", label: "\u5907\u6CE8\u540D", help: "\u53EA\u7ED9\u754C\u9762\u770B\uFF0C\u968F\u4FBF\u8D77\uFF0C\u7528\u6765\u5728\u5217\u8868\u548C\u65E5\u5FD7\u91CC\u8BA4\u51FA\u8FD9\u4E2A\u8D26\u53F7" };
function notFound(pwd) {
  return htmlRes(renderNotFound(pwd), 404);
}
__name(notFound, "notFound");
function flashFrom(url) {
  const flag = url.searchParams.get("done");
  if (flag === "saved") return { kind: "info", text: "\u5DF2\u4FDD\u5B58\u3002" };
  if (flag === "deleted") return { kind: "info", text: "\u5DF2\u5220\u9664\u3002" };
  if (url.searchParams.get("cleared") !== null) {
    const n = Number(url.searchParams.get("cleared")) || 0;
    const traces = Number(url.searchParams.get("traces")) || 0;
    const more = url.searchParams.get("more") === "1";
    return {
      kind: more ? "warn" : "info",
      // 上限要写进文案：只报实测数的话，删到上限（cleared 恰好 = CLEAR_BUDGET）
      // 与"真的删完了"看起来一模一样，用户以为清干净了而库里还剩几百条。
      // 数字来自 CLEAR_BUDGET，不写死 —— 改了上界这里自动跟着走。
      // 请求记录也在这笔预算里，所以份数必须一起报：不报的话，"清空日志"就漏说了一件删过的事。
      text: more ? `\u5DF2\u5220\u9664 ${n} \u6761\u8FD0\u884C\u65E5\u5FD7\u3001${traces} \u4EFD\u8BF7\u6C42\u8BB0\u5F55\uFF08\u5355\u6B21\u6700\u591A ${CLEAR_BUDGET} \u6761\uFF0CKV \u6BCF\u5929 1000 \u6B21\u5199/\u5220/list\uFF09\u3002\u518D\u70B9\u4E00\u6B21\u300C\u6E05\u7A7A\u300D\u7EE7\u7EED\u5220\u5269\u4E0B\u7684\u3002` : `\u5DF2\u5220\u9664 ${n} \u6761\u8FD0\u884C\u65E5\u5FD7\u3001${traces} \u4EFD\u8BF7\u6C42\u8BB0\u5F55${n + traces >= CLEAR_BUDGET ? `\uFF08\u5355\u6B21\u4E0A\u9650 ${CLEAR_BUDGET} \u6761\uFF0C\u82E5\u5E93\u91CC\u8FD8\u6709\u8BF7\u518D\u70B9\u4E00\u6B21\u300C\u6E05\u7A7A\u300D\uFF09` : ""}\u3002`
    };
  }
  const toggled = url.searchParams.get("toggled");
  if (toggled) {
    const tool = findTool(toggled);
    if (tool) {
      return url.searchParams.get("off") === "1" ? { kind: "warn", text: `\u300C${tool.name}\u300D\u5DF2\u505C\u7528\uFF1A\u4E0D\u518D\u53C2\u4E0E\u8C03\u5EA6\uFF0C\u8D26\u53F7\u4E0E\u8FDB\u5EA6\u90FD\u539F\u6837\u7559\u7740\uFF0C\u91CD\u65B0\u6253\u5F00\u5373\u53EF\u63A5\u7740\u505A\u3002` } : { kind: "info", text: `\u300C${tool.name}\u300D\u5DF2\u6062\u590D\uFF0C\u4E0B\u4E00\u8F6E\u8D77\u91CD\u65B0\u53C2\u4E0E\u8C03\u5EA6\u3002` };
    }
  }
  return null;
}
__name(flashFrom, "flashFrom");
function splitLabel(values) {
  const { label, ...cred } = values;
  return { label, cred };
}
__name(splitLabel, "splitLabel");
async function schedMap(env, toolId) {
  const index = await loadSchedIndex(env, toolId);
  return index.entries;
}
__name(schedMap, "schedMap");
async function homePage(env, pwd, flash) {
  const counts = {};
  const sched = {};
  for (const tool of TOOLS) {
    counts[tool.id] = await countAccounts(env, tool.id);
    sched[tool.id] = await schedMap(env, tool.id);
  }
  const flags = await loadFlags(env);
  const runs = await listRunLog(env, { limit: 12, toolIds: TOOLS.map((t) => t.id) });
  return htmlRes(renderHome({ pwd, tools: TOOLS, counts, sched, runs, flash, flags }));
}
__name(homePage, "homePage");
async function toolPage(env, pwd, tool, flash) {
  const { accounts, total } = await listAccounts(env, tool.id);
  const sched = await schedMap(env, tool.id);
  const flags = await loadFlags(env);
  return htmlRes(renderTool({ pwd, tool, accounts, total, sched, flash, flags }));
}
__name(toolPage, "toolPage");
async function runsPage(ctx) {
  const wanted = ctx.url.searchParams.get("tool");
  const toolId = wanted && wanted !== "all" ? wanted : null;
  const entries = await listRunLog(ctx.env, { limit: 30, toolId, toolIds: TOOLS.map((t) => t.id) });
  return htmlRes(renderRuns({ pwd: ctx.pwd, tools: TOOLS, entries, active: { tool: toolId || "" }, flash: ctx.flash }));
}
__name(runsPage, "runsPage");
async function runDetailPage(ctx, key) {
  const entry = await readRunLog(ctx.env, key);
  return htmlRes(renderRunDetail({ pwd: ctx.pwd, tools: TOOLS, entry, key, missing: !entry }));
}
__name(runDetailPage, "runDetailPage");
async function runTracePage(ctx, key) {
  const logKey = String(key ?? "");
  const usable = isRunKey(logKey) && !logKey.includes("..");
  const trace = usable ? await readTrace(ctx.env, traceKeyOf(logKey)) : null;
  return htmlRes(renderTrace({ pwd: ctx.pwd, tools: TOOLS, key: logKey, trace, missing: !trace }));
}
__name(runTracePage, "runTracePage");
async function runsClearPage(ctx, tool) {
  const entries = await listRunLog(ctx.env, { limit: 30, toolId: tool.id, toolIds: [] });
  return htmlRes(renderRunsClearConfirm({ pwd: ctx.pwd, tools: TOOLS, tool, count: entries.length }));
}
__name(runsClearPage, "runsClearPage");
async function runsClearDo(ctx, tool) {
  const { deleted, traces, more } = await clearRunLog(ctx.env, tool.id);
  return redirectRes(link("/runs", ctx.pwd, {
    tool: tool.id,
    cleared: String(deleted),
    traces: String(traces),
    more: more ? "1" : "0"
  }));
}
__name(runsClearDo, "runsClearDo");
function accountFields(tool) {
  return [LABEL_FIELD, ...tool.creds];
}
__name(accountFields, "accountFields");
function accountForm(ctx, tool, extra) {
  const { status, ...rest } = extra;
  return htmlRes(renderAccountForm({
    pwd: ctx.pwd,
    tool,
    fields: accountFields(tool),
    values: {},
    existing: {},
    errors: {},
    title: `\u65B0\u589E ${tool.name} \u8D26\u53F7`,
    ...rest
  }), status || 200);
}
__name(accountForm, "accountForm");
async function accountNewPage(ctx, tool) {
  return accountForm(ctx, tool, {});
}
__name(accountNewPage, "accountNewPage");
async function resolveUid(ctx, tool, values) {
  const config = await getJson(requireKv(ctx.env), toolKey(tool.id), {});
  const fetched = trackedFetch(ctx.budget, tool.hosts);
  try {
    const found = await tool.uidOf({ values, config, tool, env: ctx.env, budget: ctx.budget, fetch: fetched });
    const shape = typeof found === "string" || !found ? { uid: found } : found;
    return { uid: sanitizeUid(shape.uid), cred: shape.cred && typeof shape.cred === "object" ? shape.cred : null };
  } catch (error) {
    const secrets = Object.values(values).filter((value) => typeof value === "string" && value !== "");
    return { uid: "", error: truncate(scrubSecrets(String(error && error.message || error), secrets), 200) };
  }
}
__name(resolveUid, "resolveUid");
async function accountEditPage(ctx, tool, uid) {
  const account = await getAccount(ctx.env, tool.id, uid);
  if (!account) return notFound(ctx.pwd);
  return accountForm(ctx, tool, {
    uid,
    title: `\u7F16\u8F91 ${tool.name} \u8D26\u53F7`,
    values: { label: account.label || "", ...account.cred },
    existing: account.cred
  });
}
__name(accountEditPage, "accountEditPage");
async function accountCreate(ctx, tool) {
  const fields = accountFields(tool);
  const { values, errors } = coerceFields(fields, ctx.form);
  const uidKey = (tool.creds.find((field) => field.required && !field.readonly) || {}).key;
  if (Object.keys(errors).length) {
    return accountForm(ctx, tool, {
      values,
      errors,
      title: `\u65B0\u589E ${tool.name} \u8D26\u53F7`,
      status: 400,
      flash: { kind: "bad", text: "\u4FDD\u5B58\u5931\u8D25\uFF1A\u8BF7\u4FEE\u6B63\u4E0B\u9762\u6807\u7EA2\u7684\u9879\u76EE\u3002" }
    });
  }
  const derived = await resolveUid(ctx, tool, values);
  const uid = derived.uid;
  if (derived.error) {
    if (!errors[uidKey]) errors[uidKey] = `\u53D6\u8D26\u53F7\u6807\u8BC6\u5931\u8D25\uFF1A${derived.error}`;
    return accountForm(ctx, tool, {
      values,
      errors,
      title: `\u65B0\u589E ${tool.name} \u8D26\u53F7`,
      status: 400,
      flash: { kind: "bad", text: "\u4FDD\u5B58\u5931\u8D25\uFF1A\u8FD9\u5F20\u51ED\u636E\u91CC\u53D6\u4E0D\u51FA\u8D26\u53F7\u6807\u8BC6\uFF08\u8BE6\u89C1\u4E0B\u65B9\uFF09\u3002" }
    });
  }
  if (!uid) {
    if (!errors[uidKey]) errors[uidKey] = "\u65E0\u6CD5\u4ECE\u8BE5\u5B57\u6BB5\u5F97\u51FA\u8D26\u53F7\u6807\u8BC6\uFF0C\u8BF7\u68C0\u67E5\u683C\u5F0F";
    return accountForm(ctx, tool, {
      values,
      errors,
      title: `\u65B0\u589E ${tool.name} \u8D26\u53F7`,
      status: 400,
      flash: { kind: "bad", text: "\u4FDD\u5B58\u5931\u8D25\uFF1A\u8BF7\u4FEE\u6B63\u4E0B\u9762\u6807\u7EA2\u7684\u9879\u76EE\u3002" }
    });
  }
  if (await getAccount(ctx.env, tool.id, uid)) {
    return accountForm(ctx, tool, {
      values,
      uid,
      title: `\u65B0\u589E ${tool.name} \u8D26\u53F7`,
      status: 409,
      errors: { [uidKey]: `\u8D26\u53F7 ${uid} \u5DF2\u5B58\u5728\uFF0C\u8BF7\u6539\u7528\u7F16\u8F91` }
    });
  }
  if (derived.cred) Object.assign(values, derived.cred);
  const { label, cred } = splitLabel(values);
  await saveAccount(ctx.env, tool.id, { uid, values: cred, label });
  return redirectRes(link(`/tool/${tool.id}`, ctx.pwd, { done: "saved" }));
}
__name(accountCreate, "accountCreate");
async function accountUpdate(ctx, tool, uid) {
  const account = await getAccount(ctx.env, tool.id, uid);
  if (!account) return notFound(ctx.pwd);
  const fields = accountFields(tool);
  const { values, errors } = coerceFields(fields, ctx.form, { editing: true });
  const credKeys = new Set((tool.creds || []).map((field) => field.key));
  const credTouched = Object.keys(values).some((key) => credKeys.has(key));
  const derived = !credTouched ? { uid, cred: null } : await resolveUid(ctx, tool, { ...account.cred, ...values });
  const uidKeyName = (tool.creds.find((field) => field.required && !field.readonly) || {}).key;
  if (derived.error) {
    errors[uidKeyName] = `\u6821\u9A8C\u8D26\u53F7\u6807\u8BC6\u5931\u8D25\uFF1A${derived.error}`;
  } else if (derived.uid && derived.uid !== uid) {
    errors[uidKeyName] = `\u8FD9\u5F20\u51ED\u636E\u5C5E\u4E8E\u8D26\u53F7 ${derived.uid}\uFF0C\u4E0E\u672C\u9875\u8981\u7F16\u8F91\u7684 ${uid} \u4E0D\u662F\u540C\u4E00\u4E2A\u3002\u8981\u5F55\u53E6\u4E00\u4E2A\u53F7\u8BF7\u7528\u300C\u65B0\u589E\u8D26\u53F7\u300D`;
  }
  if (Object.keys(errors).length) {
    return accountForm(ctx, tool, {
      uid,
      title: `\u7F16\u8F91 ${tool.name} \u8D26\u53F7`,
      status: 409,
      values: { label: account.label || "", ...account.cred, ...values },
      existing: account.cred,
      errors,
      flash: { kind: "bad", text: "\u4FDD\u5B58\u5931\u8D25\uFF1A\u8BF7\u4FEE\u6B63\u4E0B\u9762\u6807\u7EA2\u7684\u9879\u76EE\u3002" }
    });
  }
  if (derived.cred) Object.assign(values, derived.cred);
  const { label, cred } = splitLabel(values);
  await saveAccount(ctx.env, tool.id, { uid, values: cred, label, existing: account });
  return redirectRes(link(`/tool/${tool.id}`, ctx.pwd, { done: "saved" }));
}
__name(accountUpdate, "accountUpdate");
async function accountDelete(ctx, tool, uid) {
  await deleteAccount(ctx.env, tool.id, uid);
  return redirectRes(link(`/tool/${tool.id}`, ctx.pwd, { done: "deleted" }));
}
__name(accountDelete, "accountDelete");
async function runNowHandler(ctx, tool, uid) {
  const result = await runAccountNow({ env: ctx.env, budget: ctx.budget, tool, uid, trigger: "manual" });
  return renderToolWithFlash(ctx, tool, { kind: ["error", "login_required"].includes(result.status) ? "bad" : "info", text: `${uid} \u2192 ${result.status}\uFF1A${result.message}` });
}
__name(runNowHandler, "runNowHandler");
async function validateHandler(ctx, tool, uid) {
  const result = await validateAccount({ env: ctx.env, budget: ctx.budget, tool, uid });
  return renderToolWithFlash(ctx, tool, { kind: result.status === "ok" || result.status === "claimed" ? "info" : "bad", text: `\u6D4B\u8BD5 ${uid}\uFF1A${result.status} \u2014 ${result.message}` });
}
__name(validateHandler, "validateHandler");
async function renderToolWithFlash(ctx, tool, flash) {
  const { accounts, total } = await listAccounts(ctx.env, tool.id);
  const sched = await schedMap(ctx.env, tool.id);
  const flags = await loadFlags(ctx.env);
  return htmlRes(renderTool({ pwd: ctx.pwd, tool, accounts, total, sched, flash, flags }));
}
__name(renderToolWithFlash, "renderToolWithFlash");
async function toolToggle(ctx, tool) {
  const next = !isOff(await loadFlags(ctx.env), tool.id);
  await setToolOff(ctx.env, tool.id, next);
  return redirectRes(link("/", ctx.pwd, { toggled: tool.id, off: next ? "1" : "0" }));
}
__name(toolToggle, "toolToggle");
async function configPage(ctx, tool) {
  const values = await getJson(requireKv(ctx.env), toolKey(tool.id), {});
  return htmlRes(renderToolConfig({ pwd: ctx.pwd, tool, values, errors: {}, flash: ctx.flash }));
}
__name(configPage, "configPage");
async function configSave(ctx, tool) {
  const existing = await getJson(requireKv(ctx.env), toolKey(tool.id), {});
  const { values, errors } = coerceFields(tool.config, ctx.form, { editing: true });
  if (Object.keys(errors).length) {
    return htmlRes(renderToolConfig({
      pwd: ctx.pwd,
      tool,
      values: { ...existing, ...values },
      errors,
      flash: { kind: "bad", text: "\u4FDD\u5B58\u5931\u8D25\uFF1A\u8BF7\u4FEE\u6B63\u4E0B\u9762\u6807\u7EA2\u7684\u9879\u76EE\u3002" }
    }));
  }
  await putJson(requireKv(ctx.env), toolKey(tool.id), { ...existing, ...values });
  return redirectRes(link(`/tool/${tool.id}/settings`, ctx.pwd, { done: "saved" }));
}
__name(configSave, "configSave");
async function apiState(env, budget) {
  const counts = {};
  for (const tool of TOOLS) counts[tool.id] = await countAccounts(env, tool.id);
  const flags = await loadFlags(env);
  return jsonRes({
    ok: true,
    stage: 5,
    budget: budget ? { used: budget.used, limit: budget.limit, left: budget.left() } : null,
    tools: TOOLS.map((tool) => ({
      id: tool.id,
      name: tool.name,
      steps: tool.steps.length,
      accounts: counts[tool.id],
      off: isOff(flags, tool.id)
    }))
  });
}
__name(apiState, "apiState");
async function apiTick(ctx) {
  const summary = await runTick({ env: ctx.env, budget: ctx.budget, tools: TOOLS, trigger: "manual" });
  return jsonRes({ ok: true, ...summary });
}
__name(apiTick, "apiTick");
var NEW_ACCOUNT = /^\/account\/new$/;
var RUN_DETAIL = /^\/runs\/([^/]+)$/;
var RUN_TRACE = /^\/runs\/([^/]+)\/trace$/;
var NO_TOOL_ROUTES = /* @__PURE__ */ new Set([RUN_DETAIL, RUN_TRACE]);
var ROUTES = [
  ["GET", /^\/$/, (ctx) => homePage(ctx.env, ctx.pwd, ctx.flash)],
  ["GET", /^\/help$/, (ctx) => htmlRes(renderHelp({ pwd: ctx.pwd, tools: TOOLS }))],
  ["GET", /^\/runs$/, (ctx) => runsPage(ctx)],
  // 路径必须是 /runs/<tool>/clear 而不是 /runs/clear：捕获组里的 tool 才会过注册表校验。
  // 也因此不会与 RUN_DETAIL（/runs/([^/]+)$）抢路由 —— 后者只匹配单段。
  ["GET", /^\/runs\/([^/]+)\/clear$/, (ctx, tool) => runsClearPage(ctx, tool)],
  ["POST", /^\/runs\/([^/]+)\/clear$/, (ctx, tool) => runsClearDo(ctx, tool)],
  ["GET", RUN_DETAIL, (ctx, key) => runDetailPage(ctx, key)],
  ["GET", RUN_TRACE, (ctx, key) => runTracePage(ctx, key)],
  ["GET", /^\/api\/state$/, (ctx) => apiState(ctx.env, ctx.budget)],
  ["GET", /^\/api\/tick$/, (ctx) => apiTick(ctx)],
  ["POST", /^\/api\/tick$/, (ctx) => apiTick(ctx)],
  ["GET", /^\/tool\/([^/]+)$/, (ctx, tool) => toolPage(ctx.env, ctx.pwd, tool, ctx.flash)],
  ["POST", /^\/tool\/([^/]+)\/toggle$/, (ctx, tool) => toolToggle(ctx, tool)],
  ["GET", /^\/tool\/([^/]+)\/settings$/, (ctx, tool) => configPage(ctx, tool)],
  ["POST", /^\/tool\/([^/]+)\/settings$/, (ctx, tool) => configSave(ctx, tool)],
  ["GET", NEW_ACCOUNT, (ctx) => ctx.tool ? accountNewPage(ctx, ctx.tool) : notFound(ctx.pwd)],
  ["POST", /^\/account\/([^/]+)\/new$/, (ctx, tool) => accountCreate(ctx, tool)],
  ["GET", /^\/account\/([^/]+)\/([^/]+)\/edit$/, (ctx, tool, uid) => accountEditPage(ctx, tool, uid)],
  ["POST", /^\/account\/([^/]+)\/([^/]+)\/edit$/, (ctx, tool, uid) => accountUpdate(ctx, tool, uid)],
  ["POST", /^\/account\/([^/]+)\/([^/]+)\/delete$/, (ctx, tool, uid) => accountDelete(ctx, tool, uid)],
  ["POST", /^\/account\/([^/]+)\/([^/]+)\/run$/, (ctx, tool, uid) => runNowHandler(ctx, tool, uid)],
  ["POST", /^\/account\/([^/]+)\/([^/]+)\/validate$/, (ctx, tool, uid) => validateHandler(ctx, tool, uid)]
];
async function dispatch(request, url, env, pwd, form, budget) {
  const method = request.method.toUpperCase();
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    let params;
    try {
      params = match.slice(1).map(decodeURIComponent);
    } catch {
      return notFound(pwd);
    }
    const ctx = { request, url, env, pwd, form, budget, flash: flashFrom(url), tool: null };
    const wanted = params.length && !NO_TOOL_ROUTES.has(pattern) ? params[0] : pattern === NEW_ACCOUNT ? url.searchParams.get("tool") : null;
    if (wanted) {
      const tool = findTool(wanted);
      if (!tool) return notFound(pwd);
      ctx.tool = tool;
    }
    if (NO_TOOL_ROUTES.has(pattern)) return handler(ctx, ...params);
    return params.length ? await handler(ctx, ctx.tool, ...params.slice(1)) : await handler(ctx);
  }
  return notFound(pwd);
}
__name(dispatch, "dispatch");

// src/index.js
function withLedger(env) {
  return { budget: makeBudget(budgetFrom(env)), env };
}
__name(withLedger, "withLedger");
var index_default = {
  // Cloudflare 的签名是 (request, env, ctx)。URL 在这里解析一次，网关与路由共用同一个对象。
  async fetch(request, env) {
    const url = new URL(request.url);
    const { budget, env: scoped } = withLedger(env);
    try {
      const auth = await authenticate(request, url, scoped);
      if (auth.verdict === "unconfigured") return htmlRes(renderUnconfigured(), 500);
      if (auth.verdict === "bad_body") {
        return htmlRes(renderFatal("\u8BF7\u6C42\u4F53\u65E0\u6CD5\u5904\u7406\uFF1A\u5FC5\u987B\u662F urlencoded \u8868\u5355\u3001\u5E26 content-length\u3001\u4E14\u4E0D\u8D85\u8FC7 64 KB\u3002"), 413);
      }
      if (auth.verdict !== "ok") return htmlRes(renderGate(), 401);
      return await dispatch(request, url, scoped, auth.pwd, auth.form, budget);
    } catch (error) {
      console.error("[checkin] \u8BF7\u6C42\u5904\u7406\u5931\u8D25\uFF1A" + String(error && error.message || error));
      return htmlRes(renderFatal(String(error && error.message || error)), 500);
    }
  },
  async scheduled(controller, env) {
    const { budget, env: scoped } = withLedger(env);
    const cron = String(controller && controller.cron || "");
    const now = Math.floor(Number(controller && controller.scheduledTime) / 1e3) || nowSec();
    console.log("[checkin] cron \u5DF2\u89E6\u53D1 " + cron);
    try {
      const summary = await runTick({ env: scoped, budget, tools: TOOLS, trigger: "cron", now });
      console.log("[checkin] " + JSON.stringify(summary));
    } catch (error) {
      console.error("[checkin] \u672C\u8F6E\u6267\u884C\u5931\u8D25\uFF1A" + String(error && error.message || error));
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
