// JWT 载荷读取：只解 base64url，不验签。
//
// 为什么在内核里而不是各 api.js 抄一遍：三家都需要从 access token 里取两样纯机械的东西
// —— sub（账号稳定标识）与 exp（什么时候该续期）。这跟"鉴权方言"无关，
// 头怎么拼、票据怎么带仍然是每工具各写一套（硬规则一）。
//
// 为什么不验签：这里只是读自己手里的凭据元数据，验签要服务端公钥；而且读出来的值
// 只用于"这个号是谁 / 还能用多久"这类展示与调度判断，不作为授权依据。
export function readJwtClaims(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const payload = decodeSegment(parts[1]);
  if (!payload) return null;
  try {
    const claims = JSON.parse(payload);
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

// atob 出来是 latin1 字符串，直接 JSON.parse 会在昵称这类非 ASCII 字符上炸，
// 所以先转字节再按 UTF-8 解。
function decodeSegment(segment) {
  const aligned = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = aligned + "=".repeat((4 - (aligned.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return new TextDecoder("utf-8").decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

// 账号标识的几种叫法。取到的值会进 KV 键名，所以下游还要过一遍 sanitizeUid。
//
// 只从 access token 取，绝不用 refresh token 兜底：refresh_token 会轮换，
// 拿它派生 uid 意味着续一次期就换出一个新 uid —— 旧的 acct 键被孤立，
// 账号看起来"消失了"，而凭据其实还好好的。
export function subjectOf(token) {
  const claims = readJwtClaims(token);
  if (!claims) return "";
  const candidate = [claims.sub, claims.uid, claims.user_id, claims.userId, claims.id]
    .find((value) => value !== undefined && value !== null && String(value).trim() !== "");
  return candidate === undefined ? "" : String(candidate).trim();
}

// exp 缺失时返回 0，让调用方自己决定"没给过期时间"怎么办。
// 不能就地猜一个未来时间：旧 qoder 猜 +14 天，结果"剩 72 小时内续期"这条规则永远不触发，
// 令牌真的过期那天才被上游告知。
export function expiresAtOf(token) {
  const claims = readJwtClaims(token);
  const exp = Number(claims && claims.exp);
  return Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : 0;
}
