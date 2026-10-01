import { subjectOf } from "../../core/jwt.js";
import { truncate } from "../../core/text.js";

// Qoder 请求层。这一层的存在理由：内核只认 {status, message, credits} 一种方言，
// 而 Qoder 的方言是「HTTP 200 + data.status 字符串 + 活动列表可能整页为空」。
//
// 出口只有一个域名（openapi.qoder.com.cn）。不要加"401 就换下一个 base 重试"的循环：
// 单 host 下它不换 base，只是把真实的登录失效伪装成"这个域名不对"。
const HOST = "openapi.qoder.com.cn";
const BASE = `https://${HOST}`;
const CAMPAIGNS = "/sash/api/v1/me/campaigns";
const REFRESH = "/api/v1/deviceToken/refresh";
const USER_AGENT = "Qoder/claim";

// 设备身份头：这是"一台机器"的身份，不是"一个账号"的，所以它是工具级配置而不是凭据。
// 少发或过期时上游不报错，只是 campaigns 返回空列表 —— 所以空列表必须单独认出来，
// 不能报成"今日已领取"，那种报法让设备身份失效看起来像一切正常。
function deviceHeaders(config) {
  const headers = { "Cosy-ClientType": String(config.clientType || "10") };
  const map = {
    "Cosy-MachineToken": config.machineToken,
    "Cosy-MachineCode": config.machineCode,
    "Cosy-MachineType": config.machineType,
    "Cosy-MachineOS": config.machineOS,
    "Cosy-MachineHostname": config.machineHostname,
    "Cosy-MachineId": config.machineId,
    "Cosy-Version": config.version,
  };
  for (const [name, value] of Object.entries(map)) if (value) headers[name] = String(value);
  return headers;
}

// 每一次真实请求都只经 ctx.fetch：那里记账、并且按白名单拒发别的域名
async function call(ctx, { path, method = "GET", body, token }) {
  const headers = { Accept: "application/json", "User-Agent": USER_AGENT, ...deviceHeaders(ctx.config) };
  // GET 不带 Content-Type；刷新接口不挂 Authorization —— 它的凭据在请求体里
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await ctx.fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch { /* 非 JSON 响应留给 status 分支判断 */ }
  return { status: response.status, payload, text };
}

// 解包：这个接口有时把业务体裹在 data 里，有时直接平铺
const unwrap = (payload) => (payload && typeof payload === "object" && "data" in payload ? payload.data : payload);

async function refreshToken(ctx) {
  const result = await call(ctx, { path: REFRESH, method: "POST", body: { refresh_token: ctx.account.cred.refreshToken } });
  const data = unwrap(result.payload);
  const token = data && (data.token || data.accessToken || data.access_token);
  if (result.status !== 200 || !token) return null;
  return {
    accessToken: String(token),
    // 上游可能不发新串；发空串当没发处理（否则空串写回 KV，下一轮必然认证失败）
    refreshToken: String((data && (data.refreshToken || data.refresh_token)) || ctx.account.cred.refreshToken),
    // 不返回 expiresAt：这家续期靠上游的 401 触发，不做"提前 N 天主动换票"，
    // 所以本地到期时间没有决策价值；而 dt-- 形态的令牌解不出 exp，猜一个日期只会误导。
    // creds 里也没声明它，写回时会被内核按白名单拒掉。
  };
}

// 带一次续期重试的认证调用：401/403 都算登录态问题（单 host 下 403 不该被当成"端点不对"）。
// 返回 {response, rotated}；response 为 null 表示续期也救不回来。
async function authorized(ctx, { path, method = "GET", body }) {
  const token = ctx.account.cred.accessToken;
  let result = await call(ctx, { path, method, body, token });
  if (result.status !== 401 && result.status !== 403) return { result };

  const rotated = await refreshToken(ctx);
  if (!rotated) return { result, authFailed: true };
  Object.assign(ctx.account.cred, rotated);      // 本轮后续调用立刻用新串
  result = await call(ctx, { path, method, body, token: rotated.accessToken });
  if (result.status === 401 || result.status === 403) return { result, authFailed: true, rotated };
  return { result, rotated };
}

// 「测试」按钮与领取步共用的活动读取
export async function readCampaigns(ctx) {
  const { result, authFailed, rotated } = await authorized(ctx, { path: CAMPAIGNS });
  if (authFailed) {
    return { loginRequired: true, message: `登录态失效（HTTP ${result.status}），续期后仍被拒，需要重新录入凭据`, rotated: rotated || null };
  }
  if (result.status !== 200) {
    return { error: `活动列表查询失败：HTTP ${result.status} ${truncate(result.text, 120)}`, rotated: rotated || null };
  }
  const payload = result.payload;
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.campaigns)) {
    return { error: "活动列表响应结构异常（没有 campaigns 数组）", rotated: rotated || null };
  }

  const benefits = payload.campaigns.filter((c) => c && c.actionType === "CLAIM_BENEFIT");
  const claimable = benefits.filter((c) => c.claimStatus === "CLAIMABLE");
  // startAt/endAt 缺失当"无界"处理。不要写成 (c.endAt || 0) ——
  // 那把没给结束时间的活动当成"1970 年就结束了"，真领到的活动会被报成未下发。
  const now = ctx.now;
  const within = (c) => (c.startAt ? Number(c.startAt) : 0) <= now && (c.endAt ? now < Number(c.endAt) : true);
  const claimedToday = benefits.filter((c) => c.claimStatus === "CLAIMED" && within(c));
  const pendingList = benefits.filter((c) => c.claimStatus !== "CLAIMABLE" && c.claimStatus !== "CLAIMED");
  return {
    claimable: claimable.filter(within),
    claimedToday,
    pendingList,
    total: payload.campaigns.length,
    benefits: benefits.length,
    rotated: rotated || null,
  };
}

// 领取单个活动。成功判据是「HTTP 200 且 data.status === "CLAIMED"」，
// 不是 HTTP 200 就算数 —— 上游会在 200 里回 status 别的值。
export async function claimOne(ctx, campaign) {
  const path = `${CAMPAIGNS}/${encodeURIComponent(campaign.campaignId)}/claim`;
  const { result, authFailed, rotated } = await authorized(ctx, { path, method: "POST", body: {} });
  if (authFailed) return { status: "login_required", message: `领取时登录态失效（HTTP ${result.status}），续期后仍被拒`, rotated: rotated || null };
  if (result.status !== 200) {
    return { status: "error", message: `领取 ${campaign.campaignId} 失败：HTTP ${result.status} ${truncate(result.text, 100)}`, rotated: rotated || null };
  }
  const data = unwrap(result.payload);
  if (!data || typeof data !== "object" || data.status !== "CLAIMED") {
    return { status: "error", message: `领取响应不是 CLAIMED：${truncate(JSON.stringify(data ?? result.payload), 100)}`, rotated: rotated || null };
  }
  // 金额：只信 benefit.amount 是数字这一种形态；0 是合法值，不能用 || 兜底 ——
  // 那会把真 0 当成缺失，于是"这次领了 0 额度"被报成列表里的数字，日志里的加成就凭空多出来
  const raw = data.benefit && data.benefit.amount;
  const credits = Number.isFinite(Number(raw)) ? Number(raw) : 0;
  return {
    status: "claimed",
    // replayed 是上游在告诉我们"这次是幂等重放"。必须如实上报并与"新领到"分开，
    // 否则重跑一轮会被记成"新领到了额度"
    replayed: Boolean(data.replayed),
    credits,
    rotated: rotated || null,
  };
}

export const qoderHosts = [HOST];

// 账号标识按优先级两种来源：
//   JWT（旧版客户端）→ sub，上游认的真号，永远优先；
//   设备令牌（新版客户端，dt-- 开头的不透明串）→ 解不出 sub，退到用户手填的固定代号。
// 绝不从 refresh_token 或任何会轮换的串派生：串一换 uid 就换，旧账号记录原地孤立。
// 手填代号不随任何串变，是设备令牌形态下唯一稳定的锚点。
export function uidFromToken(values) {
  const uid = subjectOf(values.accessToken);
  if (uid) return uid;
  const fallback = String(values.uid || "").trim();
  if (!fallback) {
    throw new Error("这张 access token 不是 JWT（新版客户端的设备令牌），解不出账号标识 —— 请在「账号标识」栏给它起个固定代号（如 main），建号后不要再改");
  }
  return fallback;
}
