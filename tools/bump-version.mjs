// 发布前把 src/version.js 重算为「当前北京时间」：
//   · 版本号格式 yyyy-MM-dd:HHMM，日期与时间都按 UTC+8（无夏令时，偏移直接加）
//   · 它就是构建时刻本身 —— 不读现版本、不递增：构建工作区每次都是新的 clone，
//     任何"记住上次数值"的写法都会退化成同一个值（见 src/version.js 的说明）
// 只替换 VERSION 那一行，文件里的说明与 stampFor 函数原样保留。
import { readFileSync, writeFileSync } from "node:fs";
import { VERSION, stampFor } from "../src/version.js";

// 先把时间戳加 8 小时再取 UTC 部分，得到的就是北京时间的"墙上时钟"。
// 不能用 toLocaleString("zh-CN")：那依赖 ICU 数据，minimal 环境里可能整个塌成英文，
// 而版本号格式必须是固定的 yyyy-MM-dd:HHMM。
const nowCst = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16);
const next = stampFor(nowCst);

const file = new URL("../src/version.js", import.meta.url);
const src = readFileSync(file, "utf8");
if (!/export const VERSION = "[^"]*"/.test(src)) {
  console.error("version.js 里找不到 VERSION 常量，无法重算");
  process.exit(1);
}
writeFileSync(file, src.replace(/export const VERSION = "[^"]*"/, `export const VERSION = "${next}"`));
console.log(`version ${VERSION} → ${next}（北京时间 ${nowCst.replace("T", " ")}）`);
