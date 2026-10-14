; ============================================================================
; ViewLBA Server — Setup.exe Bootstrapper (NSIS 3) — Mision M
; ============================================================================
; PURE bootstrapper — does NOT install anything itself.
; The MSI (ViewLBA-Server-Setup-X.Y.Z.msi) is the CANONICAL installer.
; This .exe just wraps the MSI for user convenience:
;   1. User double-clicks ViewLBA-Server-Setup-X.Y.Z.exe
;   2. Bootstrapper finds the MSI (same directory)
;   3. Bootstrapper runs: msiexec /i ViewLBA-Server-Setup-X.Y.Z.msi
;   4. MSI handles ALL installation (files, service, ACLs, ARP, shortcuts)
;   5. Bootstrapper passes through the MSI exit code
;
; NO payload copying, NO service registration, NO ProgramData creation.
; The MSI does ALL of that. This is NOT a second installer.
;
; Icon: official viewlba.ico (from branding generation, NOT old Tauri icon)
;
; Build:
;   makensis -DVERSION=3.2.3 ^
;            -DICO=installer\branding\generated\windows\viewlba.ico ^
;            -DMSI_NAME=ViewLBA-Server-Setup-3.2.3.msi ^
;            installer\windows\viewlba-setup.nsi
; ============================================================================

Unicode true

!include "LogicLib.nsh"

!ifndef VERSION
  !error "VERSION requerido: -DVERSION=3.2.3"
!endif
!ifndef ICO
  !define ICO "viewlba.ico"
!endif
!ifndef MSI_NAME
  !define MSI_NAME "ViewLBA-Server-Setup-${VERSION}.msi"
!endif
!ifndef OUT_EXE
  !define OUT_EXE "../../dist/release/windows/out/ViewLBA-Server-Setup-${VERSION}.exe"
!endif

Name "ViewLBA Server ${VERSION}"
OutFile "${OUT_EXE}"
Icon "${ICO}"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

VIAddVersionKey "ProductName" "ViewLBA Server"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "ViewLBA"
VIAddVersionKey "LegalCopyright" "MIT License"
VIAddVersionKey "FileDescription" "ViewLBA Server Setup Bootstrapper"
VIProductVersion "${VERSION}.0"

; ---------------------------------------------------------------------------
; Section: launch MSI
; ---------------------------------------------------------------------------
Section ""
  SetSilent silent

  ; Find the MSI in the same directory as this .exe
  ; If the MSI is embedded (via File command), extract it to $PLUGINSDIR
  ; For now, expect the MSI to be in the same directory as the .exe
  InitPluginsDir

  ; Check if MSI exists next to the .exe
  IfFileExists "$EXEDIR\${MSI_NAME}" 0 try_temp

  ; Run the MSI
  DetailPrint "Installing ViewLBA Server ${VERSION}..."
  ExecWait '"$WINDIR\System32\msiexec.exe" /i "$EXEDIR\${MSI_NAME}"' $0
  DetailPrint "MSI exit code: $0"
  SetErrorLevel $0
  Goto done

  try_temp:
  ; Check if MSI is in $TEMP (downloaded or extracted)
  IfFileExists "$TEMP\${MSI_NAME}" 0 error

  DetailPrint "Installing ViewLBA Server ${VERSION} from TEMP..."
  ExecWait '"$WINDIR\System32\msiexec.exe" /i "$TEMP\${MSI_NAME}"' $0
  DetailPrint "MSI exit code: $0"
  SetErrorLevel $0
  Goto done

  error:
  DetailPrint "ERROR: ${MSI_NAME} not found."
  DetailPrint "Expected in: $EXEDIR\${MSI_NAME}"
  DetailPrint "Or in: $TEMP\${MSI_NAME}"
  MessageBox MB_OK|MB_ICONSTOP "ViewLBA Server installer not found.$\r$\n$\r$\nExpected: ${MSI_NAME}$\r$\nIn: $EXEDIR or $TEMP"
  SetErrorLevel 1

  done:
SectionEnd

Function .onInit
  ; Single instance check — prevent multiple bootstrappers
  System::Call 'kernel32::CreateMutex(p 0, i 0, t "ViewLBA-Setup") p .r1 ?e'
  Pop $0
  ${If} $0 != 0
    Quit
  ${EndIf}
FunctionEnd
