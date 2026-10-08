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
// 三家的取法（与三个前身手 Worker 的做法一致，值全在本机客户端上，不需要 F12 抓包）：
//   · Qoder     —— 跑客户端自带的 runtime-info.exe 取设备标识，DPAPI 解密登录凭据
//   · Trae      —— 打开登录页 → 浏览器跳到 127.0.0.1 的回调 → PowerShell 解析出参数
//   · WorkBuddy —— 旧版客户端从 .info 直接取两个令牌；新版走官方短信登录接口换明文 Token

// 一个步骤块。code 非空时渲染成 <pre><code>；link 非空时渲染成一个新标签页打开的按钮，
// 它是**函数**而不是字符串 —— href 里带随机串，必须在每次渲染时现取。
const step = (title, body, code, link) => ({ title, body, code, link });
const note = (kind, text) => ({ kind, text });

const randHex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const randDigits = (count) => Array.from(crypto.getRandomValues(new Uint8Array(count)))
  .map((b) => String(b % 10)).join("");

// Trae 登录页的 URL。参数集对齐 2026-10 的真实抓包，只有一处**刻意不跟**，改之前先读完：
//   · code_challenge / code_challenge_method —— 抓包里有，那是 PKCE 分支（回调回的是 authCodeInfo）。
//     我们手里没有 code_verifier，加上会把页面推进那条分支，回调里就**没有** userJwt / refreshToken 了。
// client_id 与 auth_from 已跟着抓包改成新版客户端那一对（ono9krqynydwx5 / trae）。两者必须成对：
// auth_from 只决定页面加载哪个 scope（solo→SOLO_PC、trae→IDE_PC，同一个组件），而 client_id
// 决定签出的票属于哪个 app —— 它**必须与 tools/trae/api.js 换票时的 ClientID 同源**，
// 只改一头会让另一头签出来的票在几天后静默换票失败。这条同源关系有测试盯着。
// 回调地址被登录页自己的正则钉死在 http://127.0.0.1:<任意端口>/authorize（https 与 localhost 都拒），
// 所以只能回到本机那条"打不开的地址"；端口用 18080 —— 真实客户端自己监听的是随机高位端口，撞不上。
const traeLoginUrl = () => {
  const machineId = randHex(32);      // 抓包是 64 位十六进制
  const deviceId = randDigits(16);    // 抓包是 16 位数字（真实客户端在那儿填的是自己的 Aha 设备号）
  const p = new URLSearchParams({
    login_version: "1", auth_from: "trae", login_channel: "native_ide",
    plugin_version: "2.3.87416", auth_type: "local", client_id: "ono9krqynydwx5",
    redirect: "0", login_trace_id: crypto.randomUUID(),
    auth_callback_url: "http://127.0.0.1:18080/authorize",
    machine_id: machineId, device_id: deviceId, x_device_id: deviceId, x_machine_id: machineId,
    x_device_brand: "PC", x_device_type: "windows", x_os_version: "Windows 11 Pro", x_env: "",
    x_app_version: "3.3.104", x_app_type: "stable", channel_name: "common",
  });
  // 带空格的值必须用 %20 传，不能用 URLSearchParams 默认吐出的 `+`：登录页读参数时只做一次
  // %XX 解码、不把 `+` 当空格（浏览器实测：`Windows+11+Pro` 被它原样带进了 redirect_url，
  // 变成 Windows%2B11%2BPro）。这套语义与我们教程里那段 PowerShell 的 Q 函数是同一个坑。
  // 换成 %20 是安全的：其余参数的值里没有一个含字面量 `+`。
  return `https://www.trae.cn/authorization?${p.toString().replaceAll("+", "%20")}`;
};

export const TUTORIALS = {
  qoder: {
    intro: "Qoder 服务端从 2026-09-26 起要求请求带一整套设备头才下发每日活动，"
      + "缺了它们（尤其是 Cosy-ClientType: 10）活动列表会直接返回空。"
      + "Cloudflare Worker 跑在云端、没法执行 Windows exe，所以要在装过 Qoder 客户端的机器上取一次。",
    steps: [
      step("先设 Qoder 安装目录",
        "就是包含 `Qoder CN.exe` 的那个文件夹，改成你自己的路径。"),
      step("整段复制到 PowerShell 回车",
        "在装有 Qoder 桌面端的 Windows 上打开 **PowerShell**（Windows 自带的 5.1 和 PowerShell 7 都行，开始菜单搜 PowerShell）。"
        + "脚本会读上面设的 `$qoderRoot`，没设会报错提示。",
        `$qoderRoot = "D:\\Program\\Qoder CN"

& {
if (-not $qoderRoot) { throw "请先执行 \`$qoderRoot = \`"你的Qoder安装目录\`" 设置路径" }

# 解密辅助（DPAPI 取密钥；AES-GCM 解密：7.x 用系统 AesGcm，5.1 用 bcrypt.dll）
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
public class BcryptGcm {
    // PowerShell 5.1 跑在 .NET Framework 上，没有 System.Security.Cryptography.AesGcm，用 Windows 自带的 bcrypt.dll（CNG）兜底
    // BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public int cbSize; public int dwInfoVersion;
        public IntPtr pbNonce; public int cbNonce;
        public IntPtr pbAuthData; public int cbAuthData;
        public IntPtr pbTag; public int cbTag;
        public IntPtr pbMacContext; public int cbMacContext;
        public int cbAAD; public long cbData; public int dwFlags;
    }
    [DllImport("bcrypt.dll", CharSet=CharSet.Unicode)] static extern int BCryptOpenAlgorithmProvider(out IntPtr h, string alg, string impl, int flags);
    [DllImport("bcrypt.dll", CharSet=CharSet.Unicode)] static extern int BCryptSetProperty(IntPtr h, string prop, byte[] v, int n, int flags);
    [DllImport("bcrypt.dll")] static extern int BCryptGenerateSymmetricKey(IntPtr hAlg, out IntPtr hKey, IntPtr obj, int objLen, byte[] secret, int secretLen, int flags);
    [DllImport("bcrypt.dll")] static extern int BCryptDecrypt(IntPtr hKey, byte[] input, int inputLen, ref Info info, byte[] iv, int ivLen, byte[] output, int outputLen, out int done, int flags);
    [DllImport("bcrypt.dll")] static extern int BCryptDestroyKey(IntPtr hKey);
    [DllImport("bcrypt.dll")] static extern int BCryptCloseAlgorithmProvider(IntPtr h, int flags);
    public static void Decrypt(byte[] key, byte[] nonce, byte[] ct, byte[] tag, byte[] pt) {
        IntPtr hAlg, hKey;
        Chk(BCryptOpenAlgorithmProvider(out hAlg, "AES", null, 0), "open");
        try {
            byte[] mode = System.Text.Encoding.Unicode.GetBytes("ChainingModeGCM\\0");
            Chk(BCryptSetProperty(hAlg, "ChainingMode", mode, mode.Length, 0), "gcm");
            Chk(BCryptGenerateSymmetricKey(hAlg, out hKey, IntPtr.Zero, 0, key, key.Length, 0), "key");
            try {
                IntPtr pN = Marshal.AllocHGlobal(nonce.Length), pT = Marshal.AllocHGlobal(tag.Length);
                try {
                    Marshal.Copy(nonce, 0, pN, nonce.Length);
                    Marshal.Copy(tag, 0, pT, tag.Length);
                    var inf = new Info();
                    inf.cbSize = Marshal.SizeOf(typeof(Info));
                    inf.dwInfoVersion = 1;
                    inf.pbNonce = pN; inf.cbNonce = nonce.Length;
                    inf.pbTag = pT; inf.cbTag = tag.Length;
                    int done;
                    Chk(BCryptDecrypt(hKey, ct, ct.Length, ref inf, null, 0, pt, pt.Length, out done, 0), "decrypt");
                    if (done != pt.Length) throw new Exception("bcrypt plaintext length mismatch");
                } finally { Marshal.FreeHGlobal(pN); Marshal.FreeHGlobal(pT); }
            } finally { BCryptDestroyKey(hKey); }
        } finally { BCryptCloseAlgorithmProvider(hAlg, 0); }
    }
    static void Chk(int status, string what) {
        if (status != 0) throw new Exception("bcrypt " + what + " failed: 0x" + status.ToString("X8"));
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
            if ($PSVersionTable.PSVersion.Major -ge 7) {
                $gcm = [System.Security.Cryptography.AesGcm]::new($key)
                $gcm.Decrypt($nonce, $ct, $tag, $pt)
            } else {
                [BcryptGcm]::Decrypt($key, $nonce, $ct, $tag, $pt)
            }
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
        "**设备标识**（输出里的 8 行 `COSY_*`）填到本工具的「工具配置」页 —— "
        + "照下面表格第一列的栏位名填，表格第二列告诉你是脚本输出的哪一行；"
        + "**TOKEN / REFRESH** 填到「新增账号」的表单里。"
        + "若 TOKEN 是 `dt--` 开头的短串（新版客户端的设备令牌），表单会多一个「账号标识」栏："
        + "给它起个固定代号（如 `main`）填上即可，建号后不要再改。"),
    ],
    // 这里不放"配不上怎么办"之类的提示：上游分不开这些情况，
    // 日志里本来就会把三种可能一次列全，摆在这里只会让人以为是自己弄错了。
    //
    // 第一列写「工具配置」页里能看到的栏位名。环境变量名（COSY_*）放在说明列里 ——
    // 那是脚本的输出标签，用户是在表单里找栏位，照着 COSY_* 找会找不到。
    fields: [
      ["**Cosy-ClientType**", "固定值 `10`", "环境变量 `COSY_CLIENT_TYPE`。**缺这个活动列表直接为空**"],
      ["**Cosy-MachineToken**", "runtime-info.exe", "环境变量 `COSY_MACHINE_TOKEN`。设备令牌（最可能过期的那个）"],
      ["**Cosy-MachineCode**", "runtime-info.exe", "环境变量 `COSY_MACHINE_CODE`。设备编码"],
      ["**Cosy-MachineType**", "runtime-info.exe", "环境变量 `COSY_MACHINE_TYPE`。设备类型"],
      ["**Cosy-MachineOS**", "系统架构", "环境变量 `COSY_MACHINE_OS`，如 `x86_64_windows`"],
      ["**Cosy-MachineHostname**", "本机主机名", "环境变量 `COSY_MACHINE_HOSTNAME`"],
      ["**Cosy-MachineId**", "`auth.machine-id`", "环境变量 `COSY_MACHINE_ID`"],
      ["**Cosy-Version**", "build-manifest.json", "环境变量 `COSY_VERSION`。Qoder 客户端的版本号"],
    ],
  },

  trae: {
    intro: "Trae 的凭据只能从登录回调里拿：登录页会跳到一个 `http://127.0.0.1:18080/authorize?...` "
      + "的地址（那个页面打不开是**正常的**，本机没有服务在监听），整条 URL 里就带着令牌。"
      + "设备号在客户端的 `storage.json` 里，最后一步脚本会自动读出来，不用单独找。",
    steps: [
      step("打开登录链接",
        "点下面的按钮，在新标签页打开 Trae 登录页。这条链接由**本页现生成**，每次打开都是新的。"
        + "新标签被拦时右键按钮「复制链接地址」，粘到地址栏打开一样能用。",
        "",
        () => ({ label: "打开 Trae 登录页", href: traeLoginUrl() })),
      step("登录，然后复制那条打不开的地址",
        "用手机号 + 验证码登录。登录成功后浏览器会跳到"
        + " `http://127.0.0.1:18080/authorize?...` 开头的页面，显示「无法访问此网站」—— 正常。"
        + "在地址栏 `Ctrl+A` → `Ctrl+C`（macOS `Cmd+A` → `Cmd+C`），"
        + "把这一整条完整 URL 复制下来（很长，带 `refreshToken=...` 等参数；在浏览器里复制不会被截断）。"),
      step("运行脚本：解析令牌 + 自动取设备号",
        "把脚本里 `$cb = \"…\"` 那行的引号内换成你刚复制的那条完整 URL，整段回车。"
        + "先从回调 URL 里解析出两个令牌，再从本地客户端的 storage.json 里读出 Aha 设备号，一次输出三个值。",
        `& {
# 1. 把下面引号内换成你复制的整条 127.0.0.1 开头的 URL，解析出两个令牌
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
$jwt = J (Q "userJwt")
$rt  = Q "refreshToken"
if (-not $rt -and $jwt) { $rt = $jwt.RefreshToken }

# 2. 从本地客户端的 storage.json 取 Aha 设备号（8-16 位数字）
$deviceId = ""
$paths = @(
  "$env:APPDATA\\TRAE SOLO CN\\User\\globalStorage\\storage.json",
  "$env:APPDATA\\Trae CN\\User\\globalStorage\\storage.json",
  "$env:APPDATA\\Trae\\User\\globalStorage\\storage.json"
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    $m = Select-String -Path $p -Pattern 'iCubeAuthInfo://icube-dc:(\\d{8,16})' -AllMatches |
      ForEach-Object { $_.Matches } | Select-Object -First 1
    if ($m) { $deviceId = $m.Groups[1].Value; break }
  }
}

Write-Host ""
Write-Host "====== 填到「新增账号」======" -ForegroundColor Cyan
Write-Host "Aha 设备号  : $deviceId"
Write-Host "Access Token : $($jwt.Token)"
Write-Host "Refresh Token: $rt"
Write-Host "=================================" -ForegroundColor Cyan
if (-not $deviceId) { Write-Host "（没找到设备号——确认装过 Trae 客户端并登录过）" -ForegroundColor Yellow }
if (-not $rt) { Write-Host "（回调里没有 refreshToken —— 请确认整条 URL 都复制了）" -ForegroundColor Yellow }
}`),
    ],
    notes: [
      note("warn", "**设备号必须是真实的。** 签到风控按它判定，随手编一个（哪怕 8–16 位格式看着对）"
        + "会每天稳定返回 9074「服务器繁忙」—— 看着像限频，其实是设备号错了。"),
    ],
    // 第一列必须是**表单里能看到的字段名**，不能是平台内部的头名 ——
    // 用户按头名去找字段找不到，会以为少填了一项（这三个头与两个令牌框的关系本来就不直观）。
    fields: [
      ["**Aha 设备号**", "第 3 步脚本自动从客户端 `storage.json` 读出", "填进表单的「Aha 设备号」那一栏。签到时它被放进 `x-device-id` 头，8–16 位数字，风控按它判定"],
      ["**Access Token**", "登录回调 URL 里的 `userJwt`", "换票与查用户信息时它被放进 `x-cloudide-token` 头"],
      ["**Refresh Token**", "登录回调 URL 里的 `refreshToken`", "续期时换新票；**签到用的不是它**"],
      ["（不用填）`Cloud-IDE-JWT`", "同一个 `userJwt`", "签到与额度查询时它才是 `Authorization` 的值 —— 所以上面两个令牌里，只有 Access Token 参与签到"],
    ],
  },

  workbuddy: {
    // 不提别的工具的文件名：三份教程各自独立，跨工具互相指路只会让人串台。
    intro: "令牌走 WorkBuddy 官方的短信登录接口换明文 Token —— 值在本机拿，不经过 Cloudflare。"
      + "桌面端较旧时也可以不折腾这个接口，直接从客户端的凭据文件里取（见下面第 1 步）。",
    steps: [
      step("先试旧版：从客户端凭据文件里直接取（可跳过）",
        "打开 `%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info`，"
        + "里面是 JSON，**旧版本**的 `accessToken` / `refreshToken` 还是纯字符串（不是加密对象），"
        + "复制这两个值填进表单即可，不用发短信。"
        + "新版本这两个值已被加密成 `{\"$wbEncrypted\":1,\"envelope\":\"…\"}`，复制出来也没用 —— 那种版本走第 2、3 步。",
        `$p = "$env:LOCALAPPDATA\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info"
if (Test-Path $p) {
  $j = Get-Content $p -Raw | ConvertFrom-Json
  Write-Host ""
  Write-Host "====== 填到「新增账号」（取到明文才有效）======" -ForegroundColor Cyan
  Write-Host "Access Token : $($j.accessToken)"
  Write-Host "Refresh Token: $($j.refreshToken)"
  Write-Host "==============================================" -ForegroundColor Cyan
} else {
  Write-Host "没找到 $p —— 桌面端装过吗？或版本较新，请走短信登录那两步。" -ForegroundColor Yellow
}`),
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
      note("info", "多账号时每个号都要走一遍：旧版客户端从第 1 步的 `.info` 取，新版走第 2、3 步发短信。"),
    ],
    fields: [
      ["**Access Token**", "第 1 步（`.info`）或第 3 步（短信）的 `Access Token`",
        "填进表单的 Access Token 那一栏，到期时间平台自动从 `exp` 解。旧版桌面端凭据是明文可直接粘；新版是 `{\"$wbEncrypted\":1,\"envelope\":\"…\"}` 加密格式，不能直接粘，需走短信登录"],
      ["**Refresh Token**", "第 1 步（`.info`）或第 3 步（短信）的 `Refresh Token`", "填进 Refresh Token 那一栏。旧串用过一次即废，续期后平台当场写回"],
    ],
  },
  "69yun": {
    intro: "69 云是 SSPanel 架构的机场，签到凭据就是网站的登录邮箱和密码——"
      + "不需要抓包、不需要客户端，能登录网页就能签到。"
      + "签到台会自动保存登录后的 Cookie，失效时用邮箱密码重新登录，不需要手动维护。",
    steps: [
      step("确认能登录 69 云官网",
        "在浏览器里打开 https://69yun69.com，用你的邮箱密码登录。"
        + "能进到用户中心就说明凭据有效——签到台用的就是这对凭据。"),
      step("（可选）用 PowerShell 验证登录接口",
        "把 `your@email.com` 和 `your_password` 换成你自己的。"
        + "输出「登录成功」就说明凭据正确，可以直接填表单。"
        + "这一步不是必须的，只是给不确定密码对不对的人一个快速验证。",
        `& {
  $email = "your@email.com"
  $pass  = "your_password"
  $body = @{ email = $email; passwd = $pass; remember_me = "on"; code = "" } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Uri "https://69yun69.com/auth/login" \`
      -Method Post -ContentType "application/json" -Body $body
    if ($r.ret -eq 1) {
      Write-Host "登录成功！把邮箱和密码填进签到台即可" -ForegroundColor Green
    } else {
      Write-Host "登录失败: $($r.msg)" -ForegroundColor Red
    }
  } catch {
    Write-Host "请求失败: $_" -ForegroundColor Red
  }
}`),
      step("填到表单",
        "邮箱填进「邮箱」栏，密码填进「密码」栏。"
        + "「会话 Cookie」那一栏留空就行——签到台第一次签到时会自动登录并保存。"),
    ],
    notes: [
      note("info", "Cookie 自动管理：第一次签到时如果没有 Cookie，会自动走登录流程并保存；之后每次直接用 Cookie，失效时自动重新登录。"),
    ],
    fields: [
      ["**邮箱**", "69 云官网的登录邮箱", "同时作为账号的唯一标识，建号后不要改"],
      ["**密码**", "69 云官网的登录密码", "Cookie 失效时用它重新登录"],
      ["**会话 Cookie**", "自动生成，无需填写", "登录后自动保存，readonly 字段"],
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

  // link 每次渲染现取（href 里带随机串），所以在这里调用而不是把值存进数据。
  // 它是 <a target="_blank">，不是脚本：链接导航不受 CSP 的 default-src 'none' 约束，
  // 零 JS 这条约定不破。rel=noopener 是因为本站口令就在本页 URL 上，不能让新页面拿到 window.opener。
  const steps = t.steps.map((s, i) => {
    const link = s.link ? s.link() : null;
    return `<div class="tut">
      <div class="tut-h"><span class="tut-n">${i + 1}</span>${rich(s.title)}</div>
      ${s.body ? `<p class="tut-b">${rich(s.body)}</p>` : ""}
      ${link ? `<div class="tut-l"><a class="btn pri" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a></div>` : ""}
      ${s.code ? `<pre class="tut-c">${esc(s.code)}</pre>` : ""}
    </div>`;
  }).join("");

  // 代码块用 CSS 的 user-select:all 做到"点一下整段全选"。本站零 JS（CSP default-src
  // 'none'），复制按钮做不出来 —— 所以需要这一句话告诉用户怎么用。只在真有代码块时出现。
  const copyHint = t.steps.some((s) => s.code)
    ? `<p class="tiny m0">下面每段脚本：点一下即整段选中，再按 Ctrl/Cmd + C 复制。</p>`
    : "";

  const notes = (t.notes || []).map((n) => `<div class="alert ${n.kind === "warn" ? "warn" : "info"}">${rich(n.text)}</div>`).join("");

  const fields = (t.fields || []).length
    ? `<div class="tw"><table class="t"><thead><tr><th>值</th><th>从哪来</th><th>说明</th></tr></thead><tbody>${
      t.fields.map(([a, b, c]) => `<tr><td data-label="值">${rich(a)}</td><td data-label="从哪来">${rich(b)}</td><td data-label="说明">${rich(c || "—")}</td></tr>`).join("")
    }</tbody></table></div>`
    : "";

  return `<div class="tutbox">
    <div class="tut-intro">${rich(t.intro)}</div>
    ${copyHint}
    ${steps}
    ${fields}
    ${notes}
  </div>`;
}
