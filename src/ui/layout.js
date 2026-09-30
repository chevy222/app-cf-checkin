import { escapeHtml } from "../core/text.js";
import { VERSION } from "../version.js";

const CSS = `
:root{color-scheme:light dark;
  --bg:#f6f7f9;--panel:#fff;--panel2:#fafbfc;--panel3:#f1f3f6;
  --line:#e8eaee;--line2:#dfe2e7;--text:#1a1e24;--muted:#67707b;--faint:#98a1ab;
  --accent:#c9551d;--accent-weak:#fbeee6;
  --ok:#1c7f47;--ok-bg:#e7f5ed;--info:#2b62d9;--info-bg:#e9f0fd;
  --warn:#96590a;--warn-bg:#fbf1df;--bad:#ad232c;--bad-bg:#fbe9ea;
  --neu:#5a636e;--neu-bg:#edeff1;--teal:#0f6f72;--teal-bg:#e4f2f2;
  --radius:13px;--radius-sm:8px;--shadow:0 1px 2px rgba(22,24,32,.06),0 10px 26px -14px rgba(22,24,32,.16)}
@media (prefers-color-scheme:dark){:root{color-scheme:light dark;
  --bg:#111418;--panel:#191d22;--panel2:#1d2228;--panel3:#23282f;
  --line:#2a3138;--line2:#39424c;--text:#e5e9ee;--muted:#97a1ad;--faint:#6d7783;
  --accent:#f08a4b;--accent-weak:#2b1d15;
  --ok:#4ec389;--ok-bg:#152a1f;--info:#6ea3ff;--info-bg:#152033;
  --warn:#dfa254;--warn-bg:#2b2014;--bad:#f1787f;--bad-bg:#311719;
  --neu:#96a0ac;--neu-bg:#232930;--teal:#4fb2b6;--teal-bg:#12272a;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 12px 28px -18px rgba(0,0,0,.7)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);line-height:1.55;font-size:14px;
  font-family:ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:20px 18px 72px}
a{color:var(--accent)}
code,.mono,.num{font-family:ui-monospace,"Cascadia Mono",Consolas,"Sarasa Mono SC",monospace}
code{font-size:12px;background:var(--panel3);padding:1px 5px;border-radius:4px}
.num{font-size:12.5px;white-space:nowrap}
.dim{color:var(--faint)}
.top{display:flex;align-items:center;gap:16px;background:var(--panel);border:1px solid var(--line);
  border-radius:var(--radius);padding:11px 15px;box-shadow:var(--shadow);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:8px;font-weight:650;font-size:15px;text-decoration:none;color:var(--text)}
.brand .mark{width:22px;height:22px;border-radius:6px;background:var(--accent);color:#fff;display:grid;
  place-items:center;font-size:12px;font-weight:700}
.nav{display:flex;gap:2px}
.nav a{color:var(--muted);text-decoration:none;padding:6px 12px;border-radius:var(--radius-sm);font-size:13.5px}
.nav a:hover{background:var(--panel3);color:var(--text)}
.nav a.on{background:var(--accent-weak);color:var(--accent);font-weight:600}
.top .right{margin-left:auto;display:flex;align-items:center;gap:10px;color:var(--faint);font-size:12.5px}
.h{display:flex;align-items:center;gap:10px;margin:22px 0 10px;flex-wrap:wrap}
h2{margin:0;font-size:17px;font-weight:650;letter-spacing:-.2px}
.sub{color:var(--muted);font-size:12.5px}
.spacer{margin-left:auto}
.grid{display:grid;gap:12px}
.grid.cols3{grid-template-columns:repeat(auto-fit,minmax(290px,1fr))}
.split{display:grid;grid-template-columns:minmax(0,340px) minmax(0,1fr);gap:14px;align-items:start}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);overflow:hidden}
.card .hd{display:flex;align-items:center;gap:10px;padding:16px 16px 0}
.card .hd .id{display:flex;align-items:center;gap:9px;min-width:0}
.card .hd .t{font-weight:650;font-size:14.5px}
.card .hd .d{color:var(--faint);font-size:12px}
/* 只作用于文字链接（如「管理 ›」）：这条规则的优先级高于 .btn.pri，
   不收窄会把卡片头里主按钮的白字覆盖成橙色 —— 橙底橙字，文字隐形 */
.card .hd a:not(.btn){margin-left:auto;color:var(--accent);text-decoration:none;font-size:12.5px}
/* 图标是内联 data URI（见 icons.js 的理由：必须在口令闸后）。64×64 缩到 22px，
   交给浏览器双线性插值；只做圆角与去白边，不加滤镜 —— 样式 B 里图标是配角。 */
.ico{width:22px;height:22px;border-radius:5px;flex:none;display:block}
.card .bd{padding:14px 16px 18px}
.pane{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:16px 18px;box-shadow:var(--shadow)}
.alert{display:flex;gap:8px;align-items:flex-start;padding:11px 16px;font-size:12.5px;line-height:1.45}
.alert.bad{background:var(--bad-bg);color:var(--bad)}
.alert.warn{background:var(--warn-bg);color:var(--warn)}
.alert.info{background:var(--info-bg);color:var(--info)}
.alert svg{flex:none;margin-top:1px}
.alert a{color:inherit;text-decoration:underline}
.badge{display:inline-flex;align-items:center;gap:5px;padding:2.5px 8px 2.5px 6px;border-radius:7px;
  font-size:12px;font-weight:600;white-space:nowrap;line-height:1.5}
.badge svg{width:12px;height:12px;flex:none}
.b-claimed,.b-ok{background:var(--ok-bg);color:var(--ok)}
.b-already{background:var(--teal-bg);color:var(--teal)}
.b-inactive,.b-skipped{background:var(--neu-bg);color:var(--neu)}
.b-pending,.b-partial,.b-rate{background:var(--warn-bg);color:var(--warn)}
.b-defer{background:var(--info-bg);color:var(--info)}
.b-login,.b-error{background:var(--bad-bg);color:var(--bad)}
.btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;padding:6px 13px;
  border-radius:var(--radius-sm);border:1px solid var(--line2);background:var(--panel);color:var(--text);
  cursor:pointer;white-space:nowrap;text-decoration:none}
.btn:hover{background:var(--panel3)}
.btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.ghost{border-color:transparent;color:var(--accent);background:transparent;padding:6px 8px}
.btn.ghost:hover{background:var(--accent-weak)}
.btn.danger{color:var(--bad);background:transparent}
.btn.danger:hover{background:var(--bad-bg);border-color:var(--bad)}
.btn.sm{font-size:11.5px;padding:3px 9px}
.acts{display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap}
.tw{overflow-x:auto;border-radius:var(--radius)}
table.t{width:100%;min-width:640px;border-collapse:collapse;background:var(--panel);font-size:13px}
table.t th{text-align:left;font-weight:600;color:var(--muted);font-size:11.5px;letter-spacing:.3px;
  padding:11px 13px;background:var(--panel2);border-bottom:1px solid var(--line);white-space:nowrap}
table.t td{padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:middle}
table.t tr:last-child td{border-bottom:0}
.kv{display:flex;justify-content:space-between;gap:12px;padding:7px 0;font-size:13px;border-top:1px dashed var(--line)}
.kv:first-of-type{border-top:0}
.kv .k{color:var(--muted)}
.kv .v{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12.5px;text-align:right}
.field{margin:0 0 15px}
.field label{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;margin-bottom:5px;flex-wrap:wrap}
.field .help{color:var(--muted);font-weight:400;font-size:12px;margin-top:4px;line-height:1.45}
.field input,.field textarea,.field select{width:100%;font:inherit;font-size:13px;padding:7px 10px;
  border:1px solid var(--line2);border-radius:var(--radius-sm);background:var(--panel);color:var(--text)}
.field textarea{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12px;min-height:88px;
  resize:vertical;line-height:1.5}
.field input:focus,.field textarea:focus,.field select:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-weak)}
.field.bad input,.field.bad textarea,.field.bad select{border-color:var(--bad)}
.err{color:var(--bad);font-size:12px;margin-top:4px}
.req{color:var(--bad)}
.chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1.5px 7px;border-radius:99px;
  background:var(--accent-weak);color:var(--accent);font-weight:600}
.chip.off{background:var(--warn-bg);color:var(--warn)}
/* 参数获取教程。内容来自 tools 侧的数据，排版只这一份（见 tutorials.js 的说明）。 */
.tutbox{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel2);
  padding:14px 16px;margin-bottom:16px}
.tut-intro{font-size:12.5px;line-height:1.6;color:var(--muted);margin-bottom:12px}
.tut{margin-bottom:12px}
.tut:last-child{margin-bottom:0}
.tut-h{display:flex;align-items:flex-start;gap:8px;font-size:13px;font-weight:650;line-height:1.5}
.tut-n{flex:none;width:18px;height:18px;border-radius:50%;background:var(--accent-weak);
  color:var(--accent);font-size:11px;display:grid;place-items:center;margin-top:1px}
.tut-b{font-size:12.5px;line-height:1.6;color:var(--muted);margin:6px 0 0 26px}
.tut-c{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11.5px;line-height:1.5;
  background:var(--panel3);border:1px solid var(--line);border-radius:var(--radius-sm);
  padding:10px 12px;margin:8px 0 0 26px;overflow-x:auto;white-space:pre;
  color:var(--text);max-height:340px;overflow-y:auto}
.tut-c code{background:none;padding:0;font-size:inherit}
.tutbox .alert{margin:8px 0 0 26px;font-size:12px}
.tutbox .tw{margin:8px 0 0 26px}
.cmdbox{display:flex;gap:8px;align-items:center;background:var(--panel3);border:1px solid var(--line);
  border-radius:var(--radius-sm);padding:8px 10px;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:11.5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.tiny{color:var(--faint);font-size:11.5px}
.login{max-width:330px;margin:48px auto;text-align:center}
.login .lock{width:44px;height:44px;border-radius:12px;background:var(--panel3);color:var(--muted);
  display:grid;place-items:center;margin:0 auto 14px}
.login h1{font-size:16px;margin:0 0 4px}
.login p{color:var(--muted);font-size:12.5px;margin:0 0 16px}
.login .row{display:flex;gap:8px}
.login input{flex:1;font-family:ui-monospace,monospace;text-align:center;font-size:14px;padding:9px 11px;
  border:1px solid var(--line2);border-radius:var(--radius-sm);background:var(--panel);color:var(--text)}
.empty{text-align:center;padding:30px 20px}
.empty .mark{width:44px;height:44px;border-radius:12px;background:var(--panel3);color:var(--muted);
  display:grid;place-items:center;margin:0 auto 12px}
.ft{margin-top:28px;text-align:center;color:var(--faint);font-size:11.5px}
.ft a{color:var(--faint);text-decoration:none}
.ft a:hover{color:var(--accent)}
.ft .sep{margin:0 7px}
@media (max-width:860px){.split{grid-template-columns:1fr}}
`;

const SPRITE = `
<svg style="display:none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<symbol id="g-check" viewBox="0 0 16 16"><path d="M3 8.4l3.2 3.2L13 4.6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-loop" viewBox="0 0 16 16"><path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.85" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M13.4 2.3v2.7h-2.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-dot" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.1" fill="currentColor"/></symbol>
<symbol id="g-ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="2.9 2.4"/></symbol>
<symbol id="g-clock" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.1" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 4.9v3.3l2.3 1.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="g-half" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 3a5 5 0 0 1 0 10z" fill="currentColor"/></symbol>
<symbol id="g-skip" viewBox="0 0 16 16"><path d="M3.6 3.8l5 4.2-5 4.2M11.8 3.8v8.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-tri" viewBox="0 0 16 16"><path d="M8 2.3l6.1 11.2H1.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 6.2v3.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.5" r=".95" fill="currentColor"/></symbol>
<symbol id="g-lock" viewBox="0 0 16 16"><rect x="3.2" y="6.9" width="9.6" height="6.9" rx="1.7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.6 6.9V5.1a2.4 2.4 0 0 1 4.8 0v1.8" fill="none" stroke="currentColor" stroke-width="1.8"/></symbol>
<symbol id="g-down" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.1" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 5v4.4M5.7 7.2L8 9.5l2.3-2.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="g-oct" viewBox="0 0 16 16"><path d="M5.5 1.9h5L14.1 5.5v5L10.5 14.1h-5L1.9 10.5v-5z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 4.8v3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="10.8" r=".95" fill="currentColor"/></symbol>
<symbol id="g-key" viewBox="0 0 16 16"><circle cx="5.4" cy="5.4" r="3.1" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M7.6 7.6l5.1 5.1M10.4 9.6l1.6 1.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
</svg>`;

// 全站唯一的状态词汇。形状 + 颜色 + 中文三重冗余，去掉颜色也读得懂。
export const STATUS = {
  claimed: { label: "成功领取", glyph: "g-check" },
  already: { label: "今日已领", glyph: "g-loop" },
  ok: { label: "正常", glyph: "g-dot" },
  inactive: { label: "活动未开", glyph: "g-ring" },
  pending: { label: "待下发", glyph: "g-clock" },
  partial: { label: "部分完成", glyph: "g-half" },
  skipped: { label: "未开始", glyph: "g-skip" },
  rate_limited: { label: "限频", glyph: "g-tri" },
  login_required: { label: "需重新登录", glyph: "g-lock" },
  deferred: { label: "顺延", glyph: "g-down" },
  error: { label: "失败", glyph: "g-oct" },
};

export function statusInfo(status) {
  return STATUS[status] || { label: status || "未知", glyph: "g-oct" };
}

// 界面内部用的链接：自动带上访问口令，这样点链接不需要手敲 pwd。
// 口令本身永远不出现在任何可见文本里，只在 href 中。
export function link(path, pwd, extra) {
  const url = new URL(path, "https://app.invalid");
  if (pwd) url.searchParams.set("pwd", pwd);
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  return url.pathname + url.search;
}

export function pageShell({ title, pwd, nav = "", body }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${SPRITE}
<div class="wrap">
  <div class="top">
    <a class="brand" href="${link("/", pwd)}"><span class="mark">签</span>签到台</a>
    <nav class="nav">${nav}</nav>
    <div class="right"><span class="tiny">口令已随链接携带</span></div>
  </div>
  ${body}
  <footer class="ft">${VERSION}<span class="sep">·</span><a href="https://github.com/chevy222/app-cf-checkin" target="_blank" rel="noopener">Powered by GitHub</a></footer>
</div></body></html>`;
}

export function navHtml(pwd, active, tools) {
  const item = (href, text, key) => `<a class="${key === active ? "on" : ""}" href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  const links = tools.map((tool) => item(link(`/tool/${tool.id}`, pwd), tool.name, `tool:${tool.id}`));
  return item(link("/", pwd), "总览", "home") + links.join("") + item(link("/help", pwd), "说明", "help");
}