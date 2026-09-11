# Sistema de Licencias v2 (token copiar/pegar)

> **Flujo único.** El sistema v1 (ZIP + license.json + Installation/Disk ID a
> mano) fue ELIMINADO por completo en la v2.0.0. Esta página describe el
> único flujo soportado.

## Visión general

El cliente ve exactamente dos artefactos en **Administración → Licencia**:

1. **Código de solicitud** `VLREQ2-XXXX-XXXX-…` — lo copia y envía por
   WhatsApp al proveedor.
2. **Token de licencia** `VLBA2-XXXX-XXXX-…` — lo pega y activa.

Todo lo demás (Installation ID, Disk ID, hashes, JSON, ZIP, criptografía)
está **oculto** y se gestiona automáticamente.

```
CLIENTE                                 ADMIN (app Android privada)
─────────────────────────────           ──────────────────────────
Administración → Licencia
[Nombre del negocio]
(1) «Copiar código de solicitud»  ─── WhatsApp ───►  [Nueva licencia]
                                                        pegar VLREQ2-…
                                                        validar → ver nombre
                                                        duración (30/365/custom)
                                                        «Generar y copiar token»
                    ◄────────── WhatsApp ────────────────┘
[Token de licencia VLBA2-…]
(2) «Activar licencia»
════════════════════════════════════════════════════════════════
RESULTADO: LICENCIA ACTIVA · cliente · inicio · vencimiento · días restantes
```

## Formatos (v2, Base32)

Ambos son **un único valor de copiar/pegar**, tolerante a WhatsApp
(la normalización elimina espacios, saltos de línea, tabuladores y guiones;
el alfabeto Base32 RFC 4648 —A-Z/2-7, sin padding— hace los guiones
separadores inequívocos y admite mayúsculas/minúsculas).

### Código de solicitud `VLREQ2-…` (sealed box)

Contenido CIFRADO (solo la app Android del administrador puede abrirlo):

```json
{ "v":2, "product":"ViewLBA-Server", "customerName":"Lo D'Leo",
  "installationId":"VWLB-…", "diskId":"DSK-…",
  "nonce":"…", "requestedAt":1757068800000 }
```

Construcción: JSON canónico → sellado **X25519 efímero → HKDF-SHA256 →
AES-256-GCM** hacia la clave pública del emisor → trama
`"VR2" | 0x02 | ephPub(32) | iv(12) | ctLen(2BE) | ct+tag | CRC32` →
Base32 → grupos de 4 con guiones.

Propiedades: **autenticado** (AEAD), **anti-tampering** (CRC32 + tag GCM),
**anti-replay** (nonce + hash registrado por el emisor), **expirable**
(15 días de validez), **confidencial** (nombre y binding viajan cifrados).

### Token de licencia `VLBA2-…` (firmado)

Contenido FIRMADO con **Ed25519** (la privada vive solo en la app Android):

```json
{ "v":2, "licenseId":"VLBA-ab12cd34ef56", "customerName":"Lo D'Leo",
  "plan":"annual", "durationDays":365, "product":"ViewLBA-Server",
  "issuedAt":…, "startsAt":…, "expiresAt":…,
  "installationId":"VWLB-…", "diskId":"DSK-…",
  "features":{…}, "nonce":"…" }
```

Construcción: JSON canónico (claves ordenadas, sin espacios, fechas epoch
ms) → firma Ed25519 (64 B) → trama `"VT2" | 0x02 | payloadLen(2BE) |
payload | firma | CRC32` → Base32 → guiones.

## Rutas API

| Ruta | Método | Auth | Función |
|---|---|---|---|
| `/api/license` | GET | público/admin | Estado público (watermark/features); admin añade resumen seguro + historial. **Sin Installation/Disk ID.** |
| `/api/license/request-code` | POST | OPERATOR+ | `{customerName}` → `{requestCode}` (se genera la identidad del equipo automáticamente, OCULTA). |
| `/api/license/activate` | POST | ADMIN | `{token}` → validación total → resumen seguro. Rate limit 10/min/IP. |

Las rutas v1 `/api/license/identity` y `/api/license/import` **no existen**
(404).

## Activación (pipeline de 12 pasos — `activateLicenseToken`)

1. **Formato**: prefijo/charset/longitud (200–4096 normalizado).
2. **Trama**: magic/versión/CRC32 (rechazo rápido de truncados/alterados).
3. **Firma Ed25519** sobre los bytes EXACTOS del payload.
4. **Esquema** (zod): v=2, licenseId, plan, durationDays 1–3650, fechas,
   binding, features, nonce.
5. **Producto**: literal `ViewLBA-Server`.
6. **Fechas/duración**: `expiresAt = startsAt + durationDays·día` EXACTO;
   coherencia plan↔duración; `issuedAt` no futuro.
7. **Binding**: installationId + diskId contra el hardware ACTUAL.
8. **Anti-replay**: re-pegado idempotente del mismo token (200
   `alreadyActive`); licenseId repetido con token distinto → rechazo.
9. **Anti-downgrade**: nada que venza antes que la activa.
10. **Guardado**: `LicenseState` (token + payload) + `LicenseHistory`.
11. **Auditoría**: `license_activated` / `license_rejected` (sin secretos) +
    refresco realtime de las TVs.
12. **Respuesta**: resumen seguro (sin datos de binding ni cripto).

Si cualquier paso falla, **no se persiste nada**.

## Estados y mensajes humanos

| Estado | UI (cliente) | Watermark TV |
|---|---|---|
| trial | PRUEBA ACTIVA | VERSIÓN DE PRUEBA · quedan N días |
| active | LICENCIA ACTIVA | (sin marca) |
| expired | LICENCIA VENCIDA | LICENCIA VENCIDA · renueva |
| invalid | LICENCIA NO VÁLIDA | LICENCIA NO VÁLIDA |
| mismatch | LICENCIA NO CORRESPONDE A ESTE EQUIPO | LICENCIA NO CORRESPONDE A ESTE EQUIPO |
| grace | LICENCIA EN GRACIA | (sin marca) |
| unlicensed | SIN LICENCIA | PERÍODO DE PRUEBA FINALIZADO |

Vencimiento y días restantes se calculan con el **reloj efectivo
anti-rollback** (high-water de las anclas de trial, tolerancia 2 h): nunca
se confía en el reloj del frontend.

## Persistencia (servidor)

- `LicenseState` (fila "main"): `token` (VLBA2 normalizado) +
  `payloadJson` + `activatedAt/By`. El token se **revalida** (firma +
  binding) en cada evaluación.
- `LicenseHistory`: una fila por activación (licenseId, cliente, plan,
  durationDays, fechas, binding, `current`).
- Migración `20260912000000_license_v2_token` (recreación — en v1.2.1 se
  rotó la clave con **cero licencias emitidas**, no hay datos que migrar).
- Trial: anclas HMAC fuera de la DB (sin cambios respecto a v1).

## Features

Las features comerciales se resuelven **siempre en el backend**
(`requireLicenseFeature` → 403). La licencia firma el mapa `features`;
durante trial/limitado solo lo básico. La UI muestra candados, pero la
autoridad es el servidor: ni localStorage, ni query params, ni estado de
React desbloquean nada.

## Claves

| Clave | Vive en | Uso |
|---|---|---|
| Ed25519 **privada** | SOLO app Android del admin (+ backup .vlbak cifrado) | Firmar tokens VLBA2 |
| Ed25519 **pública** | Servidor (`public-key.ts` + env override) | Verificar tokens |
| X25519 **privada** | SOLO app Android del admin (+ backup) | Abrir códigos VLREQ2 |
| X25519 **pública** | Servidor (`public-key.ts` + env override) | Sellar códigos VLREQ2 |

Rotación: generar claves nuevas en la app (Ajustes), configurar
`VIEWLBA_LICENSE_PUBLIC_KEY` / `VIEWLBA_REQUEST_PUBLIC_KEY` en el servidor
(o actualizar `public-key.ts`) y reiniciar. Ver `docs/LICENSE-SECURITY.md`.

## Pruebas

- `tests/licensing/` (10 suites, 178 tests): códec, criptografía, canonical,
  solicitud (válida/modificada/expirada/replay/WhatsApp), token
  (válido/modificado/firma/clave/binding/fechas/vacío/truncado/excesivo/
  versión futura), activación (mensual/anual/custom, idempotente,
  duplicado, downgrade, renovación, DB corrupta, rollback), máquina de
  estados.
- `tests/integration/license-api.test.ts` (20 tests) contra servidor real.
- `e2e/license.spec.ts` — flujo §25 completo en UI (copia código → pega
  token → LICENCIA ACTIVA).
- Android (JVM, 57 tests): códec/políticas/backup + **vectores dorados**
  que garantizan compatibilidad byte a byte TS↔Kotlin.
