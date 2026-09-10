# ViewLBA License Generator — Web Demo

Demo **independiente del servidor principal** (rama `feature/license-demo-github-actions`)
para emitir licencias desde el navegador. También usable como base de una
herramienta interna de operación.

> Manuales completos: [`docs/LICENSE-GENERATOR.md`](../docs/LICENSE-GENERATOR.md) ·
> Seguridad: [`docs/LICENSE-SECURITY.md`](../docs/LICENSE-SECURITY.md)

## Arquitectura (sección 23 del diseño)

```
navegador (UI estática, sin claves)
        ↓ fetch JSON
backend protegido (license-demo/server.ts, Bun puro — 0 dependencias nuevas)
        ↓ firma Ed25519
VIEWLBA_LICENSE_PRIVATE_KEY  ←  SOLO en este proceso (env o efímera de demo)
```

**La UI nunca ve la clave privada.** Solo envía el formulario y recibe el ZIP
ya firmado (base64) + el resumen.

## Modos

| Modo | Cómo se activa | Clave de firma | Protección |
|---|---|---|---|
| **ADMIN PRIVADO** (producción de emisión) | `VIEWLBA_LICENSE_PRIVATE_KEY` definida | clave REAL | `DEMO_ADMIN_TOKEN` (Bearer). Sin token escucha **solo 127.0.0.1** |
| **DEMO** (pública) | `DEMO_MODE=true` | par **efímero** generado en cada arranque (licencias NO válidas en producción) | sin token (rate-limit 20/min) |

## Arranque

```bash
# Demo pública (para enseñar el flujo — clave de prueba efímera)
DEMO_MODE=true bun license-demo/server.ts            # http://localhost:3210

# Emisión real (clave privada del env + token recomendado)
VIEWLBA_LICENSE_PRIVATE_KEY="<base64url>" \
DEMO_ADMIN_TOKEN="<token-largo>" \
bun license-demo/server.ts                            # escucha 0.0.0.0:3210
```

Variables: `LICENSE_DEMO_PORT` (3210) · `LICENSE_DEMO_BIND` · `DEMO_MODE` ·
`VIEWLBA_LICENSE_PRIVATE_KEY` · `DEMO_ADMIN_TOKEN`.

## Funciones de la UI

- **Nueva licencia** — cliente, Installation ID, Disk ID, ruta, plan, fecha
  inicio → `GENERAR LICENCIA` → 4 checks (creada/firma/binding/ZIP) + descarga.
- **Renovar** — sube la licencia actual (ZIP o JSON), elige plan/fecha → nueva
  licencia firmada con el mismo binding (anti-downgrade).
- **Verificar** — sube cualquier licencia: firma, vigencia y binding contra los
  IDs del cliente que indiques.
- **Historial local** — emisiones hechas desde ese navegador (localStorage, sin
  claves ni datos del servidor).

## API de la demo

| Endpoint | Descripción |
|---|---|
| `GET /api/config` | `{mode, protected, publicKey, contact}` |
| `GET /api/health` | `{ok, mode}` |
| `POST /api/generate` | `{customerName, installationId, diskId, installPath, plan, startDate}` → `{ok, fileName, zipBase64, license, summary}` |
| `POST /api/renew` | `{fileBase64, plan, startDate}` → ídem generate |
| `POST /api/verify` | `{fileBase64, installationId?, diskId?}` → `{signatureOk, expired, daysLeft, binding, license}` |

Reusa **el mismo código canónico del producto** (`src/lib/licensing`) → firma y
verificación idénticas a las de la app del cliente.

## GitHub Actions

El workflow [`.github/workflows/license-generator.yml`](../.github/workflows/license-generator.yml)
se dispara manualmente (`workflow_dispatch`) con los inputs del requisito y
publica el ZIP como artifact usando el secret `VIEWLBA_LICENSE_PRIVATE_KEY`.
La clave nunca se imprime; el artifact se audita para garantizar que no
contiene material de clave.

## Tests

`tests/licensing/demo-server.test.ts` — arranque del servidor en modo demo y
admin (token), generación/renovación/verificación, rechazos, rate-limit y la
invariante "la clave privada nunca aparece en ninguna respuesta".
