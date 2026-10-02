// 版本号：yyyy-MM-dd:HHMM —— 日期与时间都是**北京时间**（UTC+8）。
//
// 为什么不用「第几次发布」的序号：那个序号依赖"同一天递增"的假设，
// 而实际使用中它老是不对 —— 一天里发布几次没人记着，跨天后又回到 01，
// 页脚上两个不同的构建会显示同一个号，刷新页面也看不出有没有更新。
// 改成北京时间的 HHMM 之后，版本号本身就是发布时刻：一眼能看出新旧，
// 同一分钟内重复发布（极罕见）才会撞号，而那种情况重跑一次即可。
//
// 不要手改：npm run deploy 会先跑 tools/bump-version.mjs 按当前北京时间重算。

export const VERSION = "2026-10-02:1447";

// 下一个版本号 = 今天的北京时间 HHMM。
// 纯函数单独导出，冒烟测试直接测它，不测文件读写与系统时钟。
//
// 时钟回拨（用户改系统时间、或部署机器时区不对）不该让版本号倒退，
// 所以同一天里若算出的 HHMM **小于**现版本，就用现版本 +1 分钟 ——
// 那说明钟慢了，用「至少比上一次新」这个方向修正，而不是让页脚显示的时间倒退。
// 跨天时无条件取当天 HHMM，即便现版本的数字更大（10:05 > 09:30）。
export function nextVersion(current, nowCst) {
  // nowCst 形如 "2026-10-02T14:47"，调用方负责按 UTC+8 算好。
  const day = nowCst.slice(0, 10);
  const hm = nowCst.slice(11, 13) + nowCst.slice(14, 16);
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{2})(\d{2})$/.exec(current);
  if (!m || m[1] !== day) return `${day}:${hm}`;

  // 比较必须走"分钟数"，不能把 HHMM 当整数比：Number("0900")=900 分钟是 15:00，
  // 比 14:47（887分钟）还晚 —— 而 09:00 明明早于 14:47。整数比较在这里是错的。
  const nowMin = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(2));
  const curMin = Number(m[2]) * 60 + Number(m[3]);
  if (nowMin >= curMin) return `${day}:${hm}`;
  // 钟慢了：进位一分钟，而且**日期必须一起进位** —— 23:59 +1 分是次日 00:00，
  // 只改时间会拼出「10-02:0000」这种不存在的时刻。用 UTC 做日期运算：这里的
  // 分钟数只是"当天第几分钟"，与时区无关，交给 Date 算最省事。
  const bumped = curMin + 1;
  const nextDay = new Date(`${day}T00:00:00Z`);
  nextDay.setUTCMinutes(bumped);
  return `${nextDay.toISOString().slice(0, 10)}:${String(nextDay.getUTCHours()).padStart(2, "0")}${String(nextDay.getUTCMinutes()).padStart(2, "0")}`;
}