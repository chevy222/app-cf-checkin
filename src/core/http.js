// 全站唯一的 Response 出口。安全头必须写在 init.headers 里 —— 写成 new Response(body, headers)
// 第二参数的位置会被当成 ReadableStreamSource 而静默丢掉全部头。
const SECURITY_HEADERS = {
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
