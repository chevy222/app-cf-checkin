import { authenticate } from "./core/gateway.js";
import { htmlRes } from "./core/http.js";
import { dispatch } from "./core/router.js";
import { renderFatal, renderGate, renderUnconfigured } from "./ui/pages/gate.js";
import { budgetFrom, makeBudget } from "./core/budget.js";
import { runTick } from "./core/runner.js";
import { TOOLS } from "./tools/index.js";
import { nowSec } from "./core/time.js";

// 页面渲染和调度消费同一个预算对象。账本只记外部 HTTP ——
// KV 有 Cloudflare 自家每天 1000 次的独立额度，不参与闸门（理由见 budget.js）。
function withLedger(env) {
  return { budget: makeBudget(budgetFrom(env)), env };
}

export default {
  // Cloudflare 的签名是 (request, env, ctx)。URL 在这里解析一次，网关与路由共用同一个对象。
  async fetch(request, env) {
    const url = new URL(request.url);
    const { budget, env: scoped } = withLedger(env);

    try {
      const auth = await authenticate(request, url, scoped);
      if (auth.verdict === "unconfigured") return htmlRes(renderUnconfigured(), 500);
      if (auth.verdict === "bad_body") {
        return htmlRes(renderFatal("请求体无法处理：必须是 urlencoded 表单、带 content-length、且不超过 64 KB。"), 413);
      }
      // 未鉴权时不进路由、不读 KV：错误口令不该产生任何可观察的差异
      if (auth.verdict !== "ok") return htmlRes(renderGate(), 401);

      return await dispatch(request, url, scoped, auth.pwd, auth.form, budget);
    } catch (error) {
      // 只记 message，绝不记 url —— 口令在查询串里
      console.error("[checkin] 请求处理失败：" + String((error && error.message) || error));
      return htmlRes(renderFatal(String((error && error.message) || error)), 500);
    }
  },

  async scheduled(controller, env) {
    const { budget, env: scoped } = withLedger(env);
    const cron = String((controller && controller.cron) || "");
    // 用平台给的计划时刻而不是 Date.now()：一来它才是这次触发真正对应的时间点，
    // 二来让测试可以注入时间。
    const now = Math.floor(Number(controller && controller.scheduledTime) / 1000) || nowSec();
    console.log("[checkin] cron 已触发 " + cron);
    try {
      const summary = await runTick({ env: scoped, budget, tools: TOOLS, trigger: "cron", now });
      console.log("[checkin] " + JSON.stringify(summary));
    } catch (error) {
      console.error("[checkin] 本轮执行失败：" + String((error && error.message) || error));
    }
  },
};
