import * as api from "./api.js";

// 豆包（doubao.com）签到领体验额度。
//
// 鉴权方式：纯 cookie session。用户在浏览器登录 doubao.com 后，
// F12 → Network → 任意请求 → Cookie 请求头整串复制粘贴。
// cookie 失效后用户重新粘即可。
//
// 上游方言（2026-10-23 抓包）：
//   checkin code 0 + idempotent:false → 本次领取成功（claimed）
//   checkin code 0 + idempotent:true  → 今日已签过（already）
//   checkin code 710012001            → cookie 失效（login_required）

export default {
  id: "doubao",
  name: "豆包",
  order: 50,
  summary: "每天签到领体验额度",

  config: [
    {
      key: "timeoutMs",
      label: "请求超时（毫秒）",
      type: "text",
      placeholder: "15000",
      help: "留空即用 15000（15 秒）。豆包接口响应快，不建议低于 8000",
    },
  ],

  creds: [
    {
      key: "cookie",
      label: "Cookie（整串）",
      type: "textarea",
      required: true,
      secret: true,
      help: "浏览器登录 doubao.com 后 F12 → Network → 任意请求 → Cookie 请求头整串复制粘贴。"
        + "cookie 有效期约 60 天，失效后重新登录复制即可",
    },
  ],

  uidOf: (ctx) => api.uidFromCookie(String(ctx.values.cookie || "")),

  schedule: {
    resetHour: 0,
    notBeforeHour: 0,
    minIntervalSec: 1800,
    maxDaily: 3,
    backoff: [5, 10, 30],
  },

  hosts: api.doubaoHosts,

  // 直接调 checkin，一步到位（2026-10-23 起不再先查 detail）。
  steps: [
    {
      id: "checkin",
      label: "签到领额度",
      cost: 1,
      async run(ctx) {
        const uid = ctx.account.uid || "";
        const r = await api.doCheckin(ctx, uid);
        if (r.timeout) {
          return { status: "waiting", message: "签到请求超时，下一轮确认是否到账", credits: 0, cred: null };
        }
        if (r.loginExpired) {
          return { status: "login_required", message: "豆包登录态已失效，请重新粘贴 Cookie", credits: 0, cred: null };
        }
        if (r.error) {
          return { status: "error", message: r.error, credits: 0, cred: null };
        }
        if (r.already) {
          return {
            status: "already",
            message: r.days ? `今日已签到（连签 ${r.days} 天）` : "今日已签到",
            credits: 0,
            cred: null,
          };
        }
        if (r.claimed) {
          return {
            status: "claimed",
            message: `签到 +${r.amount} 额度，连签 ${r.days} 天`,
            credits: r.amount,
            cred: null,
          };
        }
        return { status: "error", message: "签到返回未知状态", credits: 0, cred: null };
      },
    },
  ],

  // 「测试」按钮：直接调 checkin。早领晚领都要领，返回 already 说明 cookie 有效且已签过。
  async validate(ctx) {
    const uid = ctx.account.uid || "";
    const r = await api.doCheckin(ctx, uid);
    if (r.timeout) return { status: "waiting", message: "请求超时，请稍后再试" };
    if (r.loginExpired) return { status: "login_required", message: "Cookie 已失效，请重新粘贴" };
    if (r.error) return { status: "error", message: r.error };
    if (r.already) return { status: "ok", message: `Cookie 有效，今日已签到（连签 ${r.days} 天）` };
    if (r.claimed) return { status: "ok", message: `Cookie 有效，已为你领取今日额度（+${r.amount}，连签 ${r.days} 天）` };
    return { status: "error", message: "返回未知状态" };
  },
};
