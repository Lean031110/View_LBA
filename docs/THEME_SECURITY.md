# Seguridad del Sistema de Temas (ViewLBA v3.1)

> Modelo de amenazas y defensas del importador `.vtheme`. Regla de oro:
> **un tema es un paquete de DATOS visuales, jamás código.** Todo rechazo es
> tipado (`ThemeError`) y fail-closed: REJECT SAFE sin crash del servidor.

---

## 1. Principio declarativo (§9 de la misión)

Un `.vtheme` puede contener SOLO:

| Permitido | Rechazado |
|---|---|
| `manifest.json` / `theme.json` (JSON estricto) | `.js` `.mjs` `.cjs` `.ts` `.sh` `.bat` `.ps1` `.exe` `.dll` `.so` `.py` `.html` `.svg` `.xml` `.css` (y todo binario) |
| Imágenes `png` `jpg` `jpeg` `webp` (magic bytes + dimensiones reales) | Fuentes `.ttf` `.otf` (superficie de parser mayor) |
| Fuentes web `woff` `woff2` (magic bytes) | Cualquier archivo fuera de `manifest.json`, `theme.json`, `assets/` |

El CSS y las animaciones los **genera el motor** a partir de valores
validados (colores hex, enums cerrados, enteros acotados). No existe ruta de
ejecución de contenido del paquete: ni `eval`, ni inyección de markup, ni
`@font-face` arbitrario (la familia tipográfica se elige de una lista blanca
del motor).

## 2. Los 21 pasos de importación (§10)

| # | Chequeo | Código de rechazo |
|---|---|---|
| 1 | extensión `.vtheme` | `bad_extension` |
| 2 | estructura ZIP (EOCD + central directory coherentes) | `not_zip` / `zip_corrupt` |
| 3 | tamaño máx. paquete 50 MB | `too_big` |
| 4 | máx. 200 entradas | `too_many_entries` |
| 5 | profundidad ≤ 4, nombres ≤ 128 | `entry_name_invalid` |
| 6 | sin `..` en componentes | `traversal` |
| 7 | sin rutas absolutas ni `\` | `traversal` |
| 8 | sin symlinks/dispositivos (modo Unix del CD) | `symlink` |
| 9 | `manifest.json` presente + schema | `missing_manifest` / `bad_schema` |
| 10 | tipos/longitudes/enums de campos | `bad_field` / `unknown_field` |
| 11 | assets referenciados existen | `bad_asset_ref` |
| 12 | tamaños por asset (8 MB) y nº (64) | `asset_limit` |
| 13 | magic bytes REALES + coherencia con extensión | `bad_image` |
| 14 | dimensiones ≤ 4096×4096, PNG íntegro (chunks→IEND) | `bad_image` |
| 15 | nombres/id duplicados | `duplicate` / `id_conflict` |
| 16 | `minViewLbaVersion` ≤ versión actual | `incompatible` |
| 17 | CRC32 por entrada + presupuesto total 120 MB | `zip_corrupt` / `uncompressed_limit` |
| 18 | `licenseTier == "full"` | `wrong_tier` |
| 19 | instalación en directorio AISLADO generado por el servidor | `storage_error` |
| 20 | revalidación desde disco tras escribir (y en cada activación) | `storage_error` |
| 21 | activación SOLO tras validar todo lo anterior | — |

Pasos adicionales del lector ZIP: entradas cifradas → `encrypted_entry`;
método ≠ STORED/DEFLATE → `bad_compression`; ratio de compresión > 500× en
entradas grandes → `bomb_suspected`; `inflateRaw` con tope de salida
(`maxOutputLength`) → una bomba se corta ANTES de asignar memoria.

## 3. Defensas contra Path Traversal (§11)

Rechazados (tests explícitos en `tests/themes/zip.test.ts`):

- `../../server.js`, `../../../etc/passwd`, `a/../../b.json`
- `..\..\Windows\System32\evil.dll`, `C:\Windows\evil.ini`
- `/etc/passwd` (absoluta)
- NUL, tabulación, unicode, espacios, saltos de línea (charset `[A-Za-z0-9._\-/]`)
- Dispositivos Windows (`CON`, `NUL`, `AUX`, `COM1`…)
- `assets/sub/x.png` (subdirectorios en assets)
- Duplicados exactos de nombre

En el **filesystem**, además:

- El directorio de instalación lo GENERA el servidor
  (`t-<base36>-<16hex>`), jamás el id del paquete.
- `rm`/lecturas validan que el path resuelto quede dentro de
  `data/themes/imported/` (guarda anti-traversal en `deleteTheme` y
  `readThemeAsset`).
- La ruta pública `/api/theme-assets/[themeId]/[name]` valida charset
  `[a-z0-9-]{1,64}` / `[A-Za-z0-9._-]{1,128}` + index de la fila.

## 4. ZIP bomb / agotamiento de recursos (§12)

| Vector | Defensa |
|---|---|
| Bomba clásica (ratio ~1000×) | `bomb_suspected` si ratio > 500× con comprimido > 64 KB |
| Declaración mentirosa de tamaños | presupuesto global (120 MB) sobre tamaños DECLARADOS + corte real en `inflateRaw` + verificación length == declarada |
| Muchas entradas | ≤ 200 |
| Imagen gigante | dimensiones ≤ 4096² leídas de la cabecera real |
| Asset gigante | ≤ 8 MB por archivo |
| JSON gigante | ≤ 64 KB por `manifest/theme.json` |
| Nombres largos | ≤ 128 chars |
| Entry cifrada (password cracking / DoS) | rechazo inmediato |
| Bucle de chunks PNG roto | cadena de chunks con guard de 256 iteraciones |

## 5. MIME/Extensión falsos (§20)

- JS renombrado `.png` → magic bytes no coinciden → `bad_image`.
- PNG renombrado `.jpg` → incoherencia extensión/contenido.
- `exe` (MZ) renombrado `.png` → `bad_image`.
- woff renombrado `.woff2` → `bad_image`.
- Extensiones ejecutables explícitamente rechazadas con mensaje claro
  (`forbidden_file`) aunque el contenido parezca inofensivo.

## 6. Autoridad y almacenamiento

- La **DB no es autoridad**: `themeJson` de la fila es caché histórico; el
  spec se RE-PARSEA desde disco con el validador estricto en cada uso
  (activación, resolución, listado).
- Un `theme.json` editado en disco tras la instalación → `broken` en el
  listado / rechazo al activar / **fallback automático a Default en la TV**.
- Un archivo colado en el dir de assets (sin pasar validación) → la ruta
  pública devuelve 404 (solo se sirve lo INDEXADO en `assetsJson`).
- Ids de integrados (`default`, `viewlba-classic`, `viewlba-neon`) →
  `id_conflict`: imposible sobrescribir un tema integrado importando un
  paquete con su id.

## 7. Gating de licencia (§17)

`requireLicenseFeature("themes.custom")` en TODAS las mutaciones:

- Trial: GET lista OK (visualiza), POST/DELETE → **403** con contacto.
- Licencia vencida: igual que trial para GESTIÓN; los temas instalados se
  conservan y el activo sigue renderizando (sin borrado destructivo).
- Verificación HTTP real: `tests/integration/themes-gating.test.ts`
  (incluye 401 sin sesión).

## 8. Realtime y TV (§15/§16/§23)

- Aplicar tema → `broadcast("content:update", {section:"settings"})` →
  las TVs conectadas refetch `/api/content` (ETag invalidado por sello de
  tema). Múltiples TVs reciben el mismo evento.
- La TV NUNCA ejecuta contenido del tema: solo interpreta `PublicTheme.spec`
  con enums cerrados; los estilos los produce el motor (`globals.css`).
- Fallo del tema activo → Default en el MISMO refetch (§14): la pantalla
  nunca queda inutilizable.

## 9. Fuzz / robustez (§20-§21)

- 300 mutaciones de byte aleatorias + truncados progresivos del paquete
  válido → rechazo tipado o nada, JAMÁS crash (`importer.test.ts`).
- Claves unicode/cirílicas en theme.json → `unknown_field`.
- Manifest con unicode en campos de texto legibles → aceptado (son texto)
  con longitudes acotadas.

## 10. No-objectivo (honestidad)

- La firma de paquetes (paso 18 «si aplica») no está activada en schema v1:
  un .vtheme válido pero NO oficial puede importarse en una instalación con
  licencia (es una decisión de producto: el admin decide qué instala, igual
  que sube imágenes). La validación estructural completa sigue aplicando.
  Cuando se active un marketplace, `schemaVersion` sube y los paquetes v1
  firmados no serán interpretados a ciegas (§24).
