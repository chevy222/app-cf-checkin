import { escapeHtml } from "../core/text.js";
import { statusInfo } from "./layout.js";

export function glyph(id, size = 12) {
  return `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

export function badge(status, overrideLabel) {
  const info = statusInfo(status);
  return `<span class="badge b-${escapeHtml(infoClass(status))}">${glyph(info.glyph)}${escapeHtml(overrideLabel || info.label)}</span>`;
}

const CLASS_BY_STATUS = {
  claimed: "claimed", already: "already", ok: "ok", inactive: "inactive", pending: "pending",
  partial: "partial", skipped: "skipped", rate_limited: "rate", login_required: "login",
  deferred: "defer", waiting: "wait", error: "error",
};
function infoClass(status) {
  return CLASS_BY_STATUS[status] || "error";
}

export function alertBox(kind, html) {
  const map = { bad: "bad", warn: "warn", info: "info" };
  const icon = kind === "info" ? "g-clock" : "g-tri";
  return `<div class="alert ${map[kind] || "info"}">${glyph(icon, 14)}<span>${html}</span></div>`;
}

export function sectionHead(title, sub, rightHtml) {
  return `<div class="h"><h2>${escapeHtml(title)}</h2>${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ""}`
    + `${rightHtml ? `<span class="spacer"></span>${rightHtml}` : ""}</div>`;
}

export function emptyState({ title, lines, actions }) {
  return `<div class="empty"><div class="mark">${glyph("g-key", 22)}</div>
    <b class="cap">${escapeHtml(title)}</b>
    ${lines && lines.length ? `<p class="sub mt">${escapeHtml(lines.join(" "))}</p>` : ""}
    ${actions && actions.length ? `<div class="acts center mt">${actions.join("")}</div>` : ""}
  </div>`;
}

export function chip(text, off) {
  return `<span class="chip${off ? " off" : ""}">${escapeHtml(text)}</span>`;
}

export function button(href, text, style = "", small = false) {
  return `<a class="btn${style ? ` ${style}` : ""}${small ? " sm" : ""}" href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}
