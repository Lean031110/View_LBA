# PRODUCTION_AUDIT — ViewLBA / Pantalla Restaurante

> Auditoría base (FASE 0 de la misión de producción). Generada inspeccionando el 100% del repositorio: package.json, prisma/schema.prisma, todas las rutas API, auth, mini-services, componentes display/admin, uploads, scripts, CI, tests y READMEs.
> Fecha: 2026-09-09 · Commit base: `48f9583` (+ `276ec6c` docs misión)

---

## 1. Arquitectura encontrada

```
┌──────────────┐   RTMP :1935    ┌─────────────────────┐  HTTP-FLV :8000 (localhost)  ┌──────────────────────┐
│ OBS Studio   │ ──────────────▶ │ stream-service      │ ───────────────────────────▶ │ Next.js API          │
│ (LAN)        │  clave stream   │ (node-media-server  │  proxy /api/stream/live.flv  │ /api/stream/live.flv │
└──────────────┘                 │  + control :8100)   │  (clave NUNCA al navegador)  └──────────┬───────────┘
                                 └──────────┬──────────┘                                         │
                                            │ broadcast stream:server (:3004)                    │ HTTP
                                            ▼                                                    ▼
                                 ┌─────────────────────┐   socket.io :3003    ┌──────────────────────┐
                                 │ realtime-service    │ ◀────────────────── │ TV Display (navegador│
                                 │ (hub pantallas+     │ ──────────────────▶ │ mpegts.js FLV, kiosco│
                                 │  admins) + API      │   snapshots/cmd     │ 24/7, watchdog)      │
                                 │ interna :3004       │                     └──────────────────────┘
                                 └──────────▲──────────┘
                                            │ POST /broadcast (x-internal-token)
                                 ┌──────────┴──────────┐
                                 │ Next.js API (admin) │ ◀── Admin (navegador, cookie HMAC)
                                 │ Prisma + SQLite     │
                                 └─────────────────────┘
```

- **Monorepo de hecho**: app Next.js (standalone) + 2 mini-servicios (realtime, stream) con `node_modules` propios.
- **Launcher dual**: `/` → TvDisplay (`?view=tv`) o AdminApp (`?view=admin`).
- **DB**: SQLite vía Prisma (`db/custom.db`), 9 modelos.
- **Estado actual del sandbox**: dev server :3000 OK, realtime :3003/:3004 OK, stream :1935/:8000/:8100 OK (supervisores corriendo).

## 2. Servicios y puertos

| Puerto | Servicio | Bind | Uso | Exposición |
|---|---|---|---|---|
| 3000 | Next.js (dev) / standalone (prod) | 0.0.0.0 | UI TV + admin + APIs | LAN |
| 3003 | realtime-service (socket.io) | 0.0.0.0 | Pantallas + admins (CORS `*`) | LAN ⚠ |
| 3004 | realtime-service (API interna) | 127.0.0.1 | /status, /broadcast (token) | localhost ✓ |
| 1935 | stream-service RTMP | 0.0.0.0 | Ingest OBS | LAN |
| 8000 | stream-service HTTP-FLV | 0.0.0.0 | Playback FLV (con clave en URL) | LAN ⚠ |
| 8100 | stream-service control | 127.0.0.1 | /status /health /nms-notify | localhost ✓ |
| 81/443 | Caddy gateway (solo sandbox) | — | Proxy preview | — |

## 3. Variables de entorno

| Variable | Uso | Problema |
|---|---|---|
| `DATABASE_URL` | SQLite (Prisma) | valor absoluto en `.env` del sandbox (`file:/home/z/...`); ejemplo relativo OK |
| `AUTH_SECRET` | Firma HMAC de sesiones | **fallback hardcodeado** `"signage-dev-secret-change-me"` (src/lib/auth.ts:3) |
| `REALTIME_TOKEN` | Token interno app→realtime | **fallback hardcodeado** `"signage-rt-internal-token"` (src/lib/realtime.ts:5, realtime-service:16, stream-service:47) |
| `RTMP_PORT` / `HTTP_FLV_PORT` | Puertos stream | solo lee stream-service (parsea .env él mismo) |

- No existe `src/lib/env.ts` ni validación centralizada. No hay modo "production estricto".
- `.env` real del sandbox no está en git ✓. `.env.example` correcto en forma.

## 4. Base de datos

- SQLite + Prisma 6.19.2. **Sin `prisma/migrations/`**: el flujo normal es `db:push` (`prisma db push --accept-data-loss`) — destructivo e inválido para producción.
- Modelos: User, Screen, Promotion, Dish, Schedule, SocialLink, TickerMessage, Settings (fila única "main"), Log.
- `src/lib/db.ts` activa `log: ['query']` SIEMPRE (también en producción) → ruido + posible fuga de datos en logs.
- **Sin índices explícitos** aparte de los `@unique` (email, screen.code). `Log.createdAt` sin índice.
- Sin backups, sin restore, sin retención.

## 5. Rutas API (mapa completo)

| Ruta | Métodos | Rol mínimo | Observaciones |
|---|---|---|---|
| `/api/auth/login` | POST | público | sin rate limiting |
| `/api/auth/logout` | POST | público | OK |
| `/api/auth/me` | GET | cookie | OK |
| `/api/content` | GET | público | sanitiza streamKey ✓; `Cache-Control: no-store` (sin ETag) |
| `/api/health` | GET | público | trivial: `{ok:true}` — no comprueba nada |
| `/api/upload` | POST | OPERATOR | MIME declarativo, SVG permitido sin sanitizar, sin cuota |
| `/api/files/[...path]` | GET | público | anti path-traversal ✓; SVG se sirve con el MIME de imagen |
| `/api/stream/status` | GET | público | NO expone clave ✓; expone viewers/since |
| `/api/stream/live.flv` | GET | público | proxy FLV, watchdog inactividad 15s ✓, CORS `*` |
| `/api/admin/settings` | GET/PUT | VIEWER/OPERATOR | PUT acepta 46 campos **sin validación semántica**; `streamKey` escribible por OPERATOR sin restricciones |
| `/api/admin/promotions[/id]` | GET/POST/PUT/DELETE | VIEWER/OPERATOR | sin rangos (duration, order), sin formato HH:MM, sin coherencia fechas |
| `/api/admin/dish[/id]` | GET/POST/PUT/DELETE | VIEWER/OPERATOR | dayOfWeek sin rango 0-6 |
| `/api/admin/schedules[/id]` | GET/POST/PUT/DELETE | VIEWER/OPERATOR | horas sin formato; color sin hex |
| `/api/admin/socials[/id]` | GET/POST/PUT/DELETE | VIEWER/OPERATOR | `url` sin validación (javascript:/data: aceptados) |
| `/api/admin/ticker[/id]` | GET/POST/PUT/DELETE | VIEWER/OPERATOR | text sin límite; tickerSpeed sin rango |
| `/api/admin/screens` | GET/POST/PATCH | VIEWER/OPERATOR | **bug `realtimeOnline` siempre true**; PATCH reenvía payload arbitrario |
| `/api/admin/screens/[id]` | PUT/DELETE | OPERATOR/**ADMIN** | PUT permite cambiar `code` |
| `/api/admin/users[/id]` | GET/POST/PUT/DELETE | ADMIN | sin política de contraseña; sin formato email; protege último admin ✓ |
| `/api/admin/logs` | GET | VIEWER | VIEWER ve auditoría completa |
| `/api/admin/stream/rtmp` | GET/PUT/POST | VIEWER/OPERATOR/**ADMIN** | reveal de clave solo ADMIN ✓; PUT con validación real ✓ |
| `/api/admin/stream-test` | POST | OPERATOR | **SSRF: fetch de cualquier URL** |

## 6. Autenticación

- HMAC-SHA256 propio (payload b64url + firma), cookie `signage_session` httpOnly SameSite=lax, TTL **7 días**.
- scrypt para passwords ✓ (salt 16B, timingSafeEqual ✓).
- **Problemas**:
  1. `requireAuth` solo verifica firma+expiración+rol del token — **no recarga el usuario de la DB**: usuarios deshabilitados o con rol cambiado conservan sesión hasta 7 días.
  2. No existe `authVersion` → cambio de password/rol/active NO invalida tokens anteriores.
  3. Fallback de secret hardcodeado.
  4. Sin rate limiting en login (brute force viable).
  5. Cookie sin flag `secure` (aceptable en LAN http, documentar).
  6. Login revela nada ✓ (mismo error para usuario inexistente/incorrecto) pero LOGEA el email intentado (LOGIN_FAILED details) — razonable.

## 7. Realtime (mini-services/realtime-service)

- socket.io :3003 + API interna :3004 (token). Sweeper offline 45s, heartbeat 15s cliente.
- **Problemas**:
  1. **CORS `origin: "*"`** (index.ts:42).
  2. **Sin autenticación de sockets**: `admin:register` y `admin:command` aceptados de CUALQUIER cliente LAN → cualquiera puede registrarse como admin, ver snapshots (resolución, userAgent de TVs) y enviar comandos (reload/audio) a las pantallas.
  3. Pantallas se registran solo con `screenCode` (visible en el picker) → **suplantación de pantalla trivial**; sin token de pantalla ni pairing.
  4. `/status` interno expone snapshot completo (sin token en GET — solo bind localhost; aceptable, documentar).
  5. `stream:server` se emite a target `all` con `publisherIp` en el payload → llega a las TVs (información sensible innecesaria).
  6. **Sin endpoint `/health`** (solo `/status`).
  7. **Bug FASE 6 confirmado** (screens/route.ts:37): `realtimeOnline: live.length > 0 || screens.length >= 0` → segundo término siempre true → siempre informa online aunque el servicio esté caído.

## 8. Streaming (mini-services/stream-service + player)

- NMS 4.3.2: RTMP :1935, HTTP-FLV :8000 (bind 0.0.0.0), control :8100 (localhost).
- Validación de streamKey doble capa (hook prePublish + listener) ✓; rotación hot-reload 2s ✓; gracia 2.5s reconexión OBS ✓.
- **Problemas**:
  1. `/health` existe pero es trivial (`"ok"` plano, no comprueba listener/NMS vivo) — el supervisor podría dar por bueno un proceso zombi.
  2. `/status` (:8100, localhost) incluye publisherIp/lastSession → el proxy público `/api/stream/status` NO lo expone ✓, pero `/api/admin/stream/rtmp` (VIEWER) sí devuelve `server.publisherIp` — debería ser ADMIN o eliminarse.
  3. HTTP-FLV :8000 expuesto a toda la LAN con la clave en la URL → cualquier equipo LAN que conozca la clave reproduce el stream sin pasar por la app. La clave solo la ve ADMIN (reveal), riesgo acotado pero el bind debería ser 127.0.0.1 (el proxy Next.js fetchea localhost).
  4. Broadcast de rotación no aclara en UI que "aplica a nuevas conexiones" (documentado en código, no en UI).
  5. Proxy FLV: correcto (timeout solo de conexión + watchdog inactividad 15s, `X-Accel-Buffering: no`) ✓ pero CORS `*` y sin límite de conexiones simultáneas por cliente.
  6. StreamPlayer: reconexión 5/10/15s→30s, watchdog 5s, `autoCleanupSourceBuffer` ✓, guard de generación ✓, teardown completo ✓. Puntos menores: `setSinkId` se aplica con deviceId del ADMIN (arquitectura de audio rota, FASE 7); no re-suscribe `onPlaying` tras remount (usa props React ✓).

## 9. Almacenamiento / uploads

- `upload/` **dentro del árbol de la app** (`process.cwd()/upload`): en un redeploy que reemplace el directorio de la app, se pierden logos/promos/fallbacks. No hay separación APP/DATA/MEDIA/BACKUPS/LOGS.
- Upload: confianza en `file.type` declarado por el cliente; extensión se sanea (regex) y nombre lo genera el servidor ✓; **SVG permitido sin sanitizar** → XSS almacenado servido desde mismo origen; sin cuota global, sin limpieza de huérfanos, sin inspección mágica de bytes, vídeos sin validación de contenedor/codec/duración.
- Files: anti path-traversal ✓; cache immutable 24h ✓; MIME por extensión (un .svg renombrado se sirve como svg).

## 10. Tests

- **15 casos, 3 archivos**: brand (3), fields/pickFields+readBody (9), net (3). Solo utilidades puras.
- **Cero** tests de: auth/sesiones, rate limiting, permisos, API routes, timezone, validación, uploads, realtime, streaming, 24/7.
- No hay Playwright, no hay tests de integración, no hay tests de mini-servicios.

## 11. CI (GitHub Actions)

- `.github/workflows/ci.yml`: bun install → prisma generate → lint → typecheck → bun test → build. Cache **no configurado**. Sin tests de integración/E2E/servicios/seguridad. Build usa `next/font/google` → **el CI (y cualquier build) requiere Internet**.

## 12. Otros hallazgos

- **Timezone**: Clock ✓ usa `Intl` con timezone; **DailySchedule usa `new Date().getHours()/getDay()`** (hora local del navegador TV) y **TvDisplay `promoVisible/pickDishes` igual** → si la TV tiene otra zona o reloj desviado, promos/platos/horarios fallan. `Settings.timezone` existe pero no se aplica en esos puntos.
- **Audio**: `AudioSection` (admin) enumera dispositivos **del navegador del administrador** y guarda un `audioDeviceId` global que las TVs aplican con `setSinkId` → deviceId de otra máquina, concepto roto. Pide getUserMedia (micrófono) para desbloquear etiquetas.
- **reactStrictMode: false** en next.config.ts (oculta dobles efectos; misión exige activarlo tras hacer efectos idempotentes).
- **Seed**: usuarios `admin@restaurante.com/admin123` y `operador@restaurante.com/operador123` (impresos en login/README/consola); 5 imágenes remotas `z-cdn.chatglm.cn`; demo HLS `test-streams.mux.dev` en código (StreamSection). Sistema "100% LAN" con dependencia visual de Internet.
- **Deploy**: solo supervisores bash (Linux-only: setsid/nohup/cp) para mini-servicios; nada para Next.js; sin systemd; sin soporte Windows; `package.json` build usa `cp -r` (no Windows).
- **Logging**: consola sin estructura; `.catch(() => {})` silencia fallos en TODAS las secciones CRUD y en logAction; Log model sin IP/recurso/metadata.
- **Viewers y UI de roles**: VIEWER ve botones de acciones OPERATOR (ScreensSection); PATCH /screens reenvía `payload` arbitrario a pantallas.

---

## 13. PROBLEMAS CLASIFICADOS

### P0 — Bloqueadores de producción

| # | Problema | Dónde | Fase |
|---|---|---|---|
| P0-1 | Secretos con fallback hardcodeado (AUTH_SECRET, REALTIME_TOKEN) + sin validación de entorno | auth.ts:3, realtime.ts:5, rt-svc:16, st-svc:47 | F1 |
| P0-2 | Socket realtime sin autenticación + CORS `*` (cualquiera en LAN = "admin") | realtime-service:42,133-142 | F5 |
| P0-3 | Sesiones no invalidables (sin authVersion; usuarios deshabilitados/rol cambiado siguen 7 días) | auth.ts, requireAuth | F2 |
| P0-4 | Login sin rate limiting (brute force) | login/route.ts | F3 |
| P0-5 | SSRF en /api/admin/stream-test (proxy arbitrario) | stream-test/route.ts:19 | F12 |
| P0-6 | Uploads: SVG sin sanitizar (XSS same-origin), sin validación real de contenido | upload/route.ts, files/route.ts | F10 |
| P0-7 | Sin migrations Prisma (db push --accept-data-loss como flujo normal) | package.json db:push | F15 |
| P0-8 | Sin backups de SQLite (24/7 sin plan de recuperación) | — | F16 |
| P0-9 | Credenciales demo conocidas + seed no separado de producción | seed.ts, LoginScreen:87-89 | F18 |
| P0-10 | Bug `realtimeOnline` siempre true | screens/route.ts:37 | F6 |
| P0-11 | Suplantación de pantallas (identidad = screenCode público, sin token/pairing) | ScreenPicker, realtime | F32/F5 |
| P0-12 | Arquitectura de audio rota (deviceId del admin aplicado a TVs remotas) | AudioSection, StreamPlayer:404-409 | F7 |
| P0-13 | Timezone ignorado en promos/platos/horarios (hora del navegador TV) | TvDisplay:27-47, DailySchedule:35-48 | F8 |
| P0-14 | Dependencia de Internet en seed/DEMO_HLS (sistema "100% LAN") | seed.ts, StreamSection:21 | F19 |

### P1 — Importantes

| # | Problema | Fase |
|---|---|---|
| P1-1 | Next.js 16.1.3 → parche de seguridad 16.3.4 disponible (misma major) | F1 |
| P1-2 | streamKey escribible vía PUT /settings por OPERATOR sin restricciones | F4 |
| P1-3 | Validación semántica inexistente en settings/CRUD (volume, tickerSpeed, duration, dayOfWeek, urls, colores, horas) | F9 |
| P1-4 | PUT /screens/[id] permite cambiar code; PATCH reenvía payload arbitrario | F4 |
| P1-5 | users: sin política de contraseña/email | F17 |
| P1-6 | /api/health trivial (no comprueba DB/realtime/stream/storage) | F25 |
| P1-7 | /health de stream-service no comprueba NMS; realtime sin /health | F13/F25 |
| P1-8 | publisherIp: broadcast a TVs (stream:server all) y a VIEWERs vía rtmp GET | F13 |
| P1-9 | HTTP-FLV :8000 expuesto a LAN (debería ser localhost) | F13/F40 |
| P1-10 | Storage: upload/ dentro del árbol de la app; sin MEDIA_DIR/BACKUP_DIR/LOG_DIR | F11 |
| P1-11 | Sin deploy real (systemd/Windows); scripts Linux-only; build con `cp -r` | F28/F29 |
| P1-12 | Tests insuficientes (15 casos, solo utilidades) | F22 |
| P1-13 | CI sin integración/E2E/servicios; sin cache; build requiere Internet (Google Fonts) | F24 |
| P1-14 | reactStrictMode: false | F21 |
| P1-15 | Prisma `log:['query']` en producción | F26 |
| P1-16 | VIEWER ve auditoría completa y botones de OPERATOR | F4/F27 |
| P1-17 | Sin logging estructurado ni eventos clave; `.catch(()=>{})` silencia errores | F26 |
| P1-18 | Sin servicio/worker de recuperación del propio Next.js | F28/F33 |
| P1-19 | Sin flujo de installer/onboarding (primer admin, health, etc.) | F31 |
| P1-20 | Rotación de stream key no documentada en UI (aplica a nuevas conexiones) | F14 |

### P2 — Mejoras

| # | Problema | Fase |
|---|---|---|
| P2-1 | /api/content sin ETag/conditional requests (TVs re-descargan todo) | F37 |
| P2-2 | Índices DB faltantes (Log.createdAt, Promotion.active+order, etc.) | F38 |
| P2-3 | CORS `*` en live.flv y API interna 3004 | F35 |
| P2-4 | Sin PWA/service worker (contenido offline en TVs) | F34 |
| P2-5 | Errores UI silenciosos (toasts) y fallos de guardado invisibles | F26 |
| P2-6 | Clock bien; Date.now() vs serverTime no usado para skew de reloj | F8 |
| P2-7 | Íconos/colores sociales sin validar hex | F9 |
| P2-8 | `bun run start` con `tee` (Linux-only) | F29 |

## 14. Riesgos (resumen ejecutivo)

1. **Compromiso total por LAN**: con los fallbacks de secretos + socket sin auth + CORS *, cualquier equipo de la red controla pantallas y espolea comandos.
2. **Sesiones zombis**: despedir a un operador no lo desconecta (7 días de token válido).
3. **Pérdida de datos**: ni migrations ni backups → un upgrade o crash puede vaciar/corromper la DB sin recuperación.
4. **XSS persistente**: un SVG malicioso subido por OPERATOR se ejecuta en todas las TVs (same-origin).
5. **Contenido visible incorrecto**: timezone del navegador decide promos/platos/horarios.
6. **Instalación sin Internet incompleta**: seed y demo dependen de CDNs.
7. **Operación 24/7 frágil**: health checks triviales, supervisores bash sin política de reinicios, sin systemd/Windows.

## 15. Prioridades (orden de ejecución ya definido por la misión)

1. **F1** (env + dependencias) — cimientos de todo lo demás.
2. **F2-F4** (auth, rate limit, autorización) — cierran la superficie HTTP.
3. **F5-F6** (realtime + bug estado) — cierran la superficie de sockets.
4. **F7-F9** (audio, timezone, validación) — corrigen comportamiento funcional.
5. **F10-F12** (uploads, storage, SSRF) — cierran superficie de archivos/red.
6. **F13-F16** (streaming, keys, migrations, backups) — robustez operativa.
7. **F17-F21** (users, seed, LAN, 24/7, strictmode) — preparación real.
8. **F22-F27** (tests, E2E, CI, health, logs, auditoría) — evidencia y observabilidad.
9. **F28-F40** (deploy, config, installer, pairing, recovery, PWA, seguridad API, perf, caching, DB, docs, firewall).
10. **F41-F43** (revisión final, matriz de pruebas, readiness).

> Mapa de dependencias módulo a módulo (resumen): `auth.ts` ← todas las rutas admin · `realtime.ts` ← crud.ts ← todas las rutas de contenido · `client-socket.ts` ← TvDisplay + AdminApp · `settings` (DB) ← content route + live.flv + stream-service (lectura directa SQLite) · `stream-service` → `realtime:3004` → pantallas · supervisores → health de ambos servicios · CI → lint/tsc/test/build.
