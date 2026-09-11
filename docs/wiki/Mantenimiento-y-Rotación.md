# Mantenimiento y Rotación

Guía de operación continua del sistema de licencias: rotación de claves, checklist de release y resolución de problemas.

## Rotación de claves (procedimiento completo)

Caso de uso: sospecha de compromiso de la clave privada, cambio de emisor, o simplemente higiene periódica. **Impacto**: todas las licencias firmadas con la clave anterior dejan de validar → re-emitir a los clientes activos.

1. **Generar el par nuevo** (ver [Claves-Ed25519](Claves-Ed25519.md)):
   ```bash
   bun tools/license-generator/cli.ts keys --write-private /ruta/segura/nueva.key
   ```
2. **Incrustar la pública nueva**: `src/lib/licensing/public-key.ts` → `PRODUCTION_LICENSE_PUBLIC_KEY`.
3. **Actualizar el secret** `VIEWLBA_LICENSE_PRIVATE_KEY` con la privada nueva (UI o API — ver [Secret-de-GitHub-Actions](Secret-de-GitHub-Actions.md)).
4. **Commit + push** → CI verde (tests + gitleaks).
5. **Probar el workflow** License Generator con un cliente de prueba → run verde + artifact.
6. **Bump de versión + tag `v*`** → `release-installer.yml` re-compila instaladores con la pública nueva.
7. **Re-emitir** licencias a los clientes activos (el historial local del generador te dice quiénes son: `bun tools/license-generator/cli.ts history`).
8. Custodiar la privada vieja: destruirla de forma segura si ya no se necesita.

Historial de rotaciones: v1.2.0 (`hP5E…dKRY`, retirada sin emisiones) → v1.2.1 (`ZT_i…GhEg`, actual). ElCHANGELOG y `docs/RELEASE.md` documentan cada rotación.

> La arquitectura soporta convivencia de claves futura: añadir un `kid` (key id) al payload y un mapa clave→`kid` en el verificador (§9 de `docs/LICENSE-SECURITY.md`). Hoy: una sola clave activa.

## Checklist de release (resumen)

1. Todo verde en CI (`quality/integration/e2e/security` + tests de installer).
2. Versiones coherentes: `package.json` · `installer/gui/src-tauri/Cargo.toml` · `tauri.conf.json` · CHANGELOG.
3. `git tag vX.Y.Z && git push origin vX.Y.Z` → el workflow `release-installer.yml` (3 jobs: build-linux → build-windows → release) compila `.deb`, AppImages, `Setup.exe`, verifica con smoke real, gitleaks y publica el GitHub Release con `SHA256SUMS.txt` + manifiestos.
4. Verificar la release en GitHub (assets presentes).
5. Cambios notables → CHANGELOG + `docs/RELEASE.md` (historial).

## Workflow de emisión en Actions — healthcheck periódico

- Correr **License Generator** con un cliente de prueba (`Verificacion CI`) y confirmar run verde: prueba secret + clave + generador de extremo a extremo (se hizo tras la rotación v1.2.1: run 34552264176, verde, artifact "Verificacion CI Secret license").
- Recordar: los **artifacts caducan a los 14 días** (retención) — no usarlos como archivo de licencias; re-emitir.
- Revisar la lista de secrets (Settings → Secrets → Actions): debe existir `VIEWLBA_LICENSE_PRIVATE_KEY` y nadie más con acceso de administración.

## Troubleshooting (tabla rápida)

| Problema | Diagnóstico | Solución |
|---|---|---|
| Workflow License Generator falla: "Falta el secret" | El secret no existe | Crearlo ([Secret-de-GitHub-Actions](Secret-de-GitHub-Actions.md)) |
| Workflow falla: firma inválida / auto-verificación | Secret desincronizado con `public-key.ts` | Re-crear el secret con la privada del par incrustado |
| Cliente importa ZIP → "firma inválida" | ZIP editado o emitido con otra clave | Re-emitir |
| Cliente importa → `mismatch` | Licencia emitida para otros IDs (o cambió disco/equipo) | Re-emitir con los IDs de SU instalación |
| Trial "renació" tras borrado | Revisar las 2 anclas (`<data>/licensing/state.json`, `~/.viewlba-license.json`) y `deviceIdHash` | Caso conocido §4 LICENSE-SECURITY; soporte 52973387 |
| Licencia vencida en cliente | Estado `expired` (o `grace` si hay ventana) | Renovar por `renew` o re-emisión |
| Reloj retrocedido en cliente | `clock_tampering_detected` en auditoría | Congelado por diseño; corregir reloj + soporte |
| Artifact ya no disponible | Retención 14 días | Re-emitir la licencia |
| Cambiar expiry de una licencia emitida | — | **No existe**: cualquier edición rompe la firma; siempre re-emitir |

## Tareas del repositorio (todo lo que hay que mantener)

- **Secrets**: `VIEWLBA_LICENSE_PRIVATE_KEY` (creado, verificado). `GITHUB_TOKEN` es automático; no hay otros secrets necesarios para CI/release.
- **Workflows activos**: `ci.yml` (quality+security en cada push/PR), `license-generator.yml` (emisión on-demand), `release-installer.yml` (build+release en tag `v*`).
- **Ramas**: `feature/offline-licensing` y `feature/license-demo-github-actions` ya están fusionadas en `main` (PRs #1 y #2). Mantenimiento directo en `main` (repo privado sin branch-protection).
- **Documentación que debe permanecer sincronizada**: `docs/LICENSE-SYSTEM.md`, `LICENSE-GENERATOR.md`, `LICENSE-SECURITY.md`, `RELEASE.md`, `PRODUCTION_READINESS.md`, `CHANGELOG.md`, esta wiki, `tools/license-generator/README.md`, `license-demo/README.md`.

## Contacto

Soporte y emisión de licencias: **52973387**.
