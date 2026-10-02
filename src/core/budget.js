// 一次调用一本账，记的是**外部 HTTP 次数**。
//
// 为什么只有一本：Cloudflare 免费版对 fetch() 给 50 次外部子请求的硬顶，
// 撞顶不是"这次请求失败"，是**整次调用抛异常** —— 本轮已跑完账号的日志与进度
// 一起丢。所以账本必须参与闸门（fits），在发请求之前就拦住。
// 见 https://developers.cloudflare.com/workers/platform/limits/#subrequests
//
// KV 走 Cloudflare 自家服务的额度（每天 1000 次），与那 50 个名额无关，
// 撞了也只是那一次调用失败、safe() 吞掉后继续跑 —— 所以**不设闸、不计数**。

// 免费版硬顶。留 5 次余量：撞上限不是"这次请求失败"，是整次调用抛异常，
// 代价（本轮已跑完账号的日志与进度一起丢）远大于少跑一步。
export const DEFAULT_LIMIT = 45;

export function budgetFrom(env) {
  const configured = Number(env && env.BUDGET_SUBREQUESTS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LIMIT;
}

// used 只统计**已经真实发生**的外部 HTTP 次数；fits() 是纯判定、不改状态。
//
// 也不要试图用"预约 + charge 冲抵"来占位：冲抵不分对象，步骤的 fetch 会把
// 留给下一步的额度一起吃掉，used 照样越限。闸门就在准入侧 ——
// 见 runner.js：一步开跑之前要确认它自己的 cost 装得下。
export function makeBudget(limit) {
  const state = { used: 0, over: 0 };
  return {
    limit,
    // 外部 HTTP 次数（参与 fits 闸门）
    get used() { return state.used; },
    // 实际超出自设上限多少（步骤 cost 估偏低时才会发生），供上层报警
    get over() { return state.over; },
    left() { return limit - state.used; },
    // 开工前的判定：这一笔加进去还装得下吗
    fits(n) { return state.used + n <= limit; },
    charge(n = 1) {
      state.used += n;
      if (state.used > limit) state.over = state.used - limit;
      return state.used <= limit;
    },
  };
}

// 每次真实 fetch 记一笔，并且**有拒答权**：账本空了就抛错，而不是照发出去
// 让第 51 次请求把整轮炸掉 —— 那时异常会以一种无法归因的方式冒出来。
export function trackedFetch(budget, hosts) {
  const allowed = hosts && hosts.length ? new Set(hosts) : null;
  return async function fetchTracked(input, init) {
    const url = new URL(typeof input === "string" ? input : input.url);
    // 出口白名单：合并成一个 Worker 之后最大的风险是凭据串味，这里做最后一道硬拦截。
    // 白名单缺失时**拒绝一切**（fail-closed），不是放行：注册表自检已保证每个工具都会
    // 声明它，真走到这里说明有人绕过了自检 —— 那种情况下放行等于把三家凭据开放给任意域名。
    if (!allowed) throw new Error("该工具的出口白名单是空的，已拒绝一切出站请求");
    if (!allowed.has(url.hostname)) {
      throw new Error(`禁止的请求域名 ${url.hostname}（该工具只允许 ${[...allowed].join(", ")}）`);
    }
    if (!budget.fits(1)) throw new Error("本轮外部请求额度已用尽，停止发起请求");
    budget.charge(1);
    return fetch(input, init);
  };
}
