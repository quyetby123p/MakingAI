# =============================================================================
#  Studio Flow — cài đặt và khởi động
#  Bấm đúp SETUP.bat. Không cần biết gì về lập trình.
# =============================================================================

$ErrorActionPreference = "Stop"
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $appDir

function Title($t) { Write-Host ""; Write-Host $t -ForegroundColor Cyan }
function Ok($t)    { Write-Host "   $t" -ForegroundColor Green }
function Warn($t)  { Write-Host "   $t" -ForegroundColor Yellow }
function Bad($t)   { Write-Host "   $t" -ForegroundColor Red }
function Info($t)  { Write-Host "   $t" -ForegroundColor Gray }

function Stop-Here($msg) {
    Write-Host ""
    Bad $msg
    Write-Host ""
    Read-Host "Nhan Enter de dong"
    exit 1
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Find-Codex {
    if ($env:CODEX_CLI_PATH -and (Test-Path -LiteralPath $env:CODEX_CLI_PATH)) { return $env:CODEX_CLI_PATH }
    $binRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
    if (Test-Path -LiteralPath $binRoot) {
        # @() is required: a single match returns a string, and $found[0] would
        # then take its first CHARACTER instead of the path.
        $found = @(Get-ChildItem -LiteralPath $binRoot -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName "codex.exe" } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending)
        if ($found.Count -gt 0) { return $found[0] }
    }
    $cmd = Get-Command codex -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

Clear-Host
Write-Host "==============================================" -ForegroundColor White
Write-Host "   STUDIO FLOW" -ForegroundColor White
Write-Host "   Chuyen trang phuc len anh nguoi mau bang AI" -ForegroundColor Gray
Write-Host "==============================================" -ForegroundColor White

# --- 1. Node.js ---------------------------------------------------------------
Title "[1/4] Kiem tra Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Refresh-Path }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Warn "May nay chua co Node.js (phan mem nen de chay Studio Flow)."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        $answer = Read-Host "   Cai tu dong bay gio? Mat khoang 2 phut (y/n)"
        if ($answer -match '^[yY]') {
            Info "Dang cai, vui long doi..."
            winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements | Out-Null
            Refresh-Path
        }
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Start-Process "https://nodejs.org/en/download"
        Stop-Here "Hay cai Node.js tu trang vua mo, roi chay lai SETUP.bat."
    }
}
$nodeVersion = (node --version).TrimStart("v")
if ([int]($nodeVersion.Split(".")[0]) -lt 18) {
    Stop-Here "Node.js qua cu (dang la $nodeVersion). Can ban 18 tro len. Hay cap nhat tai https://nodejs.org"
}
Ok "Node.js $nodeVersion"

# --- 2. Cap nhat ma nguon (neu tai bang git) ---------------------------------
Title "[2/4] Kiem tra ban cap nhat"
if ((Test-Path ".git") -and (Get-Command git -ErrorAction SilentlyContinue)) {
    try {
        git pull --quiet 2>&1 | Out-Null
        Ok "Da lay ban moi nhat"
    } catch { Warn "Khong lay duoc ban moi, van dung ban hien tai" }
} else {
    Info "Bo qua (thu muc nay khong phai ban tai bang git)"
}

# --- 3. Codex + dang nhap -----------------------------------------------------
Title "[3/4] Kiem tra ket noi AI"
$codex = Find-Codex

if (-not $codex) {
    Warn "Chua co ung dung ChatGPT tren may."
    Write-Host ""
    Info "Studio Flow chay bang goi ChatGPT cua ban, khong ton phi API."
    Info "Ban can: tai ChatGPT cho Windows, dang nhap bang tai khoan co goi Plus hoac Pro."
    Write-Host ""
    $answer = Read-Host "   Mo trang tai ChatGPT bay gio? (y/n)"
    if ($answer -match '^[yY]') { Start-Process "https://openai.com/chatgpt/download" }
    Write-Host ""
    Warn "Sau khi cai va dang nhap ChatGPT xong, chay lai SETUP.bat."
    Write-Host ""
    Info "Neu ban dung khoa API tra phi thay vi goi ChatGPT:"
    Info "  dat bien STUDIO_BACKEND=api va OPENAI_API_KEY roi chay: node server.mjs"
    Write-Host ""
    Read-Host "Nhan Enter de dong"
    exit 1
}
Ok "Da tim thay Codex"

$status = & $codex login status 2>&1 | Out-String
if ($status -notmatch "Logged in") {
    Warn "Chua dang nhap. Cua so dang nhap se mo ra."
    Info "Hay dang nhap bang tai khoan ChatGPT co goi Plus/Pro/Team."
    Write-Host ""
    & $codex login
    $status = & $codex login status 2>&1 | Out-String
    if ($status -notmatch "Logged in") {
        Stop-Here "Van chua dang nhap duoc. Hay thu lai, hoac mo ung dung ChatGPT dang nhap truoc roi chay lai SETUP.bat."
    }
}
Ok ($status.Trim())

# --- 4. Khoi dong -------------------------------------------------------------
Title "[4/4] Khoi dong Studio Flow"

$busy = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
    $proc = Get-Process -Id $busy.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq "node") {
        Info "Dang dong ban chay truoc do..."
        Stop-Process -Id $proc.Id -Force
        Start-Sleep -Milliseconds 400
    } else {
        Stop-Here "Cong 4173 dang bi phan mem khac chiem. Hay dong no roi chay lai."
    }
}

$env:STUDIO_BACKEND = "codex"
Remove-Item Env:\OPENAI_API_KEY -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  =========================================" -ForegroundColor Green
Write-Host "   San sang. Dia chi: http://127.0.0.1:4173" -ForegroundColor Green
Write-Host "  =========================================" -ForegroundColor Green
Write-Host ""
Info "Trinh duyet se tu mo. Giu cua so den nay mo trong luc lam viec."
Info "Dong cua so den nay la tat Studio Flow."
Write-Host ""

Start-Sleep -Milliseconds 800
Start-Process "http://127.0.0.1:4173"
node server.mjs
