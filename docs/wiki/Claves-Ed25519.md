# Claves Ed25519 — Cómo se generan y dónde viven

Esta página explica **cómo se genera el par de claves** del sistema de licencias de ViewLBA, los formatos exactos y las reglas de custodia. Es la operación más sensible de todo el sistema: quien posea la clave privada puede emitir licencias válidas.

## Qué es el par de claves

- **Algoritmo:** Ed25519 (firma digital de curva Edwards), implementado con `node:crypto` — **cero dependencias nuevas** en el proyecto.
- **Clave PRIVADA** (32 bytes): la posee SOLO el emisor (dueño). Con ella se **firma** cada licencia.
- **Clave PÚBLICA** (32 bytes): va incrustada en el producto. Con ella la app del cliente **verifica** cada licencia.
- Formato en ambos casos: **base64url de los 32 bytes crudos** (43 caracteres, sin `=` de padding). Ejemplo de aspecto: `ZT_iNNFWeV0ambnm03NjqCuABG5IRMK-Ez37QtbGhEg`.

> La firma cubre la **forma canónica** del payload completo excepto `signature` (claves ordenadas recursivamente). Por eso modificar cualquier campo de `license.json` — un solo byte — rompe la firma.

## Cómo se genera un par NUEVO (procedimiento oficial)

El repositorio incluye el comando `keys` del generador (`tools/license-generator/cli.ts`):

```bash
# Opción recomendada: genera el par y escribe la privada con permisos 600
# en una ruta FUERA del repositorio:
bun tools/license-generator/cli.ts keys --write-private /ruta/segura/viewlba-private.key

# (sin --write-private, la clave privada se muestra UNA vez por pantalla
#  y no vuelve a mostrarse — guárdala en ese momento)
```

El comando imprime:

- la **clave pública** (para incrustar en `src/lib/licensing/public-key.ts` → constante `PRODUCTION_LICENSE_PUBLIC_KEY`, y para exportar como `VIEWLBA_LICENSE_PUBLIC_KEY` si quieres auto-verificar en el generador);
- la **clave privada** (archivo con permisos 600 o valor por pantalla — según la opción usada).

Internamente usa `generateLicenseKeyPair()` de `src/lib/licensing/crypto.ts`: `generateKeyPairSync("ed25519")` + export DER (`PKCS8`/`SPKI`) + extracción de los 32 bytes crudos. La app reconstruye los KeyObject con los prefijos DER fijos de Ed25519 (`302e020100300506032b657004220420` para PKCS8, `302a300506032b6570032100` para SPKI).

## Después de generar: los 3 pasos obligatorios

1. **Actualizar la clave pública en el código**: `src/lib/licensing/public-key.ts` → `PRODUCTION_LICENSE_PUBLIC_KEY = "<nueva pública>"`.
2. **Crear/actualizar el secret de GitHub Actions** `VIEWLBA_LICENSE_PRIVATE_KEY` con la nueva privada (ver [Secret-de-GitHub-Actions](Secret-de-GitHub-Actions.md) — cómo hacerlo por UI o por API).
3. **Publicar release** con el cambio (tag `v*` → el workflow `release-installer.yml` re-compila los instaladores, que llevan la pública nueva incrustada).

⚠️ **Regla de rotación:** al rotar el par, las licencias firmadas con la clave anterior dejan de validar. Rotar ANTES de emitir licencias reales (o re-emitir a todos los clientes activos tras rotar). Procedimiento completo: `docs/LICENSE-SECURITY.md` §9 y [Mantenimiento-y-Rotación](Mantenimiento-y-Rotación.md).

## Dónde vive cada clave (tabla de custodia)

| Lugar | Clave pública | Clave privada |
|---|---|---|
| Código del producto (`public-key.ts`) | ✅ SÍ (incrustada) | ❌ NUNCA |
| Instaladores `.exe` / `.deb` / AppImage | ✅ SÍ (heredan del código) | ❌ NUNCA (verificado en CI) |
| Secret de GitHub Actions | — | ✅ SÍ (`VIEWLBA_LICENSE_PRIVATE_KEY`, cifrado) |
| Generador CLI / demo web en modo ADMIN | ✅ (para auto-verificar) | ✅ vía env `VIEWLBA_LICENSE_PRIVATE_KEY` o `--private-key-file` |
| Copia del dueño (fuera de banda) | — | ✅ archivo con permisos 600, fuera del repo y de backups públicos |
| Historial git / artifacts / logs / wiki | ❌ | ❌ JAMÁS (gitleaks en CI lo bloquea) |

## Historial de claves de PRODUCCIÓN

| Clave (prefijo) | Vigente desde | Estado |
|---|---|---|
| `hP5E…dKRY` | v1.2.0 (2026-09-11) | **RETIRADA** — su privada nunca llegó a canal operativo; se rotó antes de emitir la primera licencia (cero impacto) |
| `ZT_i…GhEg` | v1.2.1 (2026-09-11) | ✅ **ACTUAL** — firma todas las licencias; su privada vive en el secret de Actions + custodia del dueño |

## Verificaciones automáticas que protegen las claves

- **CI ejecuta gitleaks** en cada push/PR: cualquier fuga de material de clave en el historial rompe el build.
- El workflow **License Generator** verifica que el ZIP emitido **no contenga** fragmento alguno de la clave privada antes de publicar el artifact.
- Los tests usan **claves DUMMY de test** (env `VIEWLBA_LICENSE_PUBLIC_KEY` con clave de prueba), nunca la de producción.
- La app no tiene **ninguna ruta de código** que lea una clave privada del entorno por defecto: `signLicense()` solo se invoca desde el generador y tests con la clave como argumento explícito.

Siguiente: [Secret-de-GitHub-Actions](Secret-de-GitHub-Actions.md).
