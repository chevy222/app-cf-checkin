import { expiresAtOf, readJwtClaims } from "../../core/jwt.js";
import { truncate } from "../../core/text.js";

// 豆包工作（www.doubao.com）签到请求层。
//
// 这一层的存在理由与 Qoder 那份一样：内核只认 {status, message, credits}，
// 而豆包的方言是「HTTP 200 + code 数字 + data 里再嵌 daily_checkin」，
// 还有一串"看起来像业务失败、其实只是今天没开门"的错误码。
//
// 出口只有一个域名。不要加"换 host 重试"的循环 —— 换了就不是同一套登录态了。
const HOST = "www.doubao.com";
const BASE = `https://${HOST}`;
const PATH_LAUNCH = "/alice/user/launch";
const PATH_DETAIL = "/alice/ug/campaign/v3/detail/";
const PATH_REPORT = "/alice/ug/campaign/landing/report";
const PATH_CHECKIN = "/alice/ug/campaign/landing/checkin";

// 两套身份参数（aid + device_platform 组合）都来自实证抓包，不是猜的：
//   · work   —— 豆包工作桌面端的 detail 抓包（2026-10-21 本机，code:0 返回完整任务列表）
//   · client —— 同一个账号的 checkin 抓包（2026-10-23 本机，code:0 领到 200 额度）
// 两套的 aid 不同，服务端按 aid 决定下发哪套活动配置。历史上 Worker 上报
// "campaign not found" 时没有条件区分"参数用错"与"活动换季"，
// 所以这里把两套都做成配置项：一条被拦就换另一条，不改代码。
//
// work 这套不带 msToken/a_bogus，是本项目最想要的免签名链路；
// client 这套在本机抓包里带了签名，缺签名时是否仍放行未验证 ——
// 所以它只是备选，页面上的「附加查询参数」可以把整段抓包 query 贴进来补齐。
const PROFILES = {
  work: {
    aid: "497858",
    devicePlatform: "web",
    doubaoDevicePlatform: "web",
    webPlatform: "work_desktop",
    clientPlatform: "",
    pcVersion: "2.32.14",
    doubaoPcVersion: "5.72.66",
    runtimeVersion: "5.72.66",
    chromium: "",
    channel: "",
    uaSuffix: "SamanthaDoubaoWork/2.32.14",
    referer: "https://www.doubao.com/pc/agent-explore",
  },
  client: {
    aid: "1044603",
    devicePlatform: "web",
    doubaoDevicePlatform: "desktop",
    webPlatform: "desktop",
    clientPlatform: "pc_client",
    pcVersion: "2.33.5",
    doubaoPcVersion: "2.33.5",
    runtimeVersion: "3.42.2",
    chromium: "147.0.7727.149",
    channel: "win",
    uaSuffix: "SamanthaDoubaoWork/2.33.5",
    referer: "https://www.doubao.com/chat/",
  },
};

const DEFAULT_GROUP = "pc_incentive_task_mvp_v3";
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

export const doubaoHosts = [HOST];
export const defaultGroup = DEFAULT_GROUP;

const profileOf = (config) => PROFILES[String(config.profile || "work")] || PROFILES.work;

const timeoutMs = (config) => {
  const raw = Number(config.timeoutMs);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
};

// Cookie 的三种粘贴形态都得吃下去：整段单行、每行一条、带 "cookie:" 前缀的抓包文本。
// 用户是从 Network 请求头整段复制的，里面必然混着换行与前缀 ——
// 要求他手工清洗，等于把"账号标识解不出来"这个坑重新挖一遍。
export function normalizeCookie(raw) {
  const lines = String(raw ?? "").split(/\r?\n/);
  const parts = [];
  for (const line of lines) {
    const cleaned = line.replace(/^\s*cookie\s*:\s*/i, "").trim();
    if (!cleaned) continue;
    for (const piece of cleaned.split(/;\s*/)) {
      const item = piece.trim().replace(/^;+/, "").replace(/;+$/, "").trim();
      if (item && item.includes("=")) parts.push(item);
    }
  }
  return parts.join("; ");
}

const cookieValue = (cookie, name) => {
  const match = new RegExp(`(?:^|;)\\s*${name}=([^;]*)`, "i").exec(cookie);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

// 账号标识只认两处，都是"这个号是谁"的一手证据：
//   1. multi_sids=<纯数字 uid>%3A<sessionid> —— 首选的数字 uid（豆包自己的账号 id）
//   2. LARK_SUITE_ACCESS_TOKEN 的 payload.doubao_uid（退 uid / sub）
// 这两个字段基本都是 HttpOnly，Application 面板抄不到，必须整段复制请求头里的 Cookie。
// 不用 uid_tt 兜底：那是 tt_ 前缀的站点侧标识，不是豆包账号 id，写进 KV 键名只会让同一个号分裂成两条记录。
export function uidFromCookie(values) {
  const cookie = normalizeCookie(values && values.cookie);
  const sids = cookieValue(cookie, "multi_sids");
  if (sids) {
    const head = sids.split(":")[0].trim();
    if (/^\d{5,}$/.test(head)) return head;
  }
  const lark = cookieValue(cookie, "LARK_SUITE_ACCESS_TOKEN");
  if (lark) {
    const claims = readJwtClaims(lark);
    const found = [claims && claims.doubao_uid, claims && claims.uid, claims && claims.sub]
      .find((value) => value !== undefined && value !== null && String(value).trim() !== "");
    if (found !== undefined) return String(found).trim();
  }
  return String((values && values.uid) || "").trim();
}

// LARK_SUITE_ACCESS_TOKEN 约 5–6 天就过期，是整份 Cookie 里最短命的一环。
// 把它写进只读的「到期时间」，用户能在卡片上看到"还剩几天"，
// 而不是等到某天突然 login_required 才发现。解不出来就返回 0（界面显示"尚未取得"），
// 不猜一个未来时间 —— 猜出来的日期比空着更误导。
export function expiresAtFromCookie(values) {
  const lark = cookieValue(normalizeCookie(values && values.cookie), "LARK_SUITE_ACCESS_TOKEN");
  return lark ? expiresAtOf(lark) : 0;
}

const userAgent = (config) => String(config.userAgent || "").trim()
  || `${CHROME_UA} ${profileOf(config).uaSuffix}`;

function queryOf(config) {
  const profile = profileOf(config);
  const params = new URLSearchParams({
    version_code: "20800",
    language: "zh",
    device_platform: profile.devicePlatform,
    doubao_device_platform: profile.doubaoDevicePlatform,
    aid: profile.aid,
    real_aid: profile.aid,
    pkg_type: "release_version",
    pc_version: profile.pcVersion,
    doubao_pc_version: profile.doubaoPcVersion,
    region: "CN",
    sys_region: "CN",
    samantha_web: "1",
    web_platform: profile.webPlatform,
    "use-olympus-account": "1",
    runtime: "web",
    runtime_version: profile.runtimeVersion,
  });
  if (profile.clientPlatform) params.set("client_platform", profile.clientPlatform);
  if (profile.chromium) params.set("chromium_version", profile.chromium);
  if (profile.channel) params.set("channel", profile.channel);
  const deviceId = String(config.deviceId || "").trim();
  const webId = String(config.webId || "").trim();
  if (deviceId) {
    params.set("device_id", deviceId);
    // 客户端里 fp 与 device_id 同源，缺了它有的接口会判"设备不一致"
    params.set("fp", `verify_${deviceId}`);
  }
  if (webId) {
    params.set("web_id", webId);
    params.set("tea_uuid", webId);
  }
  // 附加参数整段吃下：允许直接粘贴抓包里的 `...&msToken=...&a_bogus=...`。
  // 同名参数覆盖默认值 —— 用户贴进来的必须是"这次真实请求用的那一份"，
  // 否则拼出来的 query 既不是客户端也不是网页端，更难排查。
  const extra = String(config.extraQuery || "").trim();
  if (extra) {
    const tail = extra.includes("?") ? extra.slice(extra.indexOf("?") + 1) : extra;
    for (const [key, value] of new URLSearchParams(tail)) if (key) params.set(key, value);
  }
  return params;
}

// 每一次真实请求都只经 ctx.fetch：那里记账、并按 hosts 白名单拒发别的域名
async function call(ctx, { path, body, referer }) {
  const config = ctx.config || {};
  const cookie = normalizeCookie(ctx.account && ctx.account.cred && ctx.account.cred.cookie);
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "User-Agent": userAgent(config),
    // 这个头在抓包里一直有；网关用它区分"浏览器侧字符串化参数"与二进制协议
    "Agw-Js-Conv": "str",
    Origin: BASE,
    Referer: String(referer || profileOf(config).referer),
    "Content-Type": "application/json",
  };
  if (cookie) headers.Cookie = cookie;

  const url = `${BASE}${path}?${queryOf(config).toString()}`;
  let response;
  try {
    response = await ctx.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body === undefined ? {} : body),
      signal: AbortSignal.timeout(timeoutMs(config)),
    });
  } catch (error) {
    // 超时/断网在调用方眼里必须是"可能已生效"，不能当成 error 冒到界面上
    // （签到是写请求，超时的另一面经常是服务端已经签上了）。
    return { httpStatus: 0, payload: null, text: `请求失败：${String((error && error.message) || error)}` };
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch { /* 非 JSON（如网关 HTML 错误页）留给 open() 里判断 */ }
  return { httpStatus: response.status, payload, text };
}

const AUTH_CODES = new Set(["710012001"]);
const NOT_OPEN_CODES = new Set(["710010702"]);
const RATE_CODES = new Set(["710022004"]);

const codeOf = (payload) => {
  const code = payload && payload.code;
  return code === undefined || code === null ? "" : String(code);
};

const messageOf = (payload, text) => {
  const candidates = [
    payload && payload.message,
    payload && payload.msg,
    payload && payload.data && payload.data.message,
    text,
  ];
  const found = candidates.find((value) => typeof value === "string" && value.trim() !== "");
  return found ? truncate(found.replace(/\s+/g, " ").trim(), 140) : "";
};

// 把上游信号归成内核认识的几类。顺序有讲究：
// 401/403 与 710012001 必须先判 —— 它们最容易被"HTTP 200 + code 非 0"的通用分支吞掉，
// 结果是 Cookie 过期被报成"未知错误"，用户不知道该重抓。
export function classify(result) {
  const { httpStatus, payload, text } = result;
  const code = codeOf(payload);
  const message = messageOf(payload, text);

  if (httpStatus === 0) return { kind: "transient", code, message };
  if (httpStatus === 401 || httpStatus === 403) return { kind: "login", code, message };
  if (AUTH_CODES.has(code)) return { kind: "login", code, message };
  if (httpStatus === 429 || RATE_CODES.has(code)) return { kind: "rate", code, message };
  if (NOT_OPEN_CODES.has(code)) return { kind: "pending", code, message };
  if (httpStatus === 408 || httpStatus >= 500) return { kind: "transient", code, message };

  if (code === "0") return { kind: "ok", code, message };
  // code 2 是活动换季（campaign not found），不是 IP 风控也不是登录问题。
  // 它和 710010702 必须分开：一个要改配置，一个只要换个窗口再来。
  if (code === "2" || /campaign\s*not\s*found/i.test(text || "")) {
    return { kind: "notfound", code, message };
  }

  const body = String(text || "");
  if (/登录|未登录|not\s*login|login\s*required/i.test(body)) return { kind: "login", code, message };
  // 风控/人机验证：不自动重试、不伪造成功，留给界面亮红让人看
  if (/captcha|verify|频繁|风控|risk|安全验证/i.test(body)) return { kind: "risk", code, message };
  return { kind: "error", code, message };
}

const dataOf = (payload) => (payload && typeof payload === "object" ? payload.data : null);

// 只读预检。返回的 daily 是"今天到底签没签"的唯一判据：
//   checked_in_today 优先（上游在 daily_checkin 里明说），
//   task_status===3 兜底（老版本响应没有 checked_in_today 字段）。
export async function readDetail(ctx, group = DEFAULT_GROUP) {
  const result = await call(ctx, { path: PATH_DETAIL, body: { campaign_group_code: group } });
  const verdict = classify(result);
  if (verdict.kind !== "ok") return { ...verdict, group };

  const data = dataOf(result.payload);
  if (!data || typeof data !== "object") {
    return { kind: "error", code: verdict.code, message: "detail 响应里没有 data 对象", group };
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const task = tasks.find((item) => item && item.campaign_code === "daily_signin") || null;
  const daily = task && task.daily_checkin && typeof task.daily_checkin === "object" ? task.daily_checkin : {};
  const total = Number(data.progress && data.progress.total_amount);
  return {
    kind: "ok",
    code: verdict.code,
    message: verdict.message,
    group,
    hasDaily: !!task,
    taskStatus: Number(task && task.task_status),
    checkedInToday: daily.checked_in_today === true || Number(task && task.task_status) === 3,
    continuousDays: Number(daily.continuous_days),
    totalAmount: Number.isFinite(total) ? total : null,
  };
}

// launch 只在 detail 报"活动不存在"时才调：用来发现换季后的新活动组。
// 响应结构没有取证样本，所以只做一件事 —— 从原文里捞出 pc_incentive_* 候选，
// 再拿它去 detail 复核；复核不过就当没发现，绝不把猜到的名字当事实写进消息。
export async function discoverGroup(ctx) {
  const result = await call(ctx, { path: PATH_LAUNCH, body: {} });
  if (classify(result).kind !== "ok") return "";
  const text = JSON.stringify(result.payload || {});
  const found = [...text.matchAll(/pc_incentive_[A-Za-z0-9_]+/g)].map((match) => match[0]);
  return found.find((code) => code !== DEFAULT_GROUP) || "";
}

// 落地页事件上报。纯 best-effort：抓包里它在 checkin 之前，
// 但没有任何证据表明缺了它签到会失败；失败也不该让整轮变红。
export async function reportLanding(ctx) {
  try {
    const result = await call(ctx, {
      path: PATH_REPORT,
      body: { event_type: "user_operate", biz_event_name: "check_in" },
    });
    return classify(result).kind === "ok";
  } catch {
    return false;
  }
}

// 签到本体。判据只看 data.checked_in：
//   · idempotent:true —— 今天早些时候已经签过，这次是幂等重放，不算新领取；
//   · idempotent:false 且 checked_in:true —— 这次真的签上了，reward_amount 才是本次到账。
// 不拿 code:0 单独当成功：那只是"请求被受理"，签到接口对已签也回 code:0。
export async function checkin(ctx, scene = DEFAULT_GROUP) {
  const result = await call(ctx, { path: PATH_CHECKIN, body: { scene } });
  const verdict = classify(result);
  if (verdict.kind !== "ok") return { ...verdict, scene };

  const data = dataOf(result.payload);
  if (!data || typeof data !== "object" || data.checked_in !== true) {
    return {
      kind: "unconfirmed",
      code: verdict.code,
      message: data ? "签到接口返回 code:0，但没有 checked_in:true" : "签到响应里没有 data 对象",
      scene,
    };
  }
  return {
    kind: "ok",
    code: verdict.code,
    scene,
    checkedIn: true,
    idempotent: data.idempotent === true,
    rewardAmount: Number.isFinite(Number(data.reward_amount)) ? Number(data.reward_amount) : 0,
    rewardType: String(data.reward_type || ""),
    continuousDays: Number.isFinite(Number(data.continuous_days)) ? Number(data.continuous_days) : 0,
    checkinDate: String(data.checkin_date || ""),
  };
}
