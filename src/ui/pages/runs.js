import { escapeHtml } from "../../core/text.js";
import { fmtCST } from "../../core/time.js";
import { link, navHtml, pageShell } from "../layout.js";
import { badge, button, emptyState, sectionHead } from "../components.js";

// 这一行是谁、什么时候：取自键名（listRunLog 已经解析好），不依赖 KV metadata。
// metadata 只供摘要、积分、预算这些"缺了也只是少点信息"的字段。
function filterBar(pwd, tools, active) {
  const item = (label, value) => `<a class="btn sm${(active.tool || "") === value ? " pri" : ""}" href="${escapeHtml(link("/runs", pwd, value ? { tool: value } : null))}">${escapeHtml(label)}</a>`;
  return `<div class="acts">${item("全部", "")}${tools.map((t) => item(t.name, t.id)).join("")}</div>`;
}

export function renderRuns({ pwd, tools, entries, active = {} }) {
  const rows = entries.map((entry) => {
    const meta = entry.meta || {};
    const href = link(`/runs/${encodeURIComponent(entry.key)}`, pwd);
    const who = entry.kind === "tick"
      ? '<span class="mono dim">整轮调度</span>'
      : `<span class="mono">${escapeHtml(entry.tool)}/${escapeHtml(entry.uid)}</span>`;
    const budget = entry.kind === "tick" && meta.used !== undefined
      ? `<span class="num dim">${meta.used}/${meta.limit}</span>` : "";
    return `<tr>
      <td class="mono dim">${escapeHtml(fmtCST(Math.floor(entry.at / 1000)))}</td>
      <td>${who}</td>
      <td>${badge(meta.status || "error")}</td>
      <td class="dim">${escapeHtml(meta.message || "（无摘要）")}</td>
      <td class="num dim">${escapeHtml(meta.credits ? `+${meta.credits}` : "")}</td>
      <td>${budget}</td>
      <td style="text-align:right"><a class="btn sm" href="${escapeHtml(href)}">详情</a></td>
    </tr>`;
  }).join("");

  const table = entries.length === 0
    ? emptyState({
      title: active.tool ? `还没有 ${active.tool} 的运行记录` : "还没有运行记录",
      lines: active.tool
        ? ["这个工具还没有跑过，或者它的记录已经过了 30 天保留期。"]
        : ["调度每 30 分钟醒一次，跑过的账号会在这里留下痕迹。"],
    })
    : `<div class="tw"><table class="t"><thead><tr>
        <th>时间</th><th>对象</th><th>结果</th><th>摘要</th><th>积分</th><th>子请求</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;

  return pageShell({
    title: "运行日志",
    nav: navHtml(pwd, "runs", tools),
    body: `${sectionHead("运行日志", "保留 30 天；列表只读一次 KV，正文点进详情才读", filterBar(pwd, tools, active))}
      ${table}
      <p class="tiny" style="margin-top:12px">列表的摘要存在 KV 的 metadata 里，所以这一页的成本只与「已注册的工具数」有关，与记录条数无关。凭据与访问口令永不写入日志。</p>`,
  });
}

function stepRow(step) {
  const notes = [];
  if (step.reused) notes.push("复用");
  if (step.over) notes.push(`超支 ${step.over}`);
  if (step.unreachable) notes.push("成本超上限");
  return `<tr>
    <td class="mono dim">${escapeHtml(step.id)}</td>
    <td>${badge(step.status)}</td>
    <td class="dim">${escapeHtml(step.message || "")}</td>
    <td class="num dim">${escapeHtml(notes.join(" · "))}</td>
  </tr>`;
}

export function renderRunDetail({ pwd, tools, entry, key, missing }) {
  if (missing) {
    return pageShell({
      title: "记录不存在",
      nav: navHtml(pwd, "runs", tools),
      body: sectionHead("记录不存在")
        + `<div class="pane"><p class="sub" style="margin:0">这条记录已过期（保留 30 天）或键名不合法。</p>
           <div style="margin-top:14px">${button(link("/runs", pwd), "回到日志列表")}</div></div>`,
    });
  }

  const isTick = entry.kind === "tick";
  const head = isTick
    ? `<b style="font-size:14.5px">整轮调度</b> ${badge(entry.ran > 0 ? "ok" : "skipped", entry.ran > 0 ? `跑了 ${entry.ran} 个账号` : "无账号执行")}
       <span class="sp" style="margin-left:auto"></span><span class="mono dim">${escapeHtml(fmtCST(Math.floor(entry.at / 1000)))} · ${escapeHtml(entry.trigger || "")}</span>`
    : `<b style="font-size:14.5px">${escapeHtml(entry.label || entry.uid)}</b> ${badge(entry.status)}
       <span class="sp" style="margin-left:auto"></span><span class="mono dim">${escapeHtml(entry.tool)}/${escapeHtml(entry.uid)} · ${escapeHtml(fmtCST(Math.floor(entry.at / 1000)))} · ${escapeHtml(entry.trigger || "")}</span>`;

  const steps = isTick
    ? (entry.plan || []).map((p) => `<tr>
        <td class="mono dim">${escapeHtml(p.tool)}</td>
        <td>${p.skipped ? badge("skipped", p.skipped) : badge("ok", `${p.accounts.length} 个账号`)}</td>
        <td class="dim">${escapeHtml((p.accounts || []).map((a) => `${a.uid} ${a.status}`).join("；"))}</td>
        <td></td></tr>`).join("")
    : (entry.steps || []).map(stepRow).join("");

  const b = entry.budget || {};
  const heads = isTick ? ["工具", "处置", "账号结果", ""] : ["步骤", "结果", "说明", "备注"];
  return pageShell({
    title: isTick ? "本轮调度详情" : `${entry.tool} · ${entry.uid}`,
    nav: navHtml(pwd, "runs", tools),
    body: sectionHead(isTick ? "本轮调度" : "账号运行详情", "", button(link("/runs", pwd), "‹ 返回列表"))
      + `<div class="card"><div class="bd" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${head}</div>
        <div class="bd" style="padding-top:0">
          <p class="sub" style="margin:0">${escapeHtml(entry.message || "")}</p>
          ${entry.credits ? `<div class="kv"><span class="k">本次积分</span><span class="v">+${escapeHtml(String(entry.credits))}</span></div>` : ""}
          <div class="kv"><span class="k">子请求</span><span class="v">用 ${escapeHtml(String(b.used ?? "—"))} / 上限 ${escapeHtml(String(b.limit ?? "—"))}${b.over ? ` · <span style="color:var(--bad)">超出 ${escapeHtml(String(b.over))}</span>` : ""}</span></div>
          <div class="kv"><span class="k">键名</span><span class="v dim">${escapeHtml(key)}（时间那段是反转毫秒，所以键序就是时间倒序）</span></div>
        </div></div>
      ${isTick ? "" : sectionHead("步骤", "「复用」表示这一步在之前的轮次已完成，本轮没有再打上游")}
      ${steps ? `<div class="tw"><table class="t"><thead><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${steps}</tbody></table></div>` : ""}`,
  });
}
