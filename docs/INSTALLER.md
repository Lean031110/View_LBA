# ViewLBA Server — Installer oficial

> Capa de instalación oficial del servidor ViewLBA. **El installer instala el
> servidor existente — NO lo duplica**: es una capa de deployment sobre el
> código ya probado del repositorio (misión de arquitectura).

## Productos

| Artefacto | Contenido | Dónde se construye |
|---|---|---|
| `ViewLBA-Server.AppImage` | GUI (Tauri) + modo `--cli` + payload offline completo | CI (Linux) |
| `ViewLBA-Server-CLI.AppImage` | Solo CLI + payload offline (headless, sin GUI) | CI y local (`installer/package/appimage.sh`) |
| `viewlba-server_<ver>_amd64.deb` | Paquete Debian (bundle Tauri) | CI (Linux) |
| `ViewLBA-Server-Setup.exe` | Instalador Windows (NSIS, GUI + sidecar) | CI (Windows) |

Todos con `SHA256SUMS` verificable. El payload es **completamente offline**:
lleva el servidor, `node_modules`, build standalone precompilado, **Bun**
(MIT) y, en Windows, **NSSM**. El usuario no instala dependencias a mano ni
clona GitHub.

## Arquitectura (resumen — ver `installer/ARCHITECTURE.md`)

```
GUI (Tauri)  ──spawn stdio NDJSON──▶  CLI --json  ──▶  installer/core  ──▶  SO (adapter)
scripts/install.ts (compat)  ───────▶  CLI interactivo (12 pasos)
CLI --config cfg.json ───────▶  core (misma ruta, sin prompts)
```

- `installer/core/` — lógica reutilizable (sin stdin, sin `process.exit`,
  sin comandos POSIX): preflight, layout, config, secrets, detección de
  instalación previa, health, rollback no destructivo, diagnóstico.
- `installer/linux/` — adapter **systemd** (renderiza las MISMAS unidades de
  `deploy/linux/`), usuario `pantalla`, ufw/firewalld.
- `installer/windows/` — adapter **NSSM** (misma especificación de
  `deploy/windows/install.ps1`: servicios, rotación 5MB, netsh).
- `installer/cli/` — CLI único: interactivo / `--json` (GUI) / `--config`.
- `installer/gui/` — Tauri v2: SOLO presentación; cero lógica de DB/secrets.
- `installer/package/` — empaquetado: `bundle-server.ts` (payload),
  `appimage.sh` (AppImage CLI), `generate-icons.ts`.

**Reutilización real** (nada se reimplementa): `initializeProduction()` de
`scripts/lib/production-init.ts` hace las fases *database* y *admin*
(incluida la **protección de DB objetivo**: verificación real del datasource
y abort por mismatch); `scripts/lib/env-file.ts` parsea el `.env` como fuente
de verdad; `/api/health` del servidor alimenta la fase *health*;
`scripts/backup.ts`/`restore.ts` alimentan el gestor.

## Flujo de instalación (12 pasos)

1. Bienvenida · 2. Preflight (SO/CPU/RAM/disco/hostname/IP/gateway/permisos
+ Bun/ffmpeg-opcional/systemd-NSSM/puertos) · 3. Directorio y modo
(**nueva / actualizar / reparar** — detección previa, nunca se borran datos)
· 4. Config básica (nombre, timezone — default `America/Havana`, puertos
3000/3003/1935/8000) · 5. Red (subred LAN) · 6. Secretos (crypto, 600,
nunca se sobrescriben existentes) · 7. Database (migrate deploy con
verificación de target) · 8. Servicios (systemd/NSSM 24/7) · 9. Firewall
(3000/3003/1935 → LAN) · 10. Health real (application/database/storage/
realtime/stream — sin "instalación correcta" si falla) · 11. Primer admin
· 12. Reporte con URLs.

## Modos de uso

```bash
# Interactivo (terminal, 12 pasos) — igual desde el AppImage --cli
bun installer/cli/main.ts
./ViewLBA-Server.AppImage --cli

# Desatendido (config JSON)
viewlba-installer --config cfg.json

# GUI: doble clic (Windows) o ejecutar el AppImage con display

# Gestión posterior (Server Manager por CLI o GUI)
viewlba-installer services start|stop|restart|status
viewlba-installer health · logs · backup · diagnostics
viewlba-installer restore <backup.db> --confirm
viewlba-installer update <payload> · repair · uninstall
```

Ejemplo de `cfg.json` (desatendido):

```json
{
  "mode": "new",
  "restaurantName": "La Terraza",
  "timezone": "America/Havana",
  "webPort": 3000, "realtimePort": 3003, "rtmpPort": 1935, "httpFlvPort": 8000,
  "lanMode": true, "lanSubnet": "192.168.1.0/24",
  "adminEmail": "admin@l terraza.local", "adminPassword": "…",
  "withDemoData": false, "offline": true, "runBuild": false
}
```

## Instalación segura y rollback

- Detección previa de `.env` / app / DB / servicios antes de tocar nada.
- `.env` existente: se respeta TODO (solo se completan faltantes).
- Fallo de fase → **rollback no destructivo**: se detienen/quitan SOLO los
  servicios creados por el installer, el `.env` solo se borra si lo creamos,
  directorios solo si quedaron vacíos. DB/medios/backups **jamás**.
- Diagnóstico en el formato de la misión: fase, motivo, **acción sugerida**,
  comando, log y archivo afectado.

## Desinstalación (datos por defecto conservados)

Casillas: aplicación / servicios / configuración / **medios** / **backups** /
**DB** — los tres últimos desmarcados por defecto y con confirmación
explícita.

## Estado de verificación (honesto)

| Área | Estado |
|---|---|
| Core del installer (config/secrets/layout/existing/preflight/rollback/diagnostics/health) | **VERIFIED** (tests reales, sandbox Linux) |
| Protección de DB objetivo (mismatch → abort) | **VERIFIED** (tests + initialize-core existentes) |
| Adapter Linux (render unidades, comandos, permisos) | **VERIFIED (lógica)**; systemd real: CI/producción |
| Adapter Windows (secuencia NSSM/netsh) | **VERIFIED (lógica)** con RecordingRunner; ejecución real: **NOT VERIFIED** (sin Windows aquí) |
| CLI protocolo NDJSON (GUI) | **VERIFIED** (spawn real) |
| Payload offline + AppImage CLI (Linux) | **VERIFIED** localmente (migrate offline + arranque + health) |
| GUI Tauri / Setup.exe / deb | **NOT VERIFIED en sandbox** (sin Rust) — se construyen en CI |
| Instalación Windows end-to-end | **NOT VERIFIED** hasta probarlo en Windows real |

Ver `docs/INSTALLER-LINUX.md`, `docs/INSTALLER-WINDOWS.md` y
`docs/RELEASE.md` para cada plataforma.
