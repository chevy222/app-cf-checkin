// 一次调用一本账，但账本是**两本**。
//
// 为什么分开：
// Cloudflare 免费版对一次调用给**两个独立上限**，不是一个大池子：
//   · 50 次「外部子请求」= fetch() 打到你家上游站点
//   · 1000 次「内部服务子请求」= KV / R2 / D1 这类 Cloudflare 自家服务
// 见 https://developers.cloudflare.com/workers/platform/limits/#subrequests
// 与 2026-02-11 的 changelog（原文："free plan remain limited to 50 external
// subrequests and 1000 subrequests to Cloudflare services per invocation"）。
//
// http 是唯一参与 fits() 闸门的口径（它才是会抛异常的那个），
// kv 只计数、不参与判定 —— 它有自己的 1000 额度，而且真撞了也只是那一次 KV
// 调用失败，不是整轮作废。

// 免费版硬顶。留 5 次余量：撞上限不是"这次请求失败"，是整次调用抛异常，
// 代价（本轮已跑完账号的日志与进度一起丢）远大于少跑一步。
export const DEFAULT_LIMIT = 45;

export function budgetFrom(env) {
  const configured = Number(env && env.BUDGET_SUBREQUESTS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LIMIT;
}

// 模型：used 只统计**已经真实发生**的外部 HTTP 次数；kv 单独记，只用于展示与排查。
// fits() 是纯判定、不改状态。
//
// 也不要试图用"预约 + charge 冲抵"来占位：冲抵不分对象，步骤的 fetch 会把
// 留给下一步的额度一起吃掉，used 照样越限。闸门就在准入侧 ——
// 见 runner.js：一步开跑之前要确认它自己的 cost 装得下。
export function makeBudget(limit) {
  const state = { used: 0, over: 0, kv: 0 };
  return {
    limit,
    // 外部 HTTP 次数（唯一参与 fits 闸门的口径）
    get used() { return state.used; },
    // KV 操作次数（只计数，不参与判定 —— 理由见文件头）
    get kv() { return state.kv; },
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
    // KV 单独记一笔。它有自己的 1000 额度，且撞了不会让整轮抛异常。
    chargeKv(n = 1) { state.kv += n; },
  };
}

// 把 KV 包一层：所有读写自动记账（只计数，不参与闸门 —— 见文件头）。
// 这样"打开首页花了多少"和"这轮调度花了多少"仍是同一本账，只是分成两个读数。
export function trackedKv(kv, budget) {
  if (!kv || !budget) return kv;
  return {
    async get(key) { budget.chargeKv(1); return kv.get(key); },
    async put(key, value, options) { budget.chargeKv(1); return kv.put(key, value, options); },
    async delete(key) { budget.chargeKv(1); return kv.delete(key); },
    async list(options) { budget.chargeKv(1); return kv.list(options); },
  };
}

// 每次真实 fetch 记一笔，并且**有拒答权**：账本空了就抛错，而不是照发出去
// 让第 51 次请求把整轮炸掉 —— 那时异常会以一种无法归因的方式冒出来。
export function trackedFetch(budget, hosts) {
  const allowed = hosts && hosts.length ? new Set(hosts) : null;
  return async function fetchTracked(input, init) {
    const url = new URL(typeof input === "string" ? input : input.url);
    // 出口白名单：合并成一个 Worker 之后最大的风险是凭据串味，这里做最后一道硬拦截
    if (allowed && !allowed.has(url.hostname)) {
      throw new Error(`禁止的请求域名 ${url.hostname}（该工具只允许 ${[...allowed].join(", ")}）`);
    }
    if (!budget.fits(1)) throw new Error("本轮外部请求额度已用尽，停止发起请求");
    budget.charge(1);
    return fetch(input, init);
  };
}
