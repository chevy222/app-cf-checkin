import { safeEqual } from "./text.js";

const MAX_BODY = 64 * 1024;
const FORM_TYPE = "application/x-www-form-urlencoded";

// 只有「是 urlencoded 表单 + 带 content-length + 不超上限」的请求体才会被读进内存。
// 实测浏览器表单 POST 一定带 content-length（Cloudflare 会转发），分块请求不带 —— 那种直接拒。
// 不校验 content-type 的话，任意第三方页面都能无预检地对我们发 POST。
async function readForm(request) {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith(FORM_TYPE)) return null;

  const rawLength = request.headers.get("content-length");
  if (rawLength === null) return null;
  const length = Number(rawLength);
  if (!Number.isFinite(length) || length > MAX_BODY) return null;

  const text = await request.text();
  return text.length > MAX_BODY ? null : new URLSearchParams(text);
}

// 口令有三个来路：链接查询串（点链接）、表单隐藏字段（保存）、X-Pwd 头（curl）。
// 请求体只在网关读一次 —— 读两遍会撞 "body already consumed"，所以路由拿的是这里解析好的 form。
//
// 已知代价（有意接受）：口令必然出现在请求 URL 里，因此会进入 Cloudflare 的平台侧访问日志，
// 这不是本 Worker 能控制的。换来的是零 JS、无 cookie、链接可直接转发。
// 本应用自己绝不把查询串写进任何日志，也不把口令渲染成可见文本。
export async function authenticate(request, url, env) {
  const expected = env && typeof env.PASSWORD === "string" ? env.PASSWORD : "";
  // 先判配置再读体：平台没配好时也不该替攻击者缓冲请求体
  if (expected === "") return { verdict: "unconfigured", pwd: "", form: null };

  const isPost = request.method.toUpperCase() === "POST";
  const form = isPost ? await readForm(request) : null;
  if (isPost && form === null) return { verdict: "bad_body", pwd: "", form: null };

  const candidates = [];
  const fromQuery = url.searchParams.get("pwd");
  if (fromQuery) candidates.push(fromQuery);
  const fromHeader = request.headers.get("x-pwd");
  if (fromHeader) candidates.push(fromHeader);
  const fromForm = form && form.get("pwd");
  if (fromForm) candidates.push(fromForm);

  // 必须回传「真正匹配的那个」口令，不能取第一个候选：
  // 否则查询串里塞个错口令、靠请求头通过，页面里所有链接都会带上错口令，用户每点一次都 401
  const winner = candidates.find((candidate) => safeEqual(candidate, expected));
  if (!winner) return { verdict: "reject", pwd: "", form: null };

  return { verdict: "ok", pwd: winner, form };
}
