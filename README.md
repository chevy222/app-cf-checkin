# 签到台

一个 Cloudflare Worker，每天自动替领 Qoder / Trae / WorkBuddy 三家的免费额度。
**加第 4 个工具只需要新增一个 `src/tools/<id>/` 目录 + 在注册表里加一行，内核与界面零改动。**

- 176 条测试全绿（`npm run check`，约 0.3 秒，不需要网络）
- 运行时依赖 **零**（`package.json` 没有 `dependencies` 字段）
- 本仓库是三家的**唯一**实现。三个旧脚本（`qoder-cf-checkin` / `trae-cf-checkin` /
  `workbuddy-cf-checkin`）是它的前身，各自独立成仓，不在本仓库内 ——
  读设计文档 §3 里的 Git 地址可取回

---

## 目录

- [快速开始](#快速开始)
- [界面导览](#界面导览)
- [凭据怎么取](#凭据怎么取)
- [加第 4 个工具](#加第-4-个工具) ← **整个方案的验收物**
- [免费版配额与自限 45](#免费版配额与自限-45)
- [KV 键全表](#kv-键全表)
- [常见问题](#常见问题)
- [与旧设计的差异](#与旧设计的差异)

---

## 快速开始

### 两种交付方式

**方式一 · wrangler 部署（主路径）**

```bash
npm install                      # 装 wrangler（devDependencies）
npx wrangler deploy
```

部署前先在 Cloudflare 面板设一个 Secret `PASSWORD` —— 那是访问界面的口令。
**不要把它写进任何文件，也不要贴给任何人。**

**方式二 · 单文件粘贴（备用）**

```bash
npm install
npx wrangler deploy --dry-run --outdir=dist
```

`dist/` 里会得到一个 `index.js`。在 Cloudflare 控制台的 Workers 编辑器里
新建一个 Worker，把内容整个替换成它，再绑定 KV 命名空间、设 Secret、填 cron。

| 项 | 值 |
|---|---|
| Worker 名 | `checkin` |
| KV 绑定名 | `CHECKIN_KV` |
| KV 命名空间 id | 已写进 `wrangler.toml` |
| cron | **1 条** `*/30 * * * *` |
| 环境变量 | 部署时**只需设 1 个**：Secret `PASSWORD`（另有一个可选的 `BUDGET_SUBREQUESTS` 用来覆盖自限 45，正常不用管） |

### 本地跑

```bash
printf 'PASSWORD=换成你自己的\n' > .dev.vars    # 这个文件已在 .gitignore 里
npm run dev
```

两个坑：

1. `PASSWORD` **不会从 shell 环境继承**，只能通过 `.dev.vars` 或 `--var PASSWORD:x` 传入。
2. 残留的 dev 进程会占住共享的 `.wrangler/state` 导致新实例假死。
   起之前确认没有残留 worker 进程，且**只起一个**。

---

## 界面导览

全部页面都在 `?pwd=` 闸后，页面里**没有一行 JavaScript**（CSP 是 `default-src 'none'`）。

| 页面 | 路径 | 作用 |
|---|---|---|
| 总览 | `/` | 工具卡片 + 每家的停用开关 + 最近 12 条运行流 |
| 工具管理 | `/tool/<id>` | 账号列表、红条、步骤色块、逐账号的「测试」「执行」「编辑」「删除」 |
| 工具配置 | `/tool/<id>/settings` | 工具级配置（存 `v1:tool:<id>`） |
| 新增 / 编辑账号 | `/account/...` | 表单由工具的字段声明自动生成 |
| 运行日志 | `/runs`、`/runs?tool=<id>` | 列表 30 天，支持按工具筛 |
| 日志详情 | `/runs/<key>` | 步骤明细、预算分解 |
| 说明 | `/help` | 状态词汇表、停用语义、硬规则 |
| 只读 JSON | `/api/state` | 工具清单、账号数、停用状态、本次读取花了多少子请求 |
| 手动跑一轮 | `GET` 或 `POST` `/api/tick` | 返回结构化 summary，验收窗口 |

### 11 个状态词

唯一来源是 `src/ui/layout.js` 的 `STATUS`，这里是它的逐字拷贝：

`claimed 成功领取` · `already 今日已领` · `ok 正常` · `inactive 活动未开` · `pending 待下发`
· `partial 部分完成` · `skipped 未开始` · `rate_limited 限频` · `deferred 顺延`
· `login_required 需重新登录` · `error 失败`

**「测试」与「执行」的区别**（很容易搞混）：

- **测试** = 只读登录态，不发领取。**但可能顺带续期并写回新凭据** —— Trae 的换票就在
  `validate()` 里，点一下真的会把旧 refresh_token 消耗掉。界面会如实告诉你"新凭据已写回"。
- **执行** = 真的打上游。它跳过时间闸（你点了就是要现在跑）**但不跳预算**。

### 停用某个工具

总览页每张卡片上有一个独立开关，**只停一家，不影响其它，也没有"全部停用"总开关**。

- 停用后：cron 与「执行」都跳过它，别的工具照常
- **账号、凭据与当天进度一条都不删** —— 重新打开就从停下的那一步接着做，已完成的那步不重做
  （重做会真的再打一次上游，WorkBuddy 的开盲盒每调一次就扣 10 点能量）
- 停用中：卡片变暗并显示停用时间，但「今日完成 / 最后结果 / 步骤色块」照常显示
- 停用中：红条不亮（下线中的工具报错不是你的待办），但待处理的数量照常显示
- 停用中：「执行」按钮隐藏，保留「测试」「编辑」「删除」。**隐藏按钮不等于权限** ——
  直接敲 `POST /account/<id>/<uid>/run` 也会被服务端拒绝，且一个上游请求都不发
- 跨过当天的额度重置时刻再打开，按新的那一天从头算（这是本来的行为，没为开关特殊化）

---

## 凭据怎么取

三个工具的凭据都在**本机客户端上**取值，平台不参与 —— 这一点是安全设计的核心。

**界面里就有完整教程**：点「新增账号」或「工具配置」，左侧会显示分步的 PowerShell 脚本，
整段复制到 PowerShell 回车即可，不需要 F12 抓包。下面只列字段对照，脚本在界面里。

| 工具 | 令牌从哪来 | 设备标识从哪来 |
|---|---|---|
| Qoder | 脚本用 DPAPI 解密客户端的 `auth.v1.dat` | 脚本跑客户端自带的 `runtime-info.exe` |
| Trae | 登录回调 URL 里的 `userJwt`（脚本解析出令牌与 refreshToken） | 客户端 `storage.json` 里的 `iCubeAuthInfo://icube-dc:<8–16 位数字>` |
| WorkBuddy | 官方短信登录接口换明文 Token | 无（uid 平台从令牌的 `sub` 解） |

### Qoder

| 字段 | 怎么取 |
|---|---|
| `accessToken` / `refreshToken` | 界面教程第 2 步的输出（`TOKEN:` / `REFRESH:` 两行） |
| `ahaDeviceId`（不适用） | — |

工具配置里的 8 个 `COSY_*` 值由界面教程第 2 步一并打印（**`COSY_CLIENT_TYPE` 必须是 10**，
缺了活动列表接口直接返回空）。**令牌到期时间不用填** —— 平台从令牌的 `exp` 自己解。

### Trae

| 字段 | 怎么取 |
|---|---|
| `accessToken` / `refreshToken` | 界面教程第 4 步的输出（`Access Token` / `Refresh Token` 两行） |
| `ahaDeviceId` | 界面教程第 1 步从 `storage.json` 里抠出的 **8–16 位数字** |

工具级配置：`clientId` 与 `appVersion` **必填**（从客户端里抄），
另有 `timeoutMs` / `refreshAheadSec` 两项可选。

⚠️ **设备号不能编**。签到风控按它判定，随手填一个能过格式校验的值，
之后每天稳定返回 9074「服务器繁忙」—— 看着像限频，其实是设备号错了。

账号 uid 不用你填：保存时平台会打一次 `GetUserInfo` 拿 `UserID` 当标识。

### WorkBuddy

| 字段 | 怎么取 |
|---|---|
| `accessToken` / `refreshToken` | 界面教程第 2 步的输出 |
| `expiresAt` | **不用填**，平台从令牌的 `exp` 自动解出来并显示 |

**换票走线下 PowerShell 脚本，界面不发短信验证码**（这是有意的决定）。
新版桌面端可能给的是 `{"$wbEncrypted":1,"envelope":"…"}` 包装形态，平台会自动展开。

工具级配置：`timeoutMs` / `refreshAheadSec`，**都没有必填项**（所以这一家不会出现"配置未完成"）。

**注意消耗**：开盲盒（`buddy/open`）每调一次服务端就扣 10 点能量，
**这个接口没有任何幂等字段**。所以平台用本地 `OPENS_PER_ROUND` 上界卡次数，
一轮最多 5 个；抽卡的 `client_token` 是按 `(账号, 逻辑日, 序号)` 确定性派生的，
重跑不会真扣一次抽奖机会。

---

## 加第 4 个工具

**这是整个方案的验收物。** 加一个工具不需要改内核、不需要写界面代码、
不需要碰任何 `if (tool.id === ...)`。

先跑一次自检确认前提：

```bash
npm run check          # 176 条测试，含"内核与界面里没有按工具 id 分支"的约定
```

### 1. 建目录 `src/tools/<id>/`

固定两个文件：`index.js`（声明 + 步骤）与 `api.js`（上游方言）。
两个都不能省，也**绝不与其他工具共用**。

### 2. 写 `api.js` —— 上游方言

只做一件事：把"这个站点怎么说话"封装起来。**不写任何业务判断**。

```js
const HOST = "example.com";                      // 出口域名，声明进工具的 hosts
const BALANCE = "/api/v1/points/balance";

// 每个工具一个独立的 header 构造器。共用 header 构造器是硬规则一 ——
// 三家鉴权方案完全不同，共用一次就等于凭据串味，而串味不会报错，只会静默 401。
function authHeaders(ctx) {
  return { Authorization: `Bearer ${ctx.account.cred.accessToken}` };
}

export const hosts = [HOST];

export async function readBalance(ctx) {
  const res = await ctx.fetch(`https://${HOST}${BALANCE}`, {
    method: "GET",
    headers: { Accept: "application/json", ...authHeaders(ctx) },
    signal: AbortSignal.timeout(timeoutMs(ctx.config)),
  });
  return { status: res.status, payload: await res.json().catch(() => null) };
}
```

要点：

| | |
|---|---|
| `ctx.fetch` | 记账 + **域名白名单**，打到别家会直接抛错。这是防止合并部署后凭据串味的最后一道闸 |
| 不传 `search` | 平台日志只记 `pathname` |
| 别把响应体原样塞进 `message` | 一次上游 401 就可能把票据带进日志 |
| 幂等键要**确定性派生** | 别用 `crypto.randomUUID()`。看 `workbuddy/api.js` 的 `idemKey` |

### 3. 写 `index.js` —— 契约声明 + 步骤

```js
import * as api from "./api.js";

const DRAWS_PER_ROUND = 5;

export default {
  id: "example",
  name: "示例站点",
  order: 40,                                  // 界面与调度都按它排
  summary: "每日签到 + 积分查询",

  config: [                                    // 工具级配置：所有账号共用
    { key: "timeoutMs", label: "请求超时（毫秒）", type: "text", placeholder: "30000" },
  ],

  creds: [                                     // 账号级凭据：表单由这里自动生成
    { key: "accessToken", label: "Access Token", type: "textarea",
      required: true, secret: true, pattern: "^[^\\s]+$",
      patternMessage: "令牌里不能有空格",
      help: "在 DevTools 的 Network 里找 Authorization 头",
      offline: "换票走线下脚本，界面不发验证码" },
    { key: "refreshToken", label: "Refresh Token", type: "textarea",
      required: true, secret: true },
    { key: "expiresAt", label: "令牌到期时间", type: "datetime", readonly: true },
  ],

  // 账号标识从哪来 —— 工具自己回答，内核不认识任何具体站点，没法凭空知道
  // "这个工具的账号叫什么"。三家在用的都是这个：
  //   Qoder / WorkBuddy  解 JWT 的 sub（0 次子请求）
  //   Trae               问一次 GetUserInfo（1 次子请求）
  // 为什么不让人自己抄一遍 uid：抄错就是另一个键名，账号记录会原地孤立且不报错
  //（旧 qoder 用会轮换的 refresh_token 兜底算 uid，续一次期就换了个键）。
  // ⚠️ uidOf 拿到的 ctx 与步骤的 ctx **不是同一个**：
  //   它收到 { values, config, tool, env, budget, fetch }，
  //   凭据在 ctx.values 里（还没有 account，因为账号还没建出来）。
  //   返回字符串或 { uid, cred } 都行，后者可顺手把 expiresAt 之类的
  //   派生字段带进新账号，省得第一次运行白换一次票。
    uidOf: (ctx) => ({ uid: subjectOf(unwrap(ctx.values.accessToken)) }),

  schedule: {
    resetHour: 0,          // 逻辑日界：几点算"新的一天"。各家不同，别自己算
    notBeforeHour: 8,      // 早于这个点不排队
    minIntervalSec: 1800,  // 同一账号的最小间隔
    maxDaily: 20,          // 每天最多跑几次
    backoff: [30, 60, 120], // 限频退避阶梯（秒）。没有 429 方言就写 []
  },

  hosts: api.hosts,        // 出口白名单，和 api.js 里的保持一致

  steps: [
    {
      id: "checkin",
      label: "每日签到",
      cost: 4,             // **上界**，不是均值。内核据此决定这一步这轮开不开
      async run(ctx) {
        const res = await api.submitCheckin(ctx);
        if (api.isAuthFail(res)) {
          return { status: "login_required", message: "登录态失效", credits: 0, cred: ctx.rotated || null };
        }
        const credited = api.num(api.dig(res.payload, "credit")) || 0;
        return {
          status: credited > 0 ? "claimed" : "already",
          message: credited > 0 ? `签到 +${credited}` : "今日已签到",
          credits: credited,
          // ⚠️ ctx.rotated **不是内核注入的**。内核构造 ctx 时没有这个字段
          //（见 runner.js 的 runOneAccount），它由你的工具在续期后自己挂上去，
          // 典型做法照抄 workbuddy/index.js 的 guard()：
          //     if (result.rotated) ctx.rotated = result.rotated;
          // 这里**必须**回传。少了它 → outcome.cred 是 undefined → 内核不落盘 →
          // 旧 refresh_token 已被上游消费 → 下一轮起稳定 login_required，
          // 而日志里看不出任何异常。这是本教程最容易踩的一个坑。
          cred: ctx.rotated || null,
        };
      },
    },
  ],

  // 可选：实现了才有「测试」按钮
  async validate(ctx) {
    const res = await api.readBalance(ctx);
    return { status: "ok", message: `余额 ${api.num(api.dig(res.payload, "points")) ?? "?"}` };
  },
};
```

### 4. 写 `steps` 时的硬约束

> **`config` 里的 `default` 不会预填。** 只有 `type: "select"` 才应用 `default`，
> 而配置保存固定走 `{ editing: true }` 分支（`accounts.js` 的 `coerceFields`），
> 那个分支在 `default` 之前就 `continue` 了。所以别指望它 —— 要兜底就在 `api.js` 里
> 写 `String(ctx.config.timeoutMs || "30000")`，`workbuddy` 与 `qoder` 都是这么做的。

| 硬约束 | 为什么 |
|---|---|
| **每个步骤必须可安全重入** | 一轮装不下会整步顺延、下一轮接着做。半途被掐断比不跑更糟，因为上游可能已部分生效 |
| **`cost` 必须是最坏开销** | 估低了会越过自限 45 撞上平台硬顶 50，那时**整次调用抛异常**，已经跑完的账号的收尾写入一起作废 |
| **工具不许自己算「今天」** | 一律用 `ctx.day`（内核按你的 `resetHour` 算好的逻辑日）。各家日界不同 |
| **`resetHour` 必须跟着上游的活动窗口走** | 它决定"几点算新的一天"。**已接的三家：Qoder = 10**（上游 10:00 前后才下发活动）、**Trae 与 WorkBuddy = 0**（上游按北京零点判）。填错的后果：Qoder 填 0 则 10 点前白打并烧掉 `pending`，另两家填 10 则过了零点仍算前一天、当场重复领取一遍 |
| **`resetHour` 与 `notBeforeHour` 不能互相顶替** | 前者管"哪一天"，后者管"几点才准跑"。缺前者会让整点在凌晨那轮集体重新到期，缺后者会让上午白打 |
| **凭据轮换走 `cred` 返回值** | 内核先并进内存（下一步要用），再**立刻**落盘。攒到收尾才写的话，中间任何一次掐死会把新旧两张串同时烧掉 |
| **旧串要在步骤开跑前拍快照** | 内核已经处理了：你返回的 `cred` 会被它与开跑前的值做差集，差出来的旧串本轮内一直脱敏 |
| **status 只能用 11 个词表里的** | 未识别的状态一律按 `error` 聚合（宁可多跑一次，不可少跑一次）。注意 `rate_limited` 必须显式产出，否则会掉进 `already`，且 `retryAt` 因状态不匹配根本不写 → 退避阶梯整个失效 |
| **不要在 `message` 里放凭据** | 内核会洗，但它不认识你这家的形态 |
| **`ctx` 里有这些** | `ctx.account`（含 `cred`）、`ctx.config`、`ctx.day`、`ctx.now`、`ctx.fetch`（记账 + 白名单）、`ctx.kv`、`ctx.tool`、`ctx.env`、`ctx.budget`、`ctx.trigger`。**`ctx.rotated` 不在其中** —— 那是工具自己挂上去的 |

### 5. 在注册表加一行

`src/tools/index.js`：

```js
import example from "./example/index.js";
// ...
const REGISTERED = [qoder, trae, workbuddy, example];
```

**只改这一个文件。** 界面、调度、日志、预算全部自动适配。

注册表的启动期自检会挡住这些低级错误：缺 `id`/`name`、`steps` 为空数组、
某步没有 `id`、某步 `cost` 不是正数、某步没实现 `run()`、`creds` 不是数组、
`schedule.backoff` 不是数组、没声明 `schedule`、没声明 `uidOf`、`uidOf` 不是函数、
字段 key 用了保留字 `pwd` / `label`。

> 自检**不检查** `icon` —— 那是可选字段。加新工具不必急着配图，没图就不渲染 `<img>`。

### 6. 写参数获取教程（推荐）

`src/ui/tutorials.js` 的 `TUTORIALS` 里加一个键，用户的「新增账号」与「工具配置」页
左侧就会显示分步的 PowerShell 脚本。**只改这一个文件，界面代码零改动**；
不加也能跑，只是用户得自己摸索怎么取凭据。

内容就是一段段可复制的脚本（`steps[]` 的 `code`）加字段对照表（`fields[]`）。
**脚本必须是真能跑的** —— 取不出值的教程比没有教程更坏，人会以为是自己弄错了。
所以写完请在真机上复制粘贴跑一遍，别只靠读。

### 7. 配图标（可选）

把你的 `.ico` 解成 64×64 PNG，内联成 data URI 写进 `src/ui/icons.js`
（`public/` + Static Assets 已被否决：那些文件由 Cloudflare 直接伺服、**绕过 Worker**，
也就绕过了 `?pwd=` 那道闸）。`src/ui/icons.js` 的注释里写了重跑方式与为什么是 64 而不是 256。

### 8. 验证

```bash
npm run check        # 现有 176 条必须全绿 —— 你没碰内核就不该有影响
```

加完把 `npx wrangler deploy --dry-run --outdir=dist` 也跑一遍，确认能打包
（`src/tools/<id>/` 没被 import 到的话不会进包；注册表那行 import 就是进包的前提）。

然后在测试里加一段。**照这三条纪律写**（每一条都对应一次真实翻车）：

1. **断言不能被 bug 的副产物满足。** Trae 那条测试断言 `/新凭据已写回/`，
   而那句话正是崩溃之后兜底逻辑写上去的 → 崩溃被当成成功。
2. **警惕短路。** `status >= 400 || api.codeOf(...)` 让桩测永远走不到 `codeOf`，
   未导出的函数活了整个阶段。桩数据要覆盖**成功路径**，不只是错误路径。
3. **"有记录"不等于"做过事"。** 被挡在预算闸外的账号照样写日志和进度键。
   断言必须指向"真的做成了一步"。

写完把被测代码退回去，确认对应测试会红。**只写新代码、只跑绿测试，等于没测。**

---

## 免费版配额与自限 45

Cloudflare 免费版的硬顶是 **50 个子请求 / 单次调用**，而 KV 的
`get` / `put` / `list` / `delete` **全算子请求**。

撞上 50 的后果不是"这次请求失败"，是**整次调用抛异常** ——
本轮已经跑完的账号的收尾写入一起作废。所以平台自限 `DEFAULT_LIMIT = 45`，留 5 次余量。

| 平台约束 | 由此产生的设计 |
|---|---|
| 50 子请求/调用 | 一次调用一本账，**页面渲染与定时任务共用**（`src/index.js` 的 `withLedger`） |
| 同上，HTTP 也只有 50 | `trackedFetch` 在账本空时**抛错**，而不是照发出去 |
| **5 条 cron/账号**（不是每 Worker） | 只占 1 条 `*/30`。"什么时候该跑谁"从 cron 表达式搬进数据（到期队列） |
| CPU 10 ms/调用 | 不在进程内 `sleep`；限频退避写成 KV 里的 `retryAt` 时间戳，跨轮生效 |
| KV 1000 写/天 | 调度索引**合并写回**（只写本轮真正改过的 uid）；进度只在"本轮要停下的那一刻"写一次 |
| `list` 每页 ≤ 1000 键 | `listUids` 分页取全；账号列表页 `cap = 20` 并**如实显示截断提示** |

### 帧常量（`src/core/runner.js`）

```
TOOL_FRAME = 6      每工具每轮：读配置 + 列账号 + 读调度索引 + 合并写回 + 心跳 …
ACCOUNT_FRAME = 6   每账号每轮：取锁 2 + 读进度 + 读凭据 + 存/删进度 + 写运行日志
ROUND_FRAME = 1     本轮汇总日志
FLAGS_FRAME = 1     读一次 v1:flags（单键存全部工具）
TAIL_RESERVE = 7    一步做完之后最多还要写的笔数，准入时就预留
```

`TAIL_RESERVE = 7` 是逐笔数出来的：凭据轮换写回 2 + 存/删进度 1 + 运行日志 1
+ 索引合并写回 2 + 心跳 1。这 7 笔**没有任何闸门**，所以允许一步开跑之前，
必须连它一起装得下。

有一条测试（`[审核P0-2c]`）用 `cost=32` 的判别值把这笔账钉住。实测边界：

| `TAIL_RESERVE` | 结果 |
|---|---|
| 4 / 5 | **红** —— 收尾那几笔无处可付，`used` 越过自限 |
| 6 / 7 | 绿 |
| 8 | **红** —— 过度保守，无谓地把装得下的步骤顺延掉 |

所以 6 就够，7 是留了一层余量。**改这个数之前先跑那条测试。**

---

## KV 键全表

所有键名都由 `src/core/store.js` 拼出来，**禁止在别处手写字面量**。

| 键 | 内容 | TTL |
|---|---|---|
| `v1:flags` | 工具停用标记 `{ "<tool>": { off, at } }` | 无 |
| `v1:tool:<id>` | 工具级配置 | 无 |
| `v1:acct:<id>:<uid>` | `{ label, cred, createdAt, updatedAt }`，**不含调度字段** | 无 |
| `v1:schedidx:<id>` | `{ day, entries: { <uid>: {...} } }` —— 到期判定只读这一键，与账号数无关 | 无 |
| `v1:step:<id>:<uid>` | `{ day, done: { <stepId>: {...} }, order: [] }`，跨 `day` 视为全未做 | 无 |
| `v1:lock:<id>:<uid>` | 触发时刻（秒），乐观锁，**从不主动删除**（靠 TTL 过期） | 90 s |
| `v1:heartbeat:<id>` | `{ at, trigger, due, ran }` | 无 |
| `v1:run:<tool>:<反转毫秒>:<uid>` | 账号运行日志正文 + metadata | 30 天 |
| `v1:tick:<反转毫秒>` | 整轮汇总 | 30 天 |

日志键的两个设计（`src/core/logs.js` 有完整说明）：

- **工具段前置** → `?tool=` 筛选是**一次带前缀的 list**（成本 1，与日志总量无关）；
  不带筛选的"全部"是「工具数 + 1」次 list（每个工具前缀各一次 + 汇总键一次）。
  实测 4 工具 × 3 账号 × 8000 条日志：`/runs` 5 次 list，`/runs?tool=demo` 1 次。
- **毫秒时间戳取反** → KV 按字典序 list，"最新"就是最小键，一页就是最近的

**已接受的代价**：撤掉一个工具后，它的历史日志不再出现在"全部"里。

---

## 常见问题

**打开页面全是 401 / 提示没设 PASSWORD？**
`PASSWORD` 是 Cloudflare 的 Secret，在面板上设，不在代码里。本地要用 `.dev.vars`。

**为什么口令在 URL 里？** 这是有意的选择，历史上被重复提出并拒绝过三次。
代价是口令会进 Cloudflare 平台侧的访问日志，换来的是零 JS、无 cookie、链接可直接转发。
本应用自己绝不把查询串写进任何日志，也不把口令渲染成任何可见文本。

**换个链接打开就 401？** 口令要跟着走，用 `/tool/qoder` 导航里的链接，
它们都带 `?pwd=`。不要手动改地址栏。

**积分对不上 / 显示 +0？** 这是最难发现的一类问题（不报错、不进日志、界面看不出来）。
三个已知来源：① 上游把积分换了字段；② 某项返回 0 而代码当成了"没给"；
③ 响应体形态变了。**首次真实部署时务必核对报出来的积分数与上游网页/App 上看到的实际入账数**，
不要只看状态是不是 `claimed`。

**「部分完成」是坏了？** 不是。那是"一轮没做完"，平台会把剩下的顺延到下一轮接着做
（这个调度单元是 **(账号 × 步骤)**，不是账号）。

**为什么点了「测试」之后凭据变了？** 测试只读状态、不发领取，**但可能顺带续期并写回新凭据**。
Trae 的换票就在 `validate()` 里。界面会如实提示"新凭据已写回"。
不写回的话，点一下测试就会把一个好账号点成需重新登录。

**一个账号的 cron 额度够吗？** 免费版是**每账号 5 条 cron**，不是每 Worker 5 条。
平台只占 1 条 `*/30`，"谁该跑"从 cron 表达式搬进了 KV 的到期队列，所以加第 4 个工具不占槽。

**界面里能改口令吗？** 不能，也**有意不做**。

**能一次把 JSON 粘进去自动拆凭据吗？** 不能，已明确拒绝。

---

## 与旧设计的差异

`设计方案.md` §3 逐条列了**旧三个 Worker 里被改掉的逻辑与原因**（接口事实继承，
判定与容错改掉）。接手前先扫一眼那张表，别照旧代码实现。

最要紧的三条：

| 旧代码的做法 | 本项目 | 为什么改 |
|---|---|---|
| 调度字段冗余进 `v1:acct:` 记录 | 独立键 `v1:schedidx:<tool>` | 冗余进 acct 意味着每轮要 `1 list + N get` 才能算出谁到期，账号多了直接撞 50 硬顶 |
| `v1:run:<UTCms>:<id>:<uid>` | `v1:run:<tool>:<反转毫秒>:<uid>` | 时间戳在键首 → 按工具筛要全表扫；工具段前置 → 一次带前缀的 list |
| 有 `v1:schema` 键 | **没有** | `v1:` 前缀直接写成 `store.js` 的 `SCHEMA` 常量 |

---

## 安全上的取舍

| 决定 | 理由 |
|---|---|
| 凭据只存 KV，**永不进日志** | 同一个 `message` 有 5 个出口（运行日志正文/metadata、进度键、手动执行响应、`runTick` 返回值）。只在落盘那一个出口洗，另外四个照样把票据带出去 |
| 脱敏按**声明的 secret 字段值全文替换** | 打码挡不住"上游把票据回显进 message"这种泄漏。替换含 `encodeURIComponent` 与 base64 形态 |
| 被轮换掉的**旧**凭据也要脱敏 | 三家的 `api.js` 都就地改写 `cred`，事后对比拿到的已经是新值 —— 而上游最爱回显的恰恰是"你刚才带来的那把票" |
| 脱敏有**熵门槛** | 误把枚举值标成 `secret` 时，`pro` 会让每次出现都变成 8 个黑点（`HTTP 401` → `HTTP 40••••••••`）。而 5 位短信码含数字、长度够，照样照洗 |
| 出口域名白名单，`trackedFetch` 有**拒答权** | 单文件部署后最大的风险是请求打到别家域名带上错凭据 |
| 日志只记 `pathname`，绝不记 `search` | 口令在查询串里 |
| 前端零 JavaScript，状态变更只用 POST | CSP `default-src 'none'`，脚本跑不起来 |
| 缺 KV 绑定直接 `throw` | 静默降级会让人以为平台在跑，其实什么都没存 |
