$ErrorActionPreference = "Stop"

$projectDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$teamDir = Join-Path $projectDir "team"
$dataDir = Join-Path $projectDir "team-data"
$tunnelConfig = Join-Path $projectDir "cloudflared\makingai.yml"
$cloudflared = Join-Path $env:LOCALAPPDATA "npm-cache\_npx\8a26fc3a61fe4212\node_modules\cloudflared\bin\cloudflared.exe"

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

function Test-PortListening {
    param([int]$Port)
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $listener
}

function Start-NodeProcess {
    param(
        [string]$ScriptPath,
        [string]$LogName
    )

    $outLogPath = Join-Path $dataDir $LogName
    $errLogPath = Join-Path $dataDir ($LogName -replace '\.log$', '.err.log')
    Start-Process node `
        -ArgumentList @("--env-file-if-exists=team/.env", $ScriptPath) `
        -WorkingDirectory $projectDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $outLogPath `
        -RedirectStandardError $errLogPath
}

if (-not (Test-PortListening -Port 4180)) {
    Start-NodeProcess -ScriptPath "team/central-server.mjs" -LogName "central-server.log"
    Start-Sleep -Seconds 2
}

$helperProcess = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*team/helper.mjs*" } |
    Select-Object -First 1
if (-not $helperProcess) {
    Start-NodeProcess -ScriptPath "team/helper.mjs" -LogName "helper.log"
}

if (-not (Test-Path -LiteralPath $cloudflared)) {
    throw "Khong tim thay cloudflared tai: $cloudflared"
}
if (-not (Test-Path -LiteralPath $tunnelConfig)) {
    throw "Khong tim thay cau hinh tunnel tai: $tunnelConfig"
}

$tunnelProcess = Get-CimInstance Win32_Process -Filter "name = 'cloudflared.exe'" |
    Where-Object { $_.CommandLine -like "*makingai.yml*" -or $_.CommandLine -like "*tunnel run makingai*" } |
    Select-Object -First 1
if (-not $tunnelProcess) {
    $outLogPath = Join-Path $dataDir "makingai-cloudflared.log"
    $errLogPath = Join-Path $dataDir "makingai-cloudflared.err.log"
    Start-Process $cloudflared `
        -ArgumentList @("--config", $tunnelConfig, "tunnel", "run", "makingai") `
        -WorkingDirectory $projectDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $outLogPath `
        -RedirectStandardError $errLogPath
}

Write-Host "Making AI server dang chay."
Write-Host "Local:  http://127.0.0.1:4180"
Write-Host "Public: https://makingai.vayxath.com"
