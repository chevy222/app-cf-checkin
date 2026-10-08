import { expiresAtOf, readJwtClaims } from "../../core/jwt.js";

// Trae 请求层。所有接口都在同一个域名，但**鉴权头分两组**，这是这个文件存在的最大理由：
//   换票与用户信息 —— 头是 x-cloudide-token，UA 是 Electron（TraeCN/1.107.1）
//   签到与额度     —— 头是 Authorization: Cloud-IDE-JWT + x-device-id，UA 是 VSCode（VSCode 1.107.1 (Trae CN)）
// 分组的是**头**，不是域名，所以下面只有一个 HOST：把两组写成两个常量会让"域名不同"这个
// 错觉顺着代码蔓延下去。头构造器同样分两套，不复用 —— 拼错一个方案的表现是
// "某些调用偶发 401"，最难查。与 Qoder 那边不共用任何东西（硬规则一）。
const HOST = "api.trae.cn";
const EXCHANGE = "/cloudide/api/v3/trae/oauth/ExchangeToken";
const USER_INFO = "/cloudide/api/v3/trae/GetUserInfo";
const STATUS = "/trae/api/v2/ug/checkin_credits/status";
const CLAIM = "/trae/api/v2/ug/checkin_credits/claim";
const USAGE = "/trae/api/v2/pay/ide_user_ent_usage";

// 换票要带的 app 身份。**必须与登录链接里的 client_id 同源**（见 ui/tutorials.js 的 traeLoginUrl）：
// 登录页签出的 refresh_token 属于哪个 app，换票时就得报哪个 app。两头不一致的症状是
// 几天后才出现、且只表现为 login_required —— 所以这条同源关系有测试盯着，别单独改一头。
// 导出只为让那条测试能引用真值，不是给界面层用的。
export const CLIENT_ID = "ono9krqynydwx5";
// 两个版本号各司其职，来自真实抓包，写死不让用户改：
//   CLIENT_VERSION —— 客户端版本，出现在 User-Agent 里（TraeCN/1.107.1 / VSCode 1.107.1）
//   IDE_VERSION    —— IDE 内核版本，出现在 IDEVersion / x-app-version / app-version 里
const CLIENT_VERSION = "1.107.1";
const IDE_VERSION = "3.3.104";
// ClientSecret 的字面量就是单个 "-"：这个端点要求这个 key 必须存在，值本身是占位。
// 不是漏填，别"修"它。
const CLIENT_SECRET_PLACEHOLDER = "-";
const TOKEN_LIFETIME_FALLBACK = 14 * 86400;

// GetUserInfo / 换票用的 Electron UA（桌面端登录态）
const electronUA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TraeCN/${CLIENT_VERSION} Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36`;

// 签到/额度接口用的 VSCode UA（IDE 内发起的请求）
const vscodeUA = `VSCode ${CLIENT_VERSION} (Trae CN)`;

const timeoutMs = (config) => {
  const raw = Number(config.timeoutMs);
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
};

// 所有出站都必须走 ctx.fetch：那里记账 + 按域名白名单拦截。
// 工具层自己调 fetch 就等于绕开"凭据只能打到自己家"这道硬闸 —— 合并成一个 Worker 之后
// 最大的风险就是 A 家的票据被打到 B 家的域名上。
async function post(ctx, path, host, headers, body) {
  const response = await ctx.fetch(`https://${host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs(ctx.config)),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch { payload = null; }
  // 4xx 单独留着：Trae 的业务码就藏在这些响应的 body 里，只看 response.ok 会把"已签到"读成"失败"
  return { status: response.status, payload, text };
}

// 换票。注意它会换出**新的 refresh_token**，旧串用过一次即废
async function exchangeToken(ctx, refreshToken) {
  const result = await post(ctx, EXCHANGE, HOST, { "User-Agent": electronUA }, {
    ClientID: CLIENT_ID,
    RefreshToken: refreshToken,
    ClientSecret: CLIENT_SECRET_PLACEHOLDER,
    UserID: "",
  });
  if (result.status >= 400 && result.status < 500) return { authFailed: true, status: result.status };
  if (result.status !== 200 || !result.payload) return { error: `换票失败：HTTP ${result.status}` };
  const inner = result.payload.Result || {};
  const token = inner.Token;
  if (!token) return { authFailed: true, status: 200 };
  // TokenExpireAt 有时给秒有时给毫秒；判不出来就按"从现在起 14 天"兜住，
  // 但不能拿它当"上游真的告诉过我们到期时间"用
  const rawExp = Number(inner.TokenExpireAt);
  const expiresAt = Number.isFinite(rawExp) && rawExp > 0
    ? (rawExp > 1e12 ? Math.floor(rawExp / 1000) : Math.floor(rawExp))
    : ctx.now + Number(inner.TokenExpireDuration || TOKEN_LIFETIME_FALLBACK);
  return {
    cred: {
      accessToken: String(token),
      refreshToken: String(inner.RefreshToken || refreshToken),
      expiresAt: String(expiresAt),
    },
  };
}

// 签到侧的头。x-device-id 必须是真实 Aha 设备号：风控按它判定，
// 随手填一个能过格式校验，之后每天稳定返回 9074「服务器繁忙」，看上去像限频，其实是设备号错了。
// 设备头（x-device-type / x-os-version / x-app-version）与客户端同款，缺了会被拒成 9074。
function claimHeaders(ctx, token) {
  return {
    Authorization: `Cloud-IDE-JWT ${token}`,
    "x-device-id": String(ctx.account.cred.ahaDeviceId || ""),
    "x-device-type": "windows",
    "x-os-version": "10.0.19045",
    "x-app-version": IDE_VERSION,
    "app-version": IDE_VERSION,
    "User-Agent": vscodeUA,
  };
}

// 保证手里这把 access token 还能用。返回 {token, rotated}；rotated 必须交回内核当场落盘，
// 因为旧 refresh_token 已经被这次调用消耗掉了。
//
// expiresAt 缺失或为 0 时**先试着从 JWT 里读 exp**，读不到才去换票。这个顺序不能反：
// 一上来就换票会把一次本来没必要的花费变常态，结果是"每天续一次、
// 每天把刚存的新串再换一遍"，白烧还容易被风控盯上。
export async function ensureToken(ctx, { force = false } = {}) {
  const cred = ctx.account.cred;
  if (!cred.expiresAt) {
    const fromJwt = expiresFromToken(cred.accessToken);
    if (fromJwt) cred.expiresAt = String(fromJwt);
  }
  const remaining = Number(cred.expiresAt || 0) - ctx.now;
  const ahead = Number(ctx.config.refreshAheadSec || 259200);   // 默认提前 72 小时续
  if (!force && remaining > 0 && remaining > ahead) return { token: cred.accessToken, expired: false };

  const exchanged = await exchangeToken(ctx, cred.refreshToken);
  if (exchanged.cred) {
    Object.assign(cred, exchanged.cred);
    return { token: exchanged.cred.accessToken, rotated: exchanged.cred };
  }
  if (remaining <= 0) {
    return { error: `登录态已过期且续期失败（HTTP ${exchanged.status ?? "-"}），需要重新取一次凭据`, authFailed: true };
  }
  // 还没过期、只是续期没成功 —— 沿用旧票继续，别把一次续期抖动报成登录失效
  return { token: cred.accessToken, warn: exchanged.error || "续期未成功，本次沿用旧票" };
}

const httpAuthFail = (result) => result.status === 401 || result.status === 403;

export async function readStatus(ctx, token) {
  const result = await post(ctx, STATUS, HOST, claimHeaders(ctx, token), { req_source: 1 });
  if (httpAuthFail(result)) return { authFailed: true, status: result.status };
  if (result.status >= 400) return { error: `签到状态查询失败：HTTP ${result.status}` };
  const body = result.payload || {};
  return { checkedIn: body.checked_in === true, credits: body.credits, enable: body.enable };
}

export async function claimOnce(ctx, token) {
  const result = await post(ctx, CLAIM, HOST, claimHeaders(ctx, token), { req_source: 1 });
  if (httpAuthFail(result)) return { authFailed: true, status: result.status };
  // 4xx 的 body 里带着业务码与中文 message，直接当失败丢掉就把"已签到"读成了故障
  const body = result.payload || {};
  // code 归一必须写成"没给就是 null"。写成 `body.code || 0` 的话，
  // HTTP 200 + 空 body 会被当成 code=0 = 签到成功，退避暂停也被顺手清掉。
  const code = body.code === undefined || body.code === null ? null : Number(body.code);
  const msg = String(body.message || "");
  return { code, msg, status: result.status };
}

// 「剩余积分」只是观测，不是领取动作。
// 只用 usage_summary（总额 - 已用）：上游的 pack_list 里 quota 不一定带 credits_limit
// （免费包的 quota 只有功能开关布尔值），遍历 pack 会算出 0。
//
// req_source 按真实抓包取 1，与 status / claim 三个端点一致；带 require_usage 才会
// 在响应里带回 usage_summary（不带的话这个对象整个缺失）。这个字段没有任何本地推导 ——
// 改它之前先重新抓一次包，不要靠猜。
export async function readUsage(ctx, token) {
  const result = await post(ctx, USAGE, HOST, claimHeaders(ctx, token), { require_usage: true, req_source: 1 });
  if (httpAuthFail(result)) return { authFailed: true };
  if (result.status >= 400) return { error: `额度包查询失败：HTTP ${result.status}` };
  const summary = (result.payload || {}).usage_summary || {};
  const total = Number(summary.total_amount) || 0;
  const consumed = Number(summary.consumed_amount) || 0;
  if (total <= 0) return { error: "额度包查询失败：usage_summary 无数据" };
  return { limit: total, used: consumed, remaining: total - consumed };
}

// 业务码方言 → 内核状态。这一小段是 Trae 全部"方言"的所在，顺序不能乱（见下）。
// credits 不再从这里取：签到成功文案直接用 status 接口的 credits，claim 的 credits 时有时无不稳定。
export function translateClaim({ code, msg }) {
  const low = msg.toLowerCase();
  if (code === 9074 || code === 429 || msg.includes("频繁") || msg.includes("太多") || low.includes("too frequent")) {
    return { status: "rate_limited", message: msg || `服务器繁忙（code ${code}）` };
  }
  // 「已」字开头的中文消息里混着"请求已过期""账号已在其他设备登录"这类完全不同的故障，
  // 所以只能收窄到这几个说法。裸 msg.includes("已") 会把它们全报成"今天签过了"。
  if (low.includes("already") || /已(签到|领取|领过|签过)/.test(msg)) {
    return { status: "already", message: msg || "今日已签到" };
  }
  if (code === 0 || low.includes("success")) {
    return { status: "claimed", message: msg || "签到成功" };
  }
  if (code === null && !msg) return { status: "error", message: "签到响应结构异常（没返回 code/message），已按失败处理" };
  return { status: "error", message: `${msg || `code ${code}`}` };
}

// Trae 的 UserID 不在 JWT 里，只能问 GetUserInfo —— 而它的鉴权头和签到侧**完全不同**
// （x-cloudide-token，不是 Cloud-IDE-JWT），这里最容易写错。
// 顺手把 access token 的 exp 一起交回去存着：没有它，第一次运行会以为"票快到期"
// 而白换一次票，而且此后每天都换一次。
export async function uidFromToken(ctx) {
  const token = ctx.values.accessToken;
  if (!token) throw new Error("先把 Access Token 粘进来，账号标识要从它身上取");
  const result = await ctx.fetch(`https://${HOST}${USER_INFO}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cloudide-token": token,
      "User-Agent": electronUA,
    },
    body: JSON.stringify({ ReqSource: "IDE", IDEVersion: IDE_VERSION }),
    signal: AbortSignal.timeout(timeoutMs(ctx.config)),
  });
  const text = await result.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  const inner = (payload && payload.Result) || payload || {};
  const uid = String(inner.UserID ?? "").trim();
  if (!uid) {
    throw new Error(`取不到账号标识：GetUserInfo 没有返回 UserID（HTTP ${result.status}）。这把 Access Token 可能已经失效，请重新取值再粘一次`);
  }
  const expiresAt = expiresFromToken(token);
  return expiresAt ? { uid, cred: { expiresAt: String(expiresAt) } } : uid;
}

// 录入阶段从 access token 的 JWT 里读 exp 补上到期时间。Trae 的到期时间上游只在换票时给，
// 所以这里读不到就留空 —— 让第一次运行去换一次票，而不是猜一个日期假装知道。
const expiresFromToken = (token) => expiresAtOf(readJwtClaims(token));

export const traeHosts = [HOST];
