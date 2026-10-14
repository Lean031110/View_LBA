# ============================================================================
# ViewLBA Server — Manage (thin wrapper) — Fase 2
# ============================================================================
# NO usa NSSM. NO usa sc.exe. NO usa net.exe. NO usa find.exe.
# Delega al service host Rust `viewlba-service.exe`.
#
# Uso:
#   .\manage.ps1 start      → arrancar servicio
#   .\manage.ps1 stop       → detener servicio
#   .\manage.ps1 restart    → reiniciar servicio
#   .\manage.ps1 status     → estado (via SCM Get-Service, no sc.exe)
#   .\manage.ps1 logs       → abrir carpeta de logs
#   .\manage.ps1 health     → forzar health check HTTP
# ============================================================================

$ErrorActionPreference = "Stop"

$ServiceHost = Join-Path $env:ProgramFiles "ViewLBA Server\bin\viewlba-service.exe"
if (-not (Test-Path $ServiceHost)) {
    $ServiceHost = Join-Path $PSScriptRoot "..\..\installer\native\target\release\viewlba-service.exe"
}
$ServiceName = "ViewLBA"
$LogDir = Join-Path $env:ProgramData "ViewLBA\logs"

$action = $args[0]
if (-not $action) {
    Write-Host "Usage: .\manage.ps1 {start|stop|restart|status|logs|health}"
    exit 2
}

switch ($action.ToLower()) {
    "start" {
        & $ServiceHost --start
        if ($LASTEXITCODE -eq 0) { Write-Host "[OK] Service started" -ForegroundColor Green }
        else { Write-Host "[X] Start failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
    }
    "stop" {
        & $ServiceHost --stop
        if ($LASTEXITCODE -eq 0) { Write-Host "[OK] Service stopped" -ForegroundColor Green }
        else { Write-Host "[X] Stop failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
    }
    "restart" {
        & $ServiceHost --stop
        Start-Sleep -Seconds 2
        & $ServiceHost --start
        if ($LASTEXITCODE -eq 0) { Write-Host "[OK] Service restarted" -ForegroundColor Green }
        else { Write-Host "[X] Restart failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
    }
    "status" {
        # Get-Service es la forma Windows-nativa (no sc.exe, no find)
        $s = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $s) {
            Write-Host "[!] Service '$ServiceName' is NOT registered" -ForegroundColor Yellow
            exit 1
        }
        Write-Host "Service:  $($s.Name)" -ForegroundColor Cyan
        Write-Host "Display:  $($s.DisplayName)"
        Write-Host "Status:   $($s.Status)" -ForegroundColor Green
        Write-Host "StartType: $($s.StartType)"
    }
    "logs" {
        if (Test-Path $LogDir) {
            Write-Host "Logs dir: $LogDir" -ForegroundColor Cyan
            Get-ChildItem $LogDir | Format-Table Name, Length, LastWriteTime
            Write-Host "Tail of service-host.log:" -ForegroundColor Cyan
            if (Test-Path (Join-Path $LogDir "service-host.log")) {
                Get-Content (Join-Path $LogDir "service-host.log") -Tail 30
            }
        } else {
            Write-Host "[!] Log dir not found: $LogDir" -ForegroundColor Yellow
        }
    }
    "health" {
        Write-Host "GET http://127.0.0.1:3000/api/health …" -ForegroundColor Cyan
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/health" -UseBasicParsing -TimeoutSec 5
            Write-Host "Status: $($r.StatusCode)" -ForegroundColor Green
            Write-Host "Body:   $($r.Content)" -ForegroundColor Cyan
        } catch {
            Write-Host "[X] Health request failed: $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
    }
    default {
        Write-Host "Unknown action: $action" -ForegroundColor Red
        Write-Host "Usage: .\manage.ps1 {start|stop|restart|status|logs|health}"
        exit 2
    }
}
