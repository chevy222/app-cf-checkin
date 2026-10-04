// 状态词汇的语义分组。**全站唯一一份**。
//
// 为什么要集中：同义集合曾在四个文件里各写一份（内核 runner、调度 scheduler、
// 首页 home、工具页 tool），并且已经漂移过两处 ——
//   · 首页进度条把 pending / partial 画成红色，而内核注释明说 pending 是
//     "正常等待，不是故障"；
//   · 说明页给 waiting 配了绿色，而全站其它地方（badge）是蓝色。
// 漂移不会报错，只会让"这个号到底怎么了"在不同页面上说法不一。
//
// 内核与界面都用这一份；界面色块（ui/layout.js 的 progressTone / stepTone）
// 也从这里派生，不再自己写同义列表。

// 跑完就算数的状态：今天不再重复排队（scheduler 上闩、runner 存进度都用它）
export const SETTLED = new Set(["claimed", "already", "inactive", "ok"]);

// 真的领到了（aggregate 用它区分整体报 claimed 还是 already）
export const SUCCESS = new Set(["claimed"]);

// 没领到东西、下一轮该接着做的状态。
//   pending —— 上游还没开始（活动窗口没到），按账号被 PENDING_RETRY_SEC 拽慢一小时；
//   waiting —— 上游已经在推进（旅行在途），下一轮就看，不受任何节流；
//   deferred —— 预算装不下；skipped —— 前置未通过。
// 四者都不是 SETTLED（当天不收工），差别只在"下一次什么时候看"。
export const CONTINUABLE = new Set(["deferred", "skipped", "pending", "waiting"]);

// 真正需要人动手的两类：凭据失效与失败。首页与工具页的红条只认它 ——
// rate_limited / deferred / partial / pending / waiting 都会自己恢复，不该亮红。
export const NEEDS_ACTION = new Set(["login_required", "error"]);