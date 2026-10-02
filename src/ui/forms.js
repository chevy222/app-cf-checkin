import { escapeHtml, maskSecret } from "../core/text.js";
import { fmtCST } from "../core/time.js";
import { chip } from "./components.js";

function control(field, { value, masked, id }) {
  const common = `id="${id}" name="${escapeHtml(field.key)}"${field.required ? ' data-required="1"' : ""}`;
  // 只读字段：由工具算出来（uid、昵称）或由续期写回（令牌到期时间），
  // 表单不收它 —— 收进来就等于让用户能伪报一个内核事实
  if (field.readonly) {
    const shown = field.type === "datetime" && value ? fmtCST(Number(value)) : (value === undefined || value === "" ? "（尚未取得）" : String(value));
    return `<div class="kv"><span class="v mono pre">${escapeHtml(shown)}</span></div>`;
  }
  const placeholder = field.secret
    ? `placeholder="${escapeHtml(masked ? `未改动 · 当前 ${maskSecret(masked)}` : "未设置")}"`
    : `placeholder="${escapeHtml(field.placeholder || "")}"`;

  if (field.type === "select") {
    const opts = (field.options || []).map((opt) => {
      const v = String(typeof opt === "object" ? opt.value : opt);
      const l = String(typeof opt === "object" ? opt.label : opt);
      return `<option value="${escapeHtml(v)}"${v === String(value ?? field.default ?? "") ? " selected" : ""}>${escapeHtml(l)}</option>`;
    });
    const blank = field.required ? "" : `<option value="">（不改动）</option>`;
    return `<select ${common}>${blank}${opts.join("")}</select>`;
  }
  if (field.type === "textarea") {
    return `<textarea ${common} ${placeholder} ${field.secret ? "" : `spellcheck="false"`}>${field.secret ? "" : escapeHtml(value || "")}</textarea>`;
  }
  // 密码框：与 text 分支的差别是控件类型 + 自动填充策略 + **永不预填**。
  // 分开是因为「敏感」不等于「该用 password 控件」—— token 类敏感字段（JWT、Cookie）
  // 需要肉眼比对与粘贴，遮住反而碍事；而密码只有服务端认，遮住才是对的。
  // 永不预填的理由比 text 分支更强：text 预填是为了省用户抄一遍默认值，
  // 密码没有默认值可抄，而回显已存密码等于让任何能看屏幕的人拿到登录口令。
  // （secret 字段的 placeholder 走 masked，只露首尾各 4 位。）
  // autocomplete="new-password" 而不是 "current-password"：编辑态存的是这个账号的密码，
  // 让浏览器 autofill 当前的登录密码等于替用户把密码泄露给下一个访问该站点的脚本。
  if (field.type === "password") {
    return `<input ${common} type="password" ${placeholder} value="" autocomplete="new-password">`;
  }
  // 有默认值的文本框要**预填**而不是只放进 placeholder：
  // placeholder 灰字一提交就消失，用户会以为那是示例而不是真值，
  // 于是照着 help 去别处抄一个可能已经过期的版本号。
  // 敏感字段与只读之外的都要预填；编辑态下已存的值优先于默认。
  const text = value !== undefined && value !== null && value !== "" ? value : (field.default !== undefined ? field.default : "");
  return `<input ${common} type="text" ${placeholder} value="${field.secret ? "" : escapeHtml(text)}" autocomplete="off">`;
}

export function renderField(field, state) {
  const id = `f-${field.key}`;
  const badges = [
    field.secret ? chip("敏感") : "",
    field.offline ? chip("需线下取值", true) : "",
    field.readonly ? chip("只读", true) : "",
  ].join("");
  // 格式要求要在提交之前就看得见：这套界面按设计不跑 JS，服务端校验只在按下按钮之后才说话，
  // 于是"16 位数字"这种硬要求本来要撞一次报错才知道。
  // 不把 pattern 原样写进 HTML 的 pattern 属性：浏览器会再套一层 ^(?:…)$，
  // 我们自带的锚点反而让它永不匹配。
  const requirements = [field.help, field.pattern && field.patternMessage].filter(Boolean).join(" · ");
  const help = requirements ? `<div class="help">${escapeHtml(requirements)}</div>` : "";
  const error = state.error ? `<div class="err">${escapeHtml(state.error)}</div>` : "";

  return `<div class="field${state.error ? " bad" : ""}">
    <label for="${id}">${escapeHtml(field.label || field.key)}${field.required && !field.readonly ? ' <span class="req">*</span>' : ""}${badges}</label>
    ${control(field, { value: state.value, masked: state.masked, id })}
    ${help}${error}
  </div>`;
}

// values: 已存字段；masked: 敏感字段的原值（只用于占位提示，绝不回显进 value）
export function renderForm(fields, { values = {}, existing = {}, action, errors = {}, submitLabel = "保存", cancelHref, pwd }) {
  const body = fields.map((field) => renderField(field, {
    value: values[field.key],
    masked: existing[field.key],
    error: errors[field.key],
  })).join("");

  const hidden = pwd === undefined ? "" : `<input type="hidden" name="pwd" value="${escapeHtml(pwd)}">`;
  const cancel = cancelHref ? `<a class="btn" href="${escapeHtml(cancelHref)}">取消</a>` : "";

  return `<form method="post" action="${escapeHtml(action)}" accept-charset="utf-8">
    ${hidden}${body}
    <div class="acts mt">
      ${cancel}<button class="btn pri" type="submit">${escapeHtml(submitLabel)}</button>
    </div>
  </form>`;
}
