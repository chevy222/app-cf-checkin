const encoder = new TextEncoder();

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// 比较访问口令。长度不等直接返回（泄露长度是通行做法），等长时逐字节累加、不提前返回。
export function safeEqual(a, b) {
  const left = encoder.encode(String(a ?? ""));
  const right = encoder.encode(String(b ?? ""));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

// 屏蔽任意字符类。旧 trae 版用 (\d{4})\d+(\d{4})，对十六进制 uid 原样返回、等于不脱敏。
// 12 位及以下一律整串隐藏：否则 4+4 的露出会覆盖 9 位口令的 8 个字符，等于明文。
export function maskSecret(value) {
  const text = String(value ?? "");
  if (text.length === 0) return "";
  if (text.length <= 12) return "•".repeat(8);
  return `${text.slice(0, 4)}${"•".repeat(8)}${text.slice(-4)}`;
}

export function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
