import { truncate } from "../../core/text.js";

// 69 云（SSPanel 机场）请求层。
//
// 上游方言（全部经 2026-10-04 对真实上游实测核实）：
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
// 理由是"SSPanel 登录后 session 传播有延迟，立刻打 /user 会 302 回登录页"——
// **这一条沿用自原独立 Worker，本项目从未实测确认过**。2026-10-04 只能在已登录态下
// 打 /user（结果 200、延迟不复现），抓不到"登录 POST 刚返回的那一瞬"，验不了。
// 所以保留原参数，但别把它当成已证事实 —— 真要删它得先在真实 Worker 上跑一轮登录看首击结果。
// 退避阶梯而不是固定间隔：万一延迟存在，第 1 次（500ms 后）通常就过了，快上游不该被无谓拖住。
// 三次全过共 3s，比原独立 Worker 的 6 次×2s=12s 短得多，
// 也压在这一步的 cost 上界内（原固定 1.5s×3=4.5s，现在是 0.5+1+1.5=3s）。
const SESSION_BACKOFF_MS = [500, 1000, 1500];

const timeoutMs = (config) => {
  const raw = Number(config.timeoutMs);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
};

// ── Cookie 工具 ──────────────────────────────────────────────
// SSPanel 用 Set-Cookie 下发 session，**实测（2026-10-04）这版是 `PHPSESSID` / `mtauth` / `pop`**，
// 其中 `mtauth` 才是认证凭据，另两个是 HttpOnly（document.cookie 读不到，浏览器自动发送）。
// 早先注释写的 `uid + email + key + expire` 是**老版 SSPanel 的形状**，本版没有那四个 ——
// 别照着旧注释去解析名字或断言字段。
//
// 但**整串原样存、原样发**：不解析、不挑名字，所以换 SSPanel 版本也不会坏。
// 必须原样保留的只有一件事：登录响应下发几个就存几个，回程一个都不能少。

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
// 流程：POST 登录 → 轮询验证 session。**没有"先 GET 登录页"这一步**。
//
// 2026-10-04 实测删掉了它（原 Step 1 拿"初始 session cookie"）：三种情形下
// `GET /auth/login` 的 `Set-Cookie` **全是 null** —— 全新访客、带伪造 PHPSESSID、
// 带已登录 cookie（而且它也不 302）。页面 HTML 里只有 email/password/remember/code_2fa
// 四个输入框，**无隐藏字段、无 CSRF token**。那一笔是纯空转，白烧一次子请求。
//
// 不能改成"GET 登录页之后直接 POST /user/checkin"：手里还是那个失效串，会被再 302 回登录页，
// 永远出不来。`POST /auth/login` 不可省，因为它是**唯一能换出新 cookie 的地方**；
// 省掉它，Cookie 一失效账号就只能进 login_required 等人工重录。
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

  // Step 1: POST 登录
  // redirect: "manual" 与下面的轮询、签到保持一致：上游若用 302 表示结果，跟随会把
  // /user 的 HTML 当登录响应（payload 解析成 null），报出一句与真实原因无关的
  // 「登录失败」；不跟随至少能报出 `HTTP 302`，而且 302 上的 Set-Cookie 不会随跟随丢掉。
  // 不跟随还少一跳 —— 每一跳都计入平台那 50 个子请求的硬顶，而自限已经等于硬顶、没有余量。
  //
  // body 的字段名是**提交值**，不是 HTML 里的 name：页面上是 <input name="password">，
  // 但站点自己的 JS 提交的是 passwd。跟错字段的表现是「邮箱不存在」—— 上游先查邮箱，
  // 密码还没轮到被验。实测（2026-10-04，挂钩真实页面的 jQuery.ajax）确认下述 body 完全正确。
  const login = await call(ctx, {
    path: LOGIN_PAGE,
    method: "POST",
    body: JSON.stringify({ email, passwd: password, remember_me: "on", code: "" }),
    contentType: "application/json",
    referer: BASE + LOGIN_PAGE,
    redirect: "manual",
  });

  if (login.status !== 200 || !login.payload || login.payload.ret !== 1) {
    const msg = login.payload && login.payload.msg
      ? login.payload.msg
      : `HTTP ${login.status} ${truncate(login.text, 80)}`;
    // 429 是唯一的"限频"信号；3xx 也算上游自己的问题（用重定向表示结果的那种版本
    // 不是"凭据不行"）；其它 4xx 与业务码才是"密码不对"。
    // SSPanel 登录失败回 ret!=1 且 HTTP 200（实测"邮箱不存在"就是 200），
    // 所以 HTTP 状态是这里唯一能分开的信号。
    const kind = login.status === 429 ? "rate"
      : login.status >= 500 || (login.status >= 300 && login.status < 400) ? "transient" : "auth";
    return { error: `登录失败：${msg}`, kind };
  }
  const cookies = login.cookies;
  if (cookies.length === 0) return { error: "登录成功但未获取到 Cookie", kind: "transient" };

  // Step 2: 轮询验证 session 就绪
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
// 必须 redirect:manual —— Cookie 失效时上游返回 302 到登录页（2026-10-04 实测确认：
// 无 Cookie 打本端点得到 `302 → /auth/login`，无 body、无 Set-Cookie），
// 自动跟随会把 200（登录页 HTML）当成签到响应，解析 JSON 失败报一个莫名其妙的错。
//
// 端点存在性探测（无认证 + 302 目标判据：`/auth/login`=存在、`/404`=不存在）：
// `GET /user/checkin` → 302→/405（**方法不允许**），`/user/checkin/status`、
// `/user/get_checkin_status`、`/user/get_today_traffic` 等全部不存在。
// ⇒ 这版 SSPanel **没有独立的签到状态查询接口**，`GET` 根本不认。
//
// 响应体的顶层字段只有 `ret` 与 `msg` 两个（实测 Object.keys，无 checked_in/traffic 之类
// 结构化字段）—— 签到状态只能从 `ret` 语义读，别指望解析出别的东西。
// 顺带：签到状态也**服务端渲染在 `/user` 页 HTML 里**（已签到时那个按钮是
// `<a ... class="... disabled" disabled="disabled">已签到</a>`），但**不值得拿它做短路**：
// 稳态下 `already` ∈ SETTLED，`isDue` 当天就不再排这个账号，一天本来就只打一次（见 index.js 注释）。

// 上游 msg 的实际形状（真实响应，不是猜的，2026-10-04 复核仍一致）：
//   成功：「尊贵的王者Lv7，您获得了 0.771GB 流量.\n\n🎉【69云】中秋国庆季…」
//   已签：「您似乎已经签到过了...\n\n📢 69云平台专属 APP 已上线…」
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
