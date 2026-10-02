import * as api from "./api.js";

// 69 云（SSPanel 机场）签到工具。
//
// 与其他三家的本质区别：鉴权是 Cookie Session，不是 Bearer Token。
// 每次签到先拿存的 Cookie 试，被 3xx 重定向就说明失效了，重新走一遍登录流程，
// 新 Cookie 通过 cred 回写机制存进 KV（跟 Qoder 的 accessToken 续期同构）。
//
// 「3xx 即失效」这个判据成立的前提是请求带 redirect: "manual" —— 自动跟随会把
// 登录页的 200 当成签到响应，解析不出 JSON 就报一个和真实原因无关的错。
// 下游每一次签到请求都必须带这个参数（api.js 里已写死，勿删）。
//
// 上游方言（都翻成内核的状态）：
//   POST /user/checkin  ret=1 → 签到成功（claimed）
//   POST /user/checkin  ret=0 → 今日已签到（already）
//   POST /user/checkin  3xx   → Cookie 失效，重新登录后再试一次
//   登录 ret!==1 且 4xx → 凭据不行（login_required，要用户重录）
//   登录 5xx/429、轮询异常、session 未就绪 → 上游的问题（rate_limited，等下一轮）

export default {
  id: "69yun",
  name: "69 云",
  order: 40,
  summary: "每天签到领取机场流量",

  // 工具级配置：只有超时。域名写死在 api.js（就这一个机场）。
  config: [
    {
      key: "timeoutMs",
      label: "请求超时（毫秒）",
      type: "text",
      placeholder: "15000",
      help: "留空即用 15000。机场响应可能比 IDE 接口慢，不建议低于 10000",
    },
  ],

  // 账号级凭据。
  // cookie 是 readonly+secret：不在表单里出现，由登录流程自动写回 KV。
  // 跟 Qoder 的 accessToken 一样，用户不需要手动碰它。
  creds: [
    {
      key: "email",
      label: "邮箱",
      type: "text",
      required: true,
      help: "登录 69 云用的邮箱，同时作为账号的唯一键",
    },
    {
      key: "password",
      label: "密码",
      type: "password",
      required: true,
      secret: true,
      help: "登录密码。Cookie 失效时用它重新登录",
    },
    {
      key: "cookie",
      label: "会话 Cookie",
      type: "textarea",
      readonly: true,
      secret: true,
      help: "登录后自动保存，无需手动填写。失效时会自动用邮箱密码重新登录",
    },
  ],

  // uid 直接用邮箱。sanitizeUid 会剥掉 @，但邮箱的本地+域名组合后仍然唯一。
  uidOf: (ctx) => String(ctx.values.email || "").trim(),

  schedule: {
    // 机场签到 0 点刷新，没有特定发放窗口（跟 Trae/WorkBuddy 一样）。
    resetHour: 0,
    notBeforeHour: 0,
    minIntervalSec: 1800,
    maxDaily: 10,
    // 退避阶梯，**单位是分钟**（内核的 backoffSec 会 ×60，别写成秒）。
    // 量级对齐 Trae 的 [30,60,120,240,360]：首次 5 分钟、然后 10、30。
    // 它只在步骤产出 rate_limited 时生效，而那正是下面 loginTransient 的分支 ——
    // 早先这里写的是 [300,600,1800]（=5/10/30 小时，大了一个数量级），
    // 而 69 云从不产出 rate_limited，所以那个阶梯一次都不会被读到（死配置）。
    backoff: [5, 10, 30],
  },

  hosts: api.yun69Hosts,

  // 最坏情况 cost = 7：
  //   1（checkin 被 3xx）+ 1（GET 登录页）+ 1（POST 登录）+ 3（轮询 session）+ 1（再 checkin）
  // 声明 8，那多出来的 1 笔不是"随便留的"——它防的是轮询第 3 次仍返回 3xx 时
  // 上游多给的一次重定向探测，以及登录响应里分两次下发 Set-Cookie 的形态。
  // 往小了改是危险方向：低于真实上界会让 fits() 给出一张装不下的假票。
  // 正常情况（Cookie 有效）只花 1 次。
  steps: [
    {
      id: "checkin",
      label: "签到领流量",
      cost: 8,
      async run(ctx) {
        const existingCookie = ctx.account.cred.cookie || "";
        let cookie = existingCookie;
        let rotated = null;

        // 有 Cookie 就先试一次
        if (cookie) {
          const result = await api.checkin(ctx, cookie);
          if (!result.authFailed) {
            return wrap(result, rotated);
          }
          // 3xx = Cookie 失效， fall through 到重新登录
        }

        // 重新登录
        const login = await api.login(ctx);
        if (login.error) {
          // 凭据问题与上游问题必须分开：前者要用户重录（login_required），
          // 后者重录也没用（亮红条只会误导他）。transient 走 rate_limited ——
          // 那是唯一会让内核读 schedule.backoff 的状态，于是上面那个阶梯才真正生效。
          if (login.kind === "transient") {
            return { status: "rate_limited", message: login.error, credits: 0, cred: null };
          }
          return {
            status: "login_required",
            message: login.error,
            credits: 0,
            cred: null,
          };
        }
        cookie = login.cookie;
        rotated = { cookie };
        // rotated 只表示"新串拿到了"，落盘由内核做（runner.js 的凭据轮换段）。
        // 写回失败时内核会在日志 message 后追加「（新凭据写回失败…）」，
        // 但这一步的 status 仍是 claimed —— 用户看到的是"签到成功"，
        // 而 Cookie 没存上，下一轮又要重新登录一遍（多花 5 笔请求）。
        // 这是内核对三家的统一处理，不在本工具里另开分支：
        // 要判"写回有没有成"，得看运行日志详情里那句话，不看则无从察觉。

        // 登录成功后再签到一次
        const result = await api.checkin(ctx, cookie);
        if (result.authFailed) {
          // 刚登录完还被重定向，说明 session 真的有问题
          return {
            status: "error",
            message: "重新登录后签到仍被重定向，session 可能异常",
            credits: 0,
            cred: rotated,
          };
        }
        return wrap(result, rotated);
      },
    },
  ],

  // 「测试」按钮：只登录，不发签到请求。验证邮箱密码是否正确。
  async validate(ctx) {
    const login = await api.login(ctx);
    if (login.error) {
      return login.kind === "transient"
        ? { status: "error", message: login.error }
        : { status: "login_required", message: login.error };
    }
    // 必须**就地改写** ctx.account.cred，不能把 cookie 放进返回值：
    // validateAccount 的落盘判据是「调用前后 account.cred 的差异」
    // （runner.js 的 validateAccount），它根本不看 outcome.cred ——
    // 返回 { cookie } 的话新 Cookie 会被直接丢掉，而下面这句话还会撒谎。
    // 三家都是就地 Object.assign（Trae ensureToken / Qoder authorized /
    // WorkBuddy refresh），这里跟着同构。SSPanel 登录多半会覆盖 session，
    // 不写回的话旧 Cookie 可能当场作废，下一轮必然又是 3xx。
    ctx.account.cred.cookie = login.cookie;
    // 不写「已保存」——写没保存由内核决定，它会在后面自动追加
    // 「（本次测试顺带续了期，新凭据已写回）」或「（没能写回…）」。自己写等于抢它的话。
    return { status: "ok", message: "登录成功" };
  },
};

// 把 api.checkin 的返回翻成内核方言，同时带上 cred 回写。
function wrap(result, rotated) {
  if (result.error) {
    return { status: "error", message: result.error, credits: 0, cred: rotated };
  }
  // claimed / already 都不带 credits（机场签到的流量在 msg 里，不是数字字段）
  return { status: result.status, message: result.message, credits: 0, cred: rotated };
}
