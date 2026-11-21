# Builds podcave.exe: React UI -> embedded into a single Go binary.
# Usage:  .\build.ps1            (or  .\build.ps1 -Version 1.2.0)
param([string]$Version = "1.0.0")
$ErrorActionPreference = 'Stop'

function Invoke-Step([string]$Name, [scriptblock]$Cmd) {
    Write-Host "==> $Name" -ForegroundColor Yellow
    & $Cmd
    if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
}

$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go) { $go = Join-Path $env:LOCALAPPDATA 'Programs\go\bin\go.exe' }
if (-not (Test-Path $go)) { throw "Go not found. Install it from https://go.dev/dl/ (no admin needed: unzip to %LOCALAPPDATA%\Programs)." }
# govulncheck shells out to `go`, so make sure it is on PATH for this session.
$env:PATH = (Split-Path $go) + [IO.Path]::PathSeparator + $env:PATH

Push-Location (Join-Path $PSScriptRoot 'web')
try {
    Invoke-Step 'npm ci (locked dependencies)' { npm ci --no-fund --no-audit }
    Invoke-Step 'npm audit' { npm audit --audit-level=high }
    Invoke-Step 'build web UI' { npm run build }
} finally { Pop-Location }

Push-Location $PSScriptRoot
try {
    Invoke-Step 'go vet' { & $go vet ./... }
    Invoke-Step 'go test' { & $go test ./internal/... }
    $vuln = Join-Path (& $go env GOPATH) 'bin\govulncheck.exe'
    if (Test-Path $vuln) { Invoke-Step 'govulncheck' { & $vuln ./... } }
    else { Write-Host "    (skipping govulncheck: go install golang.org/x/vuln/cmd/govulncheck@latest)" }
    Invoke-Step 'go build' { & $go build -trimpath -ldflags "-s -w -X main.version=$Version" -o podcave.exe . }
    $hash = (Get-FileHash podcave.exe -Algorithm SHA256).Hash.ToLower()
    "$hash  podcave.exe" | Set-Content -Encoding ascii podcave.exe.sha256
    Write-Host "`nBuilt podcave.exe $Version`nSHA256 $hash" -ForegroundColor Green
} finally { Pop-Location }
