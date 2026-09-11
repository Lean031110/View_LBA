# Importación de Licencia (flujo del cliente)

El cliente recibe del proveedor un ZIP (`ViewLBA-License-<Cliente>-<AAAAMMDD>.zip`) con `license.json` + `README.txt`, y lo importa desde el panel: **Administración → Licencia → IMPORTAR LICENCIA**.

## Pipeline de validación (orden exacto)

`POST /api/license/import` (requiere sesión **ADMIN** — rate-limit del login aplica) ejecuta, en orden:

1. **Estructura del ZIP** — límites anti zip-bomb: máximo 1 MB de subida, ≤ 100 entradas, ≤ 10 MB por entrada, CRC obligatorio, debe contener `license.json`.
2. **Firma Ed25519** — contra la clave pública incrustada (`VIEWLBA_LICENSE_PUBLIC_KEY` env solo para tests/E2E). Cualquier byte alterado → `invalid`.
3. **Esquema (`schemaVersion`)** — versiones futuras se rechazan.
4. **Producto** — debe ser `ViewLBA-Server` (una licencia de otro producto no pasa).
5. **Fechas** — `startsAt ≤ ahora < expiresAt` (licencia futura → `invalid` con motivo; vencida → rechazo como importación útil).
6. **Binding de equipo** — `deviceId` vs Installation ID actual.
7. **Binding de disco** — `diskId` vs Disk ID actual.
8. **Anti-downgrade** — se rechaza una licencia que **acorte** la vigencia de la actual activa (no se puede "importar hacia atrás").

Solo si TODO pasa: se guarda en la tabla `LicenseState` (fila única `main`), se añade al historial (`LicenseHistory`), se registra el evento de auditoría `license_imported` y la marca de agua de la TV desaparece (el ETag de `/api/content` se invalida para refrescarla al instante).

## Códigos de estado de la importación

| Resultado | Estado | El cliente ve |
|---|---|---|
| ✅ Válida, vigente, binding correcto | `active` | `✓ Licencia válida · Equipo vinculado · Disco vinculado` + días restantes |
| Vencida | `expired` | Motivo exacto + "Renueva tu licencia: 52973387" |
| ZIP corrupto / sin license.json / JSON inválido | rechazo | Error claro de estructura (nunca crashea) |
| Firma inválida (editada o re-firmada con otra clave) | `invalid` | "El archivo fue modificado o emitido con otra clave" |
| Producto o esquema incorrecto | `invalid` | Motivo correspondiente |
| De otro equipo/disco | `mismatch` | Detalle con expected/found (solo admin) + instrucción de solicitar licencia para ESTA instalación |
| Vence antes que la activa actual | rechazo | Anti-downgrade: usa renovación |

## Renovación y coexistencia

- La renovación se hace en el **emisor** (`renew` del CLI o re-emisión por Actions — ver [[Emisión-de-Licencias]]): produce una licencia NUEVA con el mismo binding. El cliente la importa igual; la anterior queda en `LicenseHistory` (`current: false`).
- El importador compara la vigencia para no aceptar downgrades accidentales (p. ej. importar un mensual cuando corre un anual).

## APIs internas (sección 21 del diseño)

| Endpoint | Permiso | Devuelve |
|---|---|---|
| `GET /api/license` | público | Estado/watermark/features — **sin** datos de cliente ni IDs (secreto cero) |
| `GET /api/license` (con sesión admin) | ADMIN | Igual + metadatos seguros de la licencia (post-firma-válida) |
| `GET /api/license/identity` | OPERATOR+ | Installation ID, Disk ID, ruta, labels (para el bloque de solicitud; sin hashes completos) |
| `POST /api/license/import` | ADMIN | Resultado + motivos legibles |

## Auditoría (sección 22)

Eventos registrados en tabla `Log` + logger JSON (stdout/archivo rotativo) con `redact()`: `license_imported`, `license_rejected`, `license_expired`, `license_mismatch`, `trial_started`, `trial_expired`, `clock_tampering_detected`. Las respuestas de la API **nunca** incluyen firmas completas ni hashes de binding completos.

## Backup/restore consciente de licencias

Las tablas de licencias van incluidas en el backup verificado del sistema, pero tras un restore el binding se **recalcula siempre** contra el hardware actual → restaurar en otro equipo/disco da `mismatch` (deseado: la licencia no "viaja" con los backups).

Siguiente: [[Seguridad]].
