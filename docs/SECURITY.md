# SECURITY — resumen del endurecimiento (FASE 35 y relacionadas)

> Política de reporte y modelo de amenazas: `SECURITY.md` (raíz).
> Aquí: el inventario técnico de protecciones VERIFICADAS por tests/E2E.

## Autenticación y sesiones

- Sesiones HMAC-SHA256 con `authVersion`: cambiar contraseña/rol/estado **invalida** tokens antiguos al instante (verificado por E2E "sesión invalidada").
- Cookies: `HttpOnly` + `SameSite=Lax` + `Secure` SOLO bajo https (documentado: LAN http por diseño).
- Contraseñas: scrypt + salt por usuario; política ≥10 chars con mayúscula/minúscula/número.
- Login con rate limiting por IP y por cuenta con backoff; respuesta 401 genérica (no revela existencia de emails).
- El seed de producción NUNCA crea credenciales conocidas (`admin123` solo existe con `--with-demo-users` en desarrollo).

## Autorización

- TODAS las rutas `/api/admin/*` verifican rol por ruta (VIEWER lectura · OPERATOR escritura · ADMIN usuarios/tokens/backup/rotación). Matriz verificada por tests de integración.
- El backend no confía en ocultar botones del frontend.

## Superficie pública (por diseño, LAN)

| Endpoint | Qué expone |
|---|---|
| `/api/content` | Bundle público de las TVs (SIN streamKey) — ETag, sin datos privados |
| `/api/stream/status` | `{source, serverOk, live}` — mínimo (sin viewers/IPs) |
| `/api/health` | Estado de componentes, sin secretos |
| `/api/stream/live.flv` | El stream via proxy server-side (la clave NUNCA llega al navegador) — same-origin, sin CORS |
| `/api/files/*` | Medios subidos con guard anti path-traversal + nosniff + SVG como attachment |

## Realtime y pantallas

- Socket.IO con CORS restringido a orígenes LAN (sin `*`).
- Admins: cookie de sesión verificada (con authVersion) en el handshake.
- Pantallas: token de pairing (sha256 en DB) — `screenCode` nunca es el secreto; regenerar invalida el anterior (ver `docs/SCREEN_PAIRING.md`).
- Comandos remotos con payload validado por esquema (canal cerrado).

## Uploads y ficheros

- Extensión permitida + **magic bytes reales** + límites por tipo + cuota global + nombres generados por servidor + path-traversal bloqueado + SVG deshabilitado por defecto (`ALLOW_SVG` documentado).

## Red y cabeceras (FASE 35)

- CSP prudente (connect-src ws: para el realtime cross-puerto; media-src blob: para MSE; sin HSTS porque la LAN documentada es http).
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, `Permissions-Policy`.
- APIs privadas jamás cacheables (middleware de solo-headers sobre `/api/admin/*`, `/api/auth/*`, `/api/upload`).
- SSRF guard en `/api/admin/stream-test` (localhost/RFC1918/link-local/metadata bloqueados; solo hosts autorizados explícitos).

## Secretos

- Validación Zod al arranque (fail-fast en producción; placeholders conocidos rechazados).
- `.env` con permisos 600; gitleaks BLOQUEANTE en CI (0 secretos reales; allowlist solo fixtures de tests).
- Nada de secretos en logs: `redact()` del logger (passwords/tokens/JWT/cookies truncados).

## Dependencias

- `bun audit --audit-level=critical` bloqueante en CI (0 críticos de runtime).
- Dependencias saneadas: solo cadenas dev/CLI fuera del binario standalone.
