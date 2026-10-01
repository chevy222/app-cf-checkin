// 参数获取教程。
//
// 为什么放在 ui/ 而不是让工具自己声明：教程是**跨工具共享的排版逻辑**
// （步骤、代码块、注意事项、字段对照表），差别只在内容。把内容塞进
// tools/<id>/index.js 会让三个工具各写一遍同样的 HTML 拼装 —— 那正是
// "界面层不认识具体工具"这条承诺要避免的东西。
//
// 这里是**数据**，不是分支：界面按 TUTORIALS[tool.id] 取一份，没有数据就没有这一块。
// 所以加第 4 个工具不需要改这个文件，也不需要改任何界面代码。
//
// 三家的取法（与三个前身高 Worker 的做法一致，值全在本机客户端上，不需要 F12 抓包）：
//   · Qoder     —— 跑客户端自带的 runtime-info.exe 取设备标识，DPAPI 解密登录凭据
//   · Trae      —— 打开登录页 → 浏览器跳到 127.0.0.1 的回调 → PowerShell 解析出参数
//   · WorkBuddy —— 官方短信登录接口换明文 Token

// 一个步骤块。code 非空时渲染成 <pre><code>。
const step = (title, body, code) => ({ title, body, code });
const note = (kind, text) => ({ kind, text });

export const TUTORIALS = {
  qoder: {
    intro: "Qoder 服务端从 2026-09-26 起要求请求带一整套设备头才下发每日活动，"
      + "缺了它们（尤其是 Cosy-ClientType: 10）活动列表会直接返回空。"
      + "Cloudflare Worker 跑在云端、没法执行 Windows exe，所以要在装过 Qoder 客户端的机器上取一次。",
    steps: [
      step("先设 Qoder 安装目录",
        "就是包含 `Qoder CN.exe` 的那个文件夹，改成你自己的路径。"),
      step("整段复制到 PowerShell 回车",
        "在装有 Qoder 桌面端的 Windows 上打开 **PowerShell 7**（`pwsh`，开始菜单搜 PowerShell）。"
        + "脚本会读上面设的 `$qoderRoot`，没设会报错提示。",
        `$qoderRoot = "D:\\Program\\Qoder CN"

& {
if (-not $qoderRoot) { throw "请先执行 \`$qoderRoot = \`"你的Qoder安装目录\`" 设置路径" }

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
$umidExe = Join-Path $qoderRoot "resources\\umid\\runtime-info.exe"
if (-not (Test-Path $umidExe)) { throw "找不到 $umidExe，请检查 \`$qoderRoot 是否正确" }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $umidExe; $psi.Arguments = "--account-stdin"
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
$p.StandardInput.Close() | Out-Null
$out = $p.StandardOutput.ReadToEnd()
$p.WaitForExit(40000) | Out-Null
$ri = ($out -split "\`r?\`n" | Where-Object { $_.Trim() } | Select-Object -Last 1) | ConvertFrom-Json

# 2. 版本号
$cosyVersion = ""
$mf = Join-Path $qoderRoot "resources\\build-manifest.json"
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
    $tokenNote = "找不到 $dataDir\\auth.v1.dat 或 Local State，Qoder 桌面端登录过吗？"
}

# === 输出设备标识 ===
Write-Host ""
Write-Host "====== 设备标识（填到「工具配置」）======" -ForegroundColor Green
Write-Host "COSY_CLIENT_TYPE      = 10"
Write-Host "COSY_MACHINE_OS       = \${arch}_windows"
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
}`),
      step("把两段输出分别填到对应位置",
        "**设备标识**（8 个 `COSY_*`）填到本工具的「工具配置」页；"
        + "**TOKEN / REFRESH** 填到「新增账号」的表单里。到期时间不用填 —— "
        + "TOKEN 是 `eyJ` 开头的长串时平台自己解。"
        + "若 TOKEN 是 `dt--` 开头的短串（新版客户端的设备令牌），表单会多一个「账号标识」栏："
        + "给它起个固定代号（如 `main`）填上即可，建号后不要再改。"),
    ],
    notes: [
      note("warn", "设备标识的有效期是本方案唯一的不确定性。如果 `Cosy-MachineToken` 是长期有效的，"
        + "配一次即可；如果它会过期，活动列表会突然变空，届时重新跑上面那段命令更新「工具配置」即可。"),
      note("info", "活动列表变空的三个原因（上游分不开）：今天没下发活动、"
        + "这个账号不在资格范围内、设备标识过期。平台会把这三种都报成「活动未开」并在日志里列全。"),
    ],
    fields: [
      ["`COSY_CLIENT_TYPE`", "固定值 `10`", "**缺这个活动列表直接为空**"],
      ["`COSY_MACHINE_TOKEN`", "runtime-info.exe", "设备令牌（最可能过期的那个）"],
      ["`COSY_MACHINE_CODE`", "runtime-info.exe", "设备编码"],
      ["`COSY_MACHINE_TYPE`", "runtime-info.exe", "设备类型"],
      ["`COSY_MACHINE_OS`", "系统架构", "如 `x86_64_windows`"],
      ["`COSY_MACHINE_HOSTNAME`", "本机主机名", ""],
      ["`COSY_MACHINE_ID`", "`auth.machine-id`", ""],
      ["`COSY_VERSION`", "build-manifest.json", "Qoder 客户端的版本号"],
    ],
  },

  trae: {
    intro: "Trae 的凭据只能从登录回调里拿：登录页会跳到一个 `http://127.0.0.1:18080/authorize?...` "
      + "的地址（那个页面打不开是**正常的**，本机没有服务在监听），整条 URL 里就带着令牌。"
      + "设备号另有一份，在客户端的 `storage.json` 里。",
    steps: [
      step("取出 Aha 设备号（8–16 位数字）",
        "打开一个 PowerShell（Windows）或终端（macOS），整段复制回车。三个候选路径对应"
        + " SOLO 国内版 / Trae 国内版 / Trae 国际版，哪个存在就打印哪一行。",
        `& {
$paths = @(
  "$env:APPDATA\\TRAE SOLO CN\\User\\globalStorage\\storage.json",
  "$env:APPDATA\\Trae CN\\User\\globalStorage\\storage.json",
  "$env:APPDATA\\Trae\\User\\globalStorage\\storage.json"
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    Select-String -Path $p -Pattern 'iCubeAuthInfo://icube-dc:(\\d{8,16})' -AllMatches |
      ForEach-Object { $_.Matches } |
      ForEach-Object { "找到设备号: " + $_.Groups[1].Value }
  }
}
}`),
      step("打开登录链接",
        "复制下面这行到 PowerShell 回车，它会直接用默认浏览器打开 Trae 登录页。"
        + "链接**现取现用**，每次都会生成新的。",
        `Start-Process "https://api.trae.cn/ide/v1/auth/authorize?login_version=1&auth_from=solo&login_channel=native_ide&plugin_version=0.1.43&auth_type=local&client_id=en1oxy7wnw8j9n&redirect=0&auth_callback_url=http://127.0.0.1:18080/authorize&machine_id=&device_id=&x_device_brand=PC&x_device_type=PC&x_os_version=1.0&x_app_version=0.1.43&x_app_type=stable"`),
      step("登录，然后复制那条打不开的地址",
        "用手机号 + 验证码登录**与上面设备号同一个账号**。登录成功后浏览器会跳到"
        + " `http://127.0.0.1:18080/authorize?...` 开头的页面，显示「无法访问此网站」—— 正常。"
        + "在地址栏 `Ctrl+A` → `Ctrl+C`（macOS `Cmd+A` → `Cmd+C`），"
        + "把这一整条完整 URL 复制下来（很长，带 `refreshToken=...` 等参数；在浏览器里复制不会被截断）。"),
      step("用 PowerShell 从回调地址里解析出三个值",
        "把下面第一行的引号内换成你刚复制的那条完整 URL，整段回车。"
        + "它会打印出令牌、refresh token 和 Aha 设备号 —— 三个值直接对应表单的三个字段。",
        `& {
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
Write-Host "Aha 设备号   : 填第 1 步拿到的那个"
Write-Host "=================================" -ForegroundColor Cyan
if (-not $rt) { Write-Host "（回调里没有 refreshToken —— 请确认整条 URL 都复制了）" -ForegroundColor Yellow }
}`),
    ],
    notes: [
      note("warn", "**设备号必须是真实的。** 签到风控按它判定，随手编一个（哪怕 8–16 位格式看着对）"
        + "会每天稳定返回 9074「服务器繁忙」—— 看着像限频，其实是设备号错了。"),
      note("info", "本工具的 Aha 设备号接受 **8–16 位**，与旧脚本一致。"
        + "如果你的号是 16 位以外的长度、且录入时被拒，把实际位数告诉我。"),
      note("info", "uid 不用你填：保存时平台会打一次 `GetUserInfo` 拿 `UserID` 当标识"
        + "（代价是花掉 1 次子请求，值得换来键名与上游认的那个号一致）。"),
    ],
    fields: [
      ["`x-device-id`", "客户端 `storage.json`", "8–16 位数字，签到风控按它判定"],
      ["`x-cloudide-token`", "登录回调 URL", "换票与用户信息用这个头"],
      ["`Cloud-IDE-JWT`", "登录回调 URL", "签到与额度用这个头（与上面**不是同一个**）"],
    ],
  },

  workbuddy: {
    // 提到 auth.v1.dat 时必须说清它是 WorkBuddy 自己那一份：Qoder 教程里解的是
    // 同名的另一个文件，只写文件名会让人以为串台了（用户反馈过这一点）。
    // 目录不复述 —— 两家目录不同这个事实已经够用，而具体路径没核实过就不写。
    intro: "新版 WorkBuddy 桌面端把凭据文件加密了（WorkBuddy 自己那份 `auth.v1.dat`，"
      + "DPAPI + AES-256-GCM），复制不出来 —— 它和 Qoder 教程里那个同名文件不是一份东西，目录不同。"
      + "改用官方短信登录接口换明文 Token：值在本机拿，不经过 Cloudflare。",
    steps: [
      step("发验证码",
        "把 `13800000000` 换成你的手机号。返回 `code: 0` 即发送成功。",
        `Invoke-RestMethod -Uri "https://www.workbuddy.cn/v2/plugin/login/send-sms" \`
  -Method Post -ContentType "application/json" -Body '{"phone":"13800000000"}'`),
      step("用验证码换 Token",
        "把手机号和 `123456` 换成实际收到的验证码（有效期约 5 分钟）。"
        + "执行后输出两行值，复制保存好 —— 下一步要填。",
        // 刻意不解 uid：uid 平台自己从令牌的 sub 解，脚本再解一遍只是让人
        // 多看一行字，还要多三行 base64 拼装（而 WorkBuddy 的票据形态会变，
        // 拼错了反而让人以为令牌坏了）。
        `& {
$r = Invoke-RestMethod -Uri "https://www.workbuddy.cn/v2/plugin/login/token" \`
  -Method Post -ContentType "application/json" \`
  -Body '{"login_method":"phone","phone":"13800000000","sms_code":"123456"}'

Write-Host ""
Write-Host "====== 填到「新增账号」======" -ForegroundColor Cyan
Write-Host "Access Token : $($r.data.accessToken)"
Write-Host "Refresh Token: $($r.data.refreshToken)"
Write-Host "=================================" -ForegroundColor Cyan
}`),
      step("填到表单",
        "两个令牌填进表单就行 —— 令牌到期时间平台会自动从 `exp` 解出来。"),
    ],
    notes: [
      note("info", "多账号时每个号都要走一遍这两步。"),
    ],
    fields: [
      ["`Authorization: Bearer`", "第 2 步的 `Access Token`",
        "到期时间平台自动从 `exp` 解。新版桌面端可能给的是包装格式 `{\"$wbEncrypted\":1,\"envelope\":\"…\"}`，原样粘进来即可，平台会自动展开"],
      ["`X-Refresh-Token`", "第 2 步的 `Refresh Token`", "旧串用过一次即废，续期后平台当场写回"],
    ],
  },
};

// 渲染成 HTML。刻意保持得比表格窄一点 —— 界面是给"填表时瞄一眼"用的，
// 不是让人在这里通读文档；完整说明在 README 与设计文档里。
export function renderTutorial(tool) {
  const t = TUTORIALS[tool.id];
  if (!t) return "";
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // 极小的行内标记：**粗体** 与 `代码` —— 教程里只需要这两种。
  const rich = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  const steps = t.steps.map((s, i) => `<div class="tut">
      <div class="tut-h"><span class="tut-n">${i + 1}</span>${rich(s.title)}</div>
      ${s.body ? `<p class="tut-b">${rich(s.body)}</p>` : ""}
      ${s.code ? `<pre class="tut-c">${esc(s.code)}</pre>` : ""}
    </div>`).join("");

  const notes = (t.notes || []).map((n) => `<div class="alert ${n.kind === "warn" ? "warn" : "info"}">${rich(n.text)}</div>`).join("");

  const fields = (t.fields || []).length
    ? `<div class="tw"><table class="t"><thead><tr><th>值</th><th>从哪来</th><th>说明</th></tr></thead><tbody>${
      t.fields.map(([a, b, c]) => `<tr><td data-label="值">${rich(a)}</td><td data-label="从哪来">${rich(b)}</td><td data-label="说明">${rich(c || "—")}</td></tr>`).join("")
    }</tbody></table></div>`
    : "";

  return `<div class="tutbox">
    <div class="tut-intro">${rich(t.intro)}</div>
    ${steps}
    ${fields}
    ${notes}
  </div>`;
}
