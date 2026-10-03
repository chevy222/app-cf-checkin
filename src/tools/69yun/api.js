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
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
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
//
// 失败必须带 **kind**，三种失败的后果完全不同：
//   auth      = 凭据本身不行（密码错、账号不存在、字段没填全）→ login_required，用户重录才有救
//   rate      = 上游回 429，被限频 → rate_limited，走 schedule.backoff 退避
//   transient = 上游自己的问题（5xx、网络抖动、session 传播慢）→ waiting，
//               用户重录密码毫无用处；报错亮红条、或谎报「限频」都会把他带偏
export async function login(ctx) {
  const email = ctx.account.cred.email;
  const password = ctx.account.cred.password;
  // 缺字段是数据问题（用户没填全），归 auth：提示他补全，而不是让他干等退避
  if (!email || !password) return { error: "账号缺少邮箱或密码", kind: "auth" };

  // Step 1: GET 登录页，拿初始 session cookie
  // redirect: "manual" 与下面的 POST、轮询、签到保持一致。这一步**不看状态码**
  // （只要 Set-Cookie），所以 3xx 不会变成误报；不跟随还能少一跳 ——
  // 每一跳都计入平台那 50 个子请求的硬顶，而自限已经等于硬顶、没有余量。
  const init = await call(ctx, { path: LOGIN_PAGE, referer: BASE, redirect: "manual" });
  let cookies = init.cookies;

  // Step 2: POST 登录
  // 同样 manual：上游若用 302 表示结果，跟随会把 /user 的 HTML 当登录响应
  // （payload 解析成 null），报出一句与真实原因无关的「登录失败」；
  // 不跟随至少能报出 `HTTP 302`，而且 302 上的 Set-Cookie 不会随跟随丢掉。
  const login = await call(ctx, {
    path: LOGIN_PAGE,
    method: "POST",
    body: JSON.stringify({ email, passwd: password, remember_me: "on", code: "" }),
    contentType: "application/json",
    cookie: cookies,
    referer: BASE + LOGIN_PAGE,
    redirect: "manual",
  });

  if (login.status !== 200 || !login.payload || login.payload.ret !== 1) {
    const msg = login.payload && login.payload.msg
      ? login.payload.msg
      : `HTTP ${login.status} ${truncate(login.text, 80)}`;
    // 429 是唯一的"限频"信号；3xx 也算上游自己的问题（用重定向表示结果的那种版本
    // 不是"凭据不行"）；其它 4xx 与业务码才是"密码不对"。
    // SSPanel 登录失败回 ret!=1 且 HTTP 200，所以 HTTP 状态是这里唯一能分开的信号。
    const kind = login.status === 429 ? "rate"
      : login.status >= 500 || (login.status >= 300 && login.status < 400) ? "transient" : "auth";
    return { error: `登录失败：${msg}`, kind };
  }
  cookies = mergeCookies(cookies, login.cookies);
  if (cookies.length === 0) return { error: "登录成功但未获取到 Cookie", kind: "transient" };

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
    // 4xx/5xx 是上游的问题（session 没建起来），不是密码错了
    if (verify.status >= 400) {
      return { error: `会话验证异常：HTTP ${verify.status}`, kind: "transient" };
    }
  }
  // 轮询用完仍 3xx：凭据已通过认证（ret=1），只是 session 传播得比预期慢 ——
  // 归 transient 而非 auth：让用户去改密码是白费工夫，等下一轮重试才对。
  return { error: `登录成功但 session 始终未就绪（轮询 ${SESSION_BACKOFF_MS.length} 次）`, kind: "transient" };
}

// ── 签到 ──────────────────────────────────────────────────────
// 必须 redirect:manual —— Cookie 失效时上游返回 302 到登录页，
// 自动跟随会把 200（登录页 HTML）当成签到响应，解析 JSON 失败报一个莫名其妙的错。

// 上游 msg 的实际形状（真实响应，不是猜的）：
//   「尊贵的王者Lv7，您获得了 0.771GB 流量.\n\n🎉【69云】中秋国庆季…\n📅【活动时间】…\n💥【折扣码】…」
// 结果在**第一行**，其后全是站点自己的营销广告 —— 每轮一字不变，且长度随站点改版变变。
// 只取第一行有两个理由：广告会把关键数字挤出内核那 200 字的截断；广告里的折扣码每轮都一样，
// 混在运行日志里只会让人以为那是什么新信息。解析不到流量时退回整行原文，不丢信息。
const TRAFFIC_RE = /获得了\s*([\d.]+)\s*(TB|GB|MB|KB|PB)\b/i;
const RANK_RE = /尊贵的\s*([^，,。]+)/;

function resultLine(msg) {
  const line = String(msg || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
  // 尾部句点/省略号去掉：跟内核的「标签：消息」连读时多个尾巴很别扭（"…流量.."）
  return line.replace(/[.。…]+$/, "");
}

export async function checkin(ctx, cookie) {
  let result;
  try {
    result = await call(ctx, {
      path: CHECKIN,
      method: "POST",
      cookie: cookie ? cookie.split("; ").filter(Boolean) : [],
      referer: BASE + USER_PAGE,
      redirect: "manual",
    });
  } catch (err) {
    // 超时：请求可能已到达上游并执行成功，不能当普通错误抛上去（会被标记为失败亮红条）。
    // 返回 timeout 标记，由调用方（index.js 的 wrap）归为 waiting，下一轮再确认结果。
    if (err && (err.name === "TimeoutError" || /timeout|aborted/i.test(err.message || ""))) {
      return { timeout: true };
    }
    throw err;
  }

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
    const line = resultLine(msg);
    const traffic = line.match(TRAFFIC_RE);
    const rank = line.match(RANK_RE);
    // 摘要报「领了多少」而不是「领到了什么」：机场的流量单位不统一（MB/GB/TB 都见过），
    // 原文照抄时值班的人得自己心算；credits 保持 0 —— 上游没给可累加的数值字段，
    // 凭空折算一个数字进积分列反而是对账不了的假测量值。
    const amount = traffic ? `${traffic[1]}${traffic[2].toUpperCase()}` : "";
    return {
      status: "claimed",
      message: amount
        ? `签到 +${amount}${rank ? `（${rank[1].trim()}）` : ""}`
        : line || "签到成功",
    };
  }
  if (ret === 0) {
    const line = resultLine(msg);
    // 已签到时上游也会附同一段广告；等级照旧取（用户会想知道今天是什么身份签的），
    // 但不编流量数 —— 没领到就没有「+0.771GB」这回事。
    const rank = line.match(RANK_RE);
    return {
      status: "already",
      message: rank ? `今日已签到（${rank[1].trim()}）` : line || "今日已签到",
    };
  }
  return { status: "error", message: `签到返回 ret=${ret}：${resultLine(msg)}` };
}

export const yun69Hosts = [HOST];
