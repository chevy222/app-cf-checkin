import { truncate } from "../../core/text.js";

// 69 云（SSPanel 机场）请求层。
//
// 上游方言：
//   登录  POST /auth/login  body={email, passwd, remember_me:"on", code:""}  响应 ret===1 成功
//   签到  POST /user/checkin  无 body，带 Cookie，redirect:manual
//          ret===1 = 签到成功，ret===0 = 今日已签到
//          3xx 重定向到 /auth/login = Cookie 失效，需要重新登录
//
// 鉴权是 Cookie Session，不是 Token：每次签到先拿存的 Cookie 试，被重定向就重新登录。
// 登录后的 Cookie 存在账号记录里（cred.cookie），跟 Qoder 的 accessToken 同一种回写机制。
const HOST = "69yun69.com";
const BASE = `https://${HOST}`;
const LOGIN_PAGE = "/auth/login";
const USER_PAGE = "/user";
const CHECKIN = "/user/checkin";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

// 登录后验证 session 就绪的轮询参数。
// SSPanel 登录后 session 传播有延迟，立刻打 /user 会 302 回登录页。
// 退避阶梯而不是固定间隔：实测第 1 次（500ms 后）通常就过了，快上游不该被无谓拖住；
// 真慢的才逐次多等。三次全过共 3s，比原独立 Worker 的 6 次×2s=12s 短得多，
// 也压在这一步的 cost 上界内（原固定 1.5s×3=4.5s，现在是 0.5+1+1.5=3s）。
const SESSION_BACKOFF_MS = [500, 1000, 1500];

const timeoutMs = (config) => {
  const raw = Number(config.timeoutMs);
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
};

// ── Cookie 工具 ──────────────────────────────────────────────
// SSPanel 用 Set-Cookie 下发 session（通常是 uid + email + key + expire 几个）。
// 必须完整保留并在后续请求里带回，少一个上游就不认。

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

function cookieString(pairs) {
  return pairs.join("; ");
}

function mergeCookies(existing, newPairs) {
  const map = new Map();
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

// ── 基础请求 ──────────────────────────────────────────────────

async function call(ctx, { path, method = "GET", body, cookie, contentType, referer, redirect }) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/json, text/plain, */*",
  };
  if (cookie && cookie.length) headers.Cookie = cookieString(cookie);
  if (contentType) headers["Content-Type"] = contentType;
  if (referer) headers.Referer = referer;
  if (method === "POST") headers.Origin = BASE;

  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs(ctx.config)),
  };
  if (body !== undefined) init.body = body;
  if (redirect) init.redirect = redirect;

  const response = await ctx.fetch(BASE + path, init);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch { /* 非 JSON 响应（如登录页 HTML）留给调用方判断 */ }
  return { status: response.status, payload, text, cookies: extractCookies(response) };
}

// ── 登录 ──────────────────────────────────────────────────────
// 完整流程：GET 登录页拿初始 Cookie → POST 登录 → 轮询验证 session。
// 返回 { cookie } 或 { error }。

export async function login(ctx) {
  const email = ctx.account.cred.email;
  const password = ctx.account.cred.password;
  if (!email || !password) return { error: "账号缺少邮箱或密码" };

  // Step 1: GET 登录页，拿初始 session cookie
  const init = await call(ctx, { path: LOGIN_PAGE, referer: BASE });
  let cookies = init.cookies;

  // Step 2: POST 登录
  const login = await call(ctx, {
    path: LOGIN_PAGE,
    method: "POST",
    body: JSON.stringify({ email, passwd: password, remember_me: "on", code: "" }),
    contentType: "application/json",
    cookie: cookies,
    referer: BASE + LOGIN_PAGE,
  });

  if (login.status !== 200 || !login.payload || login.payload.ret !== 1) {
    const msg = login.payload && login.payload.msg
      ? login.payload.msg
      : `HTTP ${login.status} ${truncate(login.text, 80)}`;
    return { error: `登录失败：${msg}` };
  }
  cookies = mergeCookies(cookies, login.cookies);
  if (cookies.length === 0) return { error: "登录成功但未获取到 Cookie" };

  // Step 3: 轮询验证 session 就绪
  for (let i = 0; i < SESSION_BACKOFF_MS.length; i++) {
    await new Promise((r) => setTimeout(r, SESSION_BACKOFF_MS[i]));
    const verify = await call(ctx, {
      path: USER_PAGE,
      cookie: cookies,
      referer: BASE + LOGIN_PAGE,
      redirect: "manual",
    });
    // 200/304 = session 就绪；3xx = 还没传播好，继续等
    if (verify.status === 200 || verify.status === 304) {
      return { cookie: cookieString(cookies) };
    }
    if (verify.status >= 300 && verify.status < 400 && i < SESSION_BACKOFF_MS.length - 1) continue;
    // 非 3xx 的异常（如 500）不等了，直接报错
    if (verify.status >= 400) {
      return { error: `会话验证异常：HTTP ${verify.status}` };
    }
  }
  return { error: `登录成功但 session 始终未就绪（轮询 ${SESSION_BACKOFF_MS.length} 次）` };
}

// ── 签到 ──────────────────────────────────────────────────────
// 必须 redirect:manual —— Cookie 失效时上游返回 302 到登录页，
// 自动跟随会把 200（登录页 HTML）当成签到响应，解析 JSON 失败报一个莫名其妙的错。

export async function checkin(ctx, cookie) {
  const result = await call(ctx, {
    path: CHECKIN,
    method: "POST",
    cookie: cookie ? cookie.split("; ").filter(Boolean) : [],
    referer: BASE + USER_PAGE,
    redirect: "manual",
  });

  // 3xx = Cookie 失效，调用方需要重新登录
  if (result.status >= 300 && result.status < 400) {
    return { authFailed: true };
  }
  if (result.status !== 200) {
    return { error: `签到请求失败：HTTP ${result.status} ${truncate(result.text, 80)}` };
  }
  if (!result.payload) {
    return { error: `签到响应不是 JSON：${truncate(result.text, 80)}` };
  }

  const ret = result.payload.ret;
  const msg = result.payload.msg || "";

  // ret===1 = 签到成功；ret===0 = 今日已签到（SSPanel 约定）
  if (ret === 1) {
    // 流量信息可能在 msg 里（如"获得了 100 MB 流量"），也可能在 data 里
    return { status: "claimed", message: msg || "签到成功" };
  }
  if (ret === 0) {
    return { status: "already", message: msg || "今日已签到" };
  }
  return { status: "error", message: `签到返回 ret=${ret}：${msg}` };
}

export const yun69Hosts = [HOST];
