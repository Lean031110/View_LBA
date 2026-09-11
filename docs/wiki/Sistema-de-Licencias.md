# Sistema de Licencias v2 (token copiar/pegar)

> El flujo v1 (ZIP + license.json + IDs a mano) fue **eliminado** en v2.0.0.
> Esta página describe el único flujo soportado. Detalle técnico completo:
> [`docs/LICENSE-SYSTEM.md`](https://github.com/Lean031110/Pantalla_Restaurante/blob/main/docs/LICENSE-SYSTEM.md).

## El flujo en una imagen

```
CLIENTE (Administración → Licencia)           ADMINISTRADOR (app Android)
──────────────────────────────────           ────────────────────────────
Escribe el nombre del negocio
«Copiar código de solicitud»      ── WhatsApp ──►  Nueva licencia
  (el código VLREQ2-… lleva la        pegar código → validar → ver nombre
   identidad del equipo OCULTA         elegir duración (30/365/custom)
   y CIFRADA dentro)                   «Generar y copiar token»
                     ◄────── WhatsApp ──────┘
Pega el token VLBA2-…
«Activar licencia»
══► LICENCIA ACTIVA · cliente · vence DD/MM/YYYY · Restan X días
```

Tres pasos por lado, cero archivos, cero JSON, cero IDs técnicos visibles.

## Qué ve el cliente (y qué NO)

| Ve | NO ve |
|---|---|
| Estado actual (humano) | Installation ID |
| «Copiar código de solicitud» | Disk ID |
| Campo «Token de licencia» + «Activar licencia» | Hashes / firmas |
| Cliente, inicio, vencimiento, días restantes | JSON / ZIP / criptografía |

## Formatos

- **`VLREQ2-XXXX-…`** — código de solicitud: sealed box
  (X25519→HKDF→AES-256-GCM) con customerName + binding cifrados; nonce;
  expira a los 15 días; Base32 con guiones (tolerante a WhatsApp).
- **`VLBA2-XXXX-…`** — token de licencia: payload JSON canónico firmado
  Ed25519 (licenseId, cliente, plan, duración EXACTA, fechas, binding,
  features, nonce) + CRC32; Base32.

## Estados

`trial` → PRUEBA ACTIVA · `active` → LICENCIA ACTIVA · `expired` →
LICENCIA VENCIDA · `invalid` → LICENCIA NO VÁLIDA · `mismatch` →
LICENCIA NO CORRESPONDE A ESTE EQUIPO · `grace` · `unlicensed`.

El vencimiento y los días restantes usan el **reloj efectivo
anti-rollback** (nunca el reloj del frontend).

## Rutas API

- `GET /api/license` — estado público (TV) + resumen seguro (admin, SIN
  datos de binding).
- `POST /api/license/request-code` — `{customerName}` → código VLREQ2
  (identidad generada automáticamente y oculta).
- `POST /api/license/activate` — `{token}` → pipeline de 12 pasos →
  resumen seguro. Si algo falla, no se persiste nada.

Las rutas v1 (`identity`, `import`) devuelven **404**.
