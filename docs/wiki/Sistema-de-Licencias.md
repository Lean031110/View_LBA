# Sistema de Licencias — Arquitectura

ViewLBA usa un sistema de licenciamiento **100% offline** basado en criptografía asimétrica **Ed25519**. La app del cliente **solo verifica** (jamás firma); el emisor (dueño del negocio) **firma** cada licencia con la clave privada. No hay llamadas de red en ninguna parte del ciclo de vida de la licencia: ni phone-home, ni activación online, ni verificación contra servidores externos.

## Principios de diseño

1. **Clave privada solo en el emisor.** La clave privada de firma existe únicamente en el generador de licencias (CLI, demo web protegida o GitHub Actions via secret). El producto (frontend, TV, bundle, instaladores, repositorio) contiene **únicamente la clave pública** incrustada en `src/lib/licensing/public-key.ts`.
2. **Binding mínimo y robusto**: cada licencia se vincula a una instalación concreta — Installation ID (equipo) + Disk ID (disco de instalación). La ruta de instalación se registra pero no es binding estricto.
3. **Firma sobre payload canónico**: la firma Ed25519 cubre TODO el payload excepto el campo `signature`, con claves ordenadas recursivamente (`src/lib/licensing/canonical.ts`). Cambiar 1 byte de cualquier campo (cliente, fechas, IDs, plan, features) invalida la firma.
4. **Verificación offline**: `validateLicense()` no hace ninguna llamada de red. La única operación "externa" del ciclo es la entrega manual del ZIP al cliente.

## Flujo end-to-end

```
┌─────────────┐   solicitud (Installation ID + Disk ID)    ┌──────────────────┐
│  CLIENTE    │ ─────────────────────────────────────────▶ │  EMISOR (dueño)  │
│ (instalación)│                                            │                  │
│             │ ◀──────────── ZIP con licencia ──────────── │ firma Ed25519    │
│ importa ZIP │            license.json + README.txt        │ (clave PRIVADA)  │
└─────────────┘                                            └──────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ APP DEL CLIENTE (verificación 100% offline)                          │
│  1. firma Ed25519 (clave pública incrustada)                         │
│  2. esquema + producto (ViewLBA-Server)                              │
│  3. fechas (startsAt ≤ hoy < expiresAt)                              │
│  4. Installation ID == hardware actual                               │
│  5. Disk ID == disco actual                                          │
│  6. anti-downgrade (no acortar vigencia activa)                      │
└─────────────────────────────────────────────────────────────────────┘
```

El cliente solicita la licencia desde **Administración → Licencia**, donde la app muestra un bloque listo para copiar y enviar (nombre, Installation ID, Disk ID, ruta). El emisor genera el ZIP y se lo devuelve por cualquier canal (email, WhatsApp…). El cliente lo importa en la misma pantalla. Todo lo demás es automático.

## Los 7 estados (`LicenseStatus`)

| Estado | Significado | Qué ve el usuario |
|---|---|---|
| `trial` | Prueba de 7 días activa (sin licencia comercial) | App funcional con marca de agua en la TV + banner en el panel |
| `active` | Licencia válida, vigente y con binding correcto | Todo desbloqueado, sin marca de agua |
| `expired` | Licencia comercial vencida | Marca de agua "LICENCIA VENCIDA", features premium bloqueados |
| `grace` | Vencida dentro de la ventana de gracia (`LICENSE_GRACE_HOURS`) | Igual que activa, con aviso de renovación |
| `invalid` | Firma/estructura/producto inválidos | Rechazo en importación + motivo exacto |
| `mismatch` | Licencia vinculada a otro equipo/disco | Rechazo con detalle (expected vs found) |
| `unlicensed` | Sin licencia y trial agotado | Marca de agua de finalización, features bloqueados |

## Componentes del código

| Módulo (`src/lib/licensing/`) | Responsabilidad |
|---|---|
| `types.ts` | Contratos + constantes (planes, duraciones, teléfono de contacto) |
| `canonical.ts` | Forma canónica del payload (lo que se firma) |
| `crypto.ts` | Ed25519: generación de par, firma, verificación (node:crypto) |
| `public-key.ts` | **Clave pública de PRODUCCIÓN incrustada** (única clave del producto) |
| `fingerprint.ts` | Hardware → `deviceIdHash` → Installation ID público |
| `disk-binding.ts` | Disco → `diskIdHash` → Disk ID público |
| `trial.ts` | Lógica del trial de 7 días |
| `storage.ts` | Anclas duales de trial + persistencia en DB |
| `validator.ts` | Máquina de validación completa (la matriz de seguridad A–H) |
| `features.ts` | Feature gating según estado (watermark, candados) |
| `index.ts` | Orquestación del ciclo de vida (`getLicenseState()`) |
| `zip.ts` | Empaquetado/desempaquetado seguro del ZIP (límites anti zip-bomb) |
| `audit.ts` | Eventos de auditoría (vocabulario fijo) |
| `guard.ts` | Guard de sesión para rutas de licencia |

La API interna expuesta por el servidor: `GET /api/license` (público, sin secretos — solo estado/watermark/features), `GET /api/license/identity` (requiere sesión OPERATOR+), `POST /api/license/import` (requiere sesión ADMIN). Ver [Importación-de-Licencia](Importación-de-Licencia.md).

## Test suite

- **136 tests unitarios** de licensing (`tests/licensing/`) incluida la **matriz de seguridad A–H** (modificar 1 byte → FAIL, re-firmar con otra clave → FAIL, vencida → EXPIRED, IDs de otro equipo → MISMATCH, planes de 30/365 días exactos).
- **14 tests de integración** contra servidor real aislado (`tests/integration/`).
- **6 tests E2E** del flujo completo del administrador (Playwright).
- gitleaks en CI bloquea cualquier fuga de secretos en el historial.

Siguiente: [Claves-Ed25519](Claves-Ed25519.md) — cómo se generan las claves.
