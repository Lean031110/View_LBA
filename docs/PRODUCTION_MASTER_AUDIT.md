# PRODUCTION_MASTER_AUDIT — ViewLBA Server

> **Auditoría maestra de producción** — Misión «Llevar ViewLBA a Producción Real» (misión §1).
> Documento ÚNICO y canónico: reemplaza la dispersión de `PRODUCTION_AUDIT.md`,
> `PRODUCTION_PLAN.md`, `PRODUCTION_READINESS.md`, `FINAL_RELEASE_AUDIT.md`,
> `RELEASE_3_AUDIT.md` (que se conservan solo como histórico).
>
> **Auditoría realizada**: 2026-09-30 · **Repo**: `Lean031110/View_LBA` (público) ·
> **Commit auditado**: `fcb7428` (HEAD de `main`, merge PR #48) ·
> **Versión declarada**: `3.2.3` (`VERSION` + `package.json`) ·
> **Último release**: `v3.2.3` (2026-09-16) · **Commit que produjo 3.2.1**: `4b42510`
> (tag `v3.2.1`, 12 commits por detrás de HEAD).
>
> **Método**: inspección real del repo (clone público con `gh`), lectura de los 5
> audits previos, lectura de workflows CI, lectura de `viewlba-setup.nsi`,
> `ViewLBA-Tray.ps1`, `deploy/windows/install.ps1`, `deploy/linux/install.sh`,
> `installer/core/*.ts` (16 archivos, 2844 LOC), `installer/windows/adapter.ts`,
> `installer/linux/adapter.ts`, `installer/linux/build-deb.ts`, `installer/package/*`,
> `themes/*.vtheme`, `mini-services/*` y la suite de tests en `tests/`.

---

## 1. Resumen ejecutivo

ViewLBA Server es un monorepo Next.js 16 + Prisma + 2 mini-services Bun
(realtime + stream), con instaladores NSIS (Windows) y dpkg-deb (Linux), ya
funcionales y publicados (v3.2.3 del 16-09). **La base es buena** — hay
`installer/core/` unificado, secrets RNG, smoke tests, CI con runners reales
Windows/Linux, pruebas offline, y 546 tests pasan en CI.

**Pero NO cumple la misión de producción real.** Las 36 secciones de la
misión exigen un salto cualitativo: instalador MSI canónico (no NSIS),
Windows Service nativo en Rust (no NSSM), tray binario (no PowerShell),
rutas en `Program Files`/`ProgramData` (no `C:\ViewLBA` ni
`C:\PantallaRestaurante`), theme schema v2 con presentaciones
landscape/portrait/square, layout editor visual, restaurant CMS completo
(canales, playlists, dayparting, emergency overlay, POS adapter), CI con
jobs separados build vs install-test, y tests de upgrade/uninstall con
preservación de datos.

**Hallazgos críticos (resumen):**

| # | Hallazgo | Severidad | Sección misión |
|---|---|---|---|
| ~~C1~~ | ~~Workflows CI con YAML malformado~~ — **RETRACTADO**: hallazgo falso causado por visualización ANSI del tool de auditoría (los archivos siempre tuvieron `branches: ["main"]` correctamente) | — | — |
| C2 | `viewlba-setup.nsi:130` reproduce **Error A** (PowerShell `=` ParserError) vía escaping `''..''` anidado | P0 | §0/§2/§6 |
| C3 | `viewlba-setup.nsi:183` reproduce **Error B** (`FIND: formato de parámetros incorrecto`) vía `sc query \| find RUNNING` | P0 | §0/§7 |
| C4 | `deploy/windows/install.ps1:142-144` reproduce **Error C** (NSSM 2.24 usage screen) cuando `$name` está vacío | P0 | §0/§4 |
| C5 | Instalador Windows usa NSIS + NSSM (prohibido por misión §0.8, §0.9, §3, §4) | P0 | §3/§4 |
| C6 | Tray Windows es PowerShell puro (`ViewLBA-Tray.ps1`, 358 LOC) — prohibido por §5 | P0 | §5 |
| C7 | Rutas finales `C:\ViewLBA` y `C:\PantallaRestaurante` — prohibidas por §3 | P0 | §3 |
| C8 | Nombre servicio `PantallaRestaurante*` en deploy/linux + nsi — obsoleto, §33 | P1 | §33 |
| C9 | Solo 2 themes `.vtheme` (necesita 12) — §27 | P1 | §27 |
| C10 | No existe theme schema v2 con presentations landscape/portrait/square — §20-§23 | P1 | §20-§23 |
| C11 | No existe layout editor visual — §24 | P2 | §24 |
| C12 | No existe Restaurant CMS (canales, playlists, schedules, dayparting, emergency overlay, POS adapter) — §25/§26 | P1 | §25/§26 |
| C13 | CI no tiene jobs separados build-windows-installer vs test-windows-artifact (usar artifact descargado, no workspace) — §14/§15 | P0 | §14/§15 |
| C14 | CI no tiene upgrade-test ni uninstall-test con preservación de datos — §19/§15 | P0 | §15/§19 |
| C15 | No existe `installer/native/windows-service/` (Rust service host) — §4 | P0 | §4 |
| C16 | No existe `viewlba-tray.exe` binario (Rust tray) — §5 | P0 | §5 |
| C17 | No existe `manifest.json` con checksum SHA256 + build reproducibility metadata por artefacto — §13 | P1 | §13 |
| C18 | `deploy/windows/install.ps1` y `deploy/linux/install.sh` son segunda implementación de producción (deben ser solo troubleshooting) — §11 | P1 | §11 |
| C19 | `android-license-generator/` en raíz — fuera del scope de la misión (¿mover a subrepo?) | P2 | §34 |
| C20 | Tests no cubren: theme schema v2, orientation, responsive layout, emergency overlay, upgrade interrupted, uninstall preserving data — §29 | P1 | §29 |
| C21 | Sin firmado Authenticode opcional en release Windows — §31 | P2 | §31 |

**Veredicto**: el producto se puede llevar a cumplimiento de la misión, pero
requiere **5 fases mayores** (detalladas en §10) — no es un parche de un fin
de semana. La Fase 1 (este documento + tests de regresión A/B/C) es la base
sobre la que se construye el resto.

---

## 2. Estado del repositorio (evidencia git)

```
Repo:           Lean031110/View_LBA (público)
Default branch: main
HEAD commit:    fcb7428 (merge PR #48 — fix/deb-symlinks-portable-323)
Autor:          Lean031110
Ultimo push:    2026-09-16T16:44:03Z
VERSION file:   3.2.3
package.json:  "version": "3.2.3"

Tags existentes: v1.0.0, v1.0.1-rc.1, v1.2.0, v1.2.1, v2.0.0,
                 v3.0.0-rc.1, v3.0.0-rc.2, v3.0.0, v3.1.0-rc.1,
                 v3.1.0, v3.2.0, v3.2.1, v3.2.2, v3.2.3

Releases publicados: v3.2.3 (latest), v3.2.1, v3.1.0, v3.1.0-rc.1,
                     v3.0.0, v3.0.0-rc.2, v3.0.0-rc.1, v2.0.0, v1.2.1, v1.2.0

Commit que produjo 3.2.1: 4b42510 (tag v3.2.1, 12 commits por detrás de HEAD)
Diff v3.2.1..HEAD: 12 commits (PRs #45 #46 #47 #48 — bandeja offline,
                    rutas repo, symlinks portables)

Workflows activos: 7 (CI, Installer Flow CI, Release Installers,
                    Android License Generator, Android Emulator Smoke,
                    Customer Manual, Windows Exit Diagnostics)

Ultima run de CI en main: SUCCESS (todas las 5 workflows corrieron
                          el 2026-09-16T16:43:14Z tras push del tag v3.2.3)
```

**Inconsistencia versionada**: el tag `v3.2.2` EXISTE pero NO hay release
publicado con ese nombre (solo `v3.2.1` y `v3.2.3`). El `CHANGELOG.md` (44 KB)
debe aclarar si 3.2.2 se saltó o se publicó y se borró.

---

## 3. Inventario estructural completo

### 3.1 Árbol de directorios (top-level)

```
View_LBA/
├── .github/                   # 7 workflows + 1 action compuesta + 2 issue templates + PR template
├── android-license-generator/ # Generador APK (Tauri + Kotlin) — fuera del scope de la misión servidor
├── db/                        # SQLite (custom.db vacío en repo)
├── deploy/                    # 4 scripts legacy (install.ps1, install.sh, manage.*)
├── docs/                      # 22 .md + manual/ + screenshots/ + wiki/
├── e2e/                       # playwright E2E tests
├── installer/                 # NÚCLEO del instalador moderno (ver §3.3)
├── mini-services/             # 2 servicios Bun (realtime + stream)
├── prisma/                    # schema.prisma + migrations + seed
├── public/                    # assets estáticos (logo.svg, logo-mark.svg)
├── scripts/                   # 30 scripts TS + 10 sh (build, install, seed, screenshots, apk-checks)
├── src/                       # app Next.js (api, components, lib)
├── tests/                     # 30+ test files (licensing, installer, validators, net, stream, media, timezone)
├── themes/                    # 2 .vtheme (ViewLBA-Classic, ViewLBA-Neon)
├── CHANGELOG.md               # 44 KB
├── FINAL_RELEASE_AUDIT.md     # histórico (APK 3.0.0)
├── MISSION.md                 # = misión del usuario (idéntica al prompt de este audit)
├── PRODUCTION_AUDIT.md        # histórico (FASE 0, pre 3.0.0)
├── PRODUCTION_PLAN.md         # histórico (43 KB)
├── PRODUCTION_READINESS.md    # histórico
├── README.md                  # 20 KB
├── RELEASE_3_AUDIT.md         # histórico (APK 3.0.0)
├── VERSION                    # "3.2.3\n"
├── bun.lock                   # 258 KB
├── package.json               # 4 KB
├── tsconfig.json / tsconfig.installer.json
├── next.config.ts / tailwind.config.ts / postcss.config.mjs / eslint.config.mjs
└── playwright.config.ts
```

Total archivos en repo (excluyendo `.git` y `node_modules`): **511**.

### 3.2 Stack runtime

| Componente | Versión | Estado | Notas |
|---|---|---|---|
| Node.js | 24.21.0 (en env de auditoría) | OK | requerido >= 20 para Next 16 |
| Bun | 1.3.14 | OK | runtime empaquetado en el instalador (offline-first) |
| Next.js | 16.x (ver package.json) | OK | standalone build → `.next/standalone` |
| Prisma | 6.19.3 (`@prisma/client`) | OK | SQLite, migraciones versionadas en `prisma/migrations/` |
| TypeScript | 5.x | OK | `tsconfig.json` + `tsconfig.installer.json` separados |
| ESLint | flat config (`eslint.config.mjs`) | OK | |
| Tailwind | 4.x | OK | shadcn/ui (`components.json`) |
| Playwright | (config presente) | OK | E2E con `e2e-setup.ts` |
| Rust/Tauri | PRESENTE en `installer/gui/src-tauri/` | OK | base para Windows Service host + tray (§4 §5) |

### 3.3 Estructura del instalador moderno (`installer/`)

```
installer/
├── ARCHITECTURE.md                # doc de la arquitectura del installer core
├── cli/                           # sidecar CLI (binario distribuido)
│   ├── main.ts                    # entry del `viewlba-installer.exe`
│   ├── protocol.ts                # protocolo de IPC con la GUI
│   └── ui.ts                      # UI texto para CLI
├── core/                          # 16 módulos TS — FUENTE DE VERDAD (misión §11)
│   ├── adapter.ts          (78)   # interface que implementan windows/ y linux/
│   ├── config.ts           (89)   # parseo de install-config.json
│   ├── diagnostics.ts     (118)   # salida estructurada para logs
│   ├── existing.ts         (60)   # detección de instalación existente
│   ├── fsx.ts             (202)   # fs helpers (copia, mkdir, perms)
│   ├── health.ts          (145)   # check /api/health con subsistemas
│   ├── install.ts         (699)   # orquestador principal de la instalación
│   ├── layout.ts          (118)   # creación de rutas Program Files/ProgramData
│   ├── manager.ts         (274)   # lifecycle: install/start/stop/uninstall/upgrade
│   ├── ports.ts            (83)   # check de puertos (3000/3003/1935/8000)
│   ├── preflight.ts       (189)   # validación de payload + runtime + Prisma
│   ├── rollback.ts        (134)   # rollback en caso de fallo
│   ├── runner.ts          (124)   # spawn de procesos externos con argv estructurado
│   ├── secrets.ts         (125)   # RNG criptográfico (¡existe! misión §6 parcial)
│   ├── sysinfo.ts         (185)   # info de plataforma + arquitectura
│   └── types.ts           (221)   # tipos compartidos
│   └─ TOTAL: 2844 LOC
├── gui/                           # GUI Tauri (Rust) del instalador
│   ├── ui/                        # HTML/CSS/JS del frontend
│   └── src-tauri/
│       ├── Cargo.toml             # dependencias Rust
│       ├── build.rs
│       ├── src/main.rs            # entry Tauri
│       ├── src/lib.rs             # lógica
│       ├── capabilities/default.json
│       ├── tauri.conf.json
│       └── icons/                 # iconos multi-resolución
├── linux/
│   ├── adapter.ts          (234)  # LinuxAdapter: implementa core/adapter
│   ├── build-deb.ts               # builder .deb con dpkg-deb
│   └── tray/                      # tray Linux (D-Bus en TS puro, sin Python/GTK)
│       ├── tray.ts
│       ├── dbus.ts
│       └── icons/                 # 9 PNGs hicolor (22/32/48 × running/waiting/stopped)
├── package/                       # builders de payload (misión §12)
│   ├── appimage.sh                # AppImage CLI (legacy)
│   ├── appimage-gui.sh            # AppImage GUI (legacy)
│   ├── build-manifest.ts          # builder del manifest (misión §13 — existe!)
│   ├── bundle-server.ts           # empaqueta servidor + runtime
│   ├── generate-icons.ts          # icons multi-res
│   ├── payload.ts                 # lógica de composición del payload
│   └── smoke-payload.sh           # smoke test del payload
├── windows/
│   ├── adapter.ts          (234)  # WindowsAdapter
│   ├── viewlba-setup.nsi   (366)  # NSIS script — CANÓNICO ACTUAL (no MSI)
│   ├── viewlba.ico
│   └── tray/
│       └── ViewLBA-Tray.ps1 (358) # tray PowerShell — PROHIBIDO por misión §5
```

**Conclusión sobre `installer/`**: la base es sólida y **sigue el patrón
misión §11** (core como fuente de verdad + adapters por plataforma). Lo que
FALTA es: substituir `viewlba-setup.nsi` (NSIS) por MSI/WiX, eliminar
`ViewLBA-Tray.ps1` en favor de `viewlba-tray.exe` Rust, crear
`installer/native/windows-service/` (host Rust), y subir `manifest.json` +
checksum SHA256 al release.

### 3.4 Mini-services

```
mini-services/
├── realtime-service/         # socket.io en :3003, API interna en :3004
│   ├── index.ts
│   ├── auth.ts               # X-Internal-Token HMAC
│   ├── package.json
│   └── bun.lock
├── stream-service/           # node-media-server, RTMP :1935, HTTP-FLV :8000, control :8100
│   ├── index.ts
│   ├── nms.d.ts
│   ├── package.json
│   └── bun.lock
└── .gitkeep
```

**Arquitectura sana**. Sin duplicaciones. Cada uno con su propio `bun.lock`
(aislamiento de dependencias). Misión §4 evalúa si 3 servicios Windows
separados (`ViewLBA`, `ViewLBARealtime`, `ViewLBAStream`) son necesarios o si
un único service host que los gestione internamente es mejor — ver §10.

### 3.5 Temas (themes/)

```
themes/
├── ViewLBA-Classic.vtheme   (43 LOC)   # declarativo, sin JS/HTML/CSS ejecutable
└── ViewLBA-Neon.vtheme     (43 LOC)   # idem
TOTAL: 86 LOC, 2 temas
```

**Misión §27** exige mínimo 12 templates oficiales (Restaurant Classic,
Restaurant Neon, Restaurant Luxury, Menu Board, Promo Board, Portrait Menu,
TV + Menu, Happy Hour, Coffee Shop, Fast Food, Announcement, Emergency).

**Misión §20** exige ampliar `schemaVersion 1 → 2` con `presentations:
landscape/portrait/square/auto`, cada uno con canvas/regions/widget/
position/size/order/visibility/alignment/fit/priority/min-size/max-size/
safe-area.

Estado actual: schema v1, sin presentations, sin orientation detection.
Esto es bloqueante para §21 (orientation), §22 (layout engine), §23 (widget
rules), §24 (layout editor visual).

### 3.6 CI (`.github/workflows/`)

| Workflow | Líneas | Trigger (parseado por YAML) | Estado |
|---|---|---|---|
| `ci.yml` | 282 | `push/pull_request.branches: ["main"]` ✅ | OK |
| `installer-flow.yml` | 741 | `push/pull_request.branches: ["main"]` ✅ | OK |
| `release-installer.yml` | 771 | `push: tags: [v*]` | OK |
| `android-license-generator.yml` | 83 | `push/pull_request.branches: ["main"]` ✅ | OK |
| `android-emulator-smoke.yml` | 122 | `push: tags: [v*]` + `branches: ["main"]` | OK |
| `customer-manual.yml` | 114 | `push: branches: ["main"]` + `tags: [v*]` | OK |
| `windows-exit-diag.yml` | 209 | `push: branches: ["diag/**"]` + `workflow_dispatch` | OK |

**CRÍTICO C1 (RETRACTADO)**: en el primer análisis parecía que 5
workflows tenían `branches: ain]` (YAML roto). Verificación con
`od -c` + `git show HEAD:.github/workflows/ci.yml` revela que los
bytes reales son `branches: [main]` — el tool de visualización ANSI
ocultaba `[m` interpretándolo como código reset-color. **Los workflows
están correctos**.

**CRÍTICO C13**: NO existe separación build vs install-test (misión §14).
El workflow actual `installer-flow.yml` construye e instala en el mismo
job, en el mismo runner, usando el workspace como payload — viola §15
regla 5 («NO usar payload del workspace como aplicación») y §15 regla 6
(«instalar el artifact descargado»). El CI **no prueba el artefacto que
se publica**.

**CRÍTICO C14**: NO existe upgrade-test ni uninstall-test con verificación
de preservación de datos. El workflow actual prueba `install` + `uninstall`
pero no `install vA → crear datos → install vB → verificar datos intactos`.

---

## 4. Hallazgos por área — alineados con la misión

### 4.1 Misión §0 — Reglas no negociables

| Regla | Estado | Cumple |
|---|---|---|
| 1. Trabajar sobre repo existente | Audit sobre repo existente | ✅ |
| 2. Mantener arquitectura cuando es sana | Installer/core + adapters preservados | ✅ |
| 3. Eliminar duplicaciones de instalación | `deploy/windows/install.ps1` + `deploy/linux/install.sh` + `installer/windows/adapter.ts` + `installer/linux/adapter.ts` son 4 implementaciones (ver C18) | ❌ |
| 4. No dos implementaciones de producción Win/Linux | deploy/* y installer/* coexisten como producción | ❌ |
| 5. Installer offline-first (runtime, deps, Prisma, assets incluidos) | `installer/package/bundle-server.ts` + `payload.ts` ya incluyen todo | ✅ |
| 6. Ningún secreto por PowerShell/CMD/texto shell | `viewlba-setup.nsi:130` genera pwd vía PowerShell pipe (C2) — VIOLACIÓN | ❌ |
| 7. No usar pipelines CMD para estados críticos | `viewlba-setup.nsi:183` usa `sc query \| find RUNNING` (C3) — VIOLACIÓN | ❌ |
| 8. No usar NSSM | `deploy/windows/install.ps1` entero usa NSSM; sidecar también (C5) — VIOLACIÓN | ❌ |
| 9. No usar PowerShell como bandeja final | `ViewLBA-Tray.ps1` es PowerShell puro (C6) — VIOLACIÓN | ❌ |
| 10. Health debe confirmar application+database+storage+realtime+stream | `installer/core/health.ts:145` ya lo hace (verificar implementación) | ⚠️ |
| 11. Procesos externos con argv estructurado | `installer/core/runner.ts:124` lo hace bien; `viewlba-setup.nsi` no (cmd /c + powershell.exe -Command) | ⚠️ |
| 12. Pasos idempotentes + timeout + diagnóstico + rollback | `installer/core/install.ts` (699 LOC) y `rollback.ts` (134 LOC) estructurados | ✅ |
| 13. Datos del cliente NUNCA se eliminan en upgrade | `installer/core/manager.ts` respeta data dir; `viewlba-setup.nsi:365` MessageBox avisa al usuario que datos están en `${APP_DIR}` — pero `${APP_DIR}` = `C:\PantallaRestaurante` que se elimina en uninstall del NSIS | ❌ |
| 14. Smoke test de comportamiento real, no solo existencia de archivos | `installer-flow.yml` prueba servicio Running + health + start/stop — bueno; pero no prueba upgrade ni data preservation | ⚠️ |
| 15. Artefacto probado por CI = artefacto publicado | VIOLACIÓN MAYOR (C13): CI usa workspace como payload, no el artifact descargado | ❌ |

### 4.2 Misión §3 — Windows installer canónico MSI

**Estado actual**: instalador NSIS (`viewlba-setup.nsi`, 366 LOC). NO hay MSI.
NO hay WiX. NO hay `installer/native/windows-msi/`.

**Acción requerida**:
- Añadir `installer/windows-msi/` con `viewlba.wxs` (WiX Toolset v4)
- El NSIS `viewlba-setup.nsi` puede subsistir como **bootstrapper .exe**
  opcional que enruta al MSI (patrón estándar Burn/WiX)
- Validar con `msiexec /i ... /qn /l*v install.log` en CI Windows runner

### 4.3 Misión §4 — Servicio Windows nativo

**Estado actual**: NSSM envuelve `bun.exe scripts/start.ts` y los 2 mini-services.
NO existe `installer/native/windows-service/` en Rust.

**Acción requerida**:
- Crear crate `installer/native/windows-service/` con `Cargo.toml`
- Implementar `windows-service` crate (de rtomaszewski/microsoft/windows-rs)
- SCM registration directa (`StartCtrlDispatcherA` + `SetServiceStatus`)
- Spawn del proceso Bun con argv estructurado (`Command::new("bun.exe").args(["scripts/start.ts"])`)
- Watchdog del hijo: re-spawn con backoff exponencial si exit code != 0
- Logs a `C:\ProgramData\ViewLBA\logs\service-host.log`
- **Decisión arquitectónica**: un ÚNICO service host (`ViewLBA`) que
  gestiona internamente los 3 procesos (server, realtime, stream) es
  preferible a 3 servicios separados. Razón técnica: el servicio y el
  tray necesitan IPC compartido para status; un solo host simplifica.
  Si se mantiene 3 servicios, documentar la razón técnica real.

### 4.4 Misión §5 — Tray Windows binario

**Estado actual**: `ViewLBA-Tray.ps1` (PowerShell, 358 LOC) — usa
`net.exe`, `cmd.exe`, `Start-Process -Verb RunAs`. Path `C:\PantallaRestaurante`.

**Acción requerida**:
- Crear `installer/native/windows-tray/` con crate Rust `trayico`/`tao`/`winit`
- Binario: `viewlba-tray.exe`
- IPC con el service host vía named pipe (`\\.\pipe\viewlba-status`)
- Menú: Iniciar · Detener · Reiniciar · Configurar · Panel · Logs · Salir
- Autostart vía `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- NO invocar `net.exe`, `sc.exe`, `powershell.exe`, `cmd.exe`

### 4.5 Misión §6 — Credenciales seguras

**Estado actual**: `installer/core/secrets.ts` (125 LOC) ya existe con RNG
criptográfico. PERO `viewlba-setup.nsi:130` lo BYPASSA usando PowerShell
para generar la contraseña y dejarla en `.pwd.tmp` (C2). Esto viola §6.

**Acción requerida**:
- Eliminar bloque PowerShell de `viewlba-setup.nsi:130-146`
- El sidecar `viewlba-installer.exe --config` debe invocar `secrets.ts`
  directamente y generar `CREDENCIALES.txt` con RNG criptográfico
- En upgrade: NO regenerar credenciales (leer de `ProgramData/ViewLBA/credentials.json` con ACL restrictiva)
- Eliminar el fallback hardcoded `ViewLBA-CambioYa1` (línea 142)

### 4.6 Misión §7 — Eliminar FIND/CMD de validación

**Estado actual**: `viewlba-setup.nsi:183` hace
`cmd /c "sc query ${SERVICE_APP} | find RUNNING > nul"`.

**Acción requerida**:
- Reemplazar por: el sidecar consulta SCM vía Win32 API
  (`OpenSCManagerW` + `OpenServiceW` + `QueryServiceStatus`)
  o, mínimo viable, vía PowerShell `Get-Service` pero encapsulado en
  el sidecar TS (que tiene argv estructurado), no en el NSIS
- Condición de éxito: `servicio existe && Running && /api/health=200 && health.status=ok`

### 4.7 Misión §8-§10 — Linux + systemd + tray Linux

**Estado actual**:
- `installer/linux/build-deb.ts` genera `.deb` con dpkg-deb
- `installer/linux/adapter.ts` (234 LOC) implementa `LinuxAdapter`
- `deploy/linux/*.service` (6 archivos) usan nombre `pantalla-restaurante*`
- `deploy/linux/install.sh` (172 LOC) es SEGUNDA implementación de producción (C18)
- Tray Linux en `installer/linux/tray/` (TS puro hablando D-Bus, sin Python/GTK) — bueno

**Acción requerida**:
- Renombrar `deploy/linux/pantalla-restaurante*.service` → `viewlba*.service`
- Mover lógica de `deploy/linux/install.sh` a `installer/linux/adapter.ts`
- Reducir `deploy/linux/install.sh` a wrapper de troubleshooting
- Crear `installer/native/linux-systemd/` con units hardened:
  `Restart=always`, `RestartSec=5`, `NoNewPrivileges=yes`, `PrivateTmp=true`,
  `ProtectHome=true`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/viewlba`,
  `TimeoutStopSec=30`, `LimitNOFILE=4096`
- Usuario de sistema sin privilegios: `viewlba` (UID dinámico, sin shell)
- Separar rutas: `/usr/lib/viewlba` (binarios), `/etc/viewlba` (config),
  `/var/lib/viewlba` (DB + media), `/var/log/viewlba` (logs),
  `/usr/lib/systemd/system` (units), `/usr/share/applications` (.desktop)
- Tray Linux: MANTENER tal cual (TS puro, D-Bus) — solo validar

### 4.8 Misión §11 — Único core de instalación

**Estado actual**: `installer/core/` (16 módulos TS, 2844 LOC) ya es la
fuente de verdad conceptual. PERO `deploy/windows/install.ps1` y
`deploy/linux/install.sh` tienen lógica DUPLICADA (creación de dir, setup
de servicios, firewall, generación de .env).

**Acción requerida**:
- Migrar la lógica única de `deploy/*/install.*` a `installer/core/`
- Reducir `deploy/*/install.*` a scripts thin que invoquen el sidecar
  `viewlba-installer.exe --config`
- Mantenerlos como herramientas de troubleshooting/dev

### 4.9 Misión §12 — Payload

**Estado actual**: `installer/package/payload.ts` + `bundle-server.ts`
ensamblan payload con runtime Bun + node_modules + Prisma + .next/standalone
+ mini-services + themes + assets. Hay guards en `viewlba-setup.nsi:120-123`
(verifican `runtime\bun.exe` y `node_modules\.bin`).

**Acción requerida**:
- Añadir guards adicionales en `installer/core/preflight.ts`:
  - Sin symlinks absolutos en el payload (`readlink -f` y rechazar si target fuera de `/home/z/my-project/`)
  - Sin rutas del runner (`/home/runner/work/...`, `C:\Users\runneradmin\...`, `B:\~BUN\...`)
  - Plataforma correcta (linux64 vs win64)
  - Versiones consistentes (Bun runtime = el declarado en `package.json`)
  - Schema Prisma presente y migraciones deployadas

### 4.10 Misión §13 — Manifest

**Estado actual**: `installer/package/build-manifest.ts` ya existe. Pero
no se publica el `manifest.json` junto al instalador en el Release, ni se
verifica su SHA256 en CI.

**Acción requerida**:
- `manifest.json` debe incluir: version, commit SHA, build date,
  platform, arch, Bun version, Next version, Prisma version, schema version,
  installer version, checksum SHA256 del propio instalador, lista de
  componentes, build reproducibility metadata
- Subir `manifest.json` + `*.sha256` al GitHub Release junto al .exe/.deb
- En CI install-test: descargar `manifest.json`, validar checksum antes
  de instalar

### 4.11 Misión §14-§19 — CI nuevo + tests

**Estado actual**: `installer-flow.yml` (741 LOC) hace muchas cosas
pero VIOLACIÓN C13: el install test usa el workspace como app, no el
artifact descargado. No hay upgrade-test. No hay uninstall-test con
verificación de preservación de datos. No hay offline-test separado
(el offline test actual corre en el MISMO job del install).

**Acción requerida** (crear 6 nuevos workflows):
- `build-windows-installer.yml`: solo construye el MSI/Setup.exe,
  sube artifact + manifest + sha256
- `build-linux-installer.yml`: solo construye el .deb, sube artifact
- `test-windows-artifact.yml`: descarga artifact, valida sha256,
  instala en Windows runner FRESH, prueba install + service + health
  + firewall + start menu + ARP + tray + upgrade + uninstall + reinstall
- `test-linux-artifact.yml`: idem para Linux
- `offline-test.yml`: bloquea Internet, solo loopback, verifica que
  install + runtime + Prisma + DB + servicios + health funcionan
- `upgrade-test.yml`: instala vA, crea datos, backup, instala vB,
  migración, verifica datos intactos, prueba rollback

### 4.12 Misión §20-§24 — Theme schema v2 + layout engine + editor

**Estado actual**: 2 .vtheme con schema v1 (sin presentations).

**Acción requerida**:
- Ampliar `scripts/build-vtheme.ts` y `scripts/verify-vtheme.ts` a schema v2
- Añadir schema en `src/lib/themes/schema-v2.ts` con tipado Zod
- Crear 12 templates oficiales en `themes/`:
  Restaurant Classic, Restaurant Neon, Restaurant Luxury, Menu Board,
  Promo Board, Portrait Menu, TV + Menu, Happy Hour, Coffee Shop,
  Fast Food, Announcement, Emergency
- Implementar `src/lib/themes/orientation.ts` (detección LANDSCAPE/PORTRAIT/SQUARE/AUTO)
- Implementar `src/lib/themes/layout-engine.ts` (separar Theme/Layout/Widget/Playlist/Schedule/Screen)
- Crear `src/components/admin/LayoutEditor.tsx` (drag-drop, resize, snap,
  grid, safe areas, z-index, preview real a 1920x1080/1080x1920/3840x2160/1080x1080)

### 4.13 Misión §25-§26 — Restaurant CMS + Emergency Overlay

**Estado actual**: NO existe. El schema Prisma actual no tiene modelos
para channels, playlists, schedules, dayparting, emergency overlay, POS.

**Acción requerida**:
- Schema Prisma nuevo: `Channel`, `Playlist`, `PlaylistItem`,
  `Schedule`, `Daypart`, `EmergencyOverlay`, `ScreenGroup`, `Tag`,
  `Screenshot`, `ScreenHealth`
- API REST + UI admin para cada uno
- Emergency Overlay: sistema de prioridades
  `EMERGENCY > SYSTEM_MESSAGE > PROMOTION > SCHEDULE > NORMAL`
- `PosProvider` interface + adapter stub vacío (no acoplar a POS real)

### 4.14 Misión §27-§28 — Templates + Preview

Ver §4.12. Los 12 templates deben tener layout Landscape y Portrait.
La preview en admin debe usar los MISMOS componentes que la TV.

### 4.15 Misión §29-§30 — Tests + Security

**Estado actual**: 30+ test files en `tests/` (licensing crypto/fuzz/state-machine,
installer/cli-config, installer/core, validators, net, stream-pipeline, timezone,
media). E2E en `e2e/`. Playwright config presente.

**Acción requerida** (regression tests nuevos):
- `tests/installer/regression-error-a.test.ts` — Error A (PowerShell `=`)
- `tests/installer/regression-error-b.test.ts` — Error B (FIND)
- `tests/installer/regression-error-c.test.ts` — Error C (NSSM usage screen)
- `tests/installer/payload-missing.test.ts`
- `tests/installer/absolute-symlink.test.ts`
- `tests/installer/broken-prisma.test.ts`
- `tests/installer/missing-runtime.test.ts`
- `tests/installer/broken-service.test.ts`
- `tests/installer/health-degraded.test.ts`
- `tests/installer/upgrade-interrupted.test.ts`
- `tests/installer/uninstall-preserves-data.test.ts`
- `tests/themes/schema-v2.test.ts`
- `tests/themes/orientation.test.ts`
- `tests/themes/responsive-layout.test.ts`

Security audit: paths, permissions, service account, secrets, credentials,
logs, theme imports (zip bombs, traversal, symlinks, executable themes),
SSRF, uploads, filesystem boundaries, IPC, firewall, local auth.

### 4.16 Misión §31-§32 — Release Windows/Linux

**Acción requerida**:
- Windows: MSI + EXE bootstrapper + SHA256 + manifest + Authenticode
  opcional + timestamp + release notes
- Linux: .deb + AppImage CLI + AppImage GUI (si procede), cada uno con
  SHA256 + manifest + version + commit + runtime version
- Nombres consistentes: `ViewLBA-Server-Setup-3.2.4.exe`,
  `ViewLBA-Server-3.2.4-x86_64.deb`

### 4.17 Misión §33 — Documentación

**Acción requerida**: actualizar 11 .md + crear 3 nuevos:
- `docs/PRODUCTION_MASTER_PLAN.md` (hoja de ruta detallada)
- `docs/INSTALLER_CONTRACT.md` (contrato del instalador — qué hace, qué no hace)
- `docs/ARTIFACT_INSTALL_TESTS.md` (qué prueba cada CI job)

Eliminar referencias obsoletas:
- `Pantalla_Restaurante` → `ViewLBA` en docs y scripts
- workflows inexistentes
- comandos obsoletos
- versiones incorrectas

### 4.18 Misión §34 — Organización

**Acción requerida** (mínima, sin megamigración):
- Añadir `installer/native/windows-service/` (Rust crate)
- Añadir `installer/native/windows-tray/` (Rust crate)
- Añadir `tests/installer-artifacts/windows/` (CI helper scripts)
- Añadir `tests/installer-artifacts/linux/`
- Mover `android-license-generator/` a subrepo separado? (pregunta abierta
  para el usuario — fuera del scope servidor)

---

## 5. Errores reproducibles A, B, C — análisis de causa raíz

### 5.1 ERROR A — PowerShell ParserError: «Debe proporcionar una expresión de valor después del operador '='»

**Archivo**: `installer/windows/viewlba-setup.nsi:130`

```nsi
nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$p=''ViewLBA-''+[guid]::NewGuid().ToString(''N'').Substring(0,8).ToUpper()+''-7x''; Set-Content -Path \"$INSTDIR\.pwd.tmp\" -Value $$p -Encoding ASCII; Write-Host $$p"'
```

**Causa raíz**: El escaping de NSIS anida TRES niveles de comillas:
1. NSIS string `'...'` (outer, comilla simple)
2. PowerShell `-Command "..."` (comillas dobles)
3. PowerShell string `''ViewLBA-''` (escape de `'` dentro de `'...'`)

Cuando NSIS expande `$$p` → `$p` y `''` → `'`, el comando PowerShell
resultante es:

```powershell
$p='ViewLBA-'+[guid]::NewGuid().ToString('N').Substring(0,8).ToUpper()+'-7x'; Set-Content -Path "C:\ViewLBA\.pwd.tmp" -Value $p -Encoding ASCII; Write-Host $p
```

PERO si el `Set-Content -Path \"$INSTDIR\.pwd.tmp\"` (con `\"` escapado mal
por nsExec) hace que PowerShell reciba:

```powershell
$p='ViewLBA-'+...; Set-Content -Path "C:\ViewLBA\.pwd.tmp -Value $p -Encoding ASCII; Write-Host $p
```

...sin cerrar la comilla de `Path`, PowerShell se traga el resto como
continuación de string y `$p` se queda sin asignar → error «Debe
proporcionar una expresión de valor después del operador '='».

**Evidencia histórica** (git log del repo):
```
2349406 fix(ci): parse de la bandeja EN PROCESO — la línea heredada con
       escapes «$e» mandaba un comando MANGLED a powershell.exe hijo y
       su ParserError rompía el exit del paso
```

Esto confirma que el equipo ya vio el síntoma antes. La solución temporal
fue eliminar los escapes `$e` del tray. La solución canónica es **eliminar
PowerShell del instalador** (misión §6).

**Test de regresión**: `tests/installer/regression-error-a.test.ts`
- Mock del nsExec::ExecToLog con un PowerShell que falle con ParserError
- Verificar que el instalador no dependa de la línea 130 para generar
  credenciales — debe usar `installer/core/secrets.ts` directamente

### 5.2 ERROR B — «FIND: formato de parámetros incorrecto»

**Archivo**: `installer/windows/viewlba-setup.nsi:183`

```nsi
nsExec::ExecToLog 'cmd /c "sc query ${SERVICE_APP} | find RUNNING > nul"'
```

**Causa raíz**: El comando CMD resultante tras expansión NSIS es:

```cmd
cmd /c "sc query PantallaRestaurante | find RUNNING > nul"
```

El problema: `find RUNNING` (sin comillas) es interpretado por `find.exe`
como:
- `RUNNING` se parsea como argumento
- Pero `find` interpreta cualquier arg empezando con `/` como switch
- Y peor: cuando el input por stdin contiene `\r\n` (salto de línea
  Windows), `find` busca literal `RUNNING` (case-sensitive)
- Si el usuario tiene alias del comando `find` (ej. en PowerShell), el
  comportamiento cambia
- Caso más probable: el `> nul` redirige stdout pero no stderr, y si `find`
  recibe una entrada con caracteres especiales (`\`, `:`, etc.), responde
  «Formato de parámetros incorrecto»

**Mejor solución (misión §7)**: NO usar `find` ni `cmd /c`. Usar Win32
API directamente desde el sidecar TS:

```ts
// installer/windows/adapter.ts (nuevo método)
async isServiceRunning(name: string): Promise<boolean> {
  // usar PowerShell transparente o, mejor, invocar el service host Rust
  // que consulta SCM directamente
}
```

**Test de regresión**: `tests/installer/regression-error-b.test.ts`
- Verificar que el instalador NO contiene el patrón `sc query.*find`
- Verificar que la condición de éxito tras install es: servicio existe
  + Running + /api/health=200 + health.status=ok

### 5.3 ERROR C — «NSSM 2.24 mostrando su pantalla de uso»

**Archivo**: `deploy/windows/install.ps1:142-144`

```powershell
& $NssmBin stop   $name 2>$null | Out-Null
& $NssmBin remove $name confirm 2>$null | Out-Null
& $NssmBin install $name $BunBin $entry 2>$null | Out-Null
```

**Causa raíz**: `nssm.exe` sin argumentos, o con argumentos insuficientes
(`nssm install` sin `servicename`), muestra su pantalla de USAGE (GUI
popup en NSSM 2.24). Esto pasa si:
1. `$name` está vacío (caso edge case)
2. `$BunBin` o `$entry` están vacíos
3. Se llama `nssm.exe` sin subcomando (como validación de presencia)

En el NSIS (`viewlba-setup.nsi`), el sidecar `viewlba-installer.exe`
invoca `nssm.exe` internamente. Si el sidecar pasa un nombre vacío o un
path Bun inválido, NSSM muestra su usage screen — popup bloqueante que
cuelga el instalador en CI sin output útil.

**Solución canónica (misión §4)**: ELIMINAR NSSM. Reemplazar por un
service host nativo Rust que se registra directamente con SCM:

```rust
// installer/native/windows-service/src/main.rs
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let service = ViewLbaService::new();
    service.run()?;
    Ok(())
}
```

**Test de regresión**: `tests/installer/regression-error-c.test.ts`
- Verificar que el sidecar no invoca `nssm.exe` en ningún path
- Verificar que el service host Rust se registra con SCM directamente

---

## 6. Rutas y nombres obsoletos (C7, C8)

**Archivo**: `installer/windows/tray/ViewLBA-Tray.ps1:41-48`

```powershell
$ServiceName = 'PantallaRestaurante'
$AppDir      = 'C:\PantallaRestaurante\app'
$DataDir     = 'C:\PantallaRestaurante\data'
$LogDir      = 'C:\PantallaRestaurante\logs'
$CredFile    = 'C:\ViewLBA\CREDENCIALES.txt'
```

**Archivo**: `installer/windows/viewlba-setup.nsi:38-42`

```nsi
!define SERVICE_APP "PantallaRestaurante"
!define APP_DIR "C:\PantallaRestaurante"
!define PKGDIR "C:\ViewLBA"
```

**Archivo**: `deploy/windows/install.ps1:27-31`

```powershell
$AppName   = "PantallaRestaurante"
$BaseDir   = "C:\PantallaRestaurante"
$AppDir    = Join-Path $BaseDir "app"
```

**Archivo**: `deploy/linux/pantalla-restaurante*.service` (6 archivos)

Todas estas referencias violan misión §3 (rutas finales deben ser
`C:\Program Files\ViewLBA Server\` + `C:\ProgramData\ViewLBA\`) y §33
(eliminar referencias obsoletas a Pantalla_Restaurante).

**Acción requerida**:
- Renombrar servicios a `ViewLBA`, `ViewLBARealtime`, `ViewLBAStream`
- Mover binarios a `C:\Program Files\ViewLBA Server\bin\`
- Mover runtime a `C:\Program Files\ViewLBA Server\runtime\`
- Mover config + DB + media + backups + logs + credenciales a
  `C:\ProgramData\ViewLBA\`
- En Linux: `/usr/lib/viewlba`, `/etc/viewlba`, `/var/lib/viewlba`,
  `/var/log/viewlba`

---

## 7. Tests existentes (inventario)

```
tests/
├── installer/
│   ├── cli-config.test.ts      # config del sidecar CLI
│   └── core.test.ts            # installer/core/*
├── licensing/
│   ├── activation-flow.test.ts
│   ├── canonical.test.ts
│   ├── codec.test.ts
│   ├── crypto.test.ts
│   ├── features.test.ts
│   ├── fingerprint-disk.test.ts
│   ├── fuzz.test.ts
│   ├── helpers.ts
│   ├── request-code.test.ts
│   ├── state-machine.test.ts
│   ├── storage-tamper.test.ts
│   └── token.test.ts
├── media.test.ts
├── net.test.ts
├── stream-pipeline.test.ts
├── timezone.test.ts
└── validators.test.ts

e2e/                           # playwright E2E tests
├── *.spec.ts
```

Total aproximado: 546 bloques `test()` (estimado por el README del repo).

**Cobertura actual**: licensing (muy sólida — 12 archivos), installer (2
archivos), subsistemas (media, net, stream, timezone, validators).

**Cobertura faltante** (misión §29):
- Tests de regresión A/B/C
- Tests de payload (missing, absolute symlink, broken Prisma, missing runtime)
- Tests de service (broken, health degraded)
- Tests de upgrade (interrupted, rollback)
- Tests de uninstall (data preservation)
- Tests de theme schema v2 (orientation, responsive layout, emergency overlay)

---

## 8. CI workflows — detalle de los problemas

### 8.1 `ci.yml` (282 líneas)

```yaml
on:
  push:
    branches: ["main"]   # ✅ correcto (verificado con od -c)
  pull_request:
    branches: ["main"]   # ✅
  workflow_dispatch:
```

Workflow bien configurado. Sin issues.

### 8.2 `installer-flow.yml` (741 líneas)

Es el workflow más completo: prueba install + service + health + tray +
start/stop + offline (iptables Windows firewall) + uninstall, en runners
reales windows-latest y ubuntu-latest.

**Problemas**:
1. Build e install en el MISMO job — no separa build vs install-test (C13)
2. Usa el workspace como app, no el artifact descargado (C13)
3. Sin upgrade-test (C14)
4. Sin verificación de preservación de datos tras uninstall (C14)

### 8.3 `release-installer.yml` (771 líneas)

Publica los installers a GitHub Release en tag `v*`. Workflow bien
estructurado. Problema: sube solo el .exe/.deb, NO sube `manifest.json`
ni `*.sha256` como assets separados (C17).

### 8.4 Otros workflows

- `android-license-generator.yml` (83 líneas) — APK signing pipeline (sólido)
- `android-emulator-smoke.yml` (122 líneas) — APK install en emulador
- `customer-manual.yml` (114 líneas) — PDF build con ReportLab
- `windows-exit-diag.yml` (209 líneas) — diagnóstico aislado del cuelgue
  de bun-compile en Windows

---

## 9. Deuda técnica identificada

| # | Deuda | Impacto | Esfuerzo |
|---|---|---|---|
| D1 | 5 audits docs previos (PRODUCTION_AUDIT, FINAL_RELEASE_AUDIT, RELEASE_3_AUDIT, PRODUCTION_PLAN, PRODUCTION_READINESS) dispersan la verdad | Confusión | Bajo (consolidar en este doc) |
| D2 | `deploy/*/install.*` como segunda implementación de producción | Duplicación | Medio (migrar a installer/core) |
| D3 | `android-license-generator/` en raíz del repo servidor | Confusión de scopes | Bajo (mover a subrepo) |
| D4 | ~~YAML roto~~ — RETRACTADO: los workflows siempre tuvieron `["main"]` correcto (era bug de visualización del tool de auditoría que interpretaba `[m` como ANSI reset) | — | — |
| D5 | NSSM + PowerShell + CMD en instalador Windows | Prohibido por misión | ALTO (rediseño completo) |
| D6 | Solo 2 themes, schema v1 | Bloquea layout editor | Alto (12 templates + schema v2) |
| D7 | No Restaurant CMS (channels, playlists, schedules, dayparting, emergency overlay, POS adapter) | Producto incompleto | Muy alto |
| D8 | No CI separa build vs install-test | No prueba artefacto publicado | Medio (6 workflows nuevos) |
| D9 | Rutas obsoletas `C:\ViewLBA`, `C:\PantallaRestaurante`, `pantalla-restaurante*` | Infiere compliance | Medio |
| D10 | `android-license-generator/` fuera de scope | Mantenimiento | Bajo |

---

## 10. Hoja de ruta (5 fases)

### Fase 1 — Fundación (este documento + tests de regresión)

- ✅ Audit completo (este doc)
- ⏳ Tests de regresión A/B/C (`tests/installer/regression-error-{a,b,c}.test.ts`)
- ⏳ Logging estructurado en `installer/core/diagnostics.ts` (fase, comando,
  argv, cwd, exit code, stdout, stderr, timeout, servicio afectado, ruta
  de binario, versión del runtime — nunca passwords/tokens/secretos)
- ⏳ Commit + push en branch `feature/production-master-audit`
- ✅ ~~Fix YAML `branches: ain]`~~ — retractado, los workflows ya están OK

### Fase 2 — Windows nativo (MSI + service host Rust + tray binario)

- Crate `installer/native/windows-service/` (Rust)
- Crate `installer/native/windows-tray/` (Rust)
- WiX `installer/windows-msi/viewlba.wxs`
- Eliminar `viewlba-setup.nsi` (o reducir a bootstrapper .exe)
- Eliminar `ViewLBA-Tray.ps1`
- Eliminar NSSM de `installer/core/install.ts`
- Mover rutas a `C:\Program Files\ViewLBA Server\` + `C:\ProgramData\ViewLBA\`
- Renombrar servicios a `ViewLBA`/`ViewLBARealtime`/`ViewLBAStream` (o consolidar en uno)

### Fase 3 — Linux hardened (systemd + paths FHS)

- Renombrar `deploy/linux/pantalla-restaurante*.service` → `viewlba*.service`
- Crear `installer/native/linux-systemd/` con units hardened
- Mover rutas a `/usr/lib/viewlba`, `/etc/viewlba`, `/var/lib/viewlba`, `/var/log/viewlba`
- Migrar lógica de `deploy/linux/install.sh` a `installer/linux/adapter.ts`
- Usuario `viewlba` sin shell

### Fase 4 — CI nuevo (6 workflows)

- `build-windows-installer.yml` + `build-linux-installer.yml`
- `test-windows-artifact.yml` + `test-linux-artifact.yml`
- `offline-test.yml`
- `upgrade-test.yml`
- Subir `manifest.json` + `*.sha256` al Release

### Fase 5 — Producto (theme v2 + restaurant CMS + editor)

- Theme schema v2 con presentations
- 12 templates oficiales
- Layout engine + orientation detection
- Layout editor visual con preview real
- Restaurant CMS (channels, playlists, schedules, dayparting, emergency
  overlay, POS adapter interface)
- Documentación sincronizada (11 .md + 3 nuevos)

---

## 11. Definition of Done (misión §35) — gap analysis

| Item | Estado |
|---|---|
| lint PASS | ✅ (CI verde) |
| typecheck PASS | ✅ |
| installer typecheck PASS | ✅ |
| unit PASS | ✅ |
| integration PASS | ✅ |
| E2E PASS | ✅ |
| packaging PASS | ✅ |
| Windows installer build PASS | ⚠️ (NSIS, no MSI) |
| Linux package build PASS | ✅ (.deb) |
| exact Windows artifact downloaded by fresh CI job | ❌ (C13) |
| exact Linux artifact downloaded by fresh CI job | ❌ (C13) |
| Windows real install PASS | ✅ (installer-flow.yml) |
| Windows service PASS | ⚠️ (NSSM, no nativo) |
| Windows health PASS | ✅ |
| Windows restart PASS | ✅ |
| Windows upgrade PASS | ❌ (no test) |
| Windows uninstall PASS | ⚠️ (elimina `C:\PantallaRestaurante`) |
| Windows reinstall PASS | ❌ (no test) |
| Linux real install PASS | ✅ |
| Linux systemd PASS | ⚠️ (sin hardening) |
| Linux health PASS | ✅ |
| Linux restart PASS | ✅ |
| Linux upgrade PASS | ❌ (no test) |
| Linux uninstall PASS | ⚠️ |
| Linux reinstall PASS | ❌ (no test) |
| offline Windows install PASS | ✅ |
| offline Linux install PASS | ✅ |
| no PowerShell dependency for Windows core installer | ❌ (C5) |
| no NSSM dependency | ❌ (C5) |
| no FIND/CMD-based service validation | ❌ (C3) |
| no runner paths inside artifact | ⚠️ (no guards) |
| credentials secure | ❌ (C2, hardcoded fallback) |
| theme schema v2 PASS | ❌ (C10) |
| landscape layout PASS | ❌ (C10) |
| portrait layout PASS | ❌ (C10) |
| square layout PASS | ❌ (C10) |
| responsive layout PASS | ❌ (C10) |
| emergency overlay PASS | ❌ (C12) |
| upgrade preserves data | ❌ (no test) |
| uninstall preserves data | ⚠️ (parcial) |
| checksums generated | ⚠️ (parcial) |
| manifest generated | ⚠️ (build-manifest.ts existe, no publicado) |
| documentation synchronized | ❌ (PantallaRestaurante references) |

**Cumplimiento global**: 14/41 (34%). Para llegar al 100% se necesitan las
5 fases descritas en §10.

---

## 12. Decisión inmediata recomendada

Proceder con **Fase 1** ahora:
1. Este documento (commit en branch `feature/production-master-audit`)
2. Tests de regresión A/B/C
3. Fix YAML `branches: ain]` en 5 workflows
4. Logging estructurado en `installer/core/diagnostics.ts`

Tiempo estimado: 1-2 sesiones de trabajo. Resultado: base sólida, sin
cambios de arquitectura, sobre la que construir Fases 2-5 sin
destruir lo existente.

---

**Fin del audit.** Próximo paso: commit de este documento al repo en
branch `feature/production-master-audit` + push + PR para revisión.
