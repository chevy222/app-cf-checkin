import { escapeHtml } from "../../core/text.js";
import { fmtCST } from "../../core/time.js";
import { link, navHtml, pageShell } from "../layout.js";
import { alertBox, badge, button, emptyState, sectionHead } from "../components.js";

const SETTLED = new Set(["claimed", "already", "inactive", "ok"]);

function cardLine(label, value) {
  return `<div class="kv"><span class="k">${escapeHtml(label)}</span><span class="v">${value}</span></div>`;
}

export function renderHome({ pwd, tools, counts, sched = {}, runs = [], flash, budget }) {
  const cards = tools.map((tool) => {
    const entries = sched[tool.id] || {};
    const uids = Object.keys(entries);
    const done = uids.filter((uid) => SETTLED.has(entries[uid].lastStatus)).length;
    const stuck = uids.filter((uid) => ["login_required", "error"].includes(entries[uid].lastStatus));
    const last = runs.find((r) => r.kind === "run" && r.tool === tool.id);
    const total = tool.steps.reduce((sum, s) => sum + s.cost, 0);
    const segments = uids.map((uid) => {
      const s = entries[uid].lastStatus;
      const cls = SETTLED.has(s) ? "done" : s === "rate_limited" || s === "deferred" ? "wait" : s ? "bad" : "";
      return `<i class="${cls}"></i>`;
    }).join("");

    return `<div class="card">
      ${stuck.length ? `<div class="alert bad">${badge("login_required", "")}<span>${stuck.length} 个账号需要处理。<a href="${escapeHtml(link(`/tool/${tool.id}`, pwd))}">去处理 ›</a></span></div>` : ""}
      <div class="hd">
        <div><div class="t">${escapeHtml(tool.name)}</div><div class="d">${escapeHtml(tool.summary || "")}</div></div>
        <a href="${escapeHtml(link(`/tool/${tool.id}`, pwd))}">管理 ›</a>
      </div>
      <div class="bd">
        <div class="prog">${segments}<span class="n">${done}/${uids.length || counts[tool.id] || 0} 今日完成</span></div>
        ${cardLine("最后结果", last ? `${badge(last.meta && last.meta.status)} <span class="dim">${escapeHtml(fmtCST(Math.floor(last.at / 1000)))}</span>` : '<span class="dim">—</span>')}
        ${cardLine("单账号约需", `${total} 子请求 · 日界 ${escapeHtml(String(tool.schedule.resetHour))}:00 / ${escapeHtml(String(tool.schedule.notBeforeHour))}:00 后执行`)}
        ${cardLine("下一次预计执行", '<span class="dim">每 30 分钟醒一次，到期就跑</span>')}
      </div>
    </div>`;
  });

  const feed = runs.slice(0, 12).map((entry) => {
    const m = entry.meta || {};
    const href = link(`/runs/${encodeURIComponent(entry.key)}`, pwd);
    const who = entry.kind === "tick" ? "整轮调度" : `${entry.tool}/${entry.uid}`;
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
      ${budget ? `<p class="tiny" style="margin-top:12px">本次页面读取用了 ${budget.used} / ${budget.limit} 子请求。</p>` : ""}`,
  });
}
