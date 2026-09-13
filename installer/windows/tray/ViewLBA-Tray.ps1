# ============================================================================
# ViewLBA-Tray.ps1 — Bandeja del sistema para ViewLBA Server (Windows)
#
# MISIÓN (pedida por el usuario): «una notificación persistente en la barra
# de tareas donde con clic derecho sobre ella yo pueda iniciar / detener el
# servidor». SIN interfaz gráfica: solo este icono junto al reloj.
#
#   · Clic derecho → Iniciar servidor · Detener servidor · Abrir Panel · Salir
#   · Doble clic   → Abrir Panel (http://localhost:3000)
#   · Icono VERDE = servicio corriendo · ROJO = detenido · AMARILLO = transición
#   · Refresco automático cada 10 s (estado del servicio Windows).
#
# Requisitos: Windows 10/11 con PowerShell 5.1 (preinstalado) — CERO
# dependencias adicionales. El servidor (bun) ya viene en el paquete y el
# servicio se instala automáticamente con el Setup.exe.
#
# Se lanza oculto (el instalador crea el acceso y la clave de autostart):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden \
#                  -File ViewLBA-Tray.ps1
# ============================================================================

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ServiceName = 'PantallaRestaurante'
$PanelUrl    = 'http://localhost:3000'
$AppName     = 'ViewLBA Server'

# ---------------------------------------------------------------------------
# Iconos de estado (dibujados en memoria — sin archivos extra)
# ---------------------------------------------------------------------------
function New-StateIcon([int]$R, [int]$G, [int]$B) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, $R, $G, $B))
    $g.FillEllipse($brush, 2, 2, 12, 12)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(220, 255, 255, 255)), 1
    $g.DrawEllipse($pen, 2, 2, 12, 12)
    $g.Dispose()
    $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    return @{ Icon = $ico; Bitmap = $bmp }
}

$IconRun  = New-StateIcon  46 204 113   # verde
$IconStop = New-StateIcon 231  76  60   # rojo
$IconWait = New-StateIcon 241 196  15   # amarillo (arrancando/transición)

# ---------------------------------------------------------------------------
# Estado del servicio
# ---------------------------------------------------------------------------
function Get-ServiceState {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) { return 'missing' }
    switch ($svc.Status) {
        'Running'     { return 'running' }
        'StartPending' { return 'starting' }
        'Stopped'     { return 'stopped' }
        'StopPending' { return 'stopping' }
        default       { return $svc.Status.ToString() }
    }
}

# ---------------------------------------------------------------------------
# Controles
# ---------------------------------------------------------------------------
function Start-Server {
    # UAC estándar de Windows (los servicios requieren permisos de admin)
    Start-Process -FilePath 'net.exe' -ArgumentList 'start', $ServiceName -Verb RunAs -WindowStyle Hidden
    Refresh-Now
}

function Stop-Server {
    Start-Process -FilePath 'net.exe' -ArgumentList 'stop', $ServiceName -Verb RunAs -WindowStyle Hidden
    Refresh-Now
}

function Open-Panel {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $PanelUrl
}

# ---------------------------------------------------------------------------
# Bandeja + menú contextual
# ---------------------------------------------------------------------------
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Text = "$AppName"
$tray.Icon = $IconStop.Icon
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$mTitle = New-Object System.Windows.Forms.ToolStripMenuItem $AppName
$mTitle.Enabled = $false
[void]$menu.Items.Add($mTitle)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$mStart = New-Object System.Windows.Forms.ToolStripMenuItem 'Iniciar servidor'
$mStart.Add_Click({ Start-Server })
[void]$menu.Items.Add($mStart)

$mStop = New-Object System.Windows.Forms.ToolStripMenuItem 'Detener servidor'
$mStop.Add_Click({ Stop-Server })
[void]$menu.Items.Add($mStop)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$mPanel = New-Object System.Windows.Forms.ToolStripMenuItem 'Abrir Panel (localhost:3000)'
$mPanel.Add_Click({ Open-Panel })
[void]$menu.Items.Add($mPanel)

$mEstado = New-Object System.Windows.Forms.ToolStripMenuItem 'Estado: …'
$mEstado.Enabled = $false
[void]$menu.Items.Add($mEstado)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$mExit = New-Object System.Windows.Forms.ToolStripMenuItem 'Salir (cierra solo la bandeja)'
$mExit.Add_Click({
    $script:timer.Stop()
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($mExit)

$tray.ContextMenuStrip = $menu
$tray.Add_DoubleClick({ Open-Panel })

# ---------------------------------------------------------------------------
# Refresco periódico (10 s) + menú contextual dinámico
# ---------------------------------------------------------------------------
function Refresh-Now {
    $state = Get-ServiceState
    switch ($state) {
        'running'  { $tray.Icon = $IconRun.Icon;  $tray.Text = "$AppName - En ejecucion"; $mEstado.Text = 'Estado: EN EJECUCION'; $mStart.Enabled = $false; $mStop.Enabled = $true }
        'starting' { $tray.Icon = $IconWait.Icon; $tray.Text = "$AppName - Iniciando…";   $mEstado.Text = 'Estado: iniciando…';   $mStart.Enabled = $false; $mStop.Enabled = $true }
        'stopped'  { $tray.Icon = $IconStop.Icon; $tray.Text = "$AppName - Detenido";     $mEstado.Text = 'Estado: DETENIDO';     $mStart.Enabled = $true;  $mStop.Enabled = $false }
        'stopping' { $tray.Icon = $IconWait.Icon; $tray.Text = "$AppName - Deteniendo…";  $mEstado.Text = 'Estado: deteniendo…';  $mStart.Enabled = $true;  $mStop.Enabled = $false }
        'missing'  { $tray.Icon = $IconStop.Icon; $tray.Text = "$AppName - Sin servicio"; $mEstado.Text = 'Estado: servicio NO instalado'; $mStart.Enabled = $false; $mStop.Enabled = $false }
        default    { $tray.Icon = $IconWait.Icon; $tray.Text = "$AppName - $state";       $mEstado.Text = "Estado: $state" }
    }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.Add_Tick({ Refresh-Now })
$timer.Start()
Refresh-Now

# ---------------------------------------------------------------------------
# Bucle de mensajes (la bandeja vive mientras no elijan «Salir»)
# ---------------------------------------------------------------------------
[System.Windows.Forms.Application]::Run()
