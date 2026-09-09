# Installer de ViewLBA Server — Windows

> ⚠ **Estado: NOT VERIFIED en hardware real.** La LÓGICA de Windows está
> verificada (secuencia NSSM/netsh exacta, tests con RecordingRunner), el
> sidecar `.exe` compila (cross-compile verificado) y CI lo construye en
> `windows-latest`, pero **nadie ha ejecutado todavía el Setup.exe en un
> Windows real**. Regla de la misión: sin Windows no se reclama VERIFIED.

## Requisitos del host

- Windows 10/11 x64 (o Windows Server).
- Permisos de **Administrador** (el instalador NSIS los pide por UAC).
- Nada más: Bun (`runtime/bun.exe`), **NSSM** (`runtime/nssm.exe`) y el build
  precompilado van dentro del paquete. No se necesita clonar GitHub.

## Instalar (criterio de éxito de la misión)

1. Recibir `ViewLBA-Server-Setup.exe`.
2. **Doble clic** → aceptar UAC → asistente (o NSIS directo).
3. Elegir restaurante, zona horaria (`America/Havana` por defecto), puertos
   y subred LAN.
4. Crear el primer administrador.
5. Terminar con: Application ✓ Realtime ✓ Stream ✓ Database ✓ Backup ✓
   (health real contra `/api/health`; sin "instalación correcta" si falla).

## Qué crea (convención de deploy/windows)

| Ruta | Contenido |
|---|---|
| `C:\PantallaRestaurante\app` | Código + build standalone + `.env` (secretos, 600-best-effort ACL) |
| `C:\PantallaRestaurante\data` | `db\custom.db` · `media\` · `backups\` |
| `C:\PantallaRestaurante\logs` | Logs de servicios con rotación 5MB (NSSM) |

Servicios NSSM (24/7, reinicio a los 5 s, arranque automático):

| Servicio | Entrada |
|---|---|
| `PantallaRestaurante` | `scripts\start.ts` |
| `PantallaRestauranteRealtime` | `mini-services\realtime-service\index.ts` |
| `PantallaRestauranteStream` | `mini-services\stream-service\index.ts` |

Firewall (netsh, idempotente): 3000/3003/1935 → subred LAN. Los puertos
internos 3004/8000/8100 NO se abren (localhost por diseño, `docs/FIREWALL.md`).

## Gestión diaria

GUI (Server Manager: servicios/health/logs/backup/diagnóstico/uninstall) o
PowerShell:

```powershell
& "C:\PantallaRestaurante\app\...\viewlba-installer.exe" services status
& ... health
& ... backup
& ... restore C:\...\backup.db --confirm
& ... update C:\ruta\al\payload
& ... repair
& ... uninstall            # casillas; datos por defecto intactos
```

`deploy\windows\manage.ps1` sigue funcionando (misma semántica).

## Desinstalación

Casillas: aplicación / servicios / configuración / **medios** / **backups** /
**DB** — los datos van desmarcados por defecto y requieren confirmación
explícita. Nunca se borran datos automáticamente.

## Qué SÍ está verificado (honestidad)

- **Lógica NSSM/netsh exacta** (misma secuencia que `install.ps1`, nombres
  `PantallaRestaurante{,Realtime,Stream}`, `AppRestartDelay 5000`,
  `AppRotateBytes 5242880`, reglas netsh con subred): tests con
  RecordingRunner — VERIFIED.
- **Compilación del sidecar** `viewlba-installer.exe`
  (`bun build --compile --target=bun-windows-x64`): VERIFIED.
- **Construcción del Setup.exe** en CI (`windows-latest`, NSIS bundler de
  Tauri): VERIFIED (CI).
- **Ejecución completa en Windows real**: **NOT VERIFIED** — procedimiento de
  verificación abajo.

## Procedimiento de verificación pendiente (para quien tenga Windows)

1. Descargar el artefacto `viewlba-windows-installer` del release CI.
2. Verificar `SHA256SUMS.txt`.
3. Ejecutar `ViewLBA-Server-Setup.exe` en un Windows 10/11 limpio.
4. Confirmar: los 3 servicios en `services.msc`, health en
   `http://127.0.0.1:3000/api/health` con `"status":"ok"`, panel admin
   accesible desde otro PC de la LAN, OBS publicando por RTMP.
5. Probar update (nuevo payload) y uninstall (datos conservados).
6. Documentar el resultado en `PRODUCTION_READINESS.md` (Windows pasa de
   NOT VERIFIED a VERIFIED con fecha y evidencia).
