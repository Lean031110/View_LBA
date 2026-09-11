# Proceso de release de los installers oficiales

## Artefactos por release

| Archivo | Plataforma | Fuente |
|---|---|---|
| `ViewLBA-Server-<ver>-x86_64.deb` | Linux (GUI Tauri, obligatorio) | `cargo tauri build --bundles deb --ci` |
| `ViewLBA-Server-<ver>-x86_64.AppImage` | Linux (GUI, opcional) | `cargo tauri build --bundles appimage --ci` |
| `ViewLBA-Server-CLI-<ver>-x86_64.AppImage` | Linux (headless) | `installer/package/appimage.sh` |
| `ViewLBA-Server-Setup-<ver>.exe` | Windows (GUI NSIS, obligatorio) | `cargo tauri build --bundles nsis --ci` (desde `C:\v`) |
| `SHA256SUMS.txt` | todos | release job (re-computado sobre los subidos) |
| `manifest-{linux,windows}.json` | todos | `installer/package/build-manifest.ts` (commit ↔ binario) |

Todos con `SHA256SUMS` verificable. El payload es **completamente offline**:
la red se usa SOLO durante el build (deps, Bun, NSSM, herramientas de Tauri);
el instalador final funciona sin Internet.

## Release automático (recomendado)

```bash
# 1. Todo verde en CI (quality/integration/e2e/security + installer tests)
# 2. Tag de candidato (primero) y push:
git tag v1.0.1-rc.1 && git push origin v1.0.1-rc.1
# 3. Solo si TODO pasa (build+validación+packaging+smoke), tag estable:
git tag v1.0.1 && git push origin v1.0.1
```

El workflow `.github/workflows/release-installer.yml` (3 jobs):

1. **build-linux**: deps (build env) → tests del installer → **payload de
   producción** (`bundle-server.ts`, guards incluidos) → **smoke REAL**
   (`smoke-payload.sh`: migrate deploy + arranque + `/api/health` +
   mini-services + SIGTERM) → `.deb` **obligatorio** (validado con
   `dpkg-deb --info/--contents` y con el payload dentro) → AppImage GUI
   **opcional y aislado** (un fallo de linuxdeploy NO tumba el .deb) →
   AppImage CLI (arranque verificado) → manifiest + SHA256SUMS + artefactos.
2. **build-windows**: mismo payload (con `runtime/bun.exe` +
   `runtime/nssm.exe`, engines de Windows) → smoke del contrato
   (entrypoint/engines/sidecars/0 symlinks) + sidecar `--json detect` →
   NSIS desde ruta corta `C:\v` → **exactamente 1 `.exe`** validado
   (PE/MZ, >0 bytes) → manifiest + SHA256SUMS + artefactos.
3. **release**: **NO recompila nada**. `needs: [build-linux, build-windows]`
   → gitleaks → valida el conjunto completo (exe+deb+CLI AppImage) →
   `SHA256SUMS.txt` consolidado → publica el GitHub Release.

Versiones EXACTAS (reproducible — nunca `latest`): Bun build `1.4.2`
(setup-bun, sin el input `cache` no soportado), Bun del payload `1.3.14`,
tauri-cli `2.11.4` (`--locked`), NSSM `2.24`.

## Release manual (Linux, sin CI)

```bash
bun install && bunx prisma generate          # repo listo (entorno de build)
(cd mini-services/realtime-service && bun install --frozen-lockfile)
(cd mini-services/stream-service && bun install --frozen-lockfile)
bun installer/package/bundle-server.ts --platform=linux
bash installer/package/smoke-payload.sh dist/release/linux/ViewLBA-Server  # validar ANTES de empaquetar
bash installer/package/appimage.sh           # → dist/release/linux/ViewLBA-Server-CLI.AppImage
sha256sum dist/release/linux/ViewLBA-Server-CLI.AppImage
```

La GUI requiere Rust + webkit2gtk (por eso vive en CI):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev \
     libayatana-appindicator3-dev librsvg2-dev libgdk-pixbuf-2.0-dev \
     gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav
cargo install tauri-cli --version 2.11.4 --locked      # versión EXACTA
# sidecar con el sufijo de target de Tauri:
mkdir -p installer/gui/src-tauri/binaries
cp dist/release/linux/ViewLBA-Server/viewlba-installer \
   installer/gui/src-tauri/binaries/viewlba-installer-x86_64-unknown-linux-gnu
# payload (misma estructura que los globs de tauri.conf):
mkdir -p installer/gui/src-tauri/resources
cp -a dist/release/linux/ViewLBA-Server/resources/server installer/gui/src-tauri/resources/server
cp -a dist/release/linux/ViewLBA-Server/runtime installer/gui/src-tauri/resources/runtime
cp dist/release/linux/ViewLBA-Server/manifest.json installer/gui/src-tauri/resources/
cd installer/gui/src-tauri
cargo tauri build --bundles deb --ci          # obligatorio
```

El AppImage de la GUI se construye con `installer/package/appimage-gui.sh`
(linuxdeploy DIRECTO, no vía tauri-bundler): tauri-bundler coloca el sidecar
en `usr/bin` y linuxdeploy rompe al hacer `ldd` sobre binarios standalone de
bun ("Failed to run ldd: exited with code 1" — reproducido y documentado). El
script arma un AppDir propio (sidecar en `usr/lib/viewlba-server/bin/`, que
SÍ pasa el escaneo) y el `AppRun` exporta `VIEWLBA_INSTALLER_BIN` +
`VIEWLBA_PAYLOAD_DIR`, que la GUI honra primero. El payload V2 además
elimina las variantes musl de sharp (`@img/sharp-libvips-linuxmusl-*`) —
rompían mksquashfs ("Could not find dependency: libc.musl-x86_64.so.1").

## Payload de producción — qué incluye y por qué

**PRINCIPIO: BUILD DEPENDENCIES ≠ RUNTIME DEPENDENCIES.** El entorno de
build (repo con node_modules completos, Turbopack, Tailwind, TypeScript)
puede ser grande: vive en el runner y NO se distribuye. El payload V2 es
EXPLÍCITO (`installer/package/payload.ts` → `createProductionPayload()`):

- **`.next/standalone/`**: server.js + node_modules **trazados por Next**
  (next, react, sharp, @prisma/client, engines — autosuficiente) + static +
  public. Copiado por **WHITELIST**: el standalone espeja el árbol del repo
  (tracing root) y sin filtro metería `db/`, `.env`, `logs/`, `download/`
  dentro del instalador (fuga real de datos, detectada en auditoría).
- **node_modules PODADO** (raíces: `prisma`, `@prisma/client`, `zod`; walk
  transitivo por `dependencies`+`optionalDependencies`, nunca devDeps):
  - `prisma` CLI + `@prisma/engines` (103 MB): imprescindibles para
    `prisma migrate deploy/status` **durante la instalación** (offline).
  - `@prisma/client` + `.prisma/client` (generado): los importan
    `scripts/backup.ts`, `scripts/logs-purge.ts` (timers systemd) y
    `prisma/seed.ts`.
  - `zod` (8 MB): lo importa `src/lib/env.ts` (reparaciones).
  - **`next` (202 MB) EXCLUIDO a propósito**: el compilador/SWC es
    dependencia de build. En runtime el servidor usa el standalone trazado;
    la lógica de instalación va EMBEBIDA en el sidecar (`bun build
    --compile`). Reparar DESDE FUENTE (`bun scripts/init-production.ts`)
    requiere `bun install` con red — decisión documentada.
- **Scripts de runtime**: `start.ts`, `backup.ts`, `restore.ts`,
  `logs-purge.ts`, `media-gc.ts`, `init-production.ts`, `lib/{env-file,
  production-init,prompt}.ts` + `src/lib/{auth,env,validators,backup,media}.ts`.
- **`prisma/`**: `schema.prisma` + `migrations/` + `seed.ts`.
- **mini-services**: realtime (socket.io) + stream (node-media-server) con
  SUS node_modules — solo runtime deps (sus package.json no tienen devDeps).
- **Configs mínimos** (KB): next.config.ts, tsconfig.json, postcss/tailwind
  (reparación con red reproducible: `bun.lock` incluido).

Tamaño resultante: **~450 MB** (frente a los **1284 MB** de la V1, que
rompía NSIS con rutas >260 por cadenas `node_modules` anidadas de devDeps/UI
compilada — `cmdk/node_modules/@radix-ui/react-dialog/…` — y ahogaba
linuxdeploy con 1.28 GB). `bunx` es un symlink (−88 MB en deb/AppImage).

**Guards** (`validatePayload`): el build **FALLA ANTES de Tauri/NSIS** si el
payload supera 700 MB / 150k archivos / ruta relativa >200 chars /
profundidad >16, contiene paquetes prohibidos (typescript, eslint,
playwright, tailwind, cmdk, radix…), datos (`db/`, `.env`, `logs/`,
`download/`, `tests/`, `docs/`, `skills/`), symlinks fuera de
`node_modules/.bin` (en Windows: NINGUNO), o duplicados accidentales.

## Smoke del payload (antes de empaquetar)

`installer/package/smoke-payload.sh` arranca producción DESDE el payload
(no desde el repo): migrate deploy con el node_modules podado (cero red) →
seed → arranque (`runtime/bun scripts/start.ts`) → `GET /api/health` 200
(database ok + storage ok) → `GET /` 200 → realtime + stream vivos →
SIGTERM limpio. En Windows el job valida el contrato estructural (entrypoint,
engines, sidecars, 0 symlinks) y ejecuta el sidecar `--json detect`.

## Runtime incluido

- **Bun 1.3.14** (MIT) del release oficial exacto: `runtime/bun` +
  `runtime/bunx` (symlink en Linux; copia en Windows la crea el installer).
- **NSSM 2.24** (Windows, public domain de nssm.cc) en `runtime/nssm.exe`.

---

## Historial de releases

### v1.2.1 (2026-09-11) — Rotación de clave de firma (Ed25519) + secret de Actions

- **Alcance**: rotación del par de claves de PRODUCCIÓN del sistema de
  licencias antes de la primera emisión a un cliente real (cero licencias
  afectadas — no existía ninguna emitida con la clave anterior, cuya
  privada nunca llegó a canal operativo alguno).
- **Secret**: `VIEWLBA_LICENSE_PRIVATE_KEY` creado en el repositorio
  (Settings → Secrets → Actions) con la clave privada nueva, cifrado
  sealed-box vía API. El workflow "License Generator" queda 100%
  operativo: `workflow_dispatch` → licencia firmada → artifact ZIP.
- **Instaladores**: re-compilados con la clave pública nueva
  (`ZT_i…GhEg`). Los instaladores de v1.2.0 (clave retirada `hP5E…dKRY`)
  **no deben usarse** en despliegues con licencias reales.
- **Versiones**: `package.json`, `Cargo.toml` y `tauri.conf.json` en 1.2.1.
- **Rotación futura**: seguir `docs/LICENSE-SECURITY.md` §9.

### v1.2.0 (2026-09-11) — Licenciamiento offline + generador + GitHub Actions

- **Alcance**: sistema de licencias 100% offline (Ed25519, binding equipo +
  disco, trial 7 días, watermark TV, planes mensual/anual), generador CLI,
  web demo del generador y workflow de GitHub Actions para emitir licencias.
- **Tag**: `v1.2.0` → `release-installer.yml` compila `.deb`, AppImages,
  `Setup.exe` y publica el GitHub Release con `SHA256SUMS` (nada de archivos
  de desarrollo: solo instaladores + manifiestos).
- **Versiones**: `package.json`, `Cargo.toml` y `tauri.conf.json` en 1.2.0.

### Nota de seguridad del historial git (auditoría v1.2.0)

La auditoría de release detectó que **4 backups SQLite y 2 archivos WAL/SHM
de la DB de e2e fueron commiteados accidentalmente** en el commit `b538eef`
(FASE 15/16). Contenido verificado: usuarios **demo del seed**
(`admin@restaurante.com` / `operador@restaurante.com` — credenciales públicas
documentadas en `prisma/seed.ts`) y contenido de prueba. **No hay secretos de
producción ni datos de clientes reales en el historial.** Desde v1.2.0 los
archivos están **des-trackeados** (`git rm --cached`) y cubiertos por `.gitignore`.
El repo es privado, el riesgo residual es nulo en la práctica; si se hiciera
público, se recomienda purgar el historial (git filter-repo) antes.
