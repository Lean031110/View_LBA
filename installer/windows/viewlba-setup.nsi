; ============================================================================
; ViewLBA Server — Setup.exe NATIVO (NSIS 3 — sin Tauri, sin GUI)
;
; MISIÓN (feedback del usuario): «que todo sea sencillo, instalar y ejecutar»:
;   0. UNA SOLA PANTALLA: siguiente → instala → terminar. Sin preguntas.
;   1. Copia el payload (servidor Next.js standalone + runtime bun INCLUIDO
;      + nssm). NO instala node ni bun del sistema: el paquete trae SU
;      PROPIO runtime (runtime\bun.exe). Cero dependencias, 100 % offline.
;   2. Instalación REAL vía sidecar `viewlba-installer.exe --config`:
;      DB SQLite + admin + servicio de Windows (NSSM) registrado Y ARRANCADO
;      + health-check. Ubicación canónica: C:\PantallaRestaurante\{app,data,logs}.
;   3. Accesos directos en ESCRITORIO y menú Inicio:
;        ViewLBA - Panel          → abre http://localhost:3000
;        ViewLBA - Iniciar/Detener servidor (UAC estándar de Windows)
;        ViewLBA - Credenciales   → usuario + contraseña admin generados
;        ViewLBA - Bandeja        → icono persistente junto al reloj con
;                                   clic derecho: Iniciar · Detener · Panel
;      La bandeja se auto-arranca con Windows (notificación persistente).
;   4. Modo silencioso: Setup.exe /S  (empresas/CI).
;
; Build:
;   makensis -DVERSION=3.2.0 ^
;            -DPAYLOAD=dist\release\windows\ViewLBA-Server ^
;            -DICON=installer\gui\src-tauri\icons\icon.ico ^
;            installer\windows\viewlba-setup.nsi
;
; El sidecar (installer/cli) hace el trabajo REAL (copias, .env, DB, admin,
; NSSM, arranque, health). Este script empaqueta y orquesta. El uninstaller
; llama al sidecar (conserva datos/backup del usuario) y limpia accesos,
; registro y carpetas.
; ============================================================================

Unicode true

!define APPNAME "ViewLBA Server"
!define COMPANY "ViewLBA"
!define URL_PANEL "http://localhost:3000"
!define SERVICE_APP "PantallaRestaurante"
!define SERVICE_REALTIME "PantallaRestauranteRealtime"
!define SERVICE_STREAM "PantallaRestauranteStream"
; Ubicación canónica del servidor (la misma que espera el sidecar/tray/manager)
!define APP_DIR "C:\PantallaRestaurante"

Var AdminPassword

!ifndef VERSION
  !error "VERSION requerido: -DVERSION=3.2.0"
!endif
; NOTA DE RUTAS (lección del primer build real v3.2.0): makensis resuelve
; las rutas RELATIVAS de File contra el CWD DE QUIEN LO INVOCA (NO contra
; el directorio del script — comprobado empíricamente: File "tray/…"
; falló en CI con CWD=raíz del repo aunque el archivo existe junto al
; script). En CI se pasan -DPAYLOAD/-DOUT_EXE/-DTRAY_PS1/-DICON con rutas
; ABSOLUTAS; los defaults relativos solo sirven invocando makensis desde
; installer/windows/.
!ifndef PAYLOAD
  !define PAYLOAD "../../dist/release/windows/ViewLBA-Server"
!endif
!ifndef TRAY_PS1
  !define TRAY_PS1 "tray/ViewLBA-Tray.ps1"
!endif
!ifndef ICON
  !define ICON "viewlba.ico"
!endif
!ifndef OUT_EXE
  !define OUT_EXE "../../dist/release/windows/out/ViewLBA-Server-Setup-${VERSION}.exe"
!endif
!ifndef PKGDIR
  !define PKGDIR "C:\ViewLBA"
!endif

Name "${APPNAME} ${VERSION}"
OutFile "${OUT_EXE}"
InstallDir "${PKGDIR}"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

; ---------------------------------------------------------------------------
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_FINISHPAGE_TITLE "Instalación de ${APPNAME} completada"
!define MUI_FINISHPAGE_TITLE_3LINES
!define MUI_FINISHPAGE_TEXT "El servidor quedó instalado, registrado como servicio de Windows y ARRANCÁNDOSE.$\r$\n$\r$\n· Acceso directo «ViewLBA - Panel» en el escritorio → abre http://localhost:3000 (espera ~30 s el primer arranque).$\r$\n· «ViewLBA - Credenciales» → usuario y contraseña del administrador.$\r$\n· Icono de ViewLBA junto al reloj (bandeja): clic derecho para Iniciar/Detener el servidor.$\r$\n$\r$\nSe reinicia automáticamente con Windows."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Abrir el Panel de ${APPNAME} ahora"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenPanel
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Spanish"

; ---------------------------------------------------------------------------
; Sección principal
; ---------------------------------------------------------------------------
Section "Instalar ${APPNAME}" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; ---- 1. Payload completo (servidor + runtime bun + nssm + sidecar) ----
  ; Paquete AUTOSUFICIENTE: bun.exe y nssm.exe van DENTRO (runtime\).
  ; La máquina del usuario NO necesita node, bun ni nada instalado.
  DetailPrint "Copiando ${APPNAME} (servidor + runtime incluido, ~450 MB)…"
  ; ⚠ patrón `\*` y NO `\*.*`: en NSIS, *.* SOLO casa nombres con PUNTO —
  ; dejaba fuera node_modules, runtime, mini-services, prisma… (el payload
  ; llegaba COJO a $INSTDIR y el preflight fallaba con «Payload offline
  ; INCOMPLETO» — bug real del cuarto build de v3.2.0). `\*` casa TODO,
  ; incluidos los nombres sin extensión y los dotfiles (.next, .bin).
  File /r "${PAYLOAD}\*"

  ; Guard: el payload DEBE llegar completo (fail-fast con mensaje claro)
  ${IfNot} ${FileExists} "$INSTDIR\runtime\bun.exe"
    ${OrIfNot} ${FileExists} "$INSTDIR\resources\server\node_modules\.bin"
    Abort "Payload incompleto tras la copia (¿patrón de File?): falta runtime\bun.exe o node_modules\.bin"
  ${EndIf}

  ; ---- 2. Credenciales admin (generadas EN ESTA máquina) ----------------
  ; PowerShell genera una contraseña con política del servidor
  ; (10+ chars, mayúscula+minúscula+dígito) y la deja en .pwd.tmp;
  ; NSIS la lee, escribe el config y borra el temporal.
  DetailPrint "Generando credenciales del administrador…"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$p=''ViewLBA-''+[guid]::NewGuid().ToString(''N'').Substring(0,8).ToUpper()+''-7x''; Set-Content -Path \"$INSTDIR\.pwd.tmp\" -Value $$p -Encoding ASCII; Write-Host $$p"'
  Pop $0
  ${If} ${FileExists} "$INSTDIR\.pwd.tmp"
    FileOpen $1 "$INSTDIR\.pwd.tmp" r
    FileRead $1 $2
    FileClose $1
    Delete "$INSTDIR\.pwd.tmp"
    StrCpy $AdminPassword $2
    Push $AdminPassword
    Call TrimNewline
    Pop $AdminPassword
  ${Else}
    StrCpy $AdminPassword "ViewLBA-CambioYa1"
  ${EndIf}
  ${If} $AdminPassword == ""
    StrCpy $AdminPassword "ViewLBA-CambioYa1"
  ${EndIf}
  DetailPrint "Contraseña generada (se guarda en CREDENCIALES.txt)."

  FileOpen $1 "$INSTDIR\install-config.json" w
  FileWrite $1 '{"mode":"new","restaurantName":"Mi Restaurante","timezone":"America/Havana","webPort":3000,"realtimePort":3003,"rtmpPort":1935,"httpFlvPort":8000,"lanMode":false,"adminEmail":"admin@viewlba.local","adminPassword":"$AdminPassword","withDemoData":false,"offline":true,"runBuild":false}'
  FileClose $1

  FileOpen $1 "$INSTDIR\CREDENCIALES.txt" w
  FileWrite $1 "ViewLBA Server ${VERSION} - Credenciales del administrador$\r$\n$\r$\n"
  FileWrite $1 "Panel: http://localhost:3000$\r$\n"
  FileWrite $1 "Usuario:  admin@viewlba.local$\r$\n"
  FileWrite $1 "Password: $AdminPassword$\r$\n$\r$\n"
  FileWrite $1 "(Guárdalas en un lugar seguro; puedes cambiar la contraseña$\r$\n"
  FileWrite $1 " desde el panel: Usuarios - editar administrador.)$\r$\n"
  FileClose $1

  ; ---- 3. Instalación REAL: copia app + DB + admin + servicio + arranque --
  DetailPrint "Instalando el servicio de Windows y preparando la base de datos…"
  ; La salida se REDIRIGE a $INSTDIR\install.log: en /S (silencioso) el
  ; detalle de nsExec NO es visible y el error real quedaba tragado
  ; (lección de los builds 9-10: sin el log el diagnóstico era imposible).
  ; ⚠ /TIMEOUT=600000 (10 min — lección de los builds 15-18): el sidecar
  ; de bun-compile en CI completaba TODA la instalación (servicio Running,
  ; health ok) en 39-309 s pero su PROCESO a veces no terminaba (handles
  ; nativos de bun→prisma→engine) → ExecToLog esperaba para siempre. Con
  ; 10 min de margen (20× el instalar más lento observado) el wait se
  ; acota; el estado REAL se verifica después con el servicio (abajo).
  retry_install:
  nsExec::ExecToLog /TIMEOUT=600000 'cmd /c ""$INSTDIR\viewlba-installer.exe" --config "$INSTDIR\install-config.json" > "$INSTDIR\install.log" 2>&1"'
  Pop $0
  ${If} $0 == 0
    Goto after_install
  ${EndIf}
  ; ¿Timeout (-1) o código ≠ 0? VERIFICAR EL ESTADO REAL: el sidecar puede
  ; haber COMPLETADO la instalación (reporte «INSTALACIÓN COMPLETA» en el
  ; install.log, servicio registrado y Running) aunque su proceso no haya
  ; terminado limpiamente. El servicio es la verdad del sistema.
  nsExec::ExecToLog 'cmd /c "sc query ${SERVICE_APP} | find RUNNING > nul"'
  Pop $1
  ${If} $1 == 0
    DetailPrint "Instalación completada (servicio ${SERVICE_APP} RUNNING — salida del instalador: $0)."
    Goto after_install
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP \
    "La instalación del servicio terminó con código $0.$\r$\n$\r$\nRevisa $INSTDIR\install.log.$\r$\n¿Reintentar la instalación del servicio?" /SD IDCANCEL IDRETRY retry_install
  Abort "Instalación del servicio fallida (código $0)."
  after_install:
  Delete "$INSTDIR\install-config.json"

  ; ---- 4. Bandeja del sistema (icono PERMANENTE junto al reloj) --------
  ; Menú: Iniciar · Detener · Reiniciar · Configurar · Panel · Salir.
  ; Icono VERDE = activo / ROJO = detenido / AMARILLO = transición.
  ; Autostart con la sesión (HKCU Run) — el icono SIEMPRE está.
  DetailPrint "Instalando la bandeja del sistema (iniciar/detener/configurar)…"
  SetOutPath "$INSTDIR\tray"
  File "${TRAY_PS1}"
  SetOutPath "$INSTDIR"
  ; icono del producto (accesos + bandeja)
  File /oname=viewlba.ico "${ICON}"

  ; ---- 5. Accesos directos: escritorio + menú Inicio --------------------
  DetailPrint "Creando accesos directos…"
  !define SM "$SMPROGRAMS\${APPNAME}"
  CreateDirectory "${SM}"

  ; Panel (navegador)
  CreateShortCut "$DESKTOP\ViewLBA - Panel.lnk" "$WINDIR\explorer.exe" "${URL_PANEL}" "$INSTDIR\viewlba.ico" 0
  CreateShortCut "${SM}\ViewLBA - Panel.lnk" "$WINDIR\explorer.exe" "${URL_PANEL}" "$INSTDIR\viewlba.ico" 0

  ; Iniciar / Detener (UAC estándar de Windows vía PowerShell)
  ; Nota: ArgumentList separado por COMAS (start,PantallaRestaurante) para
  ; evitar comillas anidadas en el .lnk (el parser de NSIS las rechaza).
  !macro SvcShortcut NAME ARGS
    CreateShortCut "$DESKTOP\ViewLBA - ${NAME}.lnk" "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -Command "Start-Process net.exe -ArgumentList ${ARGS} -Verb RunAs -WindowStyle Hidden"' "$INSTDIR\viewlba.ico" 0
    CreateShortCut "${SM}\ViewLBA - ${NAME}.lnk" "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -Command "Start-Process net.exe -ArgumentList ${ARGS} -Verb RunAs -WindowStyle Hidden"' "$INSTDIR\viewlba.ico" 0
  !macroend
  !insertmacro SvcShortcut "Iniciar servidor" "start,${SERVICE_APP}"
  !insertmacro SvcShortcut "Detener servidor" "stop,${SERVICE_APP}"

  ; Credenciales
  CreateShortCut "$DESKTOP\ViewLBA - Credenciales.lnk" "notepad.exe" "$INSTDIR\CREDENCIALES.txt" "$INSTDIR\viewlba.ico" 0
  CreateShortCut "${SM}\ViewLBA - Credenciales.lnk" "notepad.exe" "$INSTDIR\CREDENCIALES.txt" "$INSTDIR\viewlba.ico" 0

  ; Bandeja (tray)
  CreateShortCut "$DESKTOP\ViewLBA - Bandeja.lnk" "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\tray\ViewLBA-Tray.ps1"' "$INSTDIR\viewlba.ico" 0
  CreateShortCut "${SM}\ViewLBA - Bandeja.lnk" "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\tray\ViewLBA-Tray.ps1"' "$INSTDIR\viewlba.ico" 0

  ; Autostart de la bandeja al iniciar sesión (HKCU Run)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APPNAME}Tray" '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\tray\ViewLBA-Tray.ps1"'

  ; ---- 6. Registro + desinstalador --------------------------------------
  WriteRegStr HKLM "Software\${APPNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\${APPNAME}" "AppDir" "${APP_DIR}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayName" "${APPNAME} ${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayIcon" '"$INSTDIR\viewlba-installer.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "Publisher" "${COMPANY}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoModify" "1"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoRepair" "1"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Lanzar la bandeja AHORA (para este primer uso).
  ; ⚠⚠⚠ 21.er build (v3.2.0): NO usar nsExec::Exec aquí — REGRESIÓN FATAL.
  ; nsExec::Exec ESPERA a que el proceso termine, y la bandeja es un bucle
  ; de mensajes INFINITO ([Windows.Forms.Application]::Run()) → Setup.exe
  ; quedaba colgado PARA SIEMPRE tras una instalación PERFECTA (el runner
  ; lo mató a los 22 min: PID hijo = powershell.exe de la bandeja). El
  ; comando NO-wait de NSIS es `Exec` (documentado: ejecuta y devuelve
  ; el control inmediatamente). tests/installer/tray.test.ts lo protege.
  DetailPrint "Lanzando la bandeja del sistema (icono junto al reloj)…"
  ; marcador de diagnóstico (evidencia para el CI): el flujo llegó al Exec.
  FileOpen $1 "$INSTDIR\tray\tray-launch.txt" w
  FileWrite $1 "exec ${VERSION}$\r$\n"
  FileClose $1
  ; ⚠ Exec (a secas) NO apila nada: sin Pop (a diferencia de nsExec).
  Exec '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\tray\ViewLBA-Tray.ps1"'
  ${If} ${Errors}
    DetailPrint "Aviso: no se pudo lanzar la bandeja (se iniciará con Windows)."
    ClearErrors
  ${EndIf}
SectionEnd

; ---------------------------------------------------------------------------
; Helpers
; ---------------------------------------------------------------------------
Function .onInit
  SetRegView 64
FunctionEnd

Function OpenPanel
  Exec '"$WINDIR\explorer.exe" "${URL_PANEL}"'
FunctionEnd

; Quita CR/LF finales (uno o varios) de la cadena del stack
Function TrimNewline
  Exch $R0
  Push $R1
loop:
  StrLen $R1 $R0
  StrCmp $R1 0 done
  StrCpy $R1 $R0 1 -1
  StrCmp $R1 "$\r" trim
  StrCmp $R1 "$\n" trim
  Goto done
trim:
  StrCpy $R0 $R0 -1
  Goto loop
done:
  Pop $R1
  Exch $R0
FunctionEnd

; ---------------------------------------------------------------------------
; Desinstalación: sidecar uninstall (SERVICIOS + app; conserva DB/backups
; del usuario) + limpieza de bandeja, accesos, registro y carpetas.
; ---------------------------------------------------------------------------
Section "Uninstall"
  ; 1. Quitar servicios + aplicación (sidecar — puede tardar ~1 min)
  ; ⚠ /TIMEOUT=300000 (lección builds 15-18): el sidecar puede no terminar
  ; su proceso pese a completar el trabajo; con el timeout el wait se acota
  ; y la eliminación del servicio se fuerza si quedó vivo.
  DetailPrint "Deteniendo y desinstalando los servicios…"
  nsExec::ExecToLog /TIMEOUT=300000 '"$INSTDIR\viewlba-installer.exe" uninstall --confirm'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Uninstall terminó con salida $0 — verificando/forzando eliminación del servicio…"
    nsExec::ExecToLog 'cmd /c "sc stop ${SERVICE_APP} & sc delete ${SERVICE_APP} & sc stop ${SERVICE_REALTIME} & sc delete ${SERVICE_REALTIME} & sc stop ${SERVICE_STREAM} & sc delete ${SERVICE_STREAM} > nul 2>&1"'
    Pop $0
  ${EndIf}

  ; 2. Bandeja: quitar autostart y cerrarla
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APPNAME}Tray"
  nsExec::ExecToLog 'powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name=''powershell.exe''\" | Where-Object { $$_.CommandLine -match ''ViewLBA-Tray'' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Pop $0

  ; 3. Accesos directos
  Delete "$DESKTOP\ViewLBA - Panel.lnk"
  Delete "$DESKTOP\ViewLBA - Iniciar servidor.lnk"
  Delete "$DESKTOP\ViewLBA - Detener servidor.lnk"
  Delete "$DESKTOP\ViewLBA - Credenciales.lnk"
  Delete "$DESKTOP\ViewLBA - Bandeja.lnk"
  Delete "${SM}\ViewLBA - Panel.lnk"
  Delete "${SM}\ViewLBA - Iniciar servidor.lnk"
  Delete "${SM}\ViewLBA - Detener servidor.lnk"
  Delete "${SM}\ViewLBA - Credenciales.lnk"
  Delete "${SM}\ViewLBA - Bandeja.lnk"
  RMDir "${SM}"

  ; 4. Registro y archivos del paquete
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
  DeleteRegKey HKLM "Software\${APPNAME}"
  Delete "$INSTDIR\uninstall.exe"
  Delete "$INSTDIR\install-config.json"
  Delete "$INSTDIR\CREDENCIALES.txt"
  RMDir /r "$INSTDIR\tray"
  RMDir /r "$INSTDIR"
  MessageBox MB_OK|MB_ICONINFORMATION "Se desinstalaron los programas de ${APPNAME}.$\r$\n$\r$\nLos DATOS del restaurante (base de datos, media y backups) se conservaron en:${APP_DIR} — bórralos a mano si ya no los necesitas." /SD IDOK
SectionEnd
