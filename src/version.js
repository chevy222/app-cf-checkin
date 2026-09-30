// 版本号：yyyy-MM-dd:NN —— 日期是发布日（北京时间），NN 是当天第几次发布。
// 不手改：npm run deploy 会先跑 tools/bump-version.mjs 递增后写回这里，
// 页面底部的 footer 直接渲染这个常量。

export const VERSION = "2026-10-01:01";

// 当天（today 为 yyyy-MM-dd）的第几次发布：同天序号 +1，跨天回到 01。
// 纯函数单独导出，冒烟测试直接测它，不测文件读写。
export function nextVersion(current, today) {
  const m = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(current);
  const n = m && m[1] === today ? Number(m[2]) + 1 : 1;
  return `${today}:${String(n).padStart(2, "0")}`;
}
