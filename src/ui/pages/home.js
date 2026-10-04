import { escapeHtml } from "../../core/text.js";
import { fmtCST, fmtCSTSec } from "../../core/time.js";
import { link, navHtml, pageShell, progressTone } from "../layout.js";
import { alertBox, badge, button, chip, emptyState, sectionHead } from "../components.js";
import { iconImg } from "../icons.js";
import { isOff } from "../../core/flags.js";
import { NEEDS_ACTION, SETTLED } from "../../core/status.js";

// 开关是个 POST 表单而不是链接：全站状态变更都走 POST，页面里没有一行 JS。
//
// 拨杆是个提交按钮而不是 checkbox：checkbox 点了只会打勾、不会提交表单，
// 零 JS 的页面里它永远发不出请求（第一版就栽在这上面）。按钮把自己画成
// 轨道 + 滑块，「运行中」亮绿、滑块靠右，「已停用」变灰、滑块靠左 ——
// 状态由服务端渲染成 .on class，点一下 = 提交 = 翻转。
// aria-pressed 把当前状态白送给读屏软件，文字再说一遍。
function toggleForm(pwd, tool, off) {
  return `<form method="post" action="${escapeHtml(link(`/tool/${tool.id}/toggle`, pwd))}" class="sw">
    <input type="hidden" name="pwd" value="${escapeHtml(pwd)}">
    <button type="submit" class="sw-b${off ? "" : " on"}" aria-pressed="${off ? "false" : "true"}"><span class="sw-t">${off ? "已停用" : "运行中"}</span></button>
  </form>`;
}

function cardLine(label, value) {
  // kv-row：这些行的值都短（徽章、时间、拨杆），窄屏也不跟着 .kv 竖排，值一律靠右。
  return `<div class="kv kv-row"><span class="k">${escapeHtml(label)}</span><span class="v">${value}</span></div>`;
}

export function renderHome({ pwd, tools, counts, sched = {}, runs = [], flash, flags = {} }) {
  const cards = tools.map((tool) => {
    const entries = sched[tool.id] || {};
    const uids = Object.keys(entries);
    const done = uids.filter((uid) => SETTLED.has(entries[uid].lastStatus)).length;
    const stuck = uids.filter((uid) => NEEDS_ACTION.has(entries[uid].lastStatus));
    const last = runs.find((r) => r.kind === "run" && r.tool === tool.id);
    // 色块语义统一在 ui/layout.js 的 progressTone 里：只有失败才红，
    // pending / partial / waiting / 限频 / 顺延都归"会自己好"的 amber。
    // （这里曾自己写一份列表，把 pending 与 partial 画成了红色。）
    const segments = uids.map((uid) => `<i class="${progressTone(entries[uid].lastStatus)}"></i>`).join("");

    const off = isOff(flags, tool.id);
    const offAt = (flags[tool.id] || {}).at;
    // 停用时**不亮红条**：下线中的工具报错不是用户的待办。
    // 但 stuck 数字照常显示在下面的 kv 里 —— 点进去要看得见停在哪、为什么停。
    const redBar = stuck.length && !off
      ? `<div class="alert bad">${badge("login_required", "")}<span>${stuck.length} 个账号需要处理。<a href="${escapeHtml(link(`/tool/${tool.id}`, pwd))}">去处理 ›</a></span></div>`
      : "";

    return `<div class="card${off ? " dim" : ""}">
      ${redBar}
      <div class="hd">
        <div class="id">${iconImg(tool)}<div><div class="t">${escapeHtml(tool.name)}</div><div class="d">${escapeHtml(tool.summary || "")}</div></div></div>
        ${off ? chip(`已停用 · 关于 ${fmtCST(offAt)}`, true) : ""}
        <a href="${escapeHtml(link(`/tool/${tool.id}`, pwd))}">管理 ›</a>
      </div>
      <div class="bd">
        <div class="prog">${segments}<span class="n">${done}/${uids.length || counts[tool.id] || 0} 今日完成</span></div>
        ${cardLine("最后结果", last ? `${badge(last.meta && last.meta.status)} <span class="dim">${escapeHtml(fmtCST(Math.floor(last.at / 1000)))}</span>` : '<span class="dim">—</span>')}
        ${cardLine("日界", `每天 ${escapeHtml(String(tool.schedule.resetHour))}:00 翻日 · ${escapeHtml(String(tool.schedule.notBeforeHour))}:00 起可执行`)}
        ${uids.length || counts[tool.id] ? "" : cardLine("需要处理", `<a href="${escapeHtml(link(`/tool/${tool.id}`, pwd))}">还没有账号，去添加 ›</a>`)}
        ${stuck.length ? cardLine("需要处理", `${stuck.length} 个账号${off ? "（停用中，恢复后仍要处理）" : ""}`) : ""}
        <div class="kv kv-row"><span class="k">开关</span><span class="v">${toggleForm(pwd, tool, off)}</span></div>
      </div>
    </div>`;
  });

  const feed = runs.slice(0, 12).map((entry) => {
    const m = entry.meta || {};
    const href = link(`/runs/${encodeURIComponent(entry.key)}`, pwd);
    const who = entry.kind === "tick" ? "整轮调度" : `${entry.tool}/${m.label || entry.uid}`;
    return `<a class="flowitem" href="${escapeHtml(href)}">
      <span class="who">${escapeHtml(who)}</span>${badge(m.status || "error")}
      <span class="m">${escapeHtml(m.message || "")}</span>
      <span class="when">${escapeHtml(fmtCSTSec(Math.floor(entry.at / 1000)))}</span></a>`;
  }).join("");

  return pageShell({
    title: "签到台",
    nav: navHtml(pwd, "home", tools),
    body: (flash ? alertBox(flash.kind, escapeHtml(flash.text)) : "")
      + sectionHead("工具", "每轮只处理到期账号，一轮装不下的自动顺延到下一轮")
      + (tools.length === 0 ? emptyState({ title: "还没有接入任何工具", lines: ["注册表是空的。"] }) : `<div class="grid cols3">${cards.join("")}</div>`)
      + sectionHead("最近运行", "", button(link("/runs", pwd), "全部日志 ›"))
      + `<div class="card"><div class="bd">${feed || '<span class="dim">还没有运行记录。</span>'}</div></div>`,
  });
}
