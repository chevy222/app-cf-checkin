import * as api from "./api.js";

// 豆包（doubao.com）签到领体验额度。
//
// 鉴权方式：纯 cookie session。用户在浏览器登录 doubao.com 后，
// F12 复制整串 Cookie 粘进来。工具不负责登录（短信/扫码都要交互，
// 在 Worker 里复刻风控签名不划算），cookie 失效后用户重新粘即可。
//
// 上游方言（2026-10-21 抓包 + CreditDaddy 实测）：
//   detail  code 0 + daily_checkin.checked_in_today=true  → 今日已签（already）
//   detail  code 0 + daily_checkin.checked_in_today=false → 未签，走 checkin
//   detail  code 710012001                                → cookie 失效（login_required）
//   detail  无 daily_signin 任务                            → 活动未开放/企业号（inactive）
//   checkin code 0 + idempotent:true                       → 服务端幂等去重（already）
//   checkin code 0 + idempotent:false                     → 签到成功（claimed）
//   checkin code 710012001                                → cookie 失效（login_required）

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

  // uid 从 cookie 里的 multi_sids 字段解析（multi_sids=<uid>%3A<sessionid>）。
  // 登录响应一定下发 multi_sids，所以正常粘贴的 cookie 都能解出 uid。
  uidOf: (ctx) => api.uidFromCookie(String(ctx.values.cookie || "")),

  schedule: {
    resetHour: 0,
    notBeforeHour: 0,
    minIntervalSec: 1800,
    maxDaily: 3,
    backoff: [5, 10, 30],
  },

  hosts: api.doubaoHosts,

  // cost = 3（detail 1 + checkin 1 + 1 余量）。
  // 已签到时只花 detail 1 笔。
  steps: [
    {
      id: "checkin",
      label: "签到领额度",
      cost: 3,
      async run(ctx) {
        const uid = ctx.account.uid || "";

        // 第一步：查状态
        const st = await api.readStatus(ctx, uid);
        if (st.timeout) {
          return { status: "waiting", message: "状态查询超时，下一轮再确认", credits: 0, cred: null };
        }
        if (st.loginExpired) {
          return { status: "login_required", message: "豆包登录态已失效，请重新粘贴 Cookie", credits: 0, cred: null };
        }
        if (st.error) {
          return { status: "error", message: st.error, credits: 0, cred: null };
        }
        if (st.noTask) {
          return {
            status: "inactive",
            message: "当前账号无签到任务（活动可能未开放，或飞书企业账号不支持参与）",
            credits: 0,
            cred: null,
          };
        }
        if (st.checkedIn) {
          return {
            status: "already",
            message: `今日已签到（连签 ${st.continuousDays} 天）`,
            credits: 0,
            cred: null,
          };
        }

        // 第二步：未签，执行领取
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
          return { status: "already", message: "今日已签到（服务端幂等去重）", credits: 0, cred: null };
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

  // 「测试」按钮：只查状态，不领取。验证 cookie 是否有效。
  async validate(ctx) {
    const uid = ctx.account.uid || "";
    const st = await api.readStatus(ctx, uid);
    if (st.timeout) return { status: "waiting", message: "查询超时，请稍后再试" };
    if (st.loginExpired) return { status: "login_required", message: "Cookie 已失效，请重新粘贴" };
    if (st.error) return { status: "error", message: st.error };
    if (st.noTask) return { status: "inactive", message: "Cookie 有效，但当前账号无签到任务" };
    return {
      status: "ok",
      message: st.checkedIn
        ? `Cookie 有效，今日已签到（连签 ${st.continuousDays} 天，累计 ${st.totalAmount} 额度）`
        : `Cookie 有效，今日未签到（连签 ${st.continuousDays} 天）`,
    };
  },
};
