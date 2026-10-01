import { escapeHtml } from "../../core/text.js";
import { fmtCST } from "../../core/time.js";
import { isOff } from "../../core/flags.js";
import { TOOLS } from "../../tools/index.js";
import { link, navHtml, pageShell } from "../layout.js";
import { alertBox, badge, button, emptyState, sectionHead } from "../components.js";
import { iconImg } from "../icons.js";
import { renderTutorial } from "../tutorials.js";
import { renderForm } from "../forms.js";

function nonSecretSummary(tool, account) {
  if (account.broken) return "记录内容解析不出来，删掉它再重新添加";
  const parts = (tool.creds || [])
    .filter((field) => !field.secret)
    .map((field) => {
      const value = account.cred[field.key];
      // 派生的时间字段要按北京时间显示：给用户一串 epoch 秒等于没给信息
      const shown = field.type === "datetime"
        ? (Number(value) ? fmtCST(Number(value)) : "—")
        : (value || "—");
      return `${field.label} ${escapeHtml(shown)}`;
    });
  return parts.length ? parts.join(" · ") : "—";
}

function deleteForm(pwd, action) {
  return `<form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="pwd" value="${escapeHtml(pwd)}">
    <button class="btn sm danger" type="submit">删除</button>
  </form>`;
}

// 单账号动作走 POST：GET 不该改变世界。结果直接渲染回本页，不重定向 ——
// 重定向要么丢掉"这次跑出了什么"，要么把结果塞进 URL 查询串。
// 表单不需要 display:inline：它们都放在 .acts（flex）里，块级表单照样并排。
function actionForm(pwd, action, label, style) {
  return `<form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="pwd" value="${escapeHtml(pwd)}">
    <button class="btn sm${style ? ` ${style}` : ""}" type="submit">${escapeHtml(label)}</button>
  </form>`;
}

// 步骤色块：状态取自调度索引里的 lastSteps，渲染色块不需要再读日志
function stepChips(tool, entry) {
  const codes = (entry && entry.lastSteps) || [];
  if (codes.length === 0) return '<span class="dim">—</span>';
  const chips = codes.map((code) => {
    const [id, status, flag] = String(code).split(":");
    const cls = ["claimed", "already", "ok", "inactive"].includes(status) ? "ok"
      : status === "deferred" ? "wait"
        : status === "skipped" ? "skip" : "bad";
    const label = (tool.steps.find((s) => s.id === id) || {}).label || id;
    return `<i class="${cls}" title="${escapeHtml(`${label}：${status}${flag === "r" ? "（本轮复用，未再打上游）" : ""}`)}"></i>`;
  });
  const done = codes.filter((c) => ["claimed", "already", "ok", "inactive"].includes(String(c).split(":")[1])).length;
  return `<span class="steps">${chips.join("")}</span><div class="note"><b>${done}/${codes.length}</b> 步已完成</div>`;
}

export function renderTool({ pwd, tool, accounts, total, sched = {}, flash, flags = {} }) {
  const addHref = link(`/account/new?tool=${tool.id}`, pwd);
  const configHref = link(`/tool/${tool.id}/settings`, pwd);
  const off = isOff(flags, tool.id);
  // 红条只统计"自动重试治不好"的那几类：损坏的记录要删掉重建，凭据过期的要重新录入。
  // rate_limited / deferred / partial 会自己按退避阶梯恢复，把它们算进来红条就天天亮且无事可做。
  // 停用时红条不亮 —— 下线中的工具报错不是用户的待办；但底部的说明里仍然如实写明有几个。
  const stuckAll = accounts.filter((a) => a.broken || ["login_required", "error"].includes((sched[a.uid] || {}).lastStatus));
  const needsAttention = off ? [] : stuckAll;

  const rows = accounts.map((account) => {
    const entry = sched[account.uid] || {};
    const base = `/account/${tool.id}/${encodeURIComponent(account.uid)}`;
    // 停用时隐藏「执行」，保留「测试」「编辑」「删除」。用户明确决定：执行是打上游的动作，
    // 测试只是看状态。服务端 runAccountNow 也会自己再判一次 —— 隐藏按钮不等于权限。
    return `<tr>
    <td data-label="账号"><div class="acc"><span class="nm">${escapeHtml(account.label || "（未命名）")}</span></div></td>
    <td data-label="结果">${account.broken ? badge("error", "记录损坏") : badge(entry.lastStatus || "skipped", entry.lastStatus ? undefined : "尚未运行")}</td>
    <td data-label="步骤">${stepChips(tool, entry)}</td>
    <td data-label="字段">${nonSecretSummary(tool, account)}</td>
    <td class="mono dim" data-label="更新">${escapeHtml(fmtCST(account.updatedAt))}</td>
    <td data-label=""><div class="acts">
      ${account.broken || off ? "" : actionForm(pwd, `${base}/run`, "执行", "pri")}
      ${account.broken || typeof tool.validate !== "function" ? "" : actionForm(pwd, `${base}/validate`, "测试")}
      ${account.broken ? "" : button(link(`${base}/edit`, pwd), "编辑", "", true)}
      ${deleteForm(pwd, link(`${base}/delete`, pwd))}
    </div></td>
  </tr>`;
  }).join("");

  const table = accounts.length === 0
    ? emptyState({
      title: "还没有账号",
      lines: ["点下面的「新增账号」加第一个。表单是按这个工具的字段声明自动生成的。"],
      actions: [button(addHref, "新增账号", "pri")],
    })
    : `<div class="tw"><table class="t"><thead><tr>
        <th>账号</th><th>最近结果</th><th>步骤</th><th>字段</th><th>最后更新</th><th class="r">操作</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;

  const hidden = Math.max(0, (total ?? accounts.length) - accounts.length);

  return pageShell({
    title: tool.name,
    nav: navHtml(pwd, `tool:${tool.id}`, TOOLS),
    body: `${flash ? alertBox(flash.kind, escapeHtml(flash.text)) : ""}
      ${off ? alertBox("warn", `<b>${escapeHtml(tool.name)} 已停用。</b>不参与调度（cron 与手动执行都跳过），账号、凭据与当天进度全部原样保留；重新打开后从停下的那一步接着做。${stuckAll.length ? `当前有 ${stuckAll.length} 个账号处于失败或需重新登录状态，恢复后仍要处理。` : ""}`) : ""}
      ${needsAttention.length ? `<div class="card">${alertBox("bad", `<b>${needsAttention.length} 个账号需要你处理：</b>${escapeHtml(needsAttention.map((a) => a.label || a.uid).join("、"))} —— 自动重试治不好这一类，要么重新录入凭据，要么删掉重建。`)}</div>` : ""}
      <div class="card"><div class="hd"><div class="id">${iconImg(tool, 26)}<div><div class="t">${escapeHtml(tool.name)}</div><div class="d">${escapeHtml(tool.summary || "")}</div></div></div>
        <div class="acts">${button(addHref, "+ 新增账号", "pri")}${button(configHref, "工具配置")}</div></div>
        <div class="bd flush"><p class="tiny m0">字段来自该工具的声明，界面不认具体工具。改动下一轮起生效。</p></div>
      </div>
      ${table}
      ${hidden > 0 ? `<div class="mt">${alertBox("warn", `共 ${total} 个账号，这里只列出前 ${accounts.length} 个。这一页要逐个读记录才能显示字段值，而 KV 的写/删/list 每天只有 1000 次，所以列表是有上界的；要管更多请先把账号删到有意义的规模。`)}</div>` : ""}
      <p class="tiny mt">「执行」跳过到期判定的时间闸，立刻跑这一个账号（预算、并发锁、进度复用照旧，工具配置没填或工具已停用时会被拒绝）。
        注意它真的会再打一次上游：今天已经领过的账号被点「执行」，上游会收到第二次领取请求。步骤色块悬停可看每一步的处置。</p>`,
  });
}

export function renderAccountForm({ pwd, tool, fields, values, existing, errors, uid, title, flash }) {
  const cancelHref = link(`/tool/${tool.id}`, pwd);
  const action = link(uid ? `/account/${tool.id}/${encodeURIComponent(uid)}/edit` : `/account/${tool.id}/new`, pwd);
  // 这句话必须从工具的声明里生成，不能写死任何具体工具的字段名 ——
  // 界面写死具体工具的东西，就是"加工具不改内核"这条承诺的反例。
  const uidSourceLabel = "保存时从凭据里自动解出，不用另外填";
  const uidRow = uid
    ? `<div class="kv"><span class="k">uid</span><span class="v">${escapeHtml(uid)}</span></div>`
    : `<div class="kv"><span class="k">uid</span><span class="v dim">${escapeHtml(uidSourceLabel)}</span></div>`;

  return pageShell({
    title,
    nav: navHtml(pwd, `tool:${tool.id}`, TOOLS),
    body: `${flash ? alertBox(flash.kind, escapeHtml(flash.text)) : ""}
      ${sectionHead(title, `字段来自 ${escapeHtml(tool.name)} 的声明，界面不认具体工具`)}
      ${renderTutorial(tool)}
      <div class="split">
        <div class="pane">
          ${uidRow}
          <div class="kv"><span class="k">敏感字段</span><span class="v">${fields.filter((f) => f.secret).length} 个</span></div>
          <div class="kv"><span class="k">需线下取值</span><span class="v">${fields.filter((f) => f.offline).length} 个</span></div>
          <p class="tiny mt">敏感字段保存后整串隐藏（12 位以内全隐，更长只露前后 4 位）；编辑时留空表示保持原值，非敏感的可选字段留空则是清空。凭据永不写进日志。</p>
        </div>
        <div class="pane">
          ${renderForm(fields, { values, existing, errors, action, cancelHref, pwd, submitLabel: "保存" })}
        </div>
      </div>`,
  });
}

export function renderToolConfig({ pwd, tool, values, errors, flash }) {
  const filled = tool.config.filter((field) => {
    const v = values[field.key];
    return v !== undefined && v !== "";
  }).length;

  return pageShell({
    title: `${tool.name} · 工具配置`,
    nav: navHtml(pwd, `tool:${tool.id}`, TOOLS),
    body: `${flash ? alertBox(flash.kind, escapeHtml(flash.text)) : ""}
      ${sectionHead(`${tool.name} · 工具配置`, "原先挤在 Cloudflare 变量里的值，现在都存 KV、界面可改")}
      ${filled < tool.config.length
        ? alertBox("warn", `工具配置未完成：已填 ${filled} / ${tool.config.length} 项。缺项时这个工具会被调度器跳过。`)
        : ""}
      ${renderTutorial(tool)}
      <div class="split">
        <div class="pane">
          <p class="sub mb">这一层是<b>工具级</b>的，对该工具下所有账号生效；账号级凭据在「管理」页逐个填。</p>
          <p class="tiny">改动下一轮生效。</p>
        </div>
        <div class="pane">
          ${renderForm(tool.config, { values, existing: values, errors, action: link(`/tool/${tool.id}/settings`, pwd), cancelHref: link(`/tool/${tool.id}`, pwd), pwd, submitLabel: "保存配置" })}
        </div>
      </div>`,
  });
}
