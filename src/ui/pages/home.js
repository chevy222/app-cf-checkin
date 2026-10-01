import { escapeHtml } from "../../core/text.js";
import { fmtCST } from "../../core/time.js";
import { link, navHtml, pageShell } from "../layout.js";
import { alertBox, badge, button, chip, emptyState, sectionHead } from "../components.js";
import { iconImg } from "../icons.js";
import { isOff } from "../../core/flags.js";

const SETTLED = new Set(["claimed", "already", "inactive", "ok"]);

// 开关是个 POST 表单而不是链接：全站状态变更都走 POST，页面里没有一行 JS。
//
// 用 checkbox + label 做一个拨动开关，而不是按钮：窄屏下 .kv 会变成竖排
// （见 layout.js 的 @media），按钮跟着标签上下堆叠，看起来像两件不相干的东西。
// checkbox 的原生状态还能白送"当前是开是关"给读屏软件，label 上写清动作名。
// 输入框本身要藏起来但**不能 display:none** —— 那样 label 点不到它，表单也不会提交。
function toggleForm(pwd, tool, off) {
  return `<form method="post" action="${escapeHtml(link(`/tool/${tool.id}/toggle`, pwd))}" class="sw">
    <input type="hidden" name="pwd" value="${escapeHtml(pwd)}">
    <input type="checkbox" id="sw-${escapeHtml(tool.id)}" name="off" value="1"${off ? " checked" : ""}>
    <label for="sw-${escapeHtml(tool.id)}"><span class="sw-t">${off ? "已停用" : "运行中"}</span></label>
  </form>`;
}

function cardLine(label, value) {
  return `<div class="kv"><span class="k">${escapeHtml(label)}</span><span class="v">${value}</span></div>`;
}

export function renderHome({ pwd, tools, counts, sched = {}, runs = [], flash, budget, flags = {} }) {
  const cards = tools.map((tool) => {
    const entries = sched[tool.id] || {};
    const uids = Object.keys(entries);
    const done = uids.filter((uid) => SETTLED.has(entries[uid].lastStatus)).length;
    const stuck = uids.filter((uid) => ["login_required", "error"].includes(entries[uid].lastStatus));
    const last = runs.find((r) => r.kind === "run" && r.tool === tool.id);
    const segments = uids.map((uid) => {
      const s = entries[uid].lastStatus;
      const cls = SETTLED.has(s) ? "done" : s === "rate_limited" || s === "deferred" ? "wait" : s ? "bad" : "";
      return `<i class="${cls}"></i>`;
    }).join("");

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
        ${stuck.length ? cardLine("需要处理", `<span class="v">${stuck.length} 个账号${off ? "（停用中，恢复后仍要处理）" : ""}</span>`) : ""}
        <div class="kv"><span class="k">开关</span><span class="v">${toggleForm(pwd, tool, off)}</span></div>
      </div>
    </div>`;
  });

  const feed = runs.slice(0, 12).map((entry) => {
    const m = entry.meta || {};
    const href = link(`/runs/${encodeURIComponent(entry.key)}`, pwd);
    const who = entry.kind === "tick" ? "整轮调度" : `${entry.tool}/${m.label || entry.uid}`;
    return `<a class="flowitem" href="${escapeHtml(href)}" style="text-decoration:none;color:inherit">
      <span class="who">${escapeHtml(who)}</span>${badge(m.status || "error")}
      <span class="m">${escapeHtml(m.message || "")}</span>
      <span class="when">${escapeHtml(fmtCST(Math.floor(entry.at / 1000)))}</span></a>`;
  }).join("");

  return pageShell({
    title: "签到台",
    nav: navHtml(pwd, "home", tools),
    body: (flash ? alertBox(flash.kind, escapeHtml(flash.text)) : "")
      + sectionHead("工具", "每轮只处理到期账号，一轮装不下的自动顺延到下一轮")
      + (tools.length === 0 ? emptyState({ title: "还没有接入任何工具", lines: ["注册表是空的。"] }) : `<div class="grid cols3">${cards.join("")}</div>`)
      + sectionHead("最近运行", "", button(link("/runs", pwd), "全部日志 ›"))
      + `<div class="card"><div class="bd">${feed || '<span class="dim">还没有运行记录。</span>'}</div></div>
      ${budget ? `<p class="tiny" style="margin-top:12px">本次页面读取：外部请求 ${budget.used} / ${budget.limit}（KV 操作另计 ${budget.kv} 次，走 KV 自己那份额度）。</p>` : ""}`,
  });
}
