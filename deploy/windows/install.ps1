# ============================================================================
# Pantalla Restaurante — Instalador de PRODUCCIÓN (Windows/NSSM) — FASE 29
# ============================================================================
# Uso (PowerShell como Administrador, desde un checkout del repo):
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1
#
# Qué hace:
#   1. Verifica dependencias (bun, nssm) con guía de instalación
#   2. Layout estándar:
#        C:\PantallaRestaurante\app       → código + build standalone
#        C:\PantallaRestaurante\data      → DB, media, backups, store de NMS
#        C:\PantallaRestaurante\logs      → logs de servicios + estructurados
#        C:\PantallaRestaurante\app\.env  → entorno + secretos (JAMÁS al repo)
#   3. Genera secretos reales (RNG criptográfico) si no existían
#   4. Instala deps (raíz + mini-servicios) · prisma generate · migrate deploy
#   5. Build standalone portable (scripts/build.ts — sin cp POSIX)
#   6. Instala 3 servicios Windows con NSSM (reinicio automático 24/7)
#   7. Reglas de firewall (3000/3003 LAN, 1935 solo OBS)
#   8. Arranca y espera health real (/api/health)
#
# Idempotente: re-ejecutar actualiza código/servicios sin borrar datos.
# Para actualizar: deploy\windows\manage.ps1 upgrade <ruta-checkout>
# ============================================================================
$ErrorActionPreference = "Stop"
#Requires -RunAsAdministrator

$AppName   = "PantallaRestaurante"
$BaseDir   = "C:\PantallaRestaurante"
$AppDir    = Join-Path $BaseDir "app"
$DataDir   = Join-Path $BaseDir "data"
$LogDir    = Join-Path $BaseDir "logs"
$EnvFile   = Join-Path $AppDir ".env"
$DbPath    = Join-Path $DataDir "db\custom.db"

$SrcDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not (Test-Path (Join-Path $SrcDir "package.json"))) {
    throw "No encuentro el repositorio (ejecuta desde el checkout del repo)"
}

function Say($m) { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[X]  $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. deps
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
    Die "bun no está instalado. Instálalo con: powershell -c ""irm bun.sh/install.ps1 | iex"" (y reabre la consola)"
}
$BunBin = $bun.Source
Say "bun OK: $BunBin"

$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssm) {
    Warn "nssm no está en el PATH (gestor de servicios de Windows)."
    Warn "  Instálalo con:  choco install -y nssm   (o descarga de https://nssm.cc y pon nssm.exe en el PATH)"
    Warn "  Sin nssm NO se pueden instalar los servicios automáticos (24/7)."
    Die  "Instala nssm y re-ejecuta este script."
}
$NssmBin = $nssm.Source
Say "nssm OK: $NssmBin"

# ---------------------------------------------------------------- 2. layout
foreach ($d in @($BaseDir, $AppDir, (Join-Path $DataDir "db"), (Join-Path $DataDir "media"), (Join-Path $DataDir "backups"), (Join-Path $DataDir "store"), $LogDir)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Say "Layout creado: $BaseDir"

# ---------------------------------------------------------------- 3. entorno
function New-Hex([int]$bytes) {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $buf = New-Object byte[] $bytes
    $rng.GetBytes($buf)
    return ([BitConverter]::ToString($buf) -replace "-", "").ToLower()
}

if (Test-Path $EnvFile) {
    Warn "Entorno existente: $EnvFile (se conservan secretos y rutas)"
} else {
    $authSecret = New-Hex 24
    $rtToken    = New-Hex 16
    $envContent = @"
# Pantalla Restaurante — entorno de producción (JAMÁS commitear)
AUTH_SECRET=$authSecret
REALTIME_TOKEN=$rtToken
DATABASE_URL=file:C:/PantallaRestaurante/data/db/custom.db
PORT=3000
NODE_ENV=production
TIMEZONE=America/Havana
MEDIA_DIR=C:/PantallaRestaurante/data/media
BACKUP_DIR=C:/PantallaRestaurante/data/backups
LOG_DIR=C:/PantallaRestaurante/logs
DATA_DIR=C:/PantallaRestaurante/data/store
# LOGIN_RATE_LIMIT_IP_MAX=12
# LOG_RETENTION_DAYS=90
# RTMP_PORT=1935
# HTTP_FLV_PORT=8000
"@
    Set-Content -Path $EnvFile -Value $envContent -Encoding ASCII
    Say "Secretos generados (RNG) en $EnvFile"
}

# Cargar el entorno para los pasos de instalación
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$' -and $_ -notmatch '^\s*#') {
        Set-Item -Path ("Env:" + $Matches[1]) -Value $Matches[2]
    }
}

# ---------------------------------------------------------------- 4. código
Say "Sincronizando código → $AppDir (robocopy; sin datos ni dependencias)"
# robocopy: 0=sin cambios, 1=copiado OK, <8 es éxito
robocopy $SrcDir $AppDir /MIR /NFL /NDL /NJ /NP `
    /XD node_modules .next .git db upload uploads logs backups data test-results playwright-report `
    /XF dev.log server.log | Out-Null
if ($LASTEXITCODE -ge 8) { Die "robocopy falló (código $LASTEXITCODE)" }

function Run-Bun([string]$workDir, [string]$args) {
    Push-Location $workDir
    try {
        & $BunBin @($args -split " ") 2>&1 | Write-Host
        if ($LASTEXITCODE -ne 0) { throw "bun $args falló en $workDir (código $LASTEXITCODE)" }
    } finally { Pop-Location }
}

Say "Instalando dependencias (raíz + mini-servicios)"
Run-Bun $AppDir "install --frozen-lockfile"
Run-Bun (Join-Path $AppDir "mini-services\realtime-service") "install --frozen-lockfile"
Run-Bun (Join-Path $AppDir "mini-services\stream-service") "install --frozen-lockfile"

Say "Generando Prisma Client"
Run-Bun $AppDir "x prisma generate"

Say "Aplicando migraciones versionadas (migrate deploy — JAMÁS db push)"
Run-Bun $AppDir "x prisma migrate deploy"

# ---------------------------------------------------------------- 5. build
Say "Build standalone portable (scripts/build.ts)"
Run-Bun $AppDir "run build"

# ---------------------------------------------------------------- 6. servicios NSSM
function Install-Svc([string]$name, [string]$workDir, [string]$entry) {
    & $NssmBin stop   $name 2>$null | Out-Null
    & $NssmBin remove $name confirm 2>$null | Out-Null
    & $NssmBin install $name $BunBin $entry 2>$null | Out-Null
    & $NssmBin set $name AppDirectory $workDir | Out-Null
    & $NssmBin set $name DisplayName "Pantalla Restaurante — $name" | Out-Null
    & $NssmBin set $name Description "Pantalla Restaurante ($entry) — señalización digital 24/7" | Out-Null
    # Reinicio automático (24/7)
    & $NssmBin set $name AppRestartDelay 5000 | Out-Null     # 5s
    & $NssmBin set $name AppStdout (Join-Path $LogDir "$name.log") | Out-Null
    & $NssmBin set $name AppStderr (Join-Path $LogDir "$name.err.log") | Out-Null
    & $NssmBin set $name AppRotateFiles 1 | Out-Null
    & $NssmBin set $name AppRotateBytes 5242880 | Out-Null    # 5MB
    Say "Servicio instalado: $name"
}

Install-Svc "PantallaRestaurante"          $AppDir   "scripts\start.ts"
Install-Svc "PantallaRestauranteRealtime"  $AppDir   "mini-services\realtime-service\index.ts"
Install-Svc "PantallaRestauranteStream"    $DataDir  "C:\PantallaRestaurante\app\mini-services\stream-service\index.ts"

# ---------------------------------------------------------------- 7. firewall
Say "Reglas de firewall (LAN: 3000/3003 · OBS: 1935)"
$lan = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress
$prefix = if ($lan) { ($lan -split '\.' | Select-Object -First 3) -join '.' } else { "192.168.1" }
netsh advfirewall firewall delete rule name="PantallaRestaurante-App"      2>$null | Out-Null
netsh advfirewall firewall delete rule name="PantallaRestaurante-Realtime" 2>$null | Out-Null
netsh advfirewall firewall delete rule name="PantallaRestaurante-RTMP"     2>$null | Out-Null
netsh advfirewall firewall add rule name="PantallaRestaurante-App"      dir=in action=allow protocol=TCP localport=3000 remoteip="$prefix.0/24" | Out-Null
netsh advfirewall firewall add rule name="PantallaRestaurante-Realtime" dir=in action=allow protocol=TCP localport=3003 remoteip="$prefix.0/24" | Out-Null
netsh advfirewall firewall add rule name="PantallaRestaurante-RTMP"     dir=in action=allow protocol=TCP localport=1935 | Out-Null
Say "Firewall: red local detectada $prefix.0/24 (ajusta a mano si usas otra máscara)"

# ---------------------------------------------------------------- 8. arranque + health
Say "Arrancando servicios…"
& $NssmBin start "PantallaRestauranteStream"   | Out-Null
& $NssmBin start "PantallaRestauranteRealtime" | Out-Null
& $NssmBin start "PantallaRestaurante"         | Out-Null

Say "Esperando health real (http://127.0.0.1:3000/api/health)…"
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/health" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { Start-Sleep -Seconds 2 }
}
if ($ok) { Say "Health OK — plataforma operativa" }
else     { Warn "La app no respondió health en 120s — revisa $LogDir\PantallaRestaurante.err.log" }

Write-Host ""
Write-Host "=== INSTALACIÓN COMPLETA ===" -ForegroundColor Cyan
Write-Host "Primer administrador (solo la primera vez):"
Write-Host "  cd $AppDir ; bun scripts\init-production.ts"
Write-Host ""
Write-Host "Gestión diaria:  powershell -File $AppDir\deploy\windows\manage.ps1 {start|stop|restart|status|logs|health|backup|restore|upgrade}"
Write-Host "Documentación:   $AppDir\docs\WINDOWS_PRODUCTION.md"
