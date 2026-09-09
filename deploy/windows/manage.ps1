# ============================================================================
# Pantalla Restaurante — Gestión de la instalación Windows (FASE 29)
# ============================================================================
# Uso (PowerShell como Administrador):
#   powershell -File deploy\windows\manage.ps1 <comando>
#     start    — arranca los 3 servicios (stream → realtime → app)
#     stop     — detiene los 3
#     restart  — reinicia (restart app|realtime|stream para uno solo)
#     status   — estado de los servicios + health
#     logs     — abre los .log de los servicios (tail -f equivalente)
#     health   — /api/health + mini-servicios
#     backup   — backup manual YA (online, verificado)
#     restore  — restore desde archivo: manage.ps1 restore <archivo.db>
#     upgrade  — actualiza desde un checkout nuevo: manage.ps1 upgrade <ruta>
# ============================================================================
$ErrorActionPreference = "Stop"
#Requires -RunAsAdministrator

$AppDir   = "C:\PantallaRestaurante\app"
$EnvFile  = Join-Path $AppDir ".env"
$LogDir   = "C:\PantallaRestaurante\logs"
$Nssm     = "nssm"

if (-not (Test-Path $EnvFile)) { Write-Host "No hay instalación (¿install.ps1?)"; exit 1 }
Push-Location $AppDir
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$' -and $_ -notmatch '^\s*#') {
        Set-Item -Path ("Env:" + $Matches[1]) -Value $Matches[2]
    }
}
$AppPort = if ($Env:PORT) { $Env:PORT } else { "3000" }
Pop-Location

$SVC_APP      = "PantallaRestaurante"
$SVC_REALTIME = "PantallaRestauranteRealtime"
$SVC_STREAM   = "PantallaRestauranteStream"

function Show-Health {
    Write-Host "=== /api/health (app) ==="
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$AppPort/api/health" -UseBasicParsing -TimeoutSec 5
        $r.Content | ConvertFrom-Json | ConvertTo-Json -Depth 5
    } catch { Write-Host "[X] La app no responde" -ForegroundColor Red }

    Write-Host "=== Mini-servicios ==="
    foreach ($p in @(@("realtime", 3004), @("stream", 8100))) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$($p[1])/health" -UseBasicParsing -TimeoutSec 3 | Out-Null
            Write-Host "[OK] $($p[0]) (:$($p[1])) operativo" -ForegroundColor Green
        } catch { Write-Host "[X]  $($p[0]) (:$($p[1])) CAÍDO" -ForegroundColor Red }
    }
}

switch ($args[0]) {
    "start" {
        & $Nssm start $SVC_STREAM;   & $Nssm start $SVC_REALTIME; & $Nssm start $SVC_APP
        Start-Sleep 5; Show-Health
    }
    "stop" {
        & $Nssm stop $SVC_APP; & $Nssm stop $SVC_REALTIME; & $Nssm stop $SVC_STREAM
        Write-Host "[OK] Detenida"
    }
    "restart" {
        $which = if ($args[1]) { $args[1] } else { "all" }
        switch ($which) {
            "app"      { & $Nssm restart $SVC_APP }
            "realtime" { & $Nssm restart $SVC_REALTIME }
            "stream"   { & $Nssm restart $SVC_STREAM }
            default    { & $Nssm restart $SVC_STREAM; & $Nssm restart $SVC_REALTIME; & $Nssm restart $SVC_APP }
        }
        Start-Sleep 5; Show-Health
    }
    "status" {
        Write-Host "=== Servicios (NSSM) ==="
        & $Nssm status $SVC_APP; & $Nssm status $SVC_REALTIME; & $Nssm status $SVC_STREAM
        Write-Host ""
        Show-Health
    }
    "logs" {
        Write-Host "Abriendo los logs (Ctrl+C para salir cada ventana)…"
        Get-Content (Join-Path $LogDir "$SVC_APP.log") -Wait -Tail 20
    }
    "health" { Show-Health }
    "backup" {
        Push-Location $AppDir
        try { bun scripts\backup.ts } finally { Pop-Location }
    }
    "restore" {
        if (-not $args[1] -or -not (Test-Path $args[1])) { Write-Host "Uso: restore <ruta\al\backup.db>"; exit 1 }
        $file = (Resolve-Path $args[1]).Path
        Write-Host "Restaurando $file (detiene → restaura → verifica → arranca)…"
        & $Nssm stop $SVC_APP; & $Nssm stop $SVC_REALTIME; & $Nssm stop $SVC_STREAM
        Push-Location $AppDir
        try { bun scripts\restore.ts $file } finally { Pop-Location }
        & $Nssm start $SVC_STREAM; & $Nssm start $SVC_REALTIME; & $Nssm start $SVC_APP
        Start-Sleep 5; Show-Health
    }
    "upgrade" {
        if (-not $args[1] -or -not (Test-Path (Join-Path $args[1] "package.json"))) {
            Write-Host "Uso: upgrade <ruta\al\checkout-actualizado> (git pull allí primero)"
            exit 1
        }
        Write-Host "Actualizando desde $($args[1]) (los DATOS no se tocan)…"
        & powershell -ExecutionPolicy Bypass -File (Join-Path $args[1] "deploy\windows\install.ps1")
    }
    default {
        Write-Host "Comandos: start | stop | restart [app|realtime|stream] | status | logs | health | backup | restore <db> | upgrade <ruta>"
    }
}
