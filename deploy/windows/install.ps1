# ============================================================================
# ViewLBA Server — Thin wrapper PowerShell (Fase 2 misión §0.8/§0.9/§11)
# ============================================================================
# Este script ya NO es una segunda implementación de producción (misión §11).
# Es un thin wrapper para troubleshooting / dev que delega TODA la lógica al
# service host Rust `viewlba-service.exe`.
#
# NO usa NSSM.
# NO usa cmd.exe para decisiones críticas.
# NO usa sc.exe.
# NO usa find.exe.
# NO usa PowerShell para generar credenciales (usa installer/core/secrets.ts).
#
# Para instalar en producción: usa el MSI (installer/windows-msi/viewlba.wxs)
# o el NSIS bootstrapper (installer/windows/viewlba-setup.nsi).
#
# Este script solo es útil para:
#   - Dev que quiere ver el estado rápido sin abrir el Panel
#   - Troubleshooting de un servicio que no arranca
#   - Re-instalación limpia en un entorno dev
# ============================================================================

$ErrorActionPreference = "Stop"
#Requires -RunAsAdministrator

$ServiceHost = Join-Path $PSScriptRoot "..\..\installer\native\target\release\viewlba-service.exe"
if (-not (Test-Path $ServiceHost)) {
    # Fallback al binario instalado en Program Files
    $ServiceHost = Join-Path $env:ProgramFiles "ViewLBA Server\bin\viewlba-service.exe"
}
if (-not (Test-Path $ServiceHost)) {
    Write-Host "[X] viewlba-service.exe no encontrado." -ForegroundColor Red
    Write-Host "    Compilar con: cd installer/native && cargo build --release" -ForegroundColor Yellow
    Write-Host "    O instalar el MSI oficial." -ForegroundColor Yellow
    exit 1
}

function Say($m) { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[X]  $m" -ForegroundColor Red; exit 1 }

Say "Using viewlba-service: $ServiceHost"

# ---------------------------------------------------------------- 1. install
& $ServiceHost --install
if ($LASTEXITCODE -ne 0) { Die "viewlba-service --install failed (exit $LASTEXITCODE)" }
Say "Service registered with SCM"

# ---------------------------------------------------------------- 2. start
& $ServiceHost --start
if ($LASTEXITCODE -ne 0) { Warn "viewlba-service --start returned $LASTEXITCODE (service may need more time)" }
Say "Service started (or starting in background)"

# ---------------------------------------------------------------- 3. health
Say "Waiting for /api/health (60s)…"
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/health" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { Start-Sleep -Seconds 2 }
}
if ($ok) { Say "Health OK — server up" }
else     { Warn "Health not responding — check C:\ProgramData\ViewLBA\logs\service-host.log" }

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Cyan
Write-Host "Panel:   http://localhost:3000"
Write-Host "Logs:    C:\ProgramData\ViewLBA\logs\"
Write-Host "Cred:    C:\ProgramData\ViewLBA\credentials\CREDENCIALES.txt"
