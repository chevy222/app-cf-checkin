import { truncate } from "../../core/text.js";
import { readJwtClaims } from "../../core/jwt.js";

// 豆包（doubao.com）网页会话签到领体验额度。
//
// 鉴权：纯 cookie session（浏览器登录后 F12 整串复制），无 a_bogus / msToken 签名。
// 实测（CreditDaddy issue #32 + 2026-10-21 抓包）：
//   - 裸浏览器 UA 打活动接口吃「请求非法」，必须伪装成桌面版 webview
//   - device_id / region 留空可过
//   - cookie 匿名或过期返 code 710012001「登录已过期」
//   - 重复领取返 code 0 + idempotent:true（服务端幂等）
//
// 两个端点（host 都是 www.doubao.com）：
//   POST /alice/ug/campaign/v3/detail/        任务面板（含签到状态 + 累计额度）
//   POST /alice/ug/campaign/landing/checkin    每日领取（+200 额度）
//
// detail body:  {"campaign_group_code":"pc_incentive_task_mvp_v3"}
// checkin body: {"scene":"pc_incentive_task_mvp_v3"}

const HOST = "www.doubao.com";
const DETAIL_PATH = "/alice/ug/campaign/v3/detail/";
const CHECKIN_PATH = "/alice/ug/campaign/landing/checkin";
const CAMPAIGN_GROUP = "pc_incentive_task_mvp_v3";

// 桌面客户端 webview UA（抓包实测 2026-10-21）
const CLIENT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/147.0.0.0 Safari/537.36 SamanthaDoubaoWork/2.32.14";

// detail 与 checkin 的平台参数不同（抓包实测 2026-10-21）：
//   detail：work_desktop / doubao_device_platform=web / aid=497858（网页工作台）
//   checkin：desktop / doubao_device_platform=desktop / aid=1044603（桌面客户端）
// 混用会返回 code=2 "campaign not found"。
const DETAIL_PARAMS = {
  version_code: "20800",
  language: "zh",
  device_platform: "web",
  doubao_device_platform: "web",
  aid: "497858",
  real_aid: "497858",
  pkg_type: "release_version",
  pc_version: "2.32.14",
  doubao_pc_version: "5.72.66",
  samantha_web: "1",
  web_platform: "work_desktop",
  "use-olympus-account": "1",
  runtime: "web",
  runtime_version: "5.72.66",
  web_tab_id: "0",
};

const CHECKIN_PARAMS = {
  version_code: "20800",
  language: "zh",
  device_platform: "web",
  doubao_device_platform: "desktop",
  aid: "1044603",
  real_aid: "1044603",
  pkg_type: "release_version",
  pc_version: "2.32.14",
  doubao_pc_version: "2.32.14",
  samantha_web: "1",
  web_platform: "desktop",
  "use-olympus-account": "1",
  runtime: "web",
  runtime_version: "3.41.4",
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
// 不需要密码学安全——web_id / tea_uuid 只是设备标识，不是凭据。
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function deviceIdsFor(uid) {
  const seed = hashStr(`doubao-dev:${uid || "anonymous"}`);
  // web_id: 18 位数字，76 开头
  let webId = "76";
  let n = seed;
  for (let i = 0; i < 16; i++) { n = (n * 31 + i) >>> 0; webId += String(n % 10); }
  // device_id / tea_uuid: 16 位数字（抓包实测两者相同）
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

function apiUrl(path, uid) {
  const baseParams = path === DETAIL_PATH ? DETAIL_PARAMS : CHECKIN_PARAMS;
  const ids = deviceIdsFor(uid);
  const params = new URLSearchParams({
    ...baseParams,
    ...ids,
    region: "CN",
    sys_region: "CN",
  });
  return `https://${HOST}${path}?${params.toString()}`;
}

async function postJson(ctx, path, body, uid) {
  const cookie = ctx.account.cred.cookie || "";
  let response;
  try {
    response = await ctx.fetch(apiUrl(path, uid), {
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

// detail 响应里挖签到任务：tasks[].task_kind === "daily_signin"
function findCheckinTask(body) {
  const tasks = body && body.data && Array.isArray(body.data.tasks) ? body.data.tasks : null;
  if (!tasks) return null;
  return tasks.find((t) => t && t.task_kind === "daily_signin") || null;
}

// 查签到状态。返回 { auth, checkedIn, continuousDays, rewardAmount, totalAmount, error, timeout }
export async function readStatus(ctx, uid) {
  const res = await postJson(ctx, DETAIL_PATH, { campaign_group_code: CAMPAIGN_GROUP }, uid);
  if (res.timeout) return { timeout: true };
  if (res.status !== 200 || !res.payload) {
    return { auth: false, error: `状态查询失败：HTTP ${res.status} ${truncate(res.text, 80)}` };
  }
  const code = Number(res.payload.code);
  if (code === LOGIN_INVALID) return { auth: false, loginExpired: true };
  if (code !== 0) {
    return { auth: true, error: `状态查询返回 code ${code}：${truncate(res.payload.msg || res.payload.message || "", 80)}` };
  }
  const task = findCheckinTask(res.payload);
  if (!task) return { auth: true, noTask: true };
  const c = task.daily_checkin || {};
  return {
    auth: true,
    checkedIn: c.checked_in_today === true,
    continuousDays: Number(c.continuous_days) || 0,
    rewardAmount: Number(c.reward && c.reward.reward_amount) || 0,
    totalAmount: Number(res.payload.data && res.payload.data.progress && res.payload.data.progress.total_amount) || 0,
  };
}

// 执行签到。返回 { auth, claimed, already, amount, days, error, timeout, loginExpired }
export async function doCheckin(ctx, uid) {
  const res = await postJson(ctx, CHECKIN_PATH, { scene: CAMPAIGN_GROUP }, uid);
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
  if (d.idempotent === true) return { auth: true, already: true };
  return {
    auth: true,
    claimed: true,
    amount: Number(d.reward_amount) || 200,
    days: Number(d.continuous_days) || 1,
  };
}

// 从 cookie 串里解 user_id（multi_sids=<uid>%3A<sessionid>）。
// cookie 是用户从浏览器 F12 整串复制的，multi_sids 一定有（登录下发的）。
export function uidFromCookie(cookieStr) {
  if (!cookieStr) return "";
  const text = String(cookieStr);
  // 旧版 cookie：multi_sids=<uid>%3A<sessionid>
  const m = text.match(/multi_sids\s*=\s*(\d+)/);
  if (m) return m[1];
  // 新版工作台 cookie：没有 multi_sids，但有 LARK_SUITE_ACCESS_TOKEN（JWT），
  // payload 里的 doubao_uid 就是账号标识
  const token = text.match(/LARK_SUITE_ACCESS_TOKEN\s*=\s*([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/);
  if (token) {
    const claims = readJwtClaims(token[1]);
    const uid = claims && (claims.doubao_uid || claims.uid || claims.sub);
    if (uid !== undefined && uid !== null && String(uid).trim() !== "") return String(uid).trim();
  }
  return "";
}

export const doubaoHosts = [HOST];
