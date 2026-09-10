# ViewLBA — Sistema de Licencias (offline)

> Sistema de licenciamiento **100% offline** para ViewLBA. La licencia se vincula a
> una instalación concreta (hardware + disco) mediante criptografía asimétrica
> Ed25519. **Ninguna validación requiere Internet**: la única operación externa es
> la entrega manual del archivo ZIP al cliente.

- Autor del diseño: ViewLBA (Leandro Bueno)
- Contacto comercial: **52973387**
- Planes: **TRIAL** 7 días · **MENSUAL** USD 10 / 30 días · **ANUAL** USD 100 / 365 días
- Documentos relacionados: [LICENSE-GENERATOR.md](LICENSE-GENERATOR.md) · [LICENSE-SECURITY.md](LICENSE-SECURITY.md) · [BACKUP_RESTORE.md](BACKUP_RESTORE.md)

---

## 1. Arquitectura

```
┌──────────────────────────── EMISOR (fuera del producto) ─────────────────────────────┐
│  ViewLBA License Generator (tools/license-generator · demo web · GitHub Actions)     │
│  · Posee la CLAVE PRIVADA Ed25519 (nunca en repo/app/bundle/instalador)              │
│  · Firma el payload canónico y empaqueta license.json + README.txt en ZIP            │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │  entrega manual (correo/USB)
┌──────────────────────────────────────▼───────────────────────────────────────────────┐
│  PRODUCTO ViewLBA (servidor del restaurante, LAN)                                     │
│  · CLAVE PÚBLICA incrustada (src/lib/licensing/public-key.ts)                         │
│  · src/lib/licensing/*  — verificación, identidad, trial, features                    │
│  · El SERVIDOR es la autoridad local; la TV y el panel solo consumen su estado        │
│  · SQLite (Prisma): LicenseState + LicenseHistory                                     │
│  · Anclas de trial FUERA de la DB: <DATA_DIR>/licensing/state.json + ~/.viewlba-      │
│    license.json (con sello HMAC)                                                     │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Módulos (`src/lib/licensing/`)

| Archivo | Responsabilidad |
|---|---|
| `types.ts` | Tipos, constantes (planes, contacto, duraciones) y vocabulario de auditoría |
| `canonical.ts` | `canonicalizeLicensePayload()` — forma canónica determinista (claves ordenadas recursivamente) de TODO el payload excepto `signature` |
| `crypto.ts` | Ed25519 con `node:crypto` (cero dependencias): `signLicense()`, `verifyLicenseSignature()`, `generateLicenseKeyPair()`, `resolveVerifierPublicKey()` |
| `public-key.ts` | Clave **pública** de producción (única pieza criptográfica del producto) |
| `fingerprint.ts` | Fingerprint de hardware → `INSTALLATION_ID` (`VWLB-XXXX-XXXX-XXXX-XXXX`) |
| `disk-binding.ts` | Binding al disco → `DISK_ID` (`DSK-XXXX-XXXX-XXXX`) + normalización de rutas |
| `storage.ts` | Anclas de trial (2 ubicaciones + HMAC), high-water anti-rollback, almacén Prisma |
| `trial.ts` | Lógica pura del trial de 7 días + detección de retroceso de reloj |
| `validator.ts` | `validateLicense()` — firma → esquema → fechas → binding (orden crítico) |
| `features.ts` | Feature flags reales del producto + textos del watermark |
| `zip.ts` | ZIP mínimo (STORE/DEFLATE) con verificación CRC32 |
| `audit.ts` | Eventos de auditoría (usa la infraestructura `logAction` existente) |
| `guard.ts` | `requireLicenseFeature()` — 403 en rutas admin para features premium |
| `index.ts` | Fachada: `getInstallationIdentity()`, `getLicenseSystemState()`, `importLicenseZip()`, … |

## 2. Formato de licencia

`license.json` (dentro del ZIP entregado al cliente):

```json
{
  "schemaVersion": 1,
  "licenseId": "VLBA-1a2b3c4d5e6f",
  "customerName": "Leandro Bueno",
  "plan": "monthly",
  "issuedAt": "2026-09-10T00:00:00.000Z",
  "startsAt": "2026-09-10T00:00:00.000Z",
  "expiresAt": "2026-10-10T00:00:00.000Z",
  "deviceId": "VWLB-8F2A-91CD-2D31-77AA",
  "diskId": "DSK-A5ED-432A-37DD",
  "installPath": "C:/PantallaRestaurante",
  "product": "ViewLBA-Server",
  "features": { "users.management": true, "screens.multiDisplay": true },
  "signature": "<base64url de 64 bytes — Ed25519 sobre el payload canónico>"
}
```

- **La firma cubre TODO el payload excepto `signature`** en su forma canónica
  (claves ordenadas recursivamente, sin espacios). Cambiar 1 byte rompe la firma.
- `deviceId` y `diskId` son los **bindings estrictos**; `installPath` es
  informativo (solo advertencia si difiere).
- El ZIP contiene `license.json` + `README.txt` (instrucciones, plan, fechas,
  Installation ID, contacto 52973387).

## 3. Identidad de la instalación

**INSTALLATION_ID** (`VWLB-XXXX-XXXX-XXXX-XXXX`): prefijo de 8 bytes del
SHA-256 del fingerprint de hardware. Estable ante cambios de hostname/IP/MAC.

| SO | Señal primaria | Fallback (composite) |
|---|---|---|
| Linux | `/etc/machine-id` (o `/var/lib/dbus/machine-id`) | CPU + RAM + hostname + MAC |
| Windows | `MachineGuid` del registro | CPU + RAM + hostname + MAC |
| macOS | `IOPlatformUUID` | CPU + RAM + hostname + MAC |

**DISK_ID** (`DSK-XXXX-XXXX-XXXX`): prefijo de 6 bytes del SHA-256 del binding
del disco **donde reside la instalación** (no la ruta):

| SO | Señal |
|---|---|
| Linux | UUID del filesystem (`findmnt`/`lsblk`/`/dev/disk/by-uuid`) + dispositivo + fstype |
| Windows | Número de serie del **volumen** (`vol C:`) |
| macOS | Volume UUID (`diskutil`) |

La UI muestra solo los IDs cortos y la etiqueta amigable del disco ("C:");
**nunca** hashes completos ni seriales crudos. El cliente copia el
"bloque de solicitud" desde `Administración → Licencia` y lo envía al proveedor.

## 4. Estados

| Estado | Significado | TV (watermark) | Panel admin |
|---|---|---|---|
| `trial` | Prueba de 7 días activa | "VERSIÓN DE PRUEBA · ViewLBA · Quedan X días · 52973387" | Banner ámbar + premium bloqueado |
| `active` | Licencia válida y vigente | Sin marca | Todo habilitado |
| `grace` | Vencida dentro de `LICENSE_GRACE_HOURS` (default 0 = off) | Sin marca | Todo habilitado + aviso |
| `expired` | Licencia comercial vencida | "LICENCIA VENCIDA · 52973387" | Modo limitado |
| `invalid` | Firma/esquema/producto inválidos | "LICENCIA NO VÁLIDA · 52973387" | Modo limitado |
| `mismatch` | Equipo/disco no coincide (sección 19) | "LICENCIA VINCULADA A OTRA INSTALACIÓN · 52973387" | Detalle Installation/Disk ID actual vs licencia |
| `unlicensed` | Trial agotado sin licencia (sección 14) | "PERÍODO DE PRUEBA FINALIZADO · 52973387" | Modo limitado + importación disponible |

**Modo limitado** (nunca destructivo): la pantalla TV básica sigue funcionando,
la administración esencial (contenido, transmisión, audio, ticker) sigue
disponible y `health` responde. Se bloquean las funciones premium (sección 5).

## 5. Feature flags (funciones REALES del producto)

| Flag | Sección/función real | Trial | Mensual/Anual |
|---|---|---|---|
| `screens.multiDisplay` | Pantallas — 2ª pantalla en adelante (la 1ª funciona en trial) | ✗ | ✓ |
| `branding.customLogo` | Logotipo | ✗ | ✓ |
| `themes.custom` | Apariencia (colores/temas) | ✗ | ✓ |
| `users.management` | Usuarios (crear/editar otros; la propia cuenta siempre editable) | ✗ | ✓ |
| `backup.selfService` | Botón "Copia de seguridad" del Dashboard | ✗ | ✓ |
| `analytics.advanced` | Métricas avanzadas del Dashboard | ✗ | ✓ |
| `display.watermark` | Marca de agua en TV | ✓ | ✗ |

Aplicación en **dos capas**:
1. **UI** — `AdminApp` bloquea las secciones premium (candado en el menú +
   panel "Requiere licencia comercial") y `Dashboard` oculta el botón de backup.
2. **Backend** — `requireLicenseFeature()` devuelve **403** en
   `POST /api/admin/users`, `PUT/DELETE /api/admin/users/[id]` (otros usuarios),
   `POST /api/admin/screens` (a partir de la 2ª pantalla),
   `POST /api/admin/backup` y `PUT /api/admin/settings` (campos premium de
   branding/apariencia). El propio admin puede cambiar SIEMPRE su contraseña.

La lista de features de la licencia (`features: {...}`) puede afinar flags por
licencia (arquitectura preparada para planes futuros — p. ej. multi-sucursal).

## 6. Trial de 7 días

- **Arranque único**: la primera evaluación sin licencia comercial escribe
  `trialStartAt` en **dos anclas** (DATA_DIR + `~/.viewlba-license.json`).
  Borrar una no reinicia el trial (fusión *earliest-start*). Un restore/reinstalación
  superficial de la app tampoco (el ancla del home sobrevive).
- **Anti-rollback de reloj**: cada evaluación actualiza `lastSeenAt`
  (high-water). Si `now < lastSeenAt − 2h` → `clockTampered` (sticky) y la
  evaluación se **congela** al último instante visto: volver el reloj atrás no
  alarga el trial ni revive una licencia vencida.
- **Anclas con sello HMAC** (`deviceIdHash + AUTH_SECRET`): la edición manual
  del JSON se detecta (`integrityWarnings`) y **no otorga un trial nuevo**.
- Con licencia importada el trial no arranca; si la licencia se vence, no hay
  "segundo trial" (el estado pasa a `expired`).
- El trial NO es un DRM militar: ver límites en [LICENSE-SECURITY.md](LICENSE-SECURITY.md).

## 7. Importación de licencia

`Administración → Licencia → IMPORTAR LICENCIA` (solo ADMIN, acepta `.zip` ≤ 1 MB):

1. Lee el ZIP (CRC32 verificado por entrada) y extrae `license.json`.
2. **Validación TOTAL** en orden: firma Ed25519 sobre el payload exacto →
   esquema zod → producto → fechas → **Installation ID vs equipo actual** →
   **Disk ID vs disco actual** → features.
3. Regla **anti-downgrade**: no se guarda una licencia que venza antes que la
   activa actual.
4. **Solo si TODO pasa** se persiste en `LicenseState` (DB) + `LicenseHistory`
   y se emite `license_imported` + refresco realtime de las TVs (el watermark
   desaparece en segundos; el ETag de `/api/content` se invalida).
5. Si algo falla: **422** con motivos legibles, nada se guarda, y se audita
   `license_rejected`.

### Renovaciones
Cada renovación es una **licencia nueva firmada** (nunca se modifica la
anterior). El historial (`LicenseHistory`) conserva todas con su vigencia
(`LIC-… 2026-09-10 → 2026-10-10`) y marca la actual.

## 8. API interna (sección 21)

| Endpoint | Auth | Respuesta |
|---|---|---|
| `GET /api/license` | pública (TV/watchdog) | `{status, plan, daysLeft, watermark:{visible,lines}, features, clockTampered}` — **sin datos de cliente ni IDs de binding**. Con sesión ADMIN/OPERATOR se enriquece con licencia completa, identidad, motivos e historial. Cache 3 s (invalidado al importar). |
| `GET /api/license/identity` | OPERATOR+ | `{installationId, diskId, diskLabel, installPath, requestBlock, bindingStrength}` |
| `POST /api/license/import` | ADMIN (multipart `file`) | `200 {ok, message, summary}` · `422 {ok:false, reasons}` |

La TV obtiene el estado desde el backend LAN: el bundle público
`GET /api/content` incluye `license: {status, watermark, watermarkLines}`
(integrado al ETag para refrescar cuando cambia) — **la TV nunca valida nada por su cuenta**.

## 9. Auditoría (sección 22)

Eventos (vocabulario del requisito, sección "license" de la tabla `Log`):
`license_imported` · `license_rejected` · `license_expired` ·
`license_mismatch` · `trial_started` · `trial_expired` ·
`clock_tampering_detected`. Nunca contienen secretos (`redact()` del logger +
sin firmas/claves). Las transiciones se registran una sola vez (ancla
`lastLoggedStatus`).

## 10. Backup / restore (sección 20)

- `LicenseState` y `LicenseHistory` forman parte de los backups verificados
  (`TRACKED_TABLES` de `src/lib/backup.ts`).
- **El binding se recalcula SIEMPRE contra el hardware/disco actual**: restaurar
  la DB de otra instalación produce `MISMATCH` (no una licencia clonada).
- El **trial vive en anclas fuera de la DB** → un restore de una DB vieja no
  resetea el trial.
- Tras `bun scripts/restore.ts --file … --confirm` se recomienda reiniciar la
  app; la licencia se revalida automáticamente en la siguiente evaluación.

## 11. Entorno

| Variable | Default | Nota |
|---|---|---|
| `VIEWLBA_LICENSE_PUBLIC_KEY` | clave de producción incrustada | Solo para tests/rotación. **NUNCA una clave privada.** |
| `LICENSE_GRACE_HOURS` | `0` (off) | Ventana de gracia tras vencimiento |
| `DATA_DIR` | `<cwd>/data` | Ubicación de la ancla de trial nº 1 |
| `VIEWLBA_TEST_DEVICE_FINGERPRINT` / `VIEWLBA_TEST_DISK_ID_HASH` / `VIEWLBA_TEST_INSTALL_PATH` | — | **Overrides de test: SOLO con `NODE_ENV != production`.** |

## 12. Tests

- **Unitarios** (`tests/licensing/`): canonicalización, firma/verificación,
  matriz de seguridad A–L (byte modificado, cliente/expiry/installationId/diskId
  cambiados, otra clave, expiración), ZIP (roundtrip + CRC + DEFLATE + unzip del
  SO), fingerprint/disk, trial (7 días, día 8, rollback, borrado de anclas,
  reinstalación superficial, anclas ajenas, edición manual), features,
  importación (rechazos/renovación/downgrade), máquina de estados
  (trial→active→expired→mismatch), restore a otro disco.
- **Integración** (`tests/integration/license-api.test.ts`): servidor real
  aislado (puerto 3300): watermark público, gating 403, identidad 401/200,
  importación válida/manipulada/mismatch, renovación, auditoría sin secretos.
- **E2E** (`e2e/license.spec.ts`): flujo completo del administrador (sección 34)
  contra el stack real, incluida la subida del ZIP por la UI.
