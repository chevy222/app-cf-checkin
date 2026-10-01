import { expiresAtOf, subjectOf } from "../../core/jwt.js";

// WorkBuddy 请求层。
//
// 与另外两家没有任何共用代码（硬规则一），并且**只允许一个出口域名**：
// 个人版没有企业头，也没有 per-account endpoint —— 不要加 X-Enterprise-Id / X-Tenant-Id /
// X-Domain 与 endpoint 覆盖。登录用的 www.workbuddy.cn 只出现在线下脚本里。
//
// 这一家的签到"今天算不算过了"完全由服务端判定（today_checked_in / 10001 / 空 body），
// 所以这里的逻辑日只用于内核的上闩与幂等键。
const HOST = "copilot.tencent.com";
const STATUS = "/v2/billing/meter/checkin-activity-status";
const CHECKIN = "/v2/billing/meter/daily-checkin";
const REFRESH = "/v2/plugin/auth/token/refresh";
const GROWTH = "/v2/activity/growth";

const TRAVEL_STATUS = `${GROWTH}/buddy/travel/status`;
const TRAVEL_CLAIM = `${GROWTH}/buddy/travel/claim`;
const TRAVEL_CONFIG = `${GROWTH}/buddy/travel/config`;
const TRAVEL_DEPART = `${GROWTH}/buddy/travel/depart`;
const LOTTERY_CHANCES = `${GROWTH}/lottery/chances`;
const LOTTERY_DRAW = `${GROWTH}/lottery/draw`;
const QUOTA = `${GROWTH}/buddy/quota`;
const OPEN = `${GROWTH}/buddy/open`;
const TASKS = `${GROWTH}/tasks`;
// 写端点不带 /v2，读端点带 —— 两者不是笔误，是上游真实的分工（2026-10-01 实测）
const TASK_ACCEPT = "/activity/growth/tasks/accept";
const ENERGY = `${GROWTH}/energy`;
const STREAK = `${GROWTH}/streak`;
const REDEEM = `${GROWTH}/redeem`;

const REDEEM_TIERS = [{ tier: "7d", days: 7 }, { tier: "14d", days: 14 }, { tier: "28d", days: 28 }];

// 新版桌面端会把票据包成 {"$wbEncrypted":1,"envelope":"<真 JWT>"}。
// 这层解包必须留着 —— 它是版本兼容，不是防御性编程：解不开就是每天 401，
// 而报错只会说"登录态失效"，没人会想到是包装格式变了。
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

const timeoutMs = (config) => {
  const raw = Number(config.timeoutMs);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
};

// 这一家的字段有相当一部分是"顶层没有就往几个包装对象里钻"，
// 上游在不同接口上混着用，所以取值必须走同一个 dig。
export function dig(node, key, depth = 0) {
  if (!node || typeof node !== "object" || depth > 4) return null;
  // 命中了但值是 null/undefined 时**继续往包装层里钻**，不立刻返回。
  // 这不是可有可无的整洁癖：上游在不同接口版本里会把同一个字段在顶层置 null、
  // 真正的值放进 data/result 里。命中即返回会让 {state:null, data:{state:"arrived"}}
  // 读出 null，travel 于是走不进"到站领奖"分支，一次能白拿的到站礼物就无声无息地过期了。
  if (Object.prototype.hasOwnProperty.call(node, key) && node[key] !== null && node[key] !== undefined) return node[key];
  for (const wrap of ["data", "result", "resp", "response"]) {
    if (node[wrap] && typeof node[wrap] === "object") {
      const found = dig(node[wrap], key, depth + 1);
      if (found !== null && found !== undefined) return found;
    }
  }
  return null;
}

export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// 积分取值：依次探测多个位置，取第一个非 0 的数字。存在理由是
// **上游在不同接口版本把积分挂在不同字段上**。
// 收窄成单路径的后果不是报错，是静默报 +0：能量扣了、界面显示成功、积分对不上。
//
// 判据必须是 `if (n)` 而不是 `if (n !== null)`：0 是合法的"这项没给"，
// 遇到 0 要继续试下一项。`??` 链在这里也做不到这件事 —— ?? 只挡 null/undefined，0 会直接短路。
export function firstCredit(body, item) {
  for (const [obj, key] of [
    [body, "credit_amount"], [body, "credit_granted"], [body, "reward_credit"],
    [item, "credit"], [item && item.instance, "credit"], [item && item.template, "credit"],
  ]) {
    const n = num(dig(obj, key));
    if (n) return n;
  }
  return 0;
}

// code 归一：没给才是 null，给了就按数字比。
// 两处不能写 `body.code || 0`（空 body 会被当成 0 = 成功），
// 也不能在 `=== 0` 之外再加字符串宽松比较（那会把错误响应读成成功）。
export const codeOf = (body) => (body && body.code !== undefined && body.code !== null ? num(body.code) : null);

// 一次真实请求。method 与 body 的形状严格照上游要求：
// 签到两个接口是"POST 但没有请求体"，而 Content-Type 仍然要带 —— 少这个头上游不认。
async function call(ctx, path, { method = "POST", body, auth = true, extraHeaders } = {}) {
  const cred = ctx.account.cred;
  const headers = { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "WorkBuddy" };
  if (auth) {
    const token = unwrapToken(cred.accessToken);
    if (!token) throw new Error("Access Token 解不出可用内容（可能是包装格式变了），重新取值粘贴");
    headers.Authorization = `Bearer ${token}`;
    headers["X-User-Id"] = String(ctx.account.uid);
  }
  Object.assign(headers, extraHeaders || {});
  const response = await ctx.fetch(`https://${HOST}${path}`, {
    method,
    headers,
    // 只有显式给了 body 才发体。JSON.stringify({}) 会发出字面 {}，两者对上游是不同的请求
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs(ctx.config)),
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

export const isAuthFail = (result) => result.status === 401 || result.status === 403;

// 续期。它**消耗一次性的 refresh_token 并换回新的一对**，所以拿到就当场交回内核落盘。
async function refresh(ctx) {
  const raw = unwrapToken(ctx.account.cred.refreshToken);
  if (!raw) return { error: "没有可用的 Refresh Token" };
  const result = await call(ctx, REFRESH, {
    auth: false,
    extraHeaders: { "X-Refresh-Token": raw, "X-Auth-Refresh-Source": "plugin" },
    body: {},
  });
  const token = dig(result.payload, "access_token") ?? dig(result.payload, "accessToken");
  if (result.status >= 400 || !token) {
    return { error: `续期失败（HTTP ${result.status}）`, authFailed: isAuthFail(result) };
  }
  const rotated = {
    accessToken: String(token),
    refreshToken: String(dig(result.payload, "refresh_token") ?? dig(result.payload, "refreshToken") ?? raw),
    expiresAt: String(num(dig(result.payload, "expires_in"))
      ? ctx.now + num(dig(result.payload, "expires_in"))
      // 上游没给 expires_in 时从新票的 exp 读，再兜一个 7 天
      : (expiresAtOf(String(token)) || ctx.now + 7 * 86400)),
  };
  Object.assign(ctx.account.cred, rotated);
  return { rotated };
}

// 每次动手之前先确认这把票还能用。判据只看 exp —— 不要加"距上次续期超 N 天"这类
// 触发条件：凭据真相只有一处，多一个条件就多一次白烧的续期。
export async function ensureAuth(ctx) {
  const expiresAt = num(ctx.account.cred.expiresAt) || 0;
  const ahead = num(ctx.config.refreshAheadSec) || 7 * 86400;
  // ahead 那句"还剩 7 天就别动"默认了这家发的是长票。上游一旦改发短票（比如 1 小时），
  // 这个条件恒成立，于是 7 个步骤的 guard 各换一次票：一轮烧掉 7 张一次性 refresh_token，
  // 多出来的 6 次子请求也没算进任何一步的 cost —— 整轮 used 会越过自限的 45 撞上平台硬顶，
  // 连带把已经跑完的账号的收尾写入一起作废。本轮换过一次之后，只有真过期才允许再换。
  if (ctx.renewAttempted && expiresAt > ctx.now) return {};
  if (expiresAt - ctx.now > ahead) return {};
  ctx.renewAttempted = true;
  const done = await refresh(ctx);
  if (done.error && expiresAt <= ctx.now) return done;
  return done.error ? { warn: done.error } : { rotated: done.rotated };
}

export const readStatus = (ctx) => call(ctx, STATUS);
export const submitCheckin = (ctx) => call(ctx, CHECKIN);
export const readEnergy = (ctx) => call(ctx, ENERGY, { method: "GET", body: undefined });
export const readStreak = (ctx) => call(ctx, STREAK, { method: "GET", body: undefined });
export const readChances = (ctx) => call(ctx, LOTTERY_CHANCES, { method: "GET", body: undefined });
export const readQuota = (ctx) => call(ctx, QUOTA, { method: "GET", body: undefined });
export const readTasks = (ctx) => call(ctx, TASKS, { method: "GET", body: undefined });
export const readTravelStatus = (ctx) => call(ctx, TRAVEL_STATUS, { method: "GET", body: undefined });
export const readTravelConfig = (ctx) => call(ctx, TRAVEL_CONFIG, { method: "GET", body: undefined });

// 幂等键：这一家的 lottery/draw 与 redeem 都收 client_token 作防重放。
// 必须确定性派生，不能现取随机值 —— 否则"一轮被掐死、下一轮重跑"会**再花掉一次
// 抽奖机会**，而机会只会减少不会回来。按 (账号, 逻辑日, 序号) 派生后，
// 同一轮重放发的是同一个键，上游自己就把重复请求判成重放。
// 这是把它的防重放字段拿来当我们的幂等键用。
export function idemKey(scope, uid, day, ...parts) {
  const dayTag = String(day).replace(/-/g, "");
  const who = String(uid).replace(/[^0-9a-zA-Z]/g, "").slice(-10);
  return [scope, who, dayTag, ...parts].join("-").slice(0, 60);
}

export async function drawOnce(ctx, index) {
  return call(ctx, LOTTERY_DRAW, { body: { client_token: idemKey("draw", ctx.account.uid, ctx.day, index) } });
}

export async function openBlindbox(ctx) {
  // 这个接口**没有任何幂等字段**：每调一次服务端就扣 10 点能量。
  // 所以一轮的调用次数由我们上界卡住（见 index.js），并且它必须是可安全中断的一步 ——
  // 重放最坏的后果是少一次能量，不会烧掉别的东西。
  return call(ctx, OPEN, { body: { count: 1 } });
}

// 到站礼物的领取不需要参数：服务端按当前账号的行程记录自己找。
// 之前多传 record_id 属于自作多情，上游当时没报错不代表它认这个字段。
export const claimTravel = (ctx) => call(ctx, TRAVEL_CLAIM, { method: "POST", body: undefined });
export const departTravel = (ctx, locationId) => call(ctx, TRAVEL_DEPART, { body: { location_id: locationId } });
// 接领是**批量**接口：体是数组不是单值。发单数会被上游判成非法请求（400 invalid request）。
export const acceptTasks = (ctx, taskCodes) => call(ctx, TASK_ACCEPT, { body: { task_codes: taskCodes } });
// 领奖是另一个端点，路径里带 task_code。**不带任何请求体** —— 页面实测抓包是 body: null，
// 传空对象会序列化成 "{}"，与实测形状不符（2026-10-01）。
// 响应里积分与能量叫 credit / energy，不叫 *_granted。
export const claimTask = (ctx, taskCode) => call(ctx, `/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, { method: "POST", body: undefined });
export const redeemTier = (ctx, tier) => call(ctx, REDEEM, { body: { tier, client_token: idemKey("redeem", ctx.account.uid, ctx.day, tier) } });

// 签到的判定方言，分两段。顺序不能变：401/403 必须排在"空 body 算已领"之前，
// 否则登录失效会被读成"今天已经签过了"并返回成功码。
// 拆成两个函数而不是在一个函数里重复判一遍"要不要领"：两处条件一定会漂移。
export function judgeStatus(result) {
  if (isAuthFail(result)) return { verdict: "login_required", message: `签到状态被拒（HTTP ${result.status}）` };
  if (result.status >= 400) return { verdict: "error", message: `签到状态查询失败：HTTP ${result.status}` };
  if (dig(result.payload, "active") === false) return { verdict: "inactive", message: "签到活动未开启" };
  if (dig(result.payload, "today_checked_in") === true) {
    return { verdict: "already", message: "今日已签到", credits: 0, streak: num(dig(result.payload, "streak_days")) };
  }
  return { verdict: "claimable" };
}

export function judgeClaim(result) {
  if (isAuthFail(result)) return { status: "login_required", message: `领取被拒（HTTP ${result.status}）`, credits: 0 };
  const body = result.payload;
  const code = codeOf(body);
  const msg = String((body && (body.msg ?? body.message)) ?? "");
  // 空 body / 10001 / 含"已签"都算今天已领：上游把 daily-checkin 设计成幂等的，
  // 所以"重放"与"已领"在服务端是同一件事
  const already = body === null || code === 10001 || msg.includes("已签");
  if (already && result.status >= 400 && code === null) {
    return { status: "error", message: `领取失败：HTTP ${result.status} ${msg}`.trim(), credits: 0 };
  }
  if (already) return { status: "already", message: msg || "今日已签到（服务端判定已领）", credits: 0 };

  const credit = num(dig(body, "credit"));
  if (credit !== null) return { status: "claimed", message: msg || "签到成功", credits: credit };
  if (code !== null && code !== 0) return { status: "error", message: msg || `签到返回 code=${code}`, credits: 0 };
  return {
    status: "error",
    message: `签到响应里没有 credit 字段${result.malformed ? "（响应不是 JSON）" : ""}，已按失败处理`,
    credits: 0,
  };
}

// 录入时解 uid：个人版的 uid 就是 access token 的 sub。
// 不要让用户手填 —— 填的和票对不上时，X-User-Id 与 Authorization 不同源，
// 表现是稳定的 403。
export function uidFromToken(values) {
  const text = unwrapToken(values.accessToken);
  if (!text) throw new Error("先把 Access Token 粘进来");
  // subjectOf 收的是 JWT 原文（内部再解载荷），不是载荷对象
  const uid = subjectOf(text);
  if (!uid) {
    throw new Error("这张 Access Token 解不出账号标识（sub）：要么不是标准 JWT，要么包装格式变了，请重新取值粘贴");
  }
  return { uid, cred: { expiresAt: String(expiresAtOf(text) || 0) } };
}

export const workbuddyHosts = [HOST];
export const workbuddyRedeemTiers = REDEEM_TIERS;
export const expiresFromToken = (token) => expiresAtOf(token);
