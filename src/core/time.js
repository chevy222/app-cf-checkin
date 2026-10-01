export const CST_OFFSET = 8 * 3600;

export const nowSec = () => Math.floor(Date.now() / 1000);

// 中国无夏令时，固定偏移恒正确；不要在这里引入时区库，也不要退回 toISOString 的 UTC 日期
// （北京时间 00:00–08:00 那段会拿到昨天的日期）。
export function cstDate(sec) {
  return new Date((sec + CST_OFFSET) * 1000).toISOString().slice(0, 10);
}

// 缺字段的历史记录不该把整页拖成 500：非有限值一律显示为破折号
export function fmtCST(sec) {
  if (!Number.isFinite(sec)) return "—";
  return new Date((sec + CST_OFFSET) * 1000).toISOString().replace("T", " ").slice(0, 16);
}

// 重置在 H 点的工具：把时刻往前推 H 小时再取北京日期，即得当前生效的那个逻辑日。
// resetHour=0 时退化成纯北京日期。工具不许自己算「今天」，一律用内核注入的值。
export function logicalDay(resetHour, sec) {
  return cstDate(sec - (Number(resetHour) || 0) * 3600);
}

// 上游的时间窗字段是带偏移的 ISO 串（"2026-10-10T23:59:00+08:00"），
// 不能按字典序比较字符串：偏移量不同时那不是绝对时刻。
// 解不出可用值就返回 null（当作"没有约束"），绝不返回 0 —— 0 会被当成 1970 而全部过期。
export function parseWindowEnd(value) {
  if (!value || typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
