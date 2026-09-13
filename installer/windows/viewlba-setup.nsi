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
; Ubicación canónica del servidor (la misma que espera el sidecar/tray/manager)
!define APP_DIR "C:\PantallaRestaurante"

Var AdminPassword

!ifndef VERSION
  !error "VERSION requerido: -DVERSION=3.2.0"
!endif
; NOTA DE RUTAS: makensis resuelve rutas RELATIVAS contra el DIRECTORIO
; DEL SCRIPT (no el CWD de quien lo invoca). Defaults = staging estándar
; del repo; en CI se pasan -DPAYLOAD/-DOUT_EXE con rutas ABSOLUTAS.
!ifndef PAYLOAD
  !define PAYLOAD "../../dist/release/windows/ViewLBA-Server"
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
  File /r "${PAYLOAD}\*.*"

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
  nsExec::ExecToLog '"$INSTDIR\viewlba-installer.exe" --config "$INSTDIR\install-config.json"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_RETRYCANCEL|MB_ICONSTOP \
      "La instalación del servicio terminó con código $0.$\r$\n$\r$\nRevisa el detalle arriba y en $INSTDIR.$\r$\n¿Reintentar la instalación del servicio?" /SD IDCANCEL IDRETRY retry_install
    Abort "Instalación del servicio fallida (código $0)."
  ${EndIf}
  Goto after_install
  retry_install:
    nsExec::ExecToLog '"$INSTDIR\viewlba-installer.exe" --config "$INSTDIR\install-config.json"'
    Pop $0
    ${If} $0 != 0
      Abort "La reinstalación del servicio falló (código $0)."
    ${EndIf}
  after_install:
  Delete "$INSTDIR\install-config.json"

  ; ---- 4. Bandeja del sistema (notificación persistente) ----------------
  DetailPrint "Instalando la bandeja del sistema (iniciar/detener con clic derecho)…"
  SetOutPath "$INSTDIR\tray"
  File "tray/ViewLBA-Tray.ps1"
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

  ; Lanzar la bandeja AHORA (para este primer uso)
  nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\tray\ViewLBA-Tray.ps1"'
  Pop $0
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
  DetailPrint "Deteniendo y desinstalando los servicios…"
  nsExec::ExecToLog '"$INSTDIR\viewlba-installer.exe" uninstall --confirm'
  Pop $0

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
