import { escapeHtml } from "../../core/text.js";
import { fmtCST } from "../../core/time.js";
import { CLEAR_BUDGET } from "../../core/logs.js";
import { link, navHtml, pageShell } from "../layout.js";
import { alertBox, badge, button, emptyState, sectionHead } from "../components.js";

// 这一行是谁、什么时候：uid 取自键名（listRunLog 已经解析好）；备注名取自 metadata，
// 是**记录那一刻**的快照 —— 之后改过名，旧日志仍显示旧名，这是日志语义的一部分。
// metadata 只供摘要、积分、预算这些"缺了也只是少点信息"的字段。
function filterBar(pwd, tools, active) {
  const item = (label, value) => `<a class="btn sm${(active.tool || "") === value ? " pri" : ""}" href="${escapeHtml(link("/runs", pwd, value ? { tool: value } : null))}">${escapeHtml(label)}</a>`;
  return `<div class="acts">${item("全部", "")}${tools.map((t) => item(t.name, t.id)).join("")}</div>`;
}

// 删除是 POST（GET 不该改变世界），所以这里内联一个表单而不是用 button()。
// 只在筛选到具体工具时出现：「全部」页上没有"一个工具"可清，做成清空全库
// 就是一个会误伤所有记录的操作，不该由筛选栏上的一个按钮提供。
function clearForm(pwd, toolId) {
  if (!toolId) return "";
  return `<form method="post" action="${escapeHtml(link(`/runs/${encodeURIComponent(toolId)}/clear`, pwd))}">
    <button class="btn sm danger" type="submit">清空日志</button>
  </form>`;
}

export function renderRuns({ pwd, tools, entries, active = {}, flash }) {
  const rows = entries.map((entry) => {
    const meta = entry.meta || {};
    const href = link(`/runs/${encodeURIComponent(entry.key)}`, pwd);
    const who = entry.kind === "tick"
      ? '<span class="mono dim">整轮调度</span>'
      : `<span>${escapeHtml(entry.tool)}/${escapeHtml(meta.label || entry.uid)}</span>`;
    // 「请求」列：直接读 metadata 里的账号级读数 —— 这一条记录自己花了多少
    // 外部请求 + 多少次 KV（两者各走各的额度，所以并排列出）。
    const usage = meta.http !== undefined || meta.kv !== undefined
      ? `<span class="num dim" title="外部请求 / KV 操作">${meta.http || 0} / ${meta.kv || 0}</span>`
      : "";
    // data-label 供窄屏卡片式排版用（见 layout.js 的 @media）：窄屏下 thead 隐藏，
    // 字段名由 CSS 从 data-label 生成，宽屏上这个属性没有任何副作用。
    return `<tr>
      <td class="mono dim" data-label="时间">${escapeHtml(fmtCST(Math.floor(entry.at / 1000)))}</td>
      <td data-label="对象">${who}</td>
      <td data-label="结果">${badge(meta.status || "error")}</td>
      <td class="dim" data-label="摘要">${escapeHtml(meta.message || "（无摘要）")}</td>
      <td class="num dim" data-label="积分">${escapeHtml(meta.credits ? `+${meta.credits}` : "")}</td>
      <td data-label="请求">${usage}</td>
      <td class="r" data-label=""><a class="btn sm" href="${escapeHtml(href)}">详情</a></td>
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
        <th>时间</th><th>对象</th><th>结果</th><th>摘要</th><th>积分</th><th>请求</th><th class="r"></th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;

  return pageShell({
    title: "运行日志",
    nav: navHtml(pwd, "runs", tools),
    body: `${flash ? alertBox(flash.kind, escapeHtml(flash.text)) : ""}
      ${sectionHead("运行日志", "",
        `<div class="acts">${clearForm(pwd, active.tool)}${filterBar(pwd, tools, active)}</div>`)}
      ${table}`,
  });
}

// 清空确认页。破坏性操作值得一个专门的页面：按钮旁边就是筛选栏，
// 点错了「清空」和点错了「Qoder」在同一个屏幕上，而后者只是换个筛选。
export function renderRunsClearConfirm({ pwd, tools, tool, count }) {
  const action = link(`/runs/${encodeURIComponent(tool.id)}/clear`, pwd);
  return pageShell({
    title: "清空运行日志",
    nav: navHtml(pwd, "runs", tools),
    body: sectionHead(`清空 ${tool.name} 的运行日志`, "", button(link("/runs", pwd, { tool: tool.id }), "‹ 返回列表"))
      + alertBox("warn", `将删除 <b>${escapeHtml(tool.name)}</b> 名下全部运行日志${count ? `（当前一页能看到 ${count} 条）` : ""}。`
        + `<br>只删这一个工具的记录，另外两个工具的日志、账号、凭据、当天进度全部不动。删掉之后不能恢复。`)
      + `<div class="pane mt"><p class="sub mb">`
      + `一次最多删 ${CLEAR_BUDGET} 条左右；条数更多时分几次点就行，每次删完会告诉你还剩多少。</p>`
      + `<div class="acts"><form method="post" action="${escapeHtml(action)}">`
      + `<button class="btn danger" type="submit">确认清空</button></form>`
      + `${button(link("/runs", pwd, { tool: tool.id }), "取消")}</div></div>`,
  });
}

function stepRow(step) {
  const notes = [];
  if (step.reused) notes.push("复用");
  if (step.over) notes.push(`超支 ${step.over}`);
  if (step.unreachable) notes.push("成本超上限");
  return `<tr>
    <td class="mono dim" data-label="步骤">${escapeHtml(step.id)}</td>
    <td data-label="结果">${badge(step.status)}</td>
    <td class="dim" data-label="说明">${escapeHtml(step.message || "")}</td>
    <td class="num dim" data-label="备注">${escapeHtml(notes.join(" · "))}</td>
  </tr>`;
}

export function renderRunDetail({ pwd, tools, entry, key, missing }) {
  if (missing) {
    return pageShell({
      title: "记录不存在",
      nav: navHtml(pwd, "runs", tools),
      body: sectionHead("记录不存在")
        + `<div class="pane"><p class="sub m0">这条记录已过期（保留 30 天）或键名不合法。</p>
           <div class="mt">${button(link("/runs", pwd), "回到日志列表")}</div></div>`,
    });
  }

  const isTick = entry.kind === "tick";
  const head = isTick
    ? `<b class="cap">整轮调度</b> ${badge(entry.ran > 0 ? "ok" : "skipped", entry.ran > 0 ? `跑了 ${entry.ran} 个账号` : "无账号执行")}
       <span class="spacer"></span><span class="mono dim">${escapeHtml(fmtCST(Math.floor(entry.at / 1000)))} · ${escapeHtml(entry.trigger || "")}</span>`
    : `<b class="cap">${escapeHtml(entry.label || entry.uid)}</b> ${badge(entry.status)}
       <span class="spacer"></span><span class="mono dim">${escapeHtml(entry.tool)}/${escapeHtml(entry.uid)} · ${escapeHtml(fmtCST(Math.floor(entry.at / 1000)))} · ${escapeHtml(entry.trigger || "")}</span>`;

  const steps = isTick
    ? (entry.plan || []).map((p) => `<tr>
        <td class="mono dim" data-label="工具">${escapeHtml(p.tool)}</td>
        <td data-label="处置">${p.skipped ? badge("skipped", p.skipped) : badge("ok", `${p.accounts.length} 个账号`)}</td>
        <td class="dim" data-label="账号结果">${escapeHtml((p.accounts || []).map((a) => `${a.label || a.uid} ${a.status}`).join("；"))}</td>
        <td data-label=""></td></tr>`).join("")
    : (entry.steps || []).map(stepRow).join("");

  const b = entry.budget || {};
  const u = entry.usage || {};
  const heads = isTick ? ["工具", "处置", "账号结果", ""] : ["步骤", "结果", "说明", "备注"];
  return pageShell({
    title: isTick ? "本轮调度详情" : `${entry.tool} · ${entry.label || entry.uid}`,
    nav: navHtml(pwd, "runs", tools),
    body: sectionHead(isTick ? "本轮调度" : "账号运行详情", "", button(link("/runs", pwd), "‹ 返回列表"))
      + `<div class="card"><div class="bd row">${head}</div>
        <div class="bd flush">
          <p class="sub m0">${escapeHtml(entry.message || "")}</p>
          ${entry.credits ? `<div class="kv"><span class="k">本次积分</span><span class="v">+${escapeHtml(String(entry.credits))}</span></div>` : ""}
          <div class="kv"><span class="k">本账号外部请求</span><span class="v">${escapeHtml(String(u.http ?? "—"))} / 上限 ${escapeHtml(String(b.limit ?? "—"))}${b.over ? ` · <span class="over">超出 ${escapeHtml(String(b.over))}</span>` : ""}</span></div>
          <div class="kv"><span class="k">本次调用 KV</span><span class="v">${escapeHtml(String(b.kv ?? "—"))} 次（KV 另有 1000 次额度，不占上面那个 50）</span></div>
          <div class="kv"><span class="k">键名</span><span class="v dim">${escapeHtml(key)}（时间那段是反转毫秒，所以键序就是时间倒序）</span></div>
        </div></div>
      ${isTick ? "" : sectionHead("步骤", "「复用」表示这一步在之前的轮次已完成，本轮没有再打上游")}
      ${steps ? `<div class="tw"><table class="t"><thead><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${steps}</tbody></table></div>` : ""}`,
  });
}
