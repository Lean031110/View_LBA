# Installer de ViewLBA Server — Windows

> **v3.2 — Setup.exe NATIVO (NSIS puro, sin Tauri/Rust).** Una sola
> pantalla: Siguiente → Instalar → Terminar. Sin preguntas, sin asistente
> de 12 pasos, sin elegir nada: «instalar y ejecutar», como un programa
> nativo de Windows. CI lo valida INSTALÁNDOLO de verdad en un runner
> (`/S` → servicio Running + `/api/health` 200 + stop/start + uninstall).

## Requisitos del host

- Windows 10/11 x64 (o Windows Server).
- Permisos de **Administrador** (el Setup.exe los pide por UAC).
- **NADA MÁS**: Bun (`runtime/bun.exe`), **NSSM** (`runtime/nssm.exe`) y el
  build precompilado van DENTRO del paquete (~450 MB). No se necesita
  Node.js, npm, Bun ni clonar GitHub — el instalador es 100 % offline.

## Instalar (criterio de éxito)

1. Descargar `ViewLBA-Server-Setup-<ver>.exe` (verificar SHA256 contra
   `SHA256SUMS.txt`).
2. **Doble clic** → aceptar UAC → Siguiente → Terminar. (Silencioso:
   `Setup.exe /S`.)
3. Al terminar, el servidor **ya está instalado, registrado como servicio
   de Windows y arrancándose**. El primer arranque tarda ~30 s.

En el **escritorio** quedan los accesos directos:

| Acceso directo | Qué hace |
|---|---|
| `ViewLBA - Panel` | Abre `http://localhost:3000` (el navegador) |
| `ViewLBA - Iniciar servidor` | Arranca el servicio (UAC estándar) |
| `ViewLBA - Detener servidor` | Detiene el servicio (UAC estándar) |
| `ViewLBA - Credenciales` | Usuario y contraseña del administrador (generados en tu máquina) |
| `ViewLBA - Bandeja` | Icono persistente junto al reloj |

**Bandeja del sistema** (notificación persistente, arranca con Windows):
clic derecho sobre el icono → **Iniciar servidor · Detener servidor ·
Abrir Panel · Salir**. Icono verde = corriendo, rojo = detenido, refresco
cada 10 s. Sin interfaz gráfica: solo ese icono, tal como se pidió.

## Qué crea (convención de deploy/windows)

| Ruta | Contenido |
|---|---|
| `C:\ViewLBA` | Paquete: sidecar `viewlba-installer.exe` + `runtime\` (bun+nssm) + `tray\` + `CREDENCIALES.txt` + desinstalador |
| `C:\PantallaRestaurante\app` | Código + build standalone + `.env` |
| `C:\PantallaRestaurante\data` | DB SQLite, media, backups |
| `C:\PantallaRestaurante\logs` | Logs con rotación (NSSM 5 MB) |
| Servicios `PantallaRestaurante{,Realtime,Stream}` | Windows services vía NSSM (auto-arranque) |

## Credenciales del administrador

Generadas en tu máquina durante la instalación (`admin@viewlba.local` +
contraseña aleatoria) y guardadas en `C:\ViewLBA\CREDENCIALES.txt` (acceso
directo «ViewLBA - Credenciales»). Cámbiala desde el panel
(Usuarios → editar administrador) en el primer uso.

## Desinstalar

`Configuración → Aplicaciones → ViewLBA Server` (o
`C:\ViewLBA\uninstall.exe`). Detiene y quita los servicios, accesos,
bandeja y programas. **Los DATOS del restaurante se conservan** en
`C:\PantallaRestaurante` (bórralos a mano si ya no los necesitas).

## Build (CI)

```bash
# payload (sidecar + runtime + servidor)
bun installer/package/bundle-server.ts --platform=windows --version=3.2.0
# Setup.exe (NSIS 3 — makensis)
makensis -DVERSION=3.2.0 -DPAYLOAD=<abs>/dist/release/windows/ViewLBA-Server \
         installer/windows/viewlba-setup.nsi
```

`installer/windows/viewlba-setup.nsi` es el instalador completo;
`installer/windows/tray/ViewLBA-Tray.ps1` es la bandeja (PowerShell 5.1,
cero dependencias). Nota: makensis resuelve rutas RELATIVAS contra el
directorio del script (los defaults del .nsi ya lo tienen en cuenta).
