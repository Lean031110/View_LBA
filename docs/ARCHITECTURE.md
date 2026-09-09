# ARQUITECTURA — ViewLBA (señalización digital para restaurante)

> Visión completa del sistema: flujos, servicios, puertos, datos y capas de
> seguridad. Detalles operativos: `docs/OPERATIONS.md` (Linux) y
> `docs/WINDOWS_PRODUCTION.md`. Estado de verificación de cada pieza:
> `PRODUCTION_PLAN.md`.

## Flujos principales (VERIFIED — E2E 37/37)

### 1. Streaming en vivo (OBS → TVs)

```
OBS Studio (PC de la LAN)
   │ RTMP con CLAVE (validada por prePublish)
   ▼
stream-service (mini-service, Node Media Server v4)
   │ RTMP :1935  ·  HTTP-FLV :8000 (solo localhost)  ·  control :8100
   ▼
PROXY server-side  /api/stream/live.flv  (app Next.js :3000)
   │ añade la clave server-side: NUNCA llega al navegador de la TV
   ▼
Navegador de la TV → mpegts.js (MSE) reproduce el FLV mismo-origen
```

- Sin publicador → fallback configurable (mensaje/imagen/vídeo) con reconexión automática (5/10/15 s).
- Caída del publisher → `live=false` tras la gracia de NMS (~33 s, ventana de reconexión de OBS); recuperación al reconectar (VERIFIED: `tests/stream-pipeline.test.ts`).
- Caída del stream-service → systemd/NSSM lo reinicia; OBS reconecta solo (VERIFIED: `tests/recovery.test.ts`).
- Watchdog de inactividad del proxy: 15 s sin bytes → corta → el player reintenta.

### 2. Contenido y control (Admin → TVs)

```
Panel admin (/?view=admin, PC/tableta LAN)
   │ HTTP API (/api/admin/*) con cookie de sesión (HMAC + authVersion)
   ▼
App Next.js (:3000) ── POST /broadcast (token interno) ──▶ realtime-service (:3004 interno)
                                                                │ Socket.io :3003 (LAN)
                                    ┌───────────────────────────┴──────────────┐
                                    ▼                                           ▼
                        TV registrada (screen:register + token)        Panel admin (snapshot)
```

- Cambios de contenido → evento `content:update` → la TV revalida `/api/content` (ETag → 304 si no cambió nada).
- Comandos remotos: `reload`, `fullscreen`, `audio` (payload validado por esquema, canal cerrado).
- La TV sin realtime sigue vivo: polling de respaldo + último contenido persistido (FASE 34).

## Servicios y puertos (FASE 40 — ver docs/FIREWALL.md para la clasificación exacta)

| Servicio | Puerto(s) | Función |
|---|---|---|
| App Next.js | 3000 | Panel + TV + API + proxy FLV + health |
| realtime-service | 3003 / 3004 | WebSocket LAN / API interna (localhost) |
| stream-service | 1935 / 8000 / 8100 | RTMP OBS / HTTP-FLV (localhost) / control (localhost) |

## Base de datos (SQLite, VERIFIED)

- Prisma + SQLite en WAL (lectores del realtime/stream no bloquean escrituras de la app).
- Migraciones versionadas (`prisma migrate deploy`) — JAMÁS `db push` en producción.
- Modelos: User (authVersion), Screen (tokenHash + pairing), Promotion, Dish, Schedule, SocialLink, TickerMessage, Settings (single row), Log (auditoría).
- Índices: `@@index([active, order])` en las 5 tablas de contenido (query caliente de /api/content) + `Log([createdAt])`.

## Capas de seguridad (VERIFIED por tests + E2E security spec)

1. **Secretos**: validación Zod al arranque (sin fallbacks; placeholders prohibidos) — FASE 1.
2. **Sesiones**: HMAC-SHA256 + `authVersion` (invalidación real por cambio de password/rol/estado) + TTL 24 h — FASE 2.
3. **Rate limiting** de login por IP+cuenta con backoff — FASE 3.
4. **Autorización por ruta**: VIEWER/OPERATOR/ADMIN en TODAS las /api/admin/* — FASE 4.
5. **Realtime autenticado**: handshake admin (cookie verificada) + pantallas por token sha256 (pairing FASE 32); CORS por orígenes LAN.
6. **Uploads**: extensión + magic bytes + cuota + nombres generados por servidor; SVG fuera por defecto — FASE 10.
7. **SSRF guard** en stream-test (localhost/RFC1918/metadata bloqueados) — FASE 12.
8. **Headers**: CSP + nosniff + SAMEORIGIN + no-store en APIs privadas (middleware de solo headers) — FASE 35.
9. **gitleaks** en CI (bloqueante) — FASE 30.

## Identidad de las pantallas (FASE 32 — VERIFIED E2E)

```
TV nueva → muestra código de 6 dígitos (TTL 10 min) → room pair:<código>
Admin → "Nueva pantalla" (introduce código) o "Vincular" en tarjeta
      → token aleatorio (sha256 en DB, hash ANTES del broadcast)
      → pair:complete al room → la TV persiste token+code (localStorage)
      → screen:register con token → VERIFICADA
Regenerar → hash sustituido → token antiguo rechazado → TV re-vincula
```

`screenCode` NUNCA es el secreto; el token solo existe en claro en la TV y durante la entrega única.
