// 免费版硬顶：50 子请求 / 单次调用，且 KV 的 get/put/list/delete 也算子请求
// （官方定义："any request a Worker makes using the Fetch API or to Cloudflare
//   services like R2, KV, or D1"）。
// 留 5 次余量：撞上限不是"这次请求失败"，是整次调用抛异常，代价远大于少跑一步。
export const DEFAULT_LIMIT = 45;

export function budgetFrom(env) {
  const configured = Number(env && env.BUDGET_SUBREQUESTS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LIMIT;
}

// 模型：used 只统计**已经真实发生**的子请求；fits() 是纯判定、不改状态。
// 早期版本让 reserve 往 used 里预付、charge 再加一次，等于双重计数，
// 会把预算算得比实际更满、又挡不住真正超支的步骤。
//
// 也不要试图用"预约 + charge 冲抵"来占位：冲抵不分对象，步骤的 fetch 会把
// 账号帧里留给收尾写入的那几笔一起吃掉，used 照样越限。真正的闸门在准入侧 ——
// 见 runner.js 的 TAIL_RESERVE：允许一步开跑之前，必须连"这步做完之后还要写的几笔"
// 一起装得下。
export function makeBudget(limit) {
  const state = { used: 0, over: 0 };
  return {
    limit,
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

// 把 KV 包一层：所有读写自动记账。这样"打开首页花了多少"和"这轮调度花了多少"是同一本账，
// 不会出现只给定时任务记账、页面渲染却随便花的情况。
export function trackedKv(kv, budget) {
  if (!kv || !budget) return kv;
  return {
    async get(key) { budget.charge(1); return kv.get(key); },
    async put(key, value, options) { budget.charge(1); return kv.put(key, value, options); },
    async delete(key) { budget.charge(1); return kv.delete(key); },
    async list(options) { budget.charge(1); return kv.list(options); },
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
    if (!budget.fits(1)) throw new Error("本轮子请求预算已用尽，停止发起请求");
    budget.charge(1);
    return fetch(input, init);
  };
}
