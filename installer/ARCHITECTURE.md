# ViewLBA Server Installer — Arquitectura

> Diseño de la capa de instalación oficial. **Primero arquitectura, luego
> implementación, luego tests, luego empaquetado** (regla de la misión).
> Este documento es la fuente de verdad del diseño; la implementación debe
> respetarlo o actualizarlo.

---

## 0. Regla más importante

**El installer NO duplica el servidor.** Instala el servidor existente:
es una capa de deployment. Toda la lógica de negocio (env, migraciones,
admin, health, backup) ya vive en el servidor y se **reutiliza**, nunca se
reimplementa.

---

## 1. Auditoría de lo existente (base de la extracción)

| Pieza existente | Qué aporta al installer | Destino |
|---|---|---|
| `scripts/lib/env-file.ts` | parseo .env sin dotenv, comparación de rutas SQLite, target DB, detección de contaminación | **reutilizado tal cual** (lo importa el core) |
| `scripts/lib/production-init.ts` → `initializeProduction()` | validar env, **verificación real del datasource + abort por mismatch**, `migrate deploy`, primer admin, settings, seed, health | **reutilizado tal cual** (fases `database` y `admin`) |
| `scripts/lib/prompt.ts` | readline con ciclo de vida correcto (close+unref, bug de Bun) | **reutilizado** por el CLI interactivo |
| `scripts/install.ts` | preflight (bun/node/disco/permisos) + generación/merge de `.env` con secretos crypto | **refactorizado**: la lógica se extrae a `installer/core/`; `scripts/install.ts` queda como entrada de compatibilidad delegando en el CLI nuevo |
| `deploy/linux/install.sh` + unidades systemd | layout FHS, usuario `pantalla`, plantillas `__BUN_BIN__`, timers, orden de arranque | **reutilizado como plantillas**: el adapter linux renderiza esas MISMAS unidades con sustitución de rutas |
| `deploy/windows/install.ps1` | layout, NSSM (install/set/rotation/restart), reglas netsh, orden de arranque | **reutilizado como especificación**: el adapter windows emite los mismos comandos NSSM/netsh (ejecutables desde Bun, sin PowerShell) |
| `deploy/linux/manage.sh` / `manage.ps1` | semántica start/stop/restart/status/health/backup/restore/upgrade | **reutilizado como especificación** del modo Manager del CLI/GUI |
| `scripts/backup.ts` / `restore.ts` / `src/lib/backup.ts` | backup online verificado + restore con copia de seguridad | **reutilizado** por el Manager |
| `/api/health` | health real (database/storage/realtime/stream) | **reutilizado** por la fase `health` |

**Nada de esto se reescribe.** El core lo importa o lo parametriza.

---

## 2. Estructura de módulos

```
installer/
  core/                  ← lógica REUTILIZABLE, pura: sin stdin, sin process.exit,
  │                        sin comandos POSIX embebidos (solo APIs fs/path/child_process
  │                        a través de CmdRunner), multiplataforma
    types.ts             contratos: CheckResult, InstallConfig, InstallerEvent, Phase…
    runner.ts            CmdRunner (ejecución real) + RecordingRunner (tests/dry-run)
    fsx.ts               fs multiplataforma: copyDir con exclusiones, mkdir, perms
    sysinfo.ts           SO, arch, CPU, RAM, disco, hostname, IP LAN, gateway, elevación
    preflight.ts         dependencias (bun/node/ffmpeg/systemd|nssm) + puertos + disco
    ports.ts             disponibilidad TCP (net.Server) sin comandos externos
    layout.ts            Layout por plataforma (FHS linux / C:\PantallaRestaurante)
    config.ts            InstallConfig: defaults, validación, merge NO destructivo
    existing.ts          detección de instalación previa (env/DB/app/servicios) → modo
    secrets.ts           generación crypto + escritura .env (600) con merge conservador
    health.ts            poll de /api/health + validación de las 5 áreas
    rollback.ts          registro de acciones + rollback NO destructivo
    diagnostics.ts       reporte estructurado: fase/comando/error/log/archivo/solución
    install.ts           ORQUESTADOR: pipeline de fases sobre ServiceAdapter
    manager.ts           modo gestión: services/health/logs/backup/restore/update/uninstall
  linux/
    paths.ts             layout FHS por defecto
    adapter.ts           ServiceAdapter: systemd (render de unidades de deploy/linux),
                         usuario de servicio, permisos, ufw/firewalld
    tray/                BANDEJA del sistema (v3.2.2 — TypeScript puro sobre el
                         bun EMPAQUETADO, cero dependencias del sistema):
      tray.ts            StatusNotifierItem + DBusMenu + Notifications: icono
                         verde/rojo/amarillo por estado, menú Iniciar · Detener
                         · Reiniciar · Configurar… · Panel · Credenciales · Salir,
                         refresco 5 s, instancia única, degradación headless
      dbus.ts            implementación D-Bus mínima (wire format + SASL
                         EXTERNAL + llamadas + lado servidor con Properties e
                         introspección) — la bandeja NO usa python3-gi/GTK
                         (un «Recommends» que dpkg -i NO instala offline)
  windows/
    paths.ts             layout C:\PantallaRestaurante
    adapter.ts           ServiceAdapter: NSSM + netsh (misma especificación que install.ps1)
    tray/                bandeja Windows (PowerShell — integrado en el SO)
  cli/
    main.ts              entrada: modos interactivo / --json (GUI) / --unattended
    ui.ts                flujo interactivo de 12 pasos (usa scripts/lib/prompt)
    protocol.ts          NDJSON: eventos del installer → GUI (sidecar)
  gui/                   ← Tauri v2: SOLO presentación/coordinación
    src/                 interfaz (vanilla TS + Vite): wizard + Server Manager
    src-tauri/           Rust mínimo: spawn del sidecar, reenvío de eventos
  package/
    bundle-server.ts     ensambla el payload offline (código+deps+build+bun)
    appimage.sh          construye ViewLBA-Server.AppImage (appimagetool)
    build-release.ts     orquestación local + SHA256SUMS
```

### Flujo de control

```
GUI (Tauri)  ──spawn stdio NDJSON──▶  CLI --json  ──▶  core/install.runInstall()
scripts/install.ts (compat)  ───────▶  CLI interactivo
CLI --unattended config.json ───────▶  core (misma ruta, sin prompts)
                                        │
                        ┌───────────────┴───────────────┐
                  ServiceAdapter                  initializeProduction()
                  (linux: systemd)               (scripts/lib — reutilizado)
                  (windows: NSSM)
```

La GUI **no** contiene lógica de DB/secrets/migraciones/systemd: los flujos
los ejecuta el sidecar (CLI compilado con `bun build --compile`) y la GUI
solo renderiza eventos y envía respuestas (config elegida, confirmaciones).

---

## 3. Fases de instalación (las 12 del flujo)

| # | Paso (UI) | Fase core | Qué hace | Modifica |
|---|---|---|---|---|
| 1 | Bienvenida | — (UI) | presentación y elección de idioma/modo | nada |
| 2 | Preflight | `preflight` | SO/arch/CPU/RAM/disco/hostname/IP/gateway/elevación + deps (bun, node opc, ffmpeg opc, systemd\|nssm, curl opc) + puertos libres | nada (abort ante FAIL crítico) |
| 3 | Directorio | `deploy` | layout + detección de instalación previa → **Nueva / Actualizar / Reparar**; copia del payload → appDir (nunca toca datos) | appDir |
| 4 | Config básica | (config) | restaurante, timezone, puertos 3000/3003/1935/8000, dirs media/backup | nada (memoria) |
| 5 | Red | (config) | IP/host, subred LAN, modo LAN | nada |
| 6 | Secrets | `environment` | .env generado/mergeado con secretos crypto (600); **nunca sobrescribe existentes** | envFile |
| 7 | Database | `database` | `initializeProduction()` reutilizado: verificación de target + `migrate deploy` + settings + demo opc | DB nueva |
| 8 | Services | `services` | adapter: usuario+unidades+timers (linux) / NSSM×3 (windows), arranque | servicios |
| 9 | Firewall | `firewall` | 3000/3003/1935 → LAN (ufw/firewalld/netsh) | reglas |
| 10 | Health | `health` | poll `/api/health` hasta timeout; valida application/database/storage/realtime/stream | nada |
| 11 | Admin | `admin` | `initializeProduction(skipMigrations)` + restaurantName | 1 usuario |
| 12 | Finalización | `finalize` | reporte + URLs + siguiente paso | nada |

**Sin "instalación correcta" si health falla** (máximo `degraded` con
advertencia explícita; `unhealthy` = FAIL con diagnóstico).

---

## 4. Contracts clave

```ts
type CheckStatus = "pass" | "warn" | "fail"
interface CheckResult { id: string; label: string; status: CheckStatus; detail?: string; hint?: string }

interface InstallConfig {
  mode: "new" | "update" | "repair"
  restaurantName: string
  timezone: string                 // default: America/Havana
  webPort: number                  // 3000
  realtimePort: number             // 3003 (socket.io LAN)
  rtmpPort: number                 // 1935
  httpFlvPort: number              // 8000 (bind 127.0.0.1)
  installDir?: string              // layout por defecto si falta
  dataDir?: string; logDir?: string
  lanSubnet?: string               // 192.168.1.0/24
  adminEmail?: string; adminPassword?: string
  withDemoData: boolean
  offline: boolean                 // payload autosuficiente, cero red
  runBuild: boolean                // false si el payload trae build precompilado
}

interface ServiceAdapter {         // implementado por linux/ y windows/
  platform: "linux" | "windows"
  checkPlatform(runner): CheckResult[]
  detectExistingServices(layout, runner): ServiceStatus[]
  installServices(ctx): Promise<void>       // usuario+unidades+NSSM+enable+start
  configureFirewall(ctx): Promise<CheckResult[]>
  statusAll(ctx) / startAll(ctx) / stopAll(ctx) / restart(ctx, which?)
  rollbackServices(ctx, createdUnits): Promise<void>
  removeServices(ctx): Promise<void>        // uninstall: SOLO servicios
}
```

### Ejecución de comandos (testeable)

Todo comando externo pasa por `CmdRunner`:

```ts
interface CmdRunner {
  run(cmd, args, { cwd, env, timeoutMs, runAsUser? }): { status, stdout, stderr }
}
```

- `RealRunner`: `spawnSync` (misma disciplina de env explícito que production-init).
- `RecordingRunner`: registra comandos sin ejecutar → **tests de lógica
  Windows sin Windows** y modo `--dry-run`.

### Eventos (GUI/JSON)

NDJSON por stdout (una línea = un evento):

```json
{"type":"phase-start","phase":"preflight","title":"…"}
{"type":"check","result":{"id":"bun","label":"Bun ≥ 1.1","status":"pass"}}
{"type":"command","command":"systemctl daemon-reload"}
{"type":"phase-end","phase":"services","status":"ok"}
{"type":"done","report":{…}} | {"type":"failed","diagnostic":{…}}
```

---

## 5. Instalación segura / rollback / uninstall

**Detección previa** (antes de modificar): `.env` existente, appDir con
`package.json`, DB existente, servicios ya registrados → la UI ofrece
*Nueva / Actualizar / Reparar*. Nunca se borra DB/media/backups.

**Rollback NO destructivo** — registro de lo que el installer creó:

- detener **solo** servicios creados/modificados por el installer;
- deshabilitar/quitar **solo** las unidades/servicios creados;
- borrar el `.env` **solo si lo creó el installer** (si existía, se conserva);
- borrar directorios creados **solo si están vacíos**;
- DB, media, backups y datos de usuario: **jamás** se tocan;
- el reporte dice exactamente qué se revirtió, qué se conservó y por qué.

**Uninstall con casillas**: `aplicación / servicios / configuración / media /
backups / DB` — datos conservados **por defecto** (checkboxs desmarcados).

---

## 6. Diagnóstico de fallos

```
STREAM SERVICE
STATUS: FAIL
Motivo:   Port 1935 unavailable.
Acción:   Cambiar puerto o liberar servicio existente.
Comando:  (el que falló, si aplica)
Log:      ruta al log relevante
Archivo:  /etc/systemd/system/pantalla-restaurante-stream.service
Fase:     services
```

`diagnostics.ts` mapea cada fase → sugerencias concretas (puerto ocupado,
permisos, bun ausente, nssm ausente, health timeout…).

---

## 7. Dependencias y offline

- **Bun**: el paquete final INCLUYE el binario (`runtime/bun`) — MIT. En la
  fase `deploy` el runtime se copia a `<appDir>/runtime` (PERMANENTE: los
  montajes de AppImage son transitorios y desinstalar el paquete no debe
  tumbar el servidor) y las unidades systemd / servicios NSSM se renderizan
  apuntando a ese binario instalado (el `__BUN_BIN__` existente lo permite).
  No se pide al usuario instalarlo.
- **ffmpeg**: opcional en el servidor (OBS codifica en el cliente; NMS no lo
  exige). Se ofrece incluirlo en el paquete; si falta → WARNING con explicación.
- **systemd** (linux) / **NSSM** (windows): requeridos para 24/7. NSSM se
  incluye en el payload windows (`resources/runtime/nssm.exe` en los bundles
  de Tauri; `resolveNssm` lo localiza en modo multi-root: instalación →
  paquete → PATH); systemd viene con la distro (FAIL claro si no existe: no
  se puede instalar automáticamente de forma segura).
- **Localización del payload (modo binario)**: junto al binario (AppImage
  CLI / NSIS) o escaneando `../lib|share/*` (deb/AppImage GUI de Tauri, cuyo
  nombre de producto varía). La GUI inyecta `VIEWLBA_PAYLOAD_DIR` desde su
  `resource_dir()` autoritativo; el sidecar lo honra como override.
- **Modo completamente offline**: el payload lleva código + `node_modules`
  (production) + Prisma engines del SO + build standalone precompilado +
  bun → la instalación no toca la red. El flag `--offline` lo exige y falla
  con diagnóstico si falta algo del payload.

---

## 8. Empaquetado y artefactos

| Artefacto | Cómo | Dónde se construye |
|---|---|---|
| `ViewLBA-Server.AppImage` | appimagetool sobre staging (AppRun: GUI si hay display, CLI con `--cli`/headless) | CI (ubuntu) — local si hay appimagetool |
| `ViewLBA-Server-Setup.exe` | Tauri (NSIS bundler) con sidecar CLI + payload en resources | CI (windows-latest) |
| `viewlba-server.deb` | dpkg-deb sobre staging CLI-first | CI (ubuntu) |
| `SHA256SUMS` | core para todos los artefactos | ambos |

El instalador **no requiere clonar GitHub**: todo va dentro del paquete.

---

## 9. Estrategia de tests y verificación (honesta)

| Área | Test | Estado esperado aquí |
|---|---|---|
| core (config/secrets/layout/existing/preflight/rollback/diagnostics/health/manager) | unit real | **VERIFIED** (este sandbox Linux + Bun) |
| protección de DB objetivo (mismatch → abort) | integración real (ya existe en tests/initialize-core.test.ts; se reusa) | **VERIFIED** |
| adapter linux (render de unidades, comandos, permisos, firewall) | RecordingRunner + archivos reales | **VERIFIED (lógica)**; systemd real → CI/`NOT VERIFIED` en sandbox |
| adapter windows | RecordingRunner: secuencia exacta de NSSM/netsh | **VERIFIED (lógica)**; ejecución real → **NOT VERIFIED** (sin Windows, regla de la misión) |
| CLI protocolo NDJSON | spawn real del CLI en modo --json | **VERIFIED** |
| GUI (Tauri) | compila/builds | **NOT VERIFIED en sandbox** (sin Rust); construye en CI |
| AppImage/.exe/.deb | artefactos | **NOT VERIFIED en sandbox**; CI los produce y firma (SHA256) |

Nunca se marca PASS sin evidencia. Windows mantiene **NOT VERIFIED** hasta
verificación en hardware real (procedimiento documentado).
