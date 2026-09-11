# ViewLBA License Generator — Manual de operación

> Herramienta **separada del producto** que posee la clave PRIVADA de firma.
> El servidor/TV del cliente **solo verifican**. Ver [LICENSE-SECURITY.md](LICENSE-SECURITY.md)
> para las reglas de manejo de claves.

- Contacto del emisor: **52973387**
- Planes: **Mensual** USD 10 · 30 días — **Anual** USD 100 · 365 días (trial: automático en la app, 7 días, no se emite)

## 1. Ubicación

```
tools/license-generator/
├── cli.ts        # CLI principal (generate · renew · verify · keys · history)
├── lib.ts        # Validación de entradas, firma, README, ZIP, historial
└── README.md     # (otro manual, orientado al CLI)
```

Reutiliza el código canónico del producto (`src/lib/licensing/`) → **firmante y
verificador comparten exactamente la misma canonicalización** (si divergen, los
tests E2E/unitarios lo detectan).

Atajos en `package.json`:
```bash
bun run license:generate -- …   # = bun tools/license-generator/cli.ts …
bun run license:keys            # = bun tools/license-generator/cli.ts keys
```

## 2. Clave privada (UNA sola vez)

```bash
# genera el par y escribe la privada con permisos 600 FUERA del repo
bun tools/license-generator/cli.ts keys --write-private /ruta/segura/viewlba-private.key
```

- La **privada** se pasa con `--private-key-file` o con el env
  `VIEWLBA_LICENSE_PUBLIC_KEY`… ojo: `VIEWLBA_LICENSE_PRIVATE_KEY` (env) — nunca
  se commitea (`.gitignore` cubre `tools/license-generator/*.key`, `keys/`, `out/`, `history/`).
- La **pública** correspondiente va al verificador: la de producción ya está
  incrustada en `src/lib/licensing/public-key.ts`; para auto-verificar en el
  generador exporta `VIEWLBA_LICENSE_PUBLIC_KEY` con el mismo valor.
- Para GitHub Actions: el **secret** `VIEWLBA_LICENSE_PRIVATE_KEY` ya está
  creado y verificado en el repositorio (rotación v1.2.1). Para rotarlo:
  ver `docs/wiki/Secret-de-GitHub-Actions.md` (procedimiento UI y API).

## 3. Emitir una licencia nueva (sección 34, criterio de éxito)

El cliente te envía desde `Administración → Licencia` el bloque:

```
ViewLBA — Solicitud de licencia
Nombre del cliente: Leandro Bueno
Installation ID: VWLB-8F2A-91CD-2D31-77AA
Disk ID: DSK-A5ED-432A-37DD
Ruta: C:\PantallaRestaurante
```

Tú ejecutas:

```bash
VIEWLBA_LICENSE_PRIVATE_KEY="<clave privada>" \
bun tools/license-generator/cli.ts generate \
  --customer "Leandro Bueno" \
  --installation-id VWLB-8F2A-91CD-2D31-77AA \
  --disk-id DSK-A5ED-432A-37DD \
  --install-path "C:\\PantallaRestaurante" \
  --plan annual \
  --start 2026-09-10
```

Validaciones ANTES de crear (sección 6): nombre no vacío, Installation ID con
formato `VWLB-XXXX-XXXX-XXXX-XXXX`, Disk ID `DSK-XXXX-XXXX-XXXX`, plan válido,
fecha válida, `start < expiry` (garantizado por la duración del plan), clave
disponible y **no sobrescribir** accidentalmente (`--force` para permitirlo).

Salida: `ViewLBA-License-Leandro-Bueno-20260910.zip` (fecha = inicio de
vigencia) con `license.json` + `README.txt`, más el resumen:

```
✓ Licencia firmada (Ed25519)
✓ Firma verificada de ida y vuelta
✓ Binding correcto: VWLB-8F2A-91CD-2D31-77AA + DSK-A5ED-432A-37DD
✓ ZIP listo: tools/license-generator/out/ViewLBA-License-Leandro-Bueno-20260910.zip
✓ Historial actualizado

──────────────── RESUMEN DE LA LICENCIA ────────────────
  Cliente:        Leandro Bueno
  Plan:           Anual (365 días · USD 100)
  Inicio:         2026-09-10
  Vencimiento:    2027-09-10
  Installation ID:VWLB-8F2A-91CD-2D31-77AA
  Disk:           DSK-A5ED-432A-37DD
  Licencia:       VLBA-1a2b3c4d5e6f
────────────────────────────────────────────────────────
```

El cliente importa el ZIP en `Administración → Licencia → IMPORTAR LICENCIA`
→ `✓ Licencia válida · Equipo vinculado · Disco vinculado` y la marca de agua
desaparece.

## 4. Renovar (sección 18)

```bash
bun tools/license-generator/cli.ts renew \
  --from ViewLBA-License-Leandro-Bueno-20260910.zip \
  --plan annual --start 2027-09-10
```

- Verifica la firma de la licencia de origen (nunca renueva desde un archivo manipulado).
- Genera una **licencia NUEVA** con el mismo binding y nuevo `licenseId`
  (la anterior queda intacta; el historial del cliente conserva ambas).
- Rechaza **downgrades**: la renovación no puede vencer antes que la origen.

## 5. Verificar una licencia

```bash
bun tools/license-generator/cli.ts verify --file licencia.json \
  [--installation-id VWLB-…] [--disk-id DSK-…]
```
Muestra firma (válida/inválida), vigencia restante y, si pasas los IDs del
cliente, la coincidencia de binding.

## 6. Historial local de emisiones (sección 25)

```bash
bun tools/license-generator/cli.ts history
```

Registro append-only en `tools/license-generator/history/history.jsonl`
(gitignored): `licenseId, customerName, installationId, diskId, plan, issuedAt,
startsAt, expiresAt, file`. **Nunca se guarda la clave privada.** Estructura
migrable a un futuro servidor central de emisión.

## 7. Demo web + GitHub Actions (rama `feature/license-demo-github-actions`)

La rama de demo añade:

- **`license-demo/`** — web independiente del servidor principal con UI
  profesional (nueva / renovar / regenerar / verificar / exportar ZIP /
  historial local). El backend de la demo está protegido y la clave privada
  **nunca llega al navegador** (ver su propio README).
- **`.github/workflows/license-generator.yml`** — `workflow_dispatch` con los
  inputs del requisito (`customerName, installationId, diskId, installPath,
  plan, startDate`) que genera el ZIP y lo publica como **artifact** usando el
  secret `VIEWLBA_LICENSE_PRIVATE_KEY`. Ver [LICENSE-GENERATOR.md#8](LICENSE-GENERATOR.md)
  y el workflow.

## 8. Reglas de oro

1. La clave privada **no** se commitea, no se imprime en logs ni viaja al cliente.
2. Cada licencia se emite para UNA instalación concreta (equipo + disco).
3. Renovar = licencia nueva; nunca se "extiende" la anterior.
4. Ante cambio de disco/equipo del cliente: emitir licencia nueva (el sistema
   mostrará MISMATCH con el detalle de IDs — sección 19).
5. Los ZIP emitidos viven en `tools/license-generator/out/` (gitignored):
   guárdalos donde guardes tus documentos comerciales.
