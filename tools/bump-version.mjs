// 发布前把 src/version.js 递增到「今天的下一个序号」：
//   · 今天按北京时间算（UTC+8 无夏令时，偏移直接加）
//   · 与现版本同天 → 序号 +1；跨了天 → 回到 01
// 只替换 VERSION 那一行，文件里的说明与 nextVersion 函数原样保留。
import { readFileSync, writeFileSync } from "node:fs";
import { VERSION, nextVersion } from "../src/version.js";

const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const next = nextVersion(VERSION, today);

const file = new URL("../src/version.js", import.meta.url);
const src = readFileSync(file, "utf8");
if (!/export const VERSION = "[^"]*"/.test(src)) {
  console.error("version.js 里找不到 VERSION 常量，无法递增");
  process.exit(1);
}
writeFileSync(file, src.replace(/export const VERSION = "[^"]*"/, `export const VERSION = "${next}"`));
console.log(`version → ${next}`);
