#Requires -Version 5.1
<#
.SYNOPSIS
    一键安装 dsh-usage-hud —— DSH 网页版的实时用量看板。

.DESCRIPTION
    不用克隆仓库，一条命令装完：

        irm https://raw.githubusercontent.com/k-s-kbl/dsh-usage-hud/main/install.ps1 | iex

    已经克隆了仓库的话，在仓库目录里直接跑（会用本地源码，不联网）：

        .\install.ps1

    本脚本只做三件事：找 dsh 主目录和 profile → 调 install.mjs 把文件装进去并写一条
    加载行 → 回头确认插件真的挂到正在运行的 GUI 上了。装完不用重启 dsh，
    刷新一下网页就出现看板。

.PARAMETER Uninstall
    卸载：删掉加载行和已安装的文件。

.PARAMETER Profile
    指定装进哪个 profile。不指定时优先用 web，其次用仅有的那一个。

.PARAMETER DshHome
    指定 dsh 主目录。不指定时取环境变量 $DSH_HOME，没设则取 ~/.dsh。
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$Profile,
    [string]$DshHome
)

$ErrorActionPreference = 'Stop'
$repo = 'k-s-kbl/dsh-usage-hud'
$branch = 'main'
$origin = if ($env:DSH_WEB_URL) { $env:DSH_WEB_URL.TrimEnd('/') } else { 'http://127.0.0.1:3080' }

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }

# ── 1. 前提：node ────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw '找不到 node。DSH 本身就跑在 Node.js 上，先把它装好，再重新运行本脚本。'
}

# ── 2. 找源码：本目录里有就用本目录，否则下载一份到临时目录 ──────────────────
$source = $null
$temporary = $null
if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'install.mjs'))) {
    $source = $PSScriptRoot
    Write-Step "用本地源码：$source"
} else {
    Write-Step '正在下载插件源码…'
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-usage-hud-" + [guid]::NewGuid().ToString('N'))
    $zip = "$work.zip"
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $temporary = $work
    Invoke-WebRequest -Uri "https://codeload.github.com/$repo/zip/refs/heads/$branch" -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath $work -Force
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    $source = (Get-ChildItem -LiteralPath $work -Directory | Select-Object -First 1).FullName
    Write-Step '源码已就绪'
}

try {
    # ── 3. 交给安装器（它自己会做备份和 YAML 校验） ──────────────────────────
    $argumentList = @((Join-Path $source 'install.mjs'))
    if ($Uninstall) { $argumentList += '--uninstall' }
    if ($Profile) { $argumentList += @('--profile', $Profile) }
    if ($DshHome) { $argumentList += @('--dsh-home', $DshHome) }
    & node @argumentList
    if ($LASTEXITCODE -ne 0) { throw "安装器以退出码 $LASTEXITCODE 结束，上面的报错说明了原因。" }
    if ($Uninstall) { return }

    # ── 4. 回头确认它真的挂到正在运行的 GUI 上了，而不是只在磁盘上躺着 ────────
    Write-Step '检查插件是否已经挂到正在运行的 GUI 上…'
    $status = $null
    for ($attempt = 1; $attempt -le 12; $attempt += 1) {
        try {
            $status = Invoke-RestMethod -Uri "$origin/api/usage-hud/status" -TimeoutSec 5
            if ($status.ok) { break }
        } catch {
            $status = $null
        }
        Start-Sleep -Milliseconds 600
    }

    Write-Host ''
    if ($null -ne $status -and $status.ok) {
        Write-Host '装好了，而且已经挂上了。' -ForegroundColor Green
        Write-Host "  运行中的版本：$($status.revision)"
        if ($status.projection.registered) { Write-Host "  费用投影：已注册（已见到 $($status.projection.sessions) 个会话）" }
        else { Write-Host "  费用投影：未注册 —— $($status.projection.registerError)" -ForegroundColor Yellow }
        Write-Host ''
        Write-Host '最后一步：刷新网页。' -ForegroundColor Yellow
        Write-Host "  $origin"
        Write-Host '  （浏览器只在启动时读一次 __DSH_BOOT__，所以必须刷新页面，不是重装。）'
    } else {
        Write-Host '文件已经装好，但没能确认 GUI 挂载。' -ForegroundColor Yellow
        Write-Host "  多半是 dsh 网页版没在 $origin 上跑。启动它、刷新页面后，用这条命令确认："
        Write-Host "    Invoke-RestMethod $origin/api/usage-hud/status"
        Write-Host '  如果刷新后仍看不到看板，把 dsh 重启一次即可（磁盘上的补丁才是准的）。'
    }
} finally {
    if ($temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
}
