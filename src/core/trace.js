// 记录每一步的上游交互：请求原文 + 响应原文。
//
// **落点在内核**：`trackedFetch` 已经看见每一次出站请求，所以工具一行都不用改 ——
// 加第 N 个工具时自动获得这个能力，也不存在"某个工具忘了记"这种事。
//
// 两处对"原样"的折扣（有意为之，不是 bug）：
//   ① 请求头只留非敏感的：`Authorization` 掩成 `Bearer ***`、`Cookie` 掩成 `***`，
//      白名单之外的请求头一律不记。**响应头一律不记** —— `set-cookie` 里是这次刚拿到的
//      新会话 cookie，它还没写进账号、不在脱敏集合里，记了就漏。
//   ② body 有大小上限，超了**如实标注**截断（保留多少 / 原文多少），绝不静默砍掉。
//
// 收集与落盘分开：这里只管收；脱敏与写 KV 在 logs.js（与 writeRunLog 同一个出口）。
const TRACE_BODY_MAX = 32 * 1024;    // 单次 body 的字符数上限
const TRACE_TOTAL_MAX = 128 * 1024;  // 一轮的字符数上限，超了就只记"丢了几次"

const SAFE_REQ_HEADERS = new Set(["content-type", "referer", "origin", "user-agent", "accept"]);

// 白名单 + 两个硬编码掩码。掩码不依赖脱敏集合：`Authorization` 里那把票是**准备发出去**的，
// 它可能刚换出来、还没进 secretValuesOf 的集合，靠集合去扫就会漏。
function maskHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = String(name).toLowerCase();
    if (lower === "authorization") {
      const scheme = String(value).split(/\s+/)[0] || "";
      out[name] = scheme ? `${scheme} ***` : "***";
    } else if (lower === "cookie") {
      out[name] = "***";
    } else if (SAFE_REQ_HEADERS.has(lower)) {
      out[name] = String(value);
    }
  }
  return out;
}

// 截断只按**字符数**算（不是字节）：UTF-8 的字节数要遍历一遍才知道，而这里只是防"日志被一条
// 大响应撑爆"，字符数够用；标注里也写"字符"，不假装是字节。
function capText(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (text.length <= TRACE_BODY_MAX) return { text, truncated: null };
  return { text: text.slice(0, TRACE_BODY_MAX), truncated: { kept: TRACE_BODY_MAX, total: text.length } };
}

export function makeTrace() {
  const steps = [];
  let current = null;
  let used = 0;
  let dropped = 0;
  return {
    // **每一步都调一次**，包括复用与顺延的 —— 这样"这一步为什么没有请求"在页面上看得出来，
    // 而不是整行凭空消失（那正是最容易让人以为没跑的一类静默）。
    enter(id) {
      current = { id, calls: [] };
      steps.push(current);
    },
    callsOf(id) {
      const step = steps.find((s) => s.id === id);
      return step ? step.calls : [];
    },
    // 超出总量上限、被丢掉的那几次交互。掉了几次要报出来，否则"记录看起来是完整的"。
    get dropped() {
      return dropped;
    },
    record({ method, url, headers, reqBody, status, ms, at, resBody, bodyError }) {
      if (!current) return;
      if (used >= TRACE_TOTAL_MAX) {
        dropped += 1;
        return;
      }
      const req = capText(reqBody);
      const res = capText(resBody);
      used += req.text.length + res.text.length;
      const call = {
        n: current.calls.length + 1,
        method,
        url,
        reqHeaders: maskHeaders(headers),
        status,
        ms,
        at,
      };
      if (reqBody !== undefined && reqBody !== null) {
        call.reqBody = req.text;
        if (req.truncated) call.reqTruncated = req.truncated;
      }
      if (bodyError) {
        // 读不到就是读不到，别写一个空串冒充"响应体是空的"
        call.bodyError = bodyError;
      } else {
        call.resBody = res.text;
        if (res.truncated) call.resTruncated = res.truncated;
      }
      current.calls.push(call);
    },
  };
}

// 把一次真实发生的交互记进 trace。**旁路**：读的是克隆体，原响应原样返回给工具；
// 克隆或读取失败只记"读不到"，绝不影响这一笔请求本身。
export async function recordExchange(trace, { url, method, headers, body, response, ms, at }) {
  const reqBody = typeof body === "string" ? body
    : body === undefined || body === null ? undefined
      : `（非文本请求体：${typeof body}）`;
  try {
    const text = await response.clone().text();
    trace.record({ method, url: url.href, headers, reqBody, status: response.status, ms, at, resBody: text });
  } catch (error) {
    trace.record({
      method, url: url.href, headers, reqBody, status: response.status, ms, at,
      bodyError: String((error && error.message) || error),
    });
  }
}
