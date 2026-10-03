// 全站唯一的 Response 出口。安全头必须写在 init.headers 里 —— 写成 new Response(body, headers)
// 第二参数的位置会被当成 ReadableStreamSource 而静默丢掉全部头。
//
// 导出给 favicon 那条静态资源路径复用：它同样要带 nosniff / CSP / Referrer-Policy，
// 只有 cache-control 需要按语义换成 public（图标不变，缓存一天是对的）。
// 不导出的话那条路径只能手写一份 —— 而漏掉的头不会报错，只是静默失效。
export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  // 界面零 JavaScript：default-src 'none' 顺带禁掉脚本，样式必须内联所以放开 unsafe-inline
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; "
    + "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function htmlRes(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS },
  });
}

export function jsonRes(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

export function redirectRes(location) {
  return new Response(null, {
    status: 303,
    headers: { location, ...SECURITY_HEADERS },
  });
}
