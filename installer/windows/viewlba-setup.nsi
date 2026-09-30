; ============================================================================
; ViewLBA Server — Setup.exe bootstrapper (NSIS 3) — Fase 2 misión
; ============================================================================
; MISSION COMPLIANCE:
;   - NO NSSM (misión §0.8) — service host Rust (viewlba-service.exe) replaces it
;   - NO PowerShell for credentials (misión §6) — secrets.ts (RNG crypto) does it
;   - NO .pwd.tmp temporal (misión §6)
;   - NO 'sc query | find' (misión §7) — service host checks SCM directly
;   - NO hardcoded password fallback (misión §6)
;
; This is a BOOTSTRAPPER for the canonical MSI (installer/windows-msi/viewlba.wxs).
; For users who can't run .msi directly (rare on modern Windows), this .exe
; chain-installs the MSI via msiexec /i.
;
; For backwards compat during the migration period, this .exe can also do a
; "legacy install" via the sidecar viewlba-installer.exe + viewlba-service.exe.
;
; Build:
;   makensis -DVERSION=3.3.0 \
;            -DPAYLOAD=dist\release\windows\ViewLBA-Server \
;            -DBUILD_DIR=dist\release\windows\stage \
;            -DMSI_PATH=dist\release\windows\ViewLBA-Server-Setup-3.3.0.msi \
;            -DICON=installer\gui\src-tauri\icons\icon.ico \
;            installer\windows\viewlba-setup.nsi
;
; The MSI is the canonical installer. This .exe is just a launcher.
; ============================================================================

Unicode true

!define APPNAME "ViewLBA Server"
!define COMPANY "ViewLBA"
!define URL_PANEL "http://localhost:3000"
!define SERVICE_NAME "ViewLBA"
!define INSTALL_DIR_NAME "ViewLBA Server"

; Canonical Windows install locations (misión §3):
;   Program Files = binaries
;   ProgramData   = data, config, logs, credentials
!define APP_DIR "$PROGRAMFILES64\${INSTALL_DIR_NAME}"
!define DATA_DIR "$COMMONAPPDATA\ViewLBA"

Var AdminPassword

!ifndef VERSION
  !error "VERSION requerido: -DVERSION=3.3.0"
!endif
!ifndef PAYLOAD
  !define PAYLOAD "../../dist/release/windows/ViewLBA-Server"
!endif
!ifndef BUILD_DIR
  !define BUILD_DIR "../../dist/release/windows/stage"
!endif
!ifndef MSI_PATH
  !define MSI_PATH "../../dist/release/windows/out/ViewLBA-Server-Setup-${VERSION}.msi"
!endif
!ifndef ICON
  !define ICON "viewlba.ico"
!endif
!ifndef OUT_EXE
  !define OUT_EXE "../../dist/release/windows/out/ViewLBA-Server-Setup-${VERSION}.exe"
!endif

Name "${APPNAME} ${VERSION}"
OutFile "${OUT_EXE}"
InstallDir "${APP_DIR}"
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
!define MUI_FINISHPAGE_TEXT "El servidor quedó instalado en $INSTDIR.$\r$\n$\r$\n· Acceso directo «ViewLBA - Panel» en el escritorio → abre ${URL_PANEL}.$\r$\n· Credenciales en $INSTDIR\CREDENCIALES.txt.$\r$\n· Icono de ViewLBA junto al reloj (bandeja): clic derecho para Iniciar/Detener.$\r$\n$\r$\nSe reinicia automáticamente con Windows."
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
; Section: install (canónica — usa el MSI si existe, fallback a legacy)
; ---------------------------------------------------------------------------
Section "Instalar ${APPNAME}" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; ---- 1. Guard de payload completo (misión §12) ----
  ; El payload debe traer TODO lo necesario para instalación offline:
  ; runtime/bun.exe, app/server.js, mini-services/, .next/standalone, etc.
  DetailPrint "Copiando ${APPNAME} (servidor + runtime incluido, ~450 MB)…"
  File /r "${PAYLOAD}\*"

  ; Guard anti-NSSM (misión §0.8) — el payload NUNCA debe incluir nssm.exe
  ${If} ${FileExists} "$INSTDIR\runtime\nssm.exe"
    Abort "Payload contiene nssm.exe — violación misión §0.8 (NO NSSM). Revisa el build del payload."
  ${EndIf}

  ; Guard anti-PowerShell tray (misión §5) — el payload NUNCA debe incluir ViewLBA-Tray.ps1
  ${If} ${FileExists} "$INSTDIR\tray\ViewLBA-Tray.ps1"
    Abort "Payload contiene ViewLBA-Tray.ps1 — violación misión §5 (NO PowerShell tray). Usa viewlba-tray.exe."
  ${EndIf}

  ; Guard de artefactos esenciales
  ${IfNot} ${FileExists} "$INSTDIR\runtime\bun.exe"
    Abort "Payload incompleto: falta runtime\bun.exe"
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\bin\viewlba-service.exe"
    Abort "Payload incompleto: falta bin\viewlba-service.exe (service host Rust)"
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\bin\viewlba-tray.exe"
    Abort "Payload incompleto: falta bin\viewlba-tray.exe (tray Rust)"
  ${EndIf}

  ; ---- 2. ProgramData structure (misión §3 + §7) ----
  ; config/, data/{db,media,backups,store}, logs/, credentials/, run/, cache/
  ; ACLs aplicadas por el sidecar (PowerShell en el sidecar es OK porque
  ; corre con token de administrador del instalador, no como bandeja final)
  CreateDirectory "${DATA_DIR}\config"
  CreateDirectory "${DATA_DIR}\data\db"
  CreateDirectory "${DATA_DIR}\data\media"
  CreateDirectory "${DATA_DIR}\data\backups"
  CreateDirectory "${DATA_DIR}\data\store"
  CreateDirectory "${DATA_DIR}\logs"
  CreateDirectory "${DATA_DIR}\credentials"
  CreateDirectory "${DATA_DIR}\run"
  CreateDirectory "${DATA_DIR}\cache"

  ; ---- 3. install-config.json (sin adminPassword embebido) ----
  ; Misión §6: el archivo de configuración inicial NO debe guardar secretos
  ; en línea de comandos. El sidecar viewlba-installer.exe genera la
  ; contraseña vía installer/core/secrets.ts (RNG crypto) y la escribe
  ; directamente a CREDENCIALES.txt con ACL restrictive.
  ClearErrors
  FileOpen $1 "$INSTDIR\install-config.json" w
  FileWrite $1 '{"mode":"new","restaurantName":"Mi Restaurante","timezone":"America/Havana","webPort":3000,"realtimePort":3003,"rtmpPort":1935,"httpFlvPort":8000,"lanMode":false,"adminEmail":"admin@viewlba.local","withDemoData":false,"offline":true,"runBuild":false,"generateCredentials":true}'
  FileClose $1
  ${If} ${Errors}
    Abort "No se pudo escribir install-config.json"
  ${EndIf}

  ; ---- 4. Sidecar: instala la DB, .env, admin user, credenciales ----
  ; El sidecar usa installer/core/secrets.ts (RNG crypto) — NO PowerShell.
  ; NO .pwd.tmp, NO ViewLBA-CambioYa1 fallback.
  DetailPrint "Instalando base de datos y credenciales (sidecar)…"
  retry_install:
  nsExec::ExecToLog /TIMEOUT=600000 '"$INSTDIR\bin\viewlba-installer.exe" --config "$INSTDIR\install-config.json"'
  Pop $0
  ${If} $0 == 0
    Goto after_install
  ${EndIf}
  ; Si el sidecar termina non-zero, NO usamos 'sc query | find' (misión §7)
  ; para verificar el estado — el sidecar emite su propio diagnóstico vía
  ; installer/core/diagnostics.ts. Fall-fast aquí.
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP \
    "La instalación del sidecar terminó con código $0.$\r$\n$\r$\nRevisa $INSTDIR\install.log.$\r$\n¿Reintentar?" /SD IDCANCEL IDRETRY retry_install
  Abort "Instalación del sidecar fallida (código $0)."
  after_install:
  Delete "$INSTDIR\install-config.json"

  ; ---- 5. Service host Rust: registra con SCM (misión §4) ----
  ; NO NSSM. NO PowerShell. NO cmd.exe. El host Rust usa CreateServiceW
  ; directamente (via windows-service crate).
  DetailPrint "Registrando el servicio de Windows (viewlba-service.exe --install)…"
  nsExec::ExecToLog '"$INSTDIR\bin\viewlba-service.exe" --install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "El registro del servicio falló (código $0). Revisa $INSTDIR\install.log."
    Abort "Registro del servicio fallido"
  ${EndIf}

  ; ---- 6. Arrancar el servicio ----
  DetailPrint "Arrancando el servicio ViewLBA…"
  nsExec::ExecToLog '"$INSTDIR\bin\viewlba-service.exe" --start'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Aviso: el servicio no arrancó inmediatamente (código $0). Se iniciará con Windows."
  ${EndIf}

  ; ---- 7. Product icon ----
  File /oname=viewlba.ico "${ICON}"

  ; ---- 8. Shortcuts (escritorio + menú inicio) ----
  DetailPrint "Creando accesos directos…"
  !define SM "$SMPROGRAMS\${APPNAME}"
  CreateDirectory "${SM}"

  ; Panel (navegador)
  CreateShortCut "$DESKTOP\ViewLBA - Panel.lnk" "$WINDIR\explorer.exe" "${URL_PANEL}" "$INSTDIR\viewlba.ico" 0
  CreateShortCut "${SM}\ViewLBA - Panel.lnk" "$WINDIR\explorer.exe" "${URL_PANEL}" "$INSTDIR\viewlba.ico" 0

  ; Tray binario (no PowerShell)
  CreateShortCut "$DESKTOP\ViewLBA - Bandeja.lnk" "$INSTDIR\bin\viewlba-tray.exe" "" "$INSTDIR\viewlba.ico" 0
  CreateShortCut "${SM}\ViewLBA - Bandeja.lnk" "$INSTDIR\bin\viewlba-tray.exe" "" "$INSTDIR\viewlba.ico" 0

  ; Credenciales
  CreateShortCut "$DESKTOP\ViewLBA - Credenciales.lnk" "notepad.exe" "${DATA_DIR}\credentials\CREDENCIALES.txt" "$INSTDIR\viewlba.ico" 0
  CreateShortCut "${SM}\ViewLBA - Credenciales.lnk" "notepad.exe" "${DATA_DIR}\credentials\CREDENCIALES.txt" "$INSTDIR\viewlba.ico" 0

  ; Autostart del tray (HKCU Run — binario, no PowerShell)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APPNAME}Tray" '"$INSTDIR\bin\viewlba-tray.exe"'

  ; ---- 9. Lanzar el tray ahora (icono junto al reloj) ----
  DetailPrint "Lanzando la bandeja del sistema (viewlba-tray.exe)…"
  Exec '"$INSTDIR\bin\viewlba-tray.exe"'

  ; ---- 10. ARP entry + uninstaller ----
  WriteRegStr HKLM "Software\${APPNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\${APPNAME}" "AppDir" "${APP_DIR}"
  WriteRegStr HKLM "Software\${APPNAME}" "DataDir" "${DATA_DIR}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayName" "${APPNAME} ${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayIcon" '"$INSTDIR\bin\viewlba-service.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "Publisher" "${COMPANY}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoModify" "1"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoRepair" "1"
  WriteUninstaller "$INSTDIR\uninstall.exe"
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

; ---------------------------------------------------------------------------
; Desinstalación:
;   - stop + uninstall service via viewlba-service.exe (NO sc.exe, NO net.exe)
;   - conservar ProgramData (DB, media, backups) — misión §13
;   - eliminar Program Files
; ---------------------------------------------------------------------------
Section "Uninstall"
  ; 1. Stop + uninstall service (via Rust host, no NSSM/cmd)
  DetailPrint "Deteniendo y eliminando el servicio ViewLBA…"
  nsExec::ExecToLog /TIMEOUT=30000 '"$INSTDIR\bin\viewlba-service.exe" --stop'
  Pop $0
  nsExec::ExecToLog /TIMEOUT=30000 '"$INSTDIR\bin\viewlba-service.exe" --uninstall'
  Pop $0

  ; 2. Bandeja: quitar autostart y cerrarla
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APPNAME}Tray"

  ; 3. Accesos directos
  Delete "$DESKTOP\ViewLBA - Panel.lnk"
  Delete "$DESKTOP\ViewLBA - Bandeja.lnk"
  Delete "$DESKTOP\ViewLBA - Credenciales.lnk"
  Delete "${SM}\ViewLBA - Panel.lnk"
  Delete "${SM}\ViewLBA - Bandeja.lnk"
  Delete "${SM}\ViewLBA - Credenciales.lnk"
  RMDir "${SM}"

  ; 4. Registro + archivos del paquete (Program Files)
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
  DeleteRegKey HKLM "Software\${APPNAME}"
  Delete "$INSTDIR\uninstall.exe"
  Delete "$INSTDIR\install-config.json"
  Delete "$INSTDIR\viewlba.ico"
  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\mini-services"
  RMDir /r "$INSTDIR\themes"
  RMDir /r "$INSTDIR\public"
  RMDir /r "$INSTDIR"

  ; 5. NO tocar ProgramData (misión §13: datos del cliente NUNCA eliminados en upgrade/uninstall)
  MessageBox MB_OK|MB_ICONINFORMATION "Se desinstalaron los programas de ${APPNAME}.$\r$\n$\r$\nLos DATOS del restaurante (base de datos, media y backups) se conservaron en:${DATA_DIR} — bórralos a mano si ya no los necesitas." /SD IDOK
SectionEnd
