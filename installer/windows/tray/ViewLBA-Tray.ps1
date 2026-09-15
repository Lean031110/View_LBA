# ============================================================================
# ViewLBA-Tray.ps1 - Bandeja del sistema para ViewLBA Server (Windows)
#
# MISION (pedida por el usuario): 'un icono PERMANENTE en la barra de tareas
# como indicador de que esta activo y que al hacer clic sobre el salgan
# opciones de iniciar, detener y configurar'.
#
#   | Icono SIEMPRE visible junto al reloj (autostart con la sesion):
#       VERDE  = servidor EN EJECUCION (activo)
#       ROJO   = servidor DETENIDO
#       AMARILLO = arrancando / deteniendo / transicion
#   | Clic derecho -> Iniciar servidor | Detener servidor | Reiniciar |
#                    Configurar... | Abrir Panel | Estado | Salir
#   | 'Configurar...' abre una ventana de control: estado en vivo, URL del
#     panel, credenciales, carpetas (app/logs/datos) y control del
#     servicio. La configuracion completa del restaurante (temas, pantallas,
#     licencias, usuarios) vive en el Panel web.
#   | Globo de notificacion al arrancar y al cambiar de estado.
#   | Refresco automatico cada 5 s (estado del servicio Windows).
#
# Requisitos: Windows 10/11 con PowerShell 5.1 (preinstalado) - CERO
# dependencias adicionales. El servidor (bun) ya viene en el paquete y el
# servicio se instala automaticamente con el Setup.exe.
#
# Se lanza oculto (el instalador crea el acceso y la clave de autostart):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden \
#                  -File ViewLBA-Tray.ps1
# ============================================================================

$ErrorActionPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# TRAZA DE ARRANQUE - la PRIMERA accion del script (evidencia para el CI y
# el diagnostico: si este archivo no aparece, powershell NUNCA ejecuto el
# script -> el problema esta en el LANZAMIENTO, no en la logica).
# ---------------------------------------------------------------------------
try { Set-Content -Path 'C:\ViewLBA\tray\tray-boot.txt' -Value "boot pid=$PID" -Encoding ASCII } catch { }

# Variables de script (accesibles desde TODOS los handlers de eventos:
# los scriptblocks de WinForms resuelven nombres en el ambito del script).
$ServiceName = 'PantallaRestaurante'
$PanelUrl    = 'http://localhost:3000'
$AppName     = 'ViewLBA Server'
# Ubicaciones canonicas del servidor (las instala el Setup.exe)
$AppDir      = 'C:\PantallaRestaurante\app'
$DataDir     = 'C:\PantallaRestaurante\data'
$LogDir      = 'C:\PantallaRestaurante\logs'
$CredFile    = 'C:\ViewLBA\CREDENCIALES.txt'

# ---------------------------------------------------------------------------
# Instancia unica + registro INMEDIATO del pid (ANTES de Add-Type: cargar
# WinForms tarda segundos y el CI/usuario no debe esperar para vernos).
# Guard por pid-file: determinista, sin WMI, funciona con/sin elevacion
# (el autostart, el acceso directo y el instalador comparten este archivo).
# ---------------------------------------------------------------------------
$PidFile = 'C:\ViewLBA\tray\tray.pid'
if (Test-Path $PidFile) {
    try {
        $other = Get-Content $PidFile -ErrorAction Stop | Select-Object -First 1
        $proc = Get-Process -Id ([int]$other) -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match 'powershell') { exit 0 }
    } catch { }
}
# registrar ESTA instancia (el CI y las siguientes copias usan este pid)
try {
    $dir = Split-Path $PidFile -Parent
    if (Test-Path $dir) { Set-Content -Path $PidFile -Value $PID -Encoding ASCII }
} catch { }

# WinForms (tras el registro del pid: el arranque visible puede tardar)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------------------
# Iconos de estado (dibujados en memoria - sin archivos extra)
# ---------------------------------------------------------------------------
function New-StateIcon([int]$R, [int]$G, [int]$B, [string]$Glyph) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, $R, $G, $B))
    $g.FillEllipse($brush, 1, 1, 14, 14)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(220, 255, 255, 255)), 1
    $g.DrawEllipse($pen, 1, 1, 14, 14)
    if ($Glyph) {
        $font = New-Object System.Drawing.Font ('Segoe UI', 8, [System.Drawing.FontStyle]::Bold)
        $fmt = New-Object System.Drawing.StringFormat
        $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
        $g.DrawString($Glyph, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 0, 16, 16), $fmt)
        $font.Dispose()
    }
    $g.Dispose()
    $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    return @{ Icon = $ico; Bitmap = $bmp }
}

$IconRun  = New-StateIcon  46 204 113 ''    # verde  (activo)
$IconStop = New-StateIcon 231  76  60 'x'   # rojo   (detenido)
$IconWait = New-StateIcon 241 196  15 '...'   # amarillo (transicion)

# ---------------------------------------------------------------------------
# Estado del servicio
# ---------------------------------------------------------------------------
function Get-ServiceState {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) { return 'missing' }
    switch ($svc.Status) {
        'Running'      { return 'running' }
        'StartPending' { return 'starting' }
        'Stopped'      { return 'stopped' }
        'StopPending'  { return 'stopping' }
        default        { return $svc.Status.ToString() }
    }
}

# ---------------------------------------------------------------------------
# Controles (UAC estandar de Windows por accion)
# ---------------------------------------------------------------------------
function Start-Server {
    Start-Process -FilePath 'net.exe' -ArgumentList 'start', $ServiceName -Verb RunAs -WindowStyle Hidden
    Start-Sleep -Milliseconds 800
    Refresh-Now
}

function Stop-Server {
    Start-Process -FilePath 'net.exe' -ArgumentList 'stop', $ServiceName -Verb RunAs -WindowStyle Hidden
    Start-Sleep -Milliseconds 800
    Refresh-Now
}

function Restart-Server {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "net stop $ServiceName & net start $ServiceName" -Verb RunAs -WindowStyle Hidden
    Start-Sleep -Milliseconds 800
    Refresh-Now
}

function Open-Panel {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $PanelUrl
}

function Open-File([string]$path) {
    if (Test-Path $path) { Start-Process 'explorer.exe' -ArgumentList $path }
    else { [System.Windows.Forms.MessageBox]::Show("No se encontro: $path", $AppName, 'OK', 'Information') | Out-Null }
}

# ---------------------------------------------------------------------------
# Ventana 'Configurar...' (centro de control del usuario)
# ---------------------------------------------------------------------------
$script:cfgForm   = $null
$script:cfgLabel = $null   # etiqueta de estado en vivo
$script:cfgTimer = $null   # refresco de la ventana

function Update-CfgStatus {
    if (-not $script:cfgLabel -or $script:cfgLabel.IsDisposed) { return }
    switch (Get-ServiceState) {
        'running'  { $script:cfgLabel.Text = 'Estado: EN EJECUCION'; $script:cfgLabel.ForeColor = [System.Drawing.Color]::FromArgb(0, 140, 80) }
        'starting' { $script:cfgLabel.Text = 'Estado: iniciando...';   $script:cfgLabel.ForeColor = [System.Drawing.Color]::FromArgb(180, 140, 0) }
        'stopped'  { $script:cfgLabel.Text = 'Estado: DETENIDO';     $script:cfgLabel.ForeColor = [System.Drawing.Color]::FromArgb(190, 40, 30) }
        'stopping' { $script:cfgLabel.Text = 'Estado: deteniendo...';  $script:cfgLabel.ForeColor = [System.Drawing.Color]::FromArgb(180, 140, 0) }
        'missing'  { $script:cfgLabel.Text = 'Estado: servicio NO instalado'; $script:cfgLabel.ForeColor = [System.Drawing.Color]::Gray }
        default    { $script:cfgLabel.Text = "Estado: $(Get-ServiceState)";   $script:cfgLabel.ForeColor = [System.Drawing.Color]::DimGray }
    }
}

function Open-ConfigWindow {
    # Una sola ventana: si ya esta abierta, al frente.
    if ($script:cfgForm -and -not $script:cfgForm.IsDisposed) {
        [void]$script:cfgForm.Activate()
        return
    }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "Configurar - $AppName"
    $form.Size = New-Object System.Drawing.Size 500, 420
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.Icon = $IconRun.Icon

    $lblEstado = New-Object System.Windows.Forms.Label
    $lblEstado.Location = New-Object System.Drawing.Point 16, 16
    $lblEstado.Size = New-Object System.Drawing.Size 460, 24
    $lblEstado.Font = New-Object System.Drawing.Font ('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
    $lblEstado.Text = 'Estado: ...'
    $form.Controls.Add($lblEstado)
    $script:cfgLabel = $lblEstado

    $lblDetalle = New-Object System.Windows.Forms.Label
    $lblDetalle.Location = New-Object System.Drawing.Point 16, 42
    $lblDetalle.Size = New-Object System.Drawing.Size 460, 20
    $lblDetalle.ForeColor = [System.Drawing.Color]::DimGray
    $lblDetalle.Text = "Servicio de Windows: $ServiceName"
    $form.Controls.Add($lblDetalle)

    $lblUrl = New-Object System.Windows.Forms.Label
    $lblUrl.Location = New-Object System.Drawing.Point 16, 70
    $lblUrl.Size = New-Object System.Drawing.Size 460, 20
    $lblUrl.Text = "Panel (configuracion completa): $PanelUrl"
    $form.Controls.Add($lblUrl)

    # Botonera 2x4 (Iniciar | Detener | Reiniciar | Panel | Credenciales |
    # Datos | Programa | Logs) - TODO lo que el usuario pidio en 'configurar'.
    $defs = @(
        @{ T = 'Iniciar servidor';      X = 16;  Y = 100; A = { Start-Server;    Update-CfgStatus } }
        @{ T = 'Detener servidor';      X = 248; Y = 100; A = { Stop-Server;     Update-CfgStatus } }
        @{ T = 'Reiniciar servidor';    X = 16;  Y = 142; A = { Restart-Server;  Update-CfgStatus } }
        @{ T = 'Abrir Panel';           X = 248; Y = 142; A = { Open-Panel } }
        @{ T = 'Ver credenciales';      X = 16;  Y = 184; A = { if (Test-Path $CredFile) { Start-Process 'notepad.exe' -ArgumentList $CredFile } else { Open-File $CredFile } } }
        @{ T = 'Carpeta de datos';      X = 248; Y = 184; A = { Open-File $DataDir } }
        @{ T = 'Carpeta del programa';  X = 16;  Y = 226; A = { Open-File $AppDir } }
        @{ T = 'Ver registros (logs)';  X = 248; Y = 226; A = { Open-File $LogDir } }
    )
    foreach ($d in $defs) {
        $b = New-Object System.Windows.Forms.Button
        $b.Location = New-Object System.Drawing.Point $d.X, $d.Y
        $b.Size = New-Object System.Drawing.Size 224, 34
        $b.Text = $d.T
        $b.Add_Click($d.A)
        $form.Controls.Add($b)
    }

    $lblNota = New-Object System.Windows.Forms.Label
    $lblNota.Location = New-Object System.Drawing.Point 16, 278
    $lblNota.Size = New-Object System.Drawing.Size 460, 64
    $lblNota.ForeColor = [System.Drawing.Color]::DimGray
    $lblNota.Text = "Toda la configuracion del restaurante (temas, pantallas,`r`nlicencias, usuarios) se hace desde el Panel web.`r`nEl servidor se inicia automaticamente con Windows."
    $form.Controls.Add($lblNota)

    $btnCerrar = New-Object System.Windows.Forms.Button
    $btnCerrar.Location = New-Object System.Drawing.Point 372, 346
    $btnCerrar.Size = New-Object System.Drawing.Size 100, 30
    $btnCerrar.Text = 'Cerrar'
    $btnCerrar.Add_Click({ $script:cfgForm.Close() })
    $form.Controls.Add($btnCerrar)

    # Refresco en vivo mientras la ventana esta abierta (3 s)
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 3000
    $timer.Add_Tick({ Update-CfgStatus })
    $timer.Start()
    $script:cfgTimer = $timer

    $form.Add_FormClosed({
        if ($script:cfgTimer) { $script:cfgTimer.Stop(); $script:cfgTimer.Dispose(); $script:cfgTimer = $null }
        $script:cfgForm = $null
        $script:cfgLabel = $null
    })

    $script:cfgForm = $form
    Update-CfgStatus
    [void]$form.Show()
    [void]$form.Activate()
}

# ---------------------------------------------------------------------------
# Bandeja + menu contextual (Iniciar | Detener | Configurar | Panel | Salir)
# ---------------------------------------------------------------------------
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Text = "$AppName"
$tray.Icon = $IconStop.Icon
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$mTitle = New-Object System.Windows.Forms.ToolStripMenuItem $AppName
$mTitle.Enabled = $false
[void]$menu.Items.Add($mTitle)

$mEstado = New-Object System.Windows.Forms.ToolStripMenuItem 'Estado: ...'
$mEstado.Enabled = $false
[void]$menu.Items.Add($mEstado)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$mStart = New-Object System.Windows.Forms.ToolStripMenuItem 'Iniciar servidor'
$mStart.Add_Click({ Start-Server })
[void]$menu.Items.Add($mStart)

$mStop = New-Object System.Windows.Forms.ToolStripMenuItem 'Detener servidor'
$mStop.Add_Click({ Stop-Server })
[void]$menu.Items.Add($mStop)

$mRestart = New-Object System.Windows.Forms.ToolStripMenuItem 'Reiniciar servidor'
$mRestart.Add_Click({ Restart-Server })
[void]$menu.Items.Add($mRestart)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$mConfig = New-Object System.Windows.Forms.ToolStripMenuItem 'Configurar...'
$mConfig.Add_Click({ Open-ConfigWindow })
[void]$menu.Items.Add($mConfig)

$mPanel = New-Object System.Windows.Forms.ToolStripMenuItem 'Abrir Panel (localhost:3000)'
$mPanel.Add_Click({ Open-Panel })
[void]$menu.Items.Add($mPanel)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$mExit = New-Object System.Windows.Forms.ToolStripMenuItem 'Salir (cierra solo la bandeja; el servidor sigue)'
$mExit.Add_Click({
    $script:timer.Stop()
    $tray.Visible = $false
    $tray.Dispose()
    try { if ((Get-Content $PidFile -ErrorAction SilentlyContinue) -eq "$PID") { Remove-Item $PidFile -ErrorAction SilentlyContinue } } catch { }
    [System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($mExit)

$tray.ContextMenuStrip = $menu
$tray.Add_DoubleClick({ Open-ConfigWindow })

# ---------------------------------------------------------------------------
# Refresco periodico (5 s) + globos de cambio de estado
# ---------------------------------------------------------------------------
$script:lastState = ''

function Refresh-Now {
    $state = Get-ServiceState
    switch ($state) {
        'running'  { $tray.Icon = $IconRun.Icon;  $tray.Text = "$AppName - En ejecucion"; $mEstado.Text = 'Estado: EN EJECUCION'; $mStart.Enabled = $false; $mStop.Enabled = $true;  $mRestart.Enabled = $true }
        'starting' { $tray.Icon = $IconWait.Icon; $tray.Text = "$AppName - Iniciando...";   $mEstado.Text = 'Estado: iniciando...';   $mStart.Enabled = $false; $mStop.Enabled = $true;  $mRestart.Enabled = $false }
        'stopped'  { $tray.Icon = $IconStop.Icon; $tray.Text = "$AppName - Detenido";     $mEstado.Text = 'Estado: DETENIDO';     $mStart.Enabled = $true;  $mStop.Enabled = $false; $mRestart.Enabled = $false }
        'stopping' { $tray.Icon = $IconWait.Icon; $tray.Text = "$AppName - Deteniendo...";  $mEstado.Text = 'Estado: deteniendo...';  $mStart.Enabled = $true;  $mStop.Enabled = $false; $mRestart.Enabled = $false }
        'missing'  { $tray.Icon = $IconStop.Icon; $tray.Text = "$AppName - Sin servicio"; $mEstado.Text = 'Estado: servicio NO instalado'; $mStart.Enabled = $false; $mStop.Enabled = $false; $mRestart.Enabled = $false }
        default    { $tray.Icon = $IconWait.Icon; $tray.Text = "$AppName - $state";       $mEstado.Text = "Estado: $state" }
    }
    # Globo SOLO al cambiar de estado (no cada tick - no molestar).
    if ($script:lastState -and $script:lastState -ne $state) {
        switch ($state) {
            'running' { Show-Balloon 'ViewLBA activo' 'El servidor esta EN EJECUCION. Listo para usar.' 'Info' }
            'stopped' { Show-Balloon 'ViewLBA detenido' 'El servidor se DETUVO. Las pantallas dejaran de actualizarse.' 'Warning' }
        }
    }
    $script:lastState = $state
}

function Show-Balloon([string]$title, [string]$msg, [string]$kind) {
    try {
        $tray.BalloonTipTitle = $title
        $tray.BalloonTipText = $msg
        $tray.BalloonTipIcon = $kind
        $tray.ShowBalloonTip(4000)
    } catch { }
}

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 5000
$script:timer.Add_Tick({ Refresh-Now })
$script:timer.Start()
Refresh-Now

# Globo de bienvenida (el icono queda como indicador permanente de estado)
Show-Balloon "$AppName" 'Icono de estado activo: VERDE en ejecucion | ROJO detenido. Clic derecho para Iniciar / Detener / Configurar.' 'Info'

# ---------------------------------------------------------------------------
# Bucle de mensajes (la bandeja vive mientras no elijan 'Salir')
# ---------------------------------------------------------------------------
[System.Windows.Forms.Application]::Run()
