param(
    [switch]$NoBrowser,
    [ValidateSet("codex", "api")]
    [string]$Backend
)

$ErrorActionPreference = "Stop"
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Backend mac dinh: codex = chay trong han muc goi ChatGPT, khong ton API credit.
# Doi sang duong cu:  .\launch-studio-flow.ps1 -Backend api
if (-not $Backend) {
    if ($env:STUDIO_BACKEND) { $Backend = $env:STUDIO_BACKEND.ToLower() } else { $Backend = "codex" }
}
if ($Backend -ne "api") { $Backend = "codex" }
$env:STUDIO_BACKEND = $Backend

if ($Backend -eq "api") {
    $credentialDir = Join-Path $env:LOCALAPPDATA "StudioFlow"
    $credentialFile = Join-Path $credentialDir "openai-key.clixml"
    $keyDropFile = Join-Path $credentialDir "PASTE_OPENAI_KEY_HERE.txt"

    New-Item -ItemType Directory -Path $credentialDir -Force | Out-Null

    $candidateKey = ""
    if (Test-Path -LiteralPath $keyDropFile) {
        $candidateKey = (Get-Content -Raw -LiteralPath $keyDropFile).Trim()
    }

    if ($candidateKey -match '^sk-[A-Za-z0-9_-]{20,}$') {
        $candidateKey | ConvertTo-SecureString -AsPlainText -Force | Export-Clixml -LiteralPath $credentialFile
        "KEY_DA_DUOC_MA_HOA_VA_NHAP_THANH_CONG. KHONG_DAN_KEY_VAO_DAY_NUA." | Set-Content -LiteralPath $keyDropFile -Encoding UTF8
        Write-Host "Da nhap va ma hoa API key." -ForegroundColor Green
    }

    if (-not (Test-Path -LiteralPath $credentialFile)) {
        Write-Host "THIET LAP LAN DAU" -ForegroundColor Cyan
        Write-Host "Chua tim thay key hop le trong: $keyDropFile"
        Write-Host "Nhap API key moi. Key duoc ma hoa bang Windows DPAPI va chi tai khoan Windows nay doc duoc."
        $secureKey = Read-Host "OpenAI API key" -AsSecureString
        $secureKey | Export-Clixml -LiteralPath $credentialFile
    }

    $storedKey = Import-Clixml -LiteralPath $credentialFile
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($storedKey)
    try {
        $env:OPENAI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    }
    Write-Host "Backend: API (tinh phi theo OPENAI_API_KEY)" -ForegroundColor Yellow
}
else {
    # Duong codex khong dung API key. Xoa bien de server khong vo tinh goi API tra phi.
    Remove-Item Env:\OPENAI_API_KEY -ErrorAction SilentlyContinue

    $codexPath = $env:CODEX_CLI_PATH
    if (-not $codexPath -or -not (Test-Path -LiteralPath $codexPath)) {
        $binRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
        if (Test-Path -LiteralPath $binRoot) {
            # @() is required: a single match returns a string, and $found[0]
            # would then take its first CHARACTER instead of the path.
            $found = @(Get-ChildItem -LiteralPath $binRoot -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName "codex.exe" } |
                Where-Object { Test-Path -LiteralPath $_ } |
                Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending)
            if ($found.Count -gt 0) { $codexPath = $found[0] }
        }
    }

    if (-not $codexPath) {
        throw "Khong tim thay codex.exe. Cai ChatGPT/Codex, hoac dat CODEX_CLI_PATH, hoac chay: .\launch-studio-flow.ps1 -Backend api"
    }

    $status = & $codexPath login status 2>&1 | Out-String
    if ($status -notmatch "Logged in") {
        throw "Codex chua dang nhap. Chay lenh sau roi thu lai:  `"$codexPath`" login"
    }

    Write-Host "Backend: CODEX - chay trong han muc goi ChatGPT, khong ton API credit." -ForegroundColor Green
    Write-Host ("Dang nhap: " + $status.Trim())
    Write-Host "Doi sang duong tra phi:  .\launch-studio-flow.ps1 -Backend api" -ForegroundColor DarkGray
}

# If a preview server is already using Studio Flow's port, replace it so the
# newly loaded settings take effect without making the user stop processes.
$existingListener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingListener) {
    $existingProcess = Get-Process -Id $existingListener.OwningProcess -ErrorAction SilentlyContinue
    if ($existingProcess -and $existingProcess.ProcessName -eq "node") {
        Stop-Process -Id $existingProcess.Id -Force
        Start-Sleep -Milliseconds 350
    }
    else {
        throw "Port 4173 is being used by another application. Close it and run Studio Flow again."
    }
}

Set-Location -LiteralPath $appDir
Write-Host "Studio Flow: http://127.0.0.1:4173" -ForegroundColor Green
Write-Host "Server tu khoi dong lai khi code thay doi. Nhan Ctrl+C de dung."
if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:4173"
}
node --watch server.mjs
