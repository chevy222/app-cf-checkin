# 签到台

一个 Cloudflare Worker，每天自动替领 Qoder / Trae / WorkBuddy / 69 云四家的免费额度。

**给使用者**：部署与日常操作看本文档就够。
**给开发者**：架构、契约、加新工具的完整模版、预算与 KV 设计都在 [`设计方案.md`](设计方案.md)。

---

## 目录

- [部署](#部署)
- [本地跑](#本地跑)
- [界面导览](#界面导览)
- [凭据怎么取](#凭据怎么取)
- [停用某个工具](#停用某个工具)
- [常见问题](#常见问题)

---

## 部署

准备两样东西：一个 Cloudflare 账号（免费版就够），电脑上装好
[Node.js](https://nodejs.org)（LTS 版本即可）。

**第 0 步 · 拿到代码**：在仓库页面点 **Code → Download ZIP**，解压到任意目录。
后面所有命令都在这个解压出来的文件夹里执行 —— Windows 用户：资源管理器进入该
文件夹，在地址栏输入 `powershell` 回车，就打开了以它为当前目录的终端。

**第 1 步 · 装依赖**

```bash
npm install
```

**第 2 步 · 登录 Cloudflare**

```bash
npx wrangler login
```

会弹出浏览器让你授权，点 Allow 即可。

**第 3 步 · 建一个自己的 KV 存储，填进配置**

```bash
npx wrangler kv namespace create CHECKIN_KV
```

命令输出里有一行 `id = "…"`，用它**替换掉 `wrangler.toml` 里 `kv_namespaces`
段现有的那个 id** —— 那是原作者自己的命名空间，你的账号用不了，不换部署必失败。

**第 4 步 · 改掉域名配置（不改这一步，部署会失败）**

`wrangler.toml` 里有几行是**原作者自己的**，你的账号用不了：

```toml
routes = [
  { pattern = "checkin.chevy.dpdns.org", custom_domain = true }
]
workers_dev = false
```

二选一：

- **用 Cloudflare 送的免费域名**（最省事）：把整个 `routes` 段删掉（或整段注释掉），
  并把 `workers_dev` 改成 `true`。部署完拿到的是
  `https://checkin.<你的子域>.workers.dev`。
- **绑自己的域名**：把 `pattern` 换成你自己的域名（该域名需已托管在这个
  Cloudflare 账号下，否则 Cloudflare 无权为它签证书），`workers_dev` 保持 `false`。

不改的话，`wrangler deploy` 会因为「这个域名不属于你的账号」直接失败。

**第 5 步 · 设访问口令**

```bash
npx wrangler secret put PASSWORD
```

回车后输入你想设的口令再回车。这是打开界面的钥匙，别用弱口令，
也**不要把它写进任何文件或贴给任何人**。

**第 6 步 · 部署**

```bash
npm run deploy
```

输出里的地址就是你的签到台 —— 第 4 步选免费域名的话是
`https://checkin.<你的子域>.workers.dev`，绑自有域名的话就是你填的那个。
浏览器打开、输入口令，按「新增账号」页左侧的教程把四家账号加进去，当天就能开始领。

这个命令会先把页面底部的版本号重算成**当前北京时间**（格式 `yyyy-MM-dd:HHMM`，
比如 `2026-10-02:1447`）—— 版本号本身就是发布时刻，刷新页面看一眼就知道
有没有更新上。然后再执行部署。

<details>
<summary>单文件粘贴（备用方式）</summary>

```bash
npx wrangler deploy --dry-run --outdir=dist
```

结尾那行 `--dry-run: exiting now.` 是「到此为止、不真的部署」的正常提示，**不是报错**。
`dist/` 里会出来 3 个文件，**只需要其中的 `index.js`**，另外两个（`.map` 与
`README.md`）不用管。在 Cloudflare 控制台的 Workers 编辑器里新建一个 Worker，
把 `index.js` 的内容整个粘贴进去；再在面板上**创建一个 KV 命名空间**并绑定为
`CHECKIN_KV`，配好 cron（`*/30 * * * *`），并在「设置 → 变量和机密」里设
Secret `PASSWORD`。

</details>

---

## 本地跑

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

所有页面都在口令闸后，页面里**没有一行 JavaScript**。

| 页面 | 作用 |
|---|---|
| 总览 | 工具卡片 + 每家的停用开关 + 最近 12 条运行流 |
| 工具管理 | 账号列表、红条、步骤色块、逐账号的「测试」「执行」「编辑」「删除」 |
| 工具配置 | 工具级配置（Qoder 的设备标识填在这里） |
| 新增 / 编辑账号 | 表单按每个工具需要的字段自动生成，左侧带取值的分步教程 |
| 运行日志 | 列表保留 30 天，可按工具筛选，点进去看步骤明细 |
| 说明 | 状态词汇表与停用语义 |

### 12 个状态词

`成功领取` · `今日已领` · `正常` · `活动未开` · `待下发` · `等待中` · `部分完成` · `未开始`
· `限频` · `顺延` · `需重新登录` · `失败`

「部分完成」不是坏了 —— 那是"一轮没做完"，剩下的会自动顺延到下一轮接着做。

「待下发」和「等待中」都不用你动手，区别只在什么时候再看一眼：前者是上游**还没**
把奖励放出来（一小时后再看），后者是上游的事**还没走完**（比如猫猫正在路上）或
**这次没答上来**（上游抖动了一下），下一轮就再看。

### 「测试」与「执行」的区别（很容易搞混）

- **测试** = 只读登录态，不发领取。**但可能顺带续期并写回新凭据**，
  界面会如实提示"新凭据已写回"。这很正常，不是出错。
- **执行** = 真的去领。你点了就是要现在跑，所以它跳过时间闸，但不跳预算。

---

## 凭据怎么取

四个工具的凭据都在**本机的客户端上**取值，平台不参与 —— 这一点是安全设计的核心，
也意味着**全程不需要 F12 抓包**。69 云例外：它的凭据就是网站的登录邮箱和密码。

下面每一段脚本都整段复制到 **PowerShell** 回车即可（Windows）。
**界面上也有同一份教程**（「新增账号」与「工具配置」页左侧），脚本抄自那里，两边一致。

**令牌到期时间一律不用填** —— 平台从令牌自己解出来。

| 工具 | 令牌从哪来 | 设备标识从哪来 |
|---|---|---|
| Qoder | 脚本解密客户端的登录凭据文件 | 脚本跑客户端自带的 `runtime-info.exe` |
| Trae | 登录后浏览器跳到的那条 `127.0.0.1` 地址（页面打不开是**正常的**），脚本从里面解析 | 客户端 `storage.json` 里的 8–16 位数字 |
| WorkBuddy | 官方短信登录接口换明文 Token | 无（uid 平台自己解） |
| 69 云 | 机场网站的登录邮箱和密码 | 无（uid 就是邮箱） |

### Qoder

Qoder 服务端要求请求带一整套设备头才下发每日活动，**缺了它们（尤其是
`Cosy-ClientType: 10`）活动列表会直接返回空**。云端跑不了 Windows exe，
所以要在装过 Qoder 客户端的机器上取一次。

**第 1 步**：设安装目录，就是包含 `Qoder CN.exe` 的那个文件夹：

```powershell
$qoderRoot = "D:\Program\Qoder CN"
```

**第 2 步**：整段复制回车。它会跑客户端自带的 `runtime-info.exe` 取设备标识，
并用 DPAPI 解密登录凭据：

```powershell
& {
if (-not $qoderRoot) { throw "请先执行 `$qoderRoot = `"你的Qoder安装目录`" 设置路径" }

# DPAPI 解密辅助（用于解 Token）
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Dpapi {
    [StructLayout(LayoutKind.Sequential)] struct BLOB { public int cb; public IntPtr pb; }
    [DllImport("crypt32.dll", SetLastError=true)] static extern bool CryptUnprotectData(ref BLOB i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref BLOB o);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr m);
    public static byte[] Unprotect(byte[] data) {
        var bi = new BLOB { cb = data.Length, pb = Marshal.AllocHGlobal(data.Length) };
        Marshal.Copy(data, 0, bi.pb, data.Length);
        var bo = new BLOB();
        if (!CryptUnprotectData(ref bi, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, ref bo)) {
            Marshal.FreeHGlobal(bi.pb); throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        Marshal.FreeHGlobal(bi.pb);
        var r = new byte[bo.cb]; Marshal.Copy(bo.pb, r, 0, bo.cb); LocalFree(bo.pb); return r;
    }
}
"@

$dataDir = Join-Path $env:APPDATA "com.qodercn.app.stable"

# 1. runtime-info.exe（设备标识）
$umidExe = Join-Path $qoderRoot "resources\umid\runtime-info.exe"
if (-not (Test-Path $umidExe)) { throw "找不到 $umidExe，请检查 `$qoderRoot 是否正确" }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $umidExe; $psi.Arguments = "--account-stdin"
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
$p.StandardInput.Close() | Out-Null
$out = $p.StandardOutput.ReadToEnd()
$p.WaitForExit(40000) | Out-Null
$ri = ($out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1) | ConvertFrom-Json

# 2. 版本号
$cosyVersion = ""
$mf = Join-Path $qoderRoot "resources\build-manifest.json"
if (Test-Path $mf) { try { $cosyVersion = [string]((Get-Content $mf -Raw | ConvertFrom-Json).productVersion) } catch {} }

# 3. machine-id
$cosyMachineId = ""
$midFile = Join-Path $dataDir "auth.machine-id"
if (Test-Path $midFile) { $cosyMachineId = (Get-Content $midFile -Raw).Trim() }

# 4. 架构
$arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM|arm64|aarch64") { "aarch64" } else { "x86_64" }

# 5. Token 解密（DPAPI + AES-256-GCM）
$sess = $null
$tokenNote = ""
$authFile = Join-Path $dataDir "auth.v1.dat"
$stateFile = Join-Path $dataDir "Local State"
if ((Test-Path $authFile) -and (Test-Path $stateFile)) {
    try {
        $raw = [IO.File]::ReadAllBytes($authFile)
        if ($raw.Length -ge 60 -and [Text.Encoding]::ASCII.GetString($raw, 0, 3) -eq "v10") {
            $st = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $ek = [Convert]::FromBase64String($st.os_crypt.encrypted_key)
            $key = [Dpapi]::Unprotect($ek[5..($ek.Length - 1)])
            $nonce = $raw[3..14]; $ct = $raw[15..($raw.Length - 17)]; $tag = $raw[($raw.Length - 16)..($raw.Length - 1)]
            $pt = New-Object byte[] $ct.Length
            $gcm = [System.Security.Cryptography.AesGcm]::new($key)
            $gcm.Decrypt($nonce, $ct, $tag, $pt)
            $sess = [Text.Encoding]::UTF8.GetString($pt) | ConvertFrom-Json
        }
    } catch { $tokenNote = "Token 解密出错：$($_.Exception.Message)" }
} else {
    $tokenNote = "找不到 $dataDir\auth.v1.dat 或 Local State，Qoder 桌面端登录过吗？"
}

# === 输出设备标识 ===
Write-Host ""
Write-Host "====== 设备标识（填到「工具配置」）======" -ForegroundColor Green
Write-Host "COSY_CLIENT_TYPE      = 10"
Write-Host "COSY_MACHINE_OS       = ${arch}_windows"
Write-Host "COSY_MACHINE_HOSTNAME = $env:COMPUTERNAME"
if ($cosyVersion)     { Write-Host "COSY_VERSION          = $cosyVersion" }
if ($cosyMachineId)   { Write-Host "COSY_MACHINE_ID       = $cosyMachineId" }
if ($ri.machineToken) { Write-Host "COSY_MACHINE_TOKEN    = $($ri.machineToken)" }
if ($ri.machineCode)  { Write-Host "COSY_MACHINE_CODE     = $($ri.machineCode)" }
if ($ri.machineType)  { Write-Host "COSY_MACHINE_TYPE     = $($ri.machineType)" }
Write-Host "=============================================" -ForegroundColor Green

# === 输出 Token ===
if ($sess -and $sess.token) {
    Write-Host ""
    Write-Host "====== 登录凭据（填到「新增账号」）======" -ForegroundColor Cyan
    Write-Host "已读取：com.qodercn.app.stable（有效期至 $($sess.expiresAt)）"
    Write-Host "TOKEN:$($sess.token)"
    Write-Host "REFRESH:$($sess.refreshToken)"
    Write-Host "=========================================" -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "（Token 未提取到——$tokenNote）" -ForegroundColor Yellow
    Write-Host "设备标识已正常输出，不影响签到配置。" -ForegroundColor Yellow
}
}
```

**第 3 步**：两段输出分别填到对应位置 ——

- **设备标识**（8 个 `COSY_*`）填到「工具配置」页
- **`TOKEN:` / `REFRESH:`** 两行填到「新增账号」的表单里

> 若 `TOKEN:` 那行**不是** `eyJ` 开头的长串，而是 `dt--` 开头的短串（新版客户端
> 给的是设备令牌），表单里会多一个「账号标识」栏：给它起个固定代号（如 `main`）
> 填上即可，建号后不要再改。

⚠️ **设备标识的有效期是本方案唯一的不确定性**。如果它是长期有效的，配一次即可；
如果会过期，活动列表会突然变空，届时重跑第 2 步更新「工具配置」即可。

### Trae

**第 1 步 · 取出 Aha 设备号**（8–16 位数字）。三个候选路径对应 SOLO 国内版 /
Trae 国内版 / Trae 国际版，哪个存在就打印哪一行：

```powershell
& {
$paths = @(
  "$env:APPDATA\TRAE SOLO CN\User\globalStorage\storage.json",
  "$env:APPDATA\Trae CN\User\globalStorage\storage.json",
  "$env:APPDATA\Trae\User\globalStorage\storage.json"
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    Select-String -Path $p -Pattern 'iCubeAuthInfo://icube-dc:(\d{8,16})' -AllMatches |
      ForEach-Object { $_.Matches } |
      ForEach-Object { "找到设备号: " + $_.Groups[1].Value }
  }
}
}
```

**第 2 步 · 打开登录链接**。复制这行到 PowerShell 回车，会用默认浏览器打开 Trae 登录页：

```powershell
Start-Process "https://api.trae.cn/ide/v1/auth/authorize?login_version=1&auth_from=solo&login_channel=native_ide&plugin_version=0.1.43&auth_type=local&client_id=en1oxy7wnw8j9n&redirect=0&auth_callback_url=http://127.0.0.1:18080/authorize&machine_id=&device_id=&x_device_brand=PC&x_device_type=PC&x_os_version=1.0&x_app_version=0.1.43&x_app_type=stable"
```

> 链接**现取现用**，每次都会生成新的。

**第 3 步 · 登录，然后复制那条打不开的地址**。用手机号 + 验证码登录**与第 1 步
设备号同一个账号**。登录成功后浏览器会跳到 `http://127.0.0.1:18080/authorize?...`
开头的页面，显示「无法访问此网站」—— **这是正常的**，本机没有服务在监听。

在地址栏 `Ctrl+A` → `Ctrl+C`（macOS `Cmd+A` → `Cmd+C`），把这一整条完整 URL 复制下来。
它很长，带 `refreshToken=...` 等参数；在浏览器里复制不会被截断。

**第 4 步 · 解析出令牌**。把下面第一行的引号内换成你刚复制的那条完整 URL，整段回车：

```powershell
& {
$cb = "粘贴你复制的整条 127.0.0.1 开头的 URL"

# 与服务端同一套解析：只做一次 %XX 解码，不做 '+' → 空格转换
# （searchParams.get 会把字面量 '+' 解成空格，令牌里含 '+' 会被悄悄破坏）
$u = [Uri]$cb.Trim()
# 查询串与 # 后的片段都试（有的浏览器把参数放 hash 里），.Query / .Fragment 自带 ? 与 # 前缀
$raw = ($u.Query.TrimStart('?') + $u.Fragment.TrimStart('#'))
function Q($n) {
  # 这里必须用双引号：$n 要插值。(?:^|&) 里的 $ 后面跟的是 ^ ，不会被当成 $& 转义
  $m = [regex]::Match($raw, "(?:^|&)$n=([^&]*)")
  if (-not $m.Success) { return "" }
  try { return [Uri]::UnescapeDataString($m.Groups[1].Value) } catch { return $m.Groups[1].Value }
}
function J($v) {
  if (-not $v) { return $null }
  foreach ($t in @($v, [Uri]::UnescapeDataString($v))) {
    try { $o = $t | ConvertFrom-Json; if ($o) { return $o } } catch {}
  }
  return $null
}

$info = J (Q "userInfo")
$jwt  = J (Q "userJwt")
$rt   = Q "refreshToken"
if (-not $rt -and $jwt) { $rt = $jwt.RefreshToken }

Write-Host ""
Write-Host "====== 填到「新增账号」======" -ForegroundColor Cyan
Write-Host "Access Token : $($jwt.Token)"
Write-Host "Refresh Token: $rt"
Write-Host "=================================" -ForegroundColor Cyan
Write-Host "还有一栏「Aha 设备号」不在上面 —— 它填第 1 步从 storage.json 拿到的那个 8–16 位数字" -ForegroundColor DarkGray
if (-not $rt) { Write-Host "（回调里没有 refreshToken —— 请确认整条 URL 都复制了）" -ForegroundColor Yellow }
}
```

**第 5 步**：把 `Access Token` 与 `Refresh Token` 填到「新增账号」，设备号填第 1 步那个。
工具级配置里的 `clientId` 与 `appVersion` **必填**（从客户端里抄）。

⚠️ **设备号必须是真实的。** 签到风控按它判定，随手编一个（哪怕 8–16 位格式看着对）
会每天稳定返回「服务器繁忙」—— 看着像限频，其实是设备号错了。

### WorkBuddy

新版桌面端把凭据文件加密了（复制不出来），所以改用官方短信登录接口换明文 Token ——
值在本机拿，不经过 Cloudflare。**界面不发短信验证码**（这是有意的决定）。

**第 1 步 · 发验证码**。把 `13800000000` 换成你的手机号，返回 `code: 0` 即发送成功：

```powershell
Invoke-RestMethod -Uri "https://www.workbuddy.cn/v2/plugin/login/send-sms" `
  -Method Post -ContentType "application/json" -Body '{"phone":"13800000000"}'
```

**第 2 步 · 用验证码换 Token**。把手机号和 `123456` 换成实际收到的验证码
（有效期约 5 分钟）：

```powershell
& {
$r = Invoke-RestMethod -Uri "https://www.workbuddy.cn/v2/plugin/login/token" `
  -Method Post -ContentType "application/json" `
  -Body '{"login_method":"phone","phone":"13800000000","sms_code":"123456"}'

Write-Host ""
Write-Host "====== 填到「新增账号」======" -ForegroundColor Cyan
Write-Host "Access Token : $($r.data.accessToken)"
Write-Host "Refresh Token: $($r.data.refreshToken)"
Write-Host "=================================" -ForegroundColor Cyan
}
```

**第 3 步**：两个令牌填进表单就行，到期时间平台会自动从 `exp` 解出来。多账号时每个号都要走一遍这两步。

新版桌面端可能给的是一段包装格式（`{"$wbEncrypted":1,…}`），**原样粘进表单就行**，
平台会自动展开。

⚠️ **开盲盒每调一次服务端就扣 10 点能量**，所以平台每轮会自动限制次数。
如果你看到「已开 N 个」比预期多，说明取到的可用次数变了，值得看一眼。

### 69 云

69 云是 SSPanel 架构的机场，签到凭据就是网站的登录邮箱和密码——不需要抓包、不需要客户端，能登录网页就能签到。签到台会自动保存登录后的 Cookie，失效时用邮箱密码重新登录，不需要手动维护。

**第 1 步 · 确认能登录官网**。在浏览器里打开 **https://69yun69.com**，用你的邮箱密码登录，能进到用户中心就说明凭据有效。

**第 2 步 ·（可选）用 PowerShell 验证登录接口**。把 `your@email.com` 和 `your_password` 换成你自己的，输出「登录成功」就说明凭据正确：

```powershell
& {
  $email = "your@email.com"
  $pass  = "your_password"
  $body = @{ email = $email; passwd = $pass; remember_me = "on"; code = "" } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Uri "https://69yun69.com/auth/login" `
      -Method Post -ContentType "application/json" -Body $body
    if ($r.ret -eq 1) {
      Write-Host "登录成功！把邮箱和密码填进签到台即可" -ForegroundColor Green
    } else {
      Write-Host "登录失败: $($r.msg)" -ForegroundColor Red
    }
  } catch {
    Write-Host "请求失败: $_" -ForegroundColor Red
  }
}
```

**第 3 步 · 填到表单**。邮箱填进「邮箱」栏，密码填进「密码」栏。「会话 Cookie」那一栏留空就行——签到台第一次签到时会自动登录并保存。

> Cookie 自动管理：第一次签到时如果没有 Cookie，会自动走登录流程并保存；之后每次直接用 Cookie，失效时自动重新登录。

---

## 停用某个工具

总览页每张卡片上有一个独立开关，**只停一家，不影响其它，也没有"全部停用"总开关**。

- 停用后：定时任务与「执行」都跳过它，别的工具照常
- **账号、凭据与当天进度一条都不删** —— 重新打开就从停下的那一步接着做
- 停用中：卡片变暗，「执行」按钮隐藏，保留「测试」「编辑」「删除」
- 停用中红条不亮（下线中的工具报错不是你的待办）
- 跨过当天的额度重置时刻再打开，按新的那一天从头算

---

## 常见问题

**打开页面全是 401 / 提示没设 PASSWORD？**
`PASSWORD` 是 Cloudflare 的 Secret，在面板上设，不在代码里。本地要用 `.dev.vars`。

**为什么口令在 URL 里？** 这是有意的选择。代价是口令会进 Cloudflare 平台侧的访问日志，
换来的是无 cookie、链接可直接转发。本应用自己绝不把查询串写进任何日志，
也不把口令渲染成任何可见文本。

**换个链接打开就 401？** 口令要跟着走，用界面里导航的链接，它们都带口令。
不要手动改地址栏。

**积分对不上 / 显示 +0？** 这是最难发现的一类问题（不报错、界面看不出来）。
三个已知来源：① 上游把积分换了字段；② 某项返回 0 而代码当成了"没给"；
③ 响应体形态变了。**首次部署后请核对报出来的积分数与上游 App 里看到的实际入账数**，
不要只看状态是不是"成功领取"。

**「本次到账上游未回」是什么意思？** 上游这一轮没把"领到多少"回给我们，所以平台不报数字 ——
这里刻意**不写 `+0`**：`0` 是"确实没领到"，"没回"是"不知道"，两者不是一回事。
消息里会跟上"当前签到积分 N（领取前 M）"当排查依据：M 显示"未给"= 领取前上游没给这个字段；
M 与 N 相同 = 上游入账是异步的，或那个字段本来就不是余额口径。要确认实际入账，去上游 App 看。

**为什么点了「测试」之后凭据变了？** 见上面「测试与执行的区别」。

**一个账号的定时任务额度够吗？** 平台只占 1 条 cron 任务，
"谁该跑"记在数据里而不是 cron 表达式里，所以加工具不占槽。

**界面里能改口令吗？** 不能，也**有意不做**。

**能一次把整段 JSON 粘进去自动拆凭据吗？** 不能，已明确拒绝。
