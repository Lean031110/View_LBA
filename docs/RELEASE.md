# Proceso de release de los installers oficiales

## Artefactos por release

| Archivo | Plataforma | Fuente |
|---|---|---|
| `ViewLBA-Server.AppImage` | Linux (GUI + `--cli`) | Tauri (CI ubuntu) |
| `ViewLBA-Server-CLI.AppImage` | Linux (headless) | `installer/package/appimage.sh` (CI y local) |
| `viewlba-server_<ver>_amd64.deb` | Linux | Tauri deb (CI ubuntu) |
| `ViewLBA-Server-Setup.exe` | Windows (GUI NSIS) | Tauri (CI windows) |
| `SHA256SUMS.txt` | todos | CI (re-computado sobre los archivos subidos) |

## Release automático (recomendado)

```bash
# 1. Todo verde en CI (quality/integration/e2e/security + installer tests)
# 2. Tag y push:
git tag v1.0.0
git push origin v1.0.0
```

El workflow `.github/workflows/release-installer.yml`:

1. **Linux (ubuntu-latest)**: tests del installer → `bundle-server.ts`
   (payload offline: servidor + node_modules completos + build precompilado
   + Bun + sidecar compilado) → GUI Tauri (AppImage + deb) → AppImage CLI →
   **verificación real** (el AppImage arranca y responde `--json detect` y
   preflight) → SHA256SUMS.
2. **Windows (windows-latest)**: mismo payload (con `runtime/bun.exe` +
   `runtime/nssm.exe`) → smoke del sidecar `.exe` (`--json detect`) →
   `cargo tauri build --bundles nsis` → `ViewLBA-Server-Setup.exe` →
   SHA256SUMS.
3. **Release**: descarga artefactos, re-computa checksums y crea el GitHub
   Release con notas automáticas.

## Release manual (Linux, sin CI)

```bash
bun install && bunx prisma generate          # repo listo
bun installer/package/bundle-server.ts --platform=linux
bash installer/package/appimage.sh           # → dist/release/linux/ViewLBA-Server-CLI.AppImage
sha256sum dist/release/linux/ViewLBA-Server-CLI.AppImage
```

La GUI requiere Rust + webkit2gtk (por eso vive en CI):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev \
     libayatana-appindicator3-dev librsvg2-dev
cargo install tauri-cli --version "^2" --locked
# sidecar con el sufijo de target de Tauri:
cp dist/release/linux/ViewLBA-Server/viewlba-installer \
   installer/gui/src-tauri/binaries/viewlba-installer-x86_64-unknown-linux-gnu
# payload:
cp -a dist/release/linux/ViewLBA-Server/{resources,runtime,manifest.json} \
   installer/gui/src-tauri/resources/../ 2>/dev/null || true
cd installer/gui/src-tauri && cargo tauri build
```

## Payload offline — qué incluye y por qué

`bundle-server.ts` ensambla (FUERA del repo — evita la inferencia de raíz
de Turbopack por git-root que anidaba el standalone):

- **Código**: repo con exclusiones estándar (nunca datos ni node_modules).
- **node_modules COMPLETOS** (dev+prod): el payload debe poder compilar
  (Tailwind/PostCSS son devDeps) y migrar (Prisma CLI + engines del SO).
- **Build standalone precompilado** (`bun run build` en el staging).
- **Bun** oficial (MIT) descargado del release exacto (`runtime/bun`+`bunx`).
- **NSSM 2.24** (Windows, public domain de nssm.cc) en `runtime/nssm.exe`.
- **Sidecar** `viewlba-installer` compilado (`bun build --compile`).
- `manifest.json`: versión, commit, plataforma, fecha.

Verificación de payload realizada localmente (evidencia en
`docs/INSTALLER-LINUX.md`): migrate offline ✓, arranque con runtime incluido ✓,
health real ✓.

## Checksums

- CI genera `SHA256SUMS.txt` re-computado sobre los artefactos finales.
- Verificación del usuario: `sha256sum -c SHA256SUMS.txt` (Linux) /
  `Get-FileHash` (Windows).
- El AppImage CLI lleva además `*.AppImage.sha256` junto al archivo.

## Reglas de verificación (no negociables)

- **Nada de PASS sin evidencia.** Windows end-to-end sigue **NOT VERIFIED**
  hasta el procedimiento de `docs/INSTALLER-WINDOWS.md` § verificación.
- Cada release de CI incluye: tests del installer + smoke del sidecar +
  arranque del AppImage (Linux) + smoke del exe (Windows) — si fallan, no
  hay release.
- Versionar con tags semver (`vX.Y.Z`); el número viaja al `.deb`/NSIS y al
  `manifest.json` del payload.
