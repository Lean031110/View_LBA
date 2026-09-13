# Seguridad del Sistema de Licencias v2

## Modelo de amenaza

El objetivo NO es un DRM militar: es un sistema **honesto y auditable** que
(f)acilita el cobro de licencias a restaurantes, resistiendo manipulación
casual y clonación de instalación, con verificación **offline** y sin
dependencia de un servidor de licencias en Internet.

| Amenaza | Defensa |
|---|---|
| Cliente edita el token para extender la vigencia | Firma Ed25519 sobre los bytes EXACTOS + CRC32 estructural |
| Token de otro cliente/equipo | Binding installationId+diskId recalculado contra el hardware en CADA evaluación |
| Clonación de DB a otra máquina/disco | Binding → MISMATCH (la licencia no viaja) |
| Reuso de un código de solicitud (replay) | Nonce + hash registrado por el emisor; re-emisión solo por «Renovar» |
| Renovación que acorta la activa (downgrade) | Rechazo salvo acción administrativa explícita |
| Retroceso del reloj para revivir licencia/trial | Reloj efectivo high-water + `clockTampered` sticky (tolerancia 2 h) |
| Token truncado/alterado/excesivo/futuro | Validación estructural estricta antes de criptografía |
| Extracción de la clave privada del servidor | **No hay clave privada en el servidor** (solo públicas) |
| Extracción de claves del generador Android | SQLCipher + PIN (PBKDF2 150k + AES-256-GCM; v3.2: envoltura simple portable, sin Keystore) |
| Secretos en el repo/historial/CI | gitleaks + greps anti-clave + análisis del artifact APK |

## Regla de oro de las claves

```
Servidor ViewLBA  = claves PÚBLICAS (Ed25519 verificación + X25519 sellado)
App Android admin = claves PRIVADAS (Ed25519 firma + X25519 apertura)
```

La privada **nunca** está en: el repo, el bundle del servidor, el
instalador, la TV, logs, artifacts públicos, BuildConfig, assets o strings.
Vive cifrada (SQLCipher) en el teléfono del administrador, protegida por
el **PIN del administrador** (PBKDF2-HMAC-SHA256, 150 000 iteraciones +
AES-256-GCM). El único canal de salida es el **backup .vlbak**
(AES-256-GCM con contraseña del administrador + SHA-256 externo).

> **Nota v3.2**: hasta la v3.1 la master key llevaba una envoltura
> adicional por Android Keystore ligada a biometría. Se retiró por decisión
> de producto (el usuario pidió «solo un PIN simple, sin datos
> biométricos») y porque en dispositivos reales con biometría inscrita el
> primer uso quedaba atascado (`UserNotAuthenticatedException` al cifrar
> sin un BiometricPrompt visible). El cifrado en reposo (SQLCipher) y la
> envoltura por PIN se conservan íntegros; los vaults ≤3.1 siguen
> desbloqueándose con su PIN y migran al formato nuevo al cambiarlo.

## Sellado de solicitudes (VLREQ2)

- ECDH X25519 efímero → HKDF-SHA256 (salt = punto efímero,
  info = `viewlba-req-v2`) → AES-256-GCM.
- Confidencialidad: customerName + binding viajan cifrados (no aparecen en
  claro en el código que circula por WhatsApp).
- Integridad: tag GCM + CRC32 estructural.
- Expiración: 15 días desde `requestedAt`.
- El servidor **no puede** abrir sus propios códigos (solo sella); solo el
  emisor puede abrirlos. Un emisor incorrecto → "no se puede abrir".

## Firma de tokens (VLBA2)

- Ed25519 sobre el payload JSON **canónico exacto** (claves ordenadas
  recursivo, sin espacios, enteros epoch ms) — la misma serialización en
  TypeScript y Kotlin (vectores dorados en CI).
- Auto-verificación de ida y vuelta en el emisor tras firmar.
- En el servidor: trama (magic/versión/CRC32) → firma → zod → producto →
  fechas exactas → binding → replay → downgrade. **Todo antes de persistir.**

## Ataques específicos y su respuesta

- **Token duplicado**: mismo token re-pegado → idempotente
  (`alreadyActive`); mismo licenseId con token distinto → rechazo.
- **Licencia futura**: rechazada en activación ("comienza el DD/MM/AAAA").
- **Licencia vencida**: rechazada en activación; en evaluación → expired
  (con gracia opcional por `LICENSE_GRACE_HOURS`, default 0).
- **Versión futura de token/código** (0x03+): rechazo explícito
  `bad_version` — nunca "intenta decodificar igual".
- **Rate limit**: 10 activaciones/minuto/IP por proceso (además del auth
  ADMIN).

## Auditoría

Eventos persistidos en la tabla `Log` (redact() del logger — jamás
secretos): `license_activated`, `license_rejected`, `license_expired`,
`license_mismatch`, `trial_started`, `trial_expired`,
`clock_tampering_detected`. El generador Android registra además su propia
auditoría en la DB cifrada (`license_issued`, `license_renewed`,
`keys_imported`, `keys_generated`, `backup_created`, `backup_restored`).

## Límites conocidos (documentados, aceptados)

- Un atacante con **root** en el servidor del cliente puede alterar el
  binario o falsificar `/api/license` para la propia LAN — fuera de alcance
  (el objetivo es el anti-copia casual, no el anti-reversing).
- El trial usa anclas HMAC de archivo: resistentes a borrado casual, no a
  manipulación con conocimiento del `AUTH_SECRET`.
- La biometría del generador descansa en el Keystore del dispositivo; un
  bootloader desbloqueado + ataque dirigido puede extraer el material —
  mitigado con StrongBox cuando existe y con backups cifrados.

## Pruebas de seguridad en CI

- `gitleaks` sobre todo el historial (allowlist SOLO de fixtures DUMMY de
  tests: `e2e/fixtures/licensing/`).
- `bun audit --audit-level=critical` (bloqueante).
- Grep anti-material-de-claves en fuentes del generador Android.
- Análisis del artifact APK (strings del classes.dex) en busca de
  patrones de claves privadas.
- Los secrets de firma del APK nunca se imprimen; el keystore se descarta
  tras firmar.
