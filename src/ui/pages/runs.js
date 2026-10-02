import { escapeHtml } from "../../core/text.js";
import { fmtCST, fmtCSTSec } from "../../core/time.js";
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
    // 「请求」列：这一条记录自己花了多少外部请求。取自 metadata 里的账号级读数
    // （不是整轮累计 —— 那样越到后面的账号数字越离谱）。
    const usage = meta.http !== undefined
      ? `<span class="num dim" title="本条记录的外部请求数">${meta.http || 0}</span>`
      : "";
    // data-label 供窄屏卡片式排版用（见 layout.js 的 @media）：窄屏下 thead 隐藏，
    // 字段名由 CSS 从 data-label 生成，宽屏上这个属性没有任何副作用。
    return `<tr>
      <td class="mono dim" data-label="时间">${escapeHtml(fmtCSTSec(Math.floor(entry.at / 1000)))}</td>
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

function stepRow(step, key, pwd) {
  const notes = [];
  if (step.reused) notes.push("复用");
  if (step.over) notes.push(`超支 ${step.over}`);
  if (step.unreachable) notes.push("成本超上限");
  // 请求记录的入口。数字来自步骤记录里的 `calls`（跟正文一起写、不用为它多读一个键）。
  // 0 请求也要报出来：「这一步没打上游」与「打了但没记录」是两个不同的结论。
  const traceLink = step.calls === undefined ? "" : `<a class="mono" href="${link(`/runs/${encodeURIComponent(key)}/trace`, pwd)}#trace-${encodeURIComponent(step.id)}">看请求 (${step.calls})</a>`;
  const noteText = notes.join(" · ");
  return `<tr>
    <td class="mono dim" data-label="步骤">${escapeHtml(step.id)}</td>
    <td data-label="结果">${badge(step.status)}</td>
    <td class="dim" data-label="说明">${escapeHtml(step.message || "")}</td>
    <td class="num dim" data-label="备注">${escapeHtml(noteText)}${noteText && traceLink ? " · " : ""}${traceLink}</td>
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
       <span class="spacer"></span><span class="mono dim">${escapeHtml(fmtCSTSec(Math.floor(entry.at / 1000)))} · ${escapeHtml(entry.trigger || "")}</span>`
    : `<b class="cap">${escapeHtml(entry.label || entry.uid)}</b> ${badge(entry.status)}
       <span class="spacer"></span><span class="mono dim">${escapeHtml(entry.tool)}/${escapeHtml(entry.uid)} · ${escapeHtml(fmtCSTSec(Math.floor(entry.at / 1000)))} · ${escapeHtml(entry.trigger || "")}</span>`;

  const steps = isTick
    ? (entry.plan || []).map((p) => `<tr>
        <td class="mono dim" data-label="工具">${escapeHtml(p.tool)}</td>
        <td data-label="处置">${p.skipped ? badge("skipped", p.skipped) : badge("ok", `${p.accounts.length} 个账号`)}</td>
        <td class="dim" data-label="账号结果">${escapeHtml((p.accounts || []).map((a) => `${a.label || a.uid} ${a.status}`).join("；"))}</td>
        <td data-label=""></td></tr>`).join("")
    : (entry.steps || []).map((s) => stepRow(s, key, pwd)).join("");

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
          <div class="kv"><span class="k">键名</span><span class="v dim">${escapeHtml(key)}（时间那段是反转毫秒，所以键序就是时间倒序）</span></div>
        </div></div>
      ${isTick ? "" : sectionHead("步骤", "「复用」表示这一步在之前的轮次已完成，本轮没有再打上游")}
      ${steps ? `<div class="tw"><table class="t"><thead><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${steps}</tbody></table></div>` : ""}`,
  });
}

// ── 请求记录页 ─────────────────────────────────────────────
// 每一步的上游交互，请求体与响应体**原样**展示。零 JavaScript：
// 展开/收起用原生的 <details>，「原样 / 格式化」两个视图都是服务端渲染好的
// （格式化不落库，只花渲染时的 CPU；原样永远是权威 —— 它才能区分"字段是空的"与"被裁了"）。

const JSON_DISPLAY_MAX = 200 * 1024;

function isJsonText(text) {
  if (typeof text !== "string" || !/^\s*[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// 原样 +（能解析时的）格式化。超长的只给"原样"——把一份 200KB 的 JSON 再美化一遍没有意义。
function bodyBlocks(label, text, noBodyNote) {
  if (text === undefined || text === null) {
    return `<details class="dt"><summary>${escapeHtml(label)}</summary><pre class="mono">${escapeHtml(noBodyNote || "（这个请求没有请求体）")}</pre></details>`;
  }
  const raw = `<details class="dt" open><summary>${escapeHtml(label)}（原样）</summary><pre class="mono">${escapeHtml(text)}</pre></details>`;
  const pretty = isJsonText(text) && text.length <= JSON_DISPLAY_MAX
    ? `<details><summary>${escapeHtml(label)}（格式化）</summary><pre class="mono">${escapeHtml(prettyJson(text))}</pre></details>`
    : "";
  return raw + pretty;
}

export function renderTrace({ pwd, tools, key, trace, missing }) {
  const back = button(link(`/runs/${encodeURIComponent(key)}`, pwd), "‹ 返回运行详情");
  if (missing || !trace || !Array.isArray(trace.steps)) {
    return pageShell({
      title: "请求记录",
      nav: navHtml(pwd, "runs", tools),
      body: sectionHead("请求记录", "", back)
        + emptyState({
          title: "这次运行没有请求记录",
          lines: [
            "可能原因：功能上线之前的旧运行、记录已过保留期（30 天）、或键名不合法。",
            "运行日志本身在不在，点上面的「返回运行详情」就能确认。",
          ],
        }),
    });
  }

  const dropped = trace.dropped || 0;
  const banner = dropped
    ? alertBox("warn", `本轮超出记录上限，<b>${dropped}</b> 次交互没有记下来 —— 下面的记录看起来是完整的，但它不是。`)
    : "";
  const head = `<b class="cap">${escapeHtml(trace.toolName || trace.tool)}</b>
    <span class="spacer"></span><span class="mono dim">${escapeHtml(trace.uid || "")} · ${escapeHtml(fmtCSTSec(Math.floor(trace.at / 1000)))} · ${escapeHtml(trace.trigger || "")}</span>`;

  const steps = trace.steps.map((step) => {
    const calls = step.calls || [];
    const anchor = `<a id="trace-${escapeHtml(step.id)}"></a>`;
    const items = calls.length
      ? calls.map((call) => `<div class="card">
          <div class="bd row"><b class="mono">${escapeHtml(String(call.n))}. ${escapeHtml(call.method)} ${escapeHtml(call.url)}</b>
          <span class="spacer"></span><span class="mono dim">→ ${escapeHtml(String(call.status))} · ${escapeHtml(String(call.ms))}ms</span></div>
          <div class="bd flush">
            ${call.reqTruncated ? alertBox("warn", `请求体已截断：只保留 ${escapeHtml(String(call.reqTruncated.kept))} 字符（原文 ${escapeHtml(String(call.reqTruncated.total))} 字符）。`) : ""}
            ${call.resTruncated ? alertBox("warn", `响应体已截断：只保留 ${escapeHtml(String(call.resTruncated.kept))} 字符（原文 ${escapeHtml(String(call.resTruncated.total))} 字符）。`) : ""}
            ${call.bodyError ? alertBox("warn", `响应体读取失败：${escapeHtml(call.bodyError)}。`) : ""}
            ${bodyBlocks("请求头（敏感值已掩掉）", JSON.stringify(call.reqHeaders ?? {}), "")}
            ${bodyBlocks("请求体", call.reqBody, "（这个请求没有请求体 —— 与前端一致）")}
            ${bodyBlocks("响应体", call.resBody, "（响应体是空的）")}
          </div></div>`).join("")
      : `<div class="card"><div class="bd"><p class="sub m0">无请求 —— ${step.reused
          ? "这一步在前面的轮次已完成，本轮复用了结果"
          : step.status === "deferred" ? "本轮预算装不下，整步顺延了，根本没打上游"
            : step.status === "skipped" ? "前置步骤未通过，没有发起请求" : "这一步本轮没有打上游"}。</p></div></div>`;
    return sectionHead(`步骤 ${escapeHtml(step.id)}`, "", badge(step.status)) + anchor + items;
  }).join("");

  return pageShell({
    title: `请求记录 · ${trace.toolName || trace.tool}`,
    nav: navHtml(pwd, "runs", tools),
    body: sectionHead("请求记录",
      "请求体与响应体都是原样文本；凭据值已替换成 ***，响应头不记（set-cookie 是会话凭据）", back)
      + `${banner}<div class="card"><div class="bd row">${head}</div></div>${steps}`,
  });
}
