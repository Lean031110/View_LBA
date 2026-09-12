# Sistema de Temas TV (ViewLBA v3.1)

> Temas visuales **declarativos** para la pantalla TV: un paquete `.vtheme`
> describe cómo se ve la pantalla; el MOTOR de ViewLBA lo renderiza.
> Un tema **nunca contiene código ejecutable** (ver [THEME_SECURITY.md](THEME_SECURITY.md)).

---

## 1. Arquitectura

```
Administración ──POST /api/admin/themes (multipart .vtheme)──▶ importador
                                                                  │
                              21 pasos de validación (fail-closed)│
                                                                  ▼
                                              data/themes/imported/<dir-aislado>/
                                              ├── theme.json  (spec validado)
                                              └── assets/…    (índice verificado)
                                                                  │
Prisma: Theme { themeId, name, version, manifestJson, themeJson, dir, assetsJson }
Settings.activeThemeId ──aplicar──▶ colores del spec + broadcast content:update
                                                                  │
TV: GET /api/content ──▶ bundle.theme (PublicTheme resuelto) ◀────┘
        │
        └─ ThemeBackground + estilos del motor (reloj/ticker/carrusel/fuentes)
           con FALLBACK DURO a Default (§14: la TV nunca se queda sin tema)
```

Módulos (`src/lib/themes/`):

| Módulo | Responsabilidad |
|---|---|
| `types.ts` | Schema, límites (`THEME_LIMITS`), códigos de rechazo tipados |
| `zip.ts` | Lector ZIP **propio** (fail-closed) + escritor STORED determinista |
| `validate.ts` | Validadores estrictos de `manifest.json` y `theme.json` |
| `package.ts` | Pipeline de importación (21 pasos) + `buildVTheme` (empaquetado) |
| `builtin.ts` | Default / Classic / Neon (en código, sin archivos externos) |
| `store.ts` | Instalación aislada, activación, eliminación, resolución, assets |
| `index.ts` | Fachada + versión (`/VERSION`) para `minViewLbaVersion` |

## 2. Formato `.vtheme`

ZIP con EXACTAMENTE esta estructura:

```
MyTheme.vtheme
├── manifest.json    (metadatos + compatibilidad)
├── theme.json       (especificación visual — ver abajo)
└── assets/          (opcional: png/jpg/webp/woff/woff2, un nivel)
```

`manifest.json` (todos los campos obligatorios, schema v1):

```json
{
  "schemaVersion": 1,
  "id": "mi-restaurante",
  "name": "Mi Tema",
  "author": "Estudio X",
  "version": "1.0.0",
  "description": "…",
  "minViewLbaVersion": "3.1.0",
  "licenseTier": "full"
}
```

`theme.json` (todos los campos OPCIONALES — el resto son los del Default):

```json
{
  "palette":   { "primary": "#d4af37", "accent": "#a32638", "bg": "#0f0c07", "surface": "#1a150c" },
  "typography": { "heading": "serif", "body": "sans" },
  "clock":     { "style": "classic" },
  "ticker":    { "style": "classic" },
  "carousel":  { "transition": "fade" },
  "background": { "effect": "gradient" },
  "cards":     { "radius": 14, "shadow": "soft" },
  "assets":    { "backgroundImage": "bg.png" }
}
```

Enums permitidos (cualquier otro valor o campo desconocido → **rechazo**):

| Campo | Valores |
|---|---|
| `typography.heading/body` | `display` · `serif` · `sans` · `mono` |
| `clock.style` | `classic` · `digital` · `neon` |
| `ticker.style` | `classic` · `neon` |
| `carousel.transition` | `fade` · `slide` · `zoom` |
| `background.effect` | `none` · `gradient` · `grid` · `glow` |
| `cards.shadow` | `none` · `soft` · `glow` |
| `palette.*` | hex `#RRGGBB` estricto |
| `cards.radius` | entero 0–32 |

Principio **anti-schema-desconocido** (misión §24): `schemaVersion != 1` o
cualquier campo fuera del schema → rechazo. NUNCA se interpreta un campo
desconocido.

## 3. Temas integrados

| id | Nombre | Carácter |
|---|---|---|
| `default` | ViewLBA Default | Fábrica; **fallback garantizado**; no se puede eliminar |
| `viewlba-classic` | ViewLBA Classic | Elegante oscuro, dorado, serif, degradado |
| `viewlba-neon` | ViewLBA Neon | Tecnológico, cian/magenta, reloj neón, brillos |

`themes/ViewLBA-Classic.vtheme` y `themes/ViewLBA-Neon.vtheme` son la
**exportación oficial** del formato (generados por `bun scripts/build-vtheme.ts`
desde `builtin.ts` — fuente única). Importarlos en un sistema que ya los
integra se rechaza limpiamente (`id_conflict`: un tema integrado no se puede
sobrescribir); sirven como referencia del formato y plantilla.

## 4. API

| Ruta | Método | Notas |
|---|---|---|
| `/api/admin/themes` | GET | Inventario (integrados + importados). VIEWER+. Sin gate (el trial VISUALIZA §17) |
| `/api/admin/themes` | POST | Importar multipart `file`. OPERATOR+ + `themes.custom` (trial → 403) |
| `/api/admin/themes/[id]` | POST | `{action:"activate"}` — activa. OPERATOR+ + `themes.custom` |
| `/api/admin/themes/[id]` | DELETE | Elimina importado (integrados → 403). OPERATOR+ + `themes.custom` |
| `/api/theme-assets/[themeId]/[name]` | GET | **Público** (la TV). Solo assets indexados; charset duro |

La activación revalida el `theme.json` DESDE DISCO (paso 20 en cada uso — la
DB nunca es autoridad) y emite `broadcast("content:update")` → las TVs
refetch al instante (§15). El ETag de `/api/content` incluye el sello del
tema activo + agregado de la tabla `Theme`.

## 5. Resolución y fallback (§14)

`resolveActiveTheme()`:

1. `Settings.activeThemeId` → integrado? → spec del código.
2. Fila importada? → **re-parse desde disco** (`validateThemeSpec` estricto).
3. Cualquier fallo (fila borrada, archivo corrupto, JSON inválido) → **Default**.

La TV recibe SIEMPRE un `PublicTheme` válido. Un tema importado corrupto se
marca `broken` en el listado (el admin lo ve y puede eliminarlo); la
activación explícita de un tema corrupto se rechaza (`storage_error`).

Colores: al ACTIVAR un tema, su paleta se copia a `Settings`
(`primary/accent/bg/surface`) — la sección Apariencia sigue funcionando
(los ajustes del usuario prevalecen tras la activación). El resto del spec
(fuentes, reloj, ticker, carrusel, fondo, tarjetas) se resuelve en vivo.

## 6. Trial / licencia (§17)

- **Trial**: GET ok (se visualiza con candado «Los temas de pantalla están
  disponibles con una licencia completa»), importar/activar/eliminar → 403.
- **Activa**: todo habilitado.
- **Expira**: los temas instalados NO se borran; la gestión se bloquea (403);
  el tema activo se mantiene de forma segura. Ver `tests/themes/backup.test.ts`
  (documentación ejecutable).
- Features futuras (§18, sin marketplace): `themes.standard`, `themes.premium`,
  `multiDisplay`, `advancedAnimations` — `FUTURE_FEATURE_KEYS` en
  `src/lib/licensing/types.ts`.

## 7. Backup / restore (§19)

- La tabla `Theme` entra en `TRACKED_TABLES` (verificada por `createBackup`).
- Backups pre-3.1 (sin tabla Theme) restauran sin error (`OPTIONAL_TABLES`).
- Tras restaurar: `purgeInvalidThemes()` revalida filas contra el disco actual
  (purga huérfanos/corruptos). `scripts/restore.ts` lo ejecuta e informa.
- JAMÁS se ejecuta código de un tema al restaurar: los temas no contienen código.

## 8. Testing y versionado

| Suite | Archivo | Cobertura |
|---|---|---|
| Lector ZIP | `tests/themes/zip.test.ts` | 32 tests: estructura, CRC, traversal §11, bombas §12, symlinks, cifrado, duplicados |
| Validadores | `tests/themes/validator.test.ts` | 22 tests: schema, enums, unknown fields §24, semver |
| Importador | `tests/themes/importer.test.ts` | 49 tests: §20 completo + fuzz (mutaciones/truncados sin crash) |
| Store | `tests/themes/store.test.ts` | 19 tests: instalación aislada, activación, §14, purge, assets |
| Backup | `tests/themes/backup.test.ts` | 7 tests: §19 + compatibilidad pre-3.1 |
| Gating | `tests/integration/themes-gating.test.ts` | 7 tests HTTP reales: trial 403 §17 |
| E2E | `e2e/themes.spec.ts` | 8 tests §22: import/apply/persist/delete/Default/malicioso/realtime/multi-TV |

- Compatibilidad: `minViewLbaVersion` (semver por componentes) contra
  `/VERSION` (`viewlbaVersion()`; override de tests:
  `VIEWLBA_VERSION_FOR_THEMES`).
- Al subir `VTHEME_SCHEMA_VERSION`, la versión ANTERIOR de ViewLBA sigue
  rechazando el paquete nuevo (fallo explícito `bad_schema`), y la nueva
  rechaza la anterior: nunca se "interpreta a ciegas".
