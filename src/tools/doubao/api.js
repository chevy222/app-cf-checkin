import { truncate } from "../../core/text.js";
import { readJwtClaims } from "../../core/jwt.js";

// 豆包（doubao.com）网页会话签到领体验额度。
//
// 鉴权：纯 cookie session（浏览器登录后 F12 整串复制）。
// 2026-10-23 抓包实测：直接调 checkin 即可，不需要先查 detail。
//   code 0 + idempotent:false           → 本次领取成功（claimed）
//   code 0 + idempotent:true            → 今日已签过（already，服务端幂等）
//   code 710012001                       → cookie 失效（login_required）
//
// 端点（host www.doubao.com）：
//   POST /alice/ug/campaign/landing/checkin
//   body {"scene":"pc_incentive_task_mvp_v3"}

const HOST = "www.doubao.com";
const CHECKIN_PATH = "/alice/ug/campaign/landing/checkin";
const CAMPAIGN_GROUP = "pc_incentive_task_mvp_v3";

// 桌面客户端 webview UA（2026-10-23 抓包）
const CLIENT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/147.0.0.0 Safari/537.36 SamanthaDoubaoWork/2.33.5";

const CHECKIN_PARAMS = {
  version_code: "20800",
  language: "zh",
  device_platform: "web",
  doubao_device_platform: "desktop",
  aid: "1044603",
  real_aid: "1044603",
  pkg_type: "release_version",
  pc_version: "2.33.5",
  doubao_pc_version: "2.33.5",
  samantha_web: "1",
  web_platform: "desktop",
  "use-olympus-account": "1",
  runtime: "web",
  runtime_version: "3.42.2",
  client_platform: "pc_client",
  chromium_version: "147.0.7727.149",
  channel: "win",
  web_tab_id: "0",
};

// 会话失效业务码（匿名/过期 cookie 返回）
const LOGIN_INVALID = 710012001;

const timeoutMs = (config) => {
  const raw = Number(config.timeoutMs);
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
};

// 简单字符串 hash（djb2），用于从 uid 派生稳定的设备指纹。
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function deviceIdsFor(uid) {
  const seed = hashStr(`doubao-dev:${uid || "anonymous"}`);
  let webId = "76";
  let n = seed;
  for (let i = 0; i < 16; i++) { n = (n * 31 + i) >>> 0; webId += String(n % 10); }
  let devId = "";
  n = (seed * 2654435761) >>> 0;
  for (let i = 0; i < 16; i++) { n = (n * 31 + i * 7) >>> 0; devId += String(n % 10); }
  return {
    web_id: webId,
    device_id: devId,
    tea_uuid: devId,
    fp: `verify_${devId}`,
  };
}

function apiUrl(uid) {
  const ids = deviceIdsFor(uid);
  const params = new URLSearchParams({
    ...CHECKIN_PARAMS,
    ...ids,
    region: "CN",
    sys_region: "CN",
  });
  return `https://${HOST}${CHECKIN_PATH}?${params.toString()}`;
}

async function postJson(ctx, body, uid) {
  const cookie = ctx.account.cred.cookie || "";
  let response;
  try {
    response = await ctx.fetch(apiUrl(uid), {
      method: "POST",
      headers: {
        "User-Agent": CLIENT_UA,
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Cookie: cookie,
        Referer: `https://${HOST}/`,
        Origin: `https://${HOST}`,
        "agw-js-conv": "str",
        "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8"',
        "sec-ch-ua-platform": '"Windows"',
        "sec-ch-ua-mobile": "?0",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "accept-language": "zh-CN,zh;q=0.9",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs(ctx.config)),
    });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || /timeout|aborted/i.test(err.message || ""))) {
      return { timeout: true };
    }
    throw err;
  }
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: response.status, payload, text };
}

// 执行签到。返回 { auth, claimed, already, amount, days, error, timeout, loginExpired }
export async function doCheckin(ctx, uid) {
  const res = await postJson(ctx, { scene: CAMPAIGN_GROUP }, uid);
  if (res.timeout) return { timeout: true };
  if (res.status !== 200 || !res.payload) {
    return { auth: false, error: `签到请求失败：HTTP ${res.status} ${truncate(res.text, 80)}` };
  }
  const code = Number(res.payload.code);
  if (code === LOGIN_INVALID) return { auth: false, loginExpired: true };
  if (code !== 0) {
    return { auth: true, error: `签到返回 code ${code}：${truncate(res.payload.msg || res.payload.message || "", 80)}` };
  }
  const d = res.payload.data || {};
  if (d.idempotent === true) return { auth: true, already: true, days: Number(d.continuous_days) || 0 };
  return {
    auth: true,
    claimed: true,
    amount: Number(d.reward_amount) || 200,
    days: Number(d.continuous_days) || 1,
  };
}

// 从 cookie 串里解 user_id。优先 multi_sids（旧版），兜底 LARK_SUITE_ACCESS_TOKEN JWT 的 doubao_uid。
export function uidFromCookie(cookieStr) {
  if (!cookieStr) return "";
  const text = String(cookieStr);
  const m = text.match(/multi_sids\s*=\s*(\d+)/);
  if (m) return m[1];
  const token = text.match(/LARK_SUITE_ACCESS_TOKEN\s*=\s*([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/);
  if (token) {
    const claims = readJwtClaims(token[1]);
    const uid = claims && (claims.doubao_uid || claims.uid || claims.sub);
    if (uid !== undefined && uid !== null && String(uid).trim() !== "") return String(uid).trim();
  }
  return "";
}

export const doubaoHosts = [HOST];
