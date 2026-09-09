# PRODUCTION_PLAN — Orden exacto de ejecución

> Plan maestro derivado de `PRODUCTION_AUDIT.md` y la misión (MISSION.md). Se ejecuta EN ORDEN, sin saltos. Cada fase termina con checkpoint: lint + typecheck + tests + (build en hitos) + commit limpio.
> Convención: cada fase se marca [ ] pendiente / [~] en curso / [x] completada + evidencia.

---

## Checkpoint de partida (hecho)
- [x] Auditoría completa del repositorio → `PRODUCTION_AUDIT.md`
- [x] Commit base: `48f9583` + `276ec6c` (misión)
- [x] Servicios corriendo: Next :3000, realtime :3003/:3004, stream :1935/:8000/:8100

## FASE 1 — Seguridad y dependencias [ ]
- [ ] `bun add next@16.3.4` (parche de seguridad, misma major) — verificar compat react19/prisma/zod/mpegts/NMS/socket.io — lint+tsc+tests+build
- [ ] Crear `src/lib/env.ts` con Zod: AUTH_SECRET, REALTIME_TOKEN, DATABASE_URL, NODE_ENV; en production → fail-fast si faltan; en dev → error claro. **Quitar** fallbacks de auth.ts/realtime.ts/realtime-service/stream-service (leer del validador)
- [ ] Mini-servicios: validar entorno al arranque (realtime: REALTIME_TOKEN; stream: REALTIME_TOKEN + DATABASE_URL)
- [ ] `.env.example` actualizado (PORT, TIMEZONE, MEDIA_DIR, BACKUP_DIR, LOG_DIR adelantados)
- [ ] README: Node 20.9+/Bun 1.1+
- [ ] `bun audit` + registro; quitar `log:['query']` de Prisma en producción (P1-15)
- Checkpoint: lint+tsc+test+build+commit

## FASE 2 — Auth y sesiones [ ]
- [ ] Prisma: `User.authVersion Int @default(0)` → **migración inicial** (base de F15, se crea aquí la carpeta migrations con `prisma migrate dev --name auth_version`)
- [ ] `signSession` incluye `av` (authVersion); TTL reducido a 24h + renovación deslizante opcional
- [ ] `requireAuth`: firma → exp → cargar usuario DB → active → authVersion → rol (con caché en memoria de 30s para no golpear la DB en cada request público-privado)
- [ ] Incrementar authVersion en: password change, disable, enable, role change, delete
- [ ] Tests unit: sign/verify, expiración, authVersion mismatch, usuario inactivo

## FASE 3 — Rate limiting y login [ ]
- [ ] `src/lib/rate-limit.ts`: límite por IP (p.ej. 10 intentos/5min) + por cuenta (5/10min) con backoff exponencial y cooldown, en memoria (MAP) + tabla `LoginAttempt` opcional en SQLite para persistencia multi-proceso
- [ ] Login: respuestas idénticas 401 genérico, log LOGIN_FAILED, sin revelar existencia de email
- [ ] Tests: correcto, incorrecto, flood, recuperación tras cooldown, deshabilitado, inexistente

## FASE 4 — Autorización [ ]
- [ ] Auditar/ajustar roles de TODAS las rutas (tabla en AUDIT §5): settings PUT streamKey → prohibir (solo endpoint dedicado); screens PUT code → prohibir cambiar code; logs GET → OPERATOR (VIEWER fuera); PATCH payload → validar esquema del comando
- [ ] Helper `requireRole` homogéneo + respuestas 403 consistentes
- [ ] Frontend: ocultar acciones según rol (ScreensSection) para coherencia UX
- [ ] Tests: matriz VIEWER/OPERATOR/ADMIN × endpoints críticos

## FASE 5 — Realtime service [ ]
- [ ] CORS: origen configurable (env `ALLOWED_ORIGINS` o inferido del host de Next) — no `*`
- [ ] Auth de sockets: `socket.auth.token` (admin → token de sesión verificado contra DB con authVersion/rol; pantallas → screen token propio)
- [ ] `screen:register` exige par + token de pantalla (F32 adelanta el modelo: `Screen.screenTokenHash`); `admin:register`/`admin:command` exigen sesión válida
- [ ] `stream:server` a pantallas SIN publisherIp (payload sanitizado por audiencia)
- [ ] GET /health en realtime-service
- [ ] Tests del servicio (bun test del mini-service): handshake sin token rechazado, admin con rol, broadcast token incorrecto → 401

## FASE 6 — Bug realtimeOnline [ ]
- [ ] Backend: `realtimeOnline` = health check real (:3004/health, timeout 1.5s, fallback false) — eliminar condición `|| screens.length >= 0`
- [ ] Test: UP→true, DOWN→false, timeout→false

## FASE 7 — Audio output [ ]
- [ ] NUEVO: `AudioOutputSection` por pantalla — la TV enumera SUS dispositivos (sin micrófono si es posible: `enumerateDevices` directo; getUserMedia solo como último recurso), registra lista en realtime (`screen:audioDevices`), el admin elige por pantalla `TV-001 → HDMI` (etiqueta+deviceId guardados POR pantalla, no global)
- [ ] StreamPlayer: aplica setSinkId del deviceId de SU pantalla; fallback claro "Salida específica no compatible…" si no existe setSinkId o el deviceId ya no está
- [ ] Mantener volumen/mute globales como están (comportamiento actual conservado)
- [ ] Migración: `Screen.audioDeviceId`, `Screen.audioDevices` (JSON) — vía migration

## FASE 8 — Timezone [ ]
- [ ] `src/lib/timezone.ts`: getCurrentParts(tz) → {minutes, weekday, isoDate, hour}, comparisons; conversión explícita única fuente
- [ ] TvDisplay: promoVisible/pickDishes usan tz de Settings (props); DailySchedule usa tz (nuevo prop) — el reloj ya está bien
- [ ] serverTime de /api/content usado para skew (opcional)
- [ ] Tests: America/Havana, cambio de día, overnight 22:00→02:00, DST edge

## FASE 9 — Validación de datos [ ]
- [ ] `src/lib/validators.ts` (Zod): settings (rangos: volume 0-100, tickerSpeed 15-150, fontScale 0.7-1.6, streamRatio 0.45-0.8, animationSpeed 0.5-2, clockFormat 12|24, timezone no vacía, colores hex, urls http(s) seguras), promotions (duration 4-60, horas HH:MM, startDate<=endDate, dayOfWeek 0-6), schedules (HH:MM, end puede ser < start = overnight), socials (network enum, url http(s)), ticker (text<=200), screens (code regex ^[A-Z0-9-]{2,16}$)
- [ ] Aplicar en TODAS las rutas POST/PUT con respuestas 400 consistentes {error, field?}
- [ ] Tests unit de validators

## FASE 10 — Uploads [ ]
- [ ] Extensiones permitidas por tipo (png/jpg/webp/gif/mp4/webm); **SVG deshabilitado por defecto** (env `ALLOW_SVG` con sanitización si se activa) — los logos pueden ser PNG
- [ ] Magic bytes reales (PNG/JPEG/WebP/GIF/MP4 ftyp) — no confiar en MIME declarado
- [ ] Cuota global configurable (MEDIA_MAX_TOTAL_MB) + límites por tipo ya existentes; limpieza de huérfanos (script `scripts/media-gc.ts`); logging de UPLOAD_CREATED/REJECTED
- [ ] Files route: nunca servir SVG como imagen (Content-Disposition/neutral si existiera)
- [ ] Tests: upload válido, SVG rechazado, MIME mentiroso rechazado, path traversal, demasiado grande

## FASE 11 — Storage [ ]
- [ ] env: MEDIA_DIR/BACKUP_DIR/LOG_DIR/DATA_DIR con defaults portables (Linux `/var/lib/pantalla-restaurante` o relativo `./data` en dev; Windows via env) — upload/ migra a MEDIA_DIR (symlink/copia en dev)
- [ ] /api/files y /api/upload usan MEDIA_DIR; stream-service DB path via DATA_DIR
- [ ] Documentar layout estándar Linux/Windows (AUDIT §P1-10)

## FASE 12 — SSRF [ ]
- [ ] `src/lib/ssrf-guard.ts`: bloquear localhost/127/::1/0.0.0.0/link-local/RFC1918/metadata/169.254.169.254 por defecto; permitir solo hosts explícitos (env `STREAM_TEST_ALLOWED_HOSTS` o IPs LAN del servidor)
- [ ] stream-test usa el guard; respuesta 400 con motivo
- [ ] Tests: bloqueo localhost/RFC1918/metadata, permitir host autorizado

## FASE 13 — Streaming [ ]
- [ ] stream-service /health real: comprueba NMS corriendo (listener RTMP vivo) — endpoint interno con detalle, público mínimo
- [ ] /api/stream/status público: SOLO {source, streamEnabled, serverOk, live} (sin viewers/since) — detalle para admin
- [ ] publisherIp: eliminar de broadcast a pantallas; en /api/admin/stream/rtmp GET → solo ADMIN
- [ ] HTTP-FLV :8000 → bind 127.0.0.1 (el proxy ya fetchea localhost) + documentar
- [ ] Verificar proxy FLV bajo carga (2+ viewers), reconexión, OBS real
- [ ] Test de integración del pipeline (con ffmpeg publicando, base de F23)

## FASE 14 — Stream keys [ ]
- [ ] Documentar y TESTEAR comportamiento de rotación: OBS conectado sigue transmitiendo (NMS no corta sesión activa) → clave nueva aplica a NUEVAS conexiones; OBS desconectado con TV reproduciendo: la reproducción sigue hasta donePublish
- [ ] Opcional (solo si es factible sin riesgo): cerrar sesión activa al rotar vía control API de NMS — documentar la decisión
- [ ] Test: rotar con OBS vivo → publicación sigue; nueva conexión con clave vieja → rechazada

## FASE 15 — Prisma migrations [ ]
- [ ] `prisma migrate dev --name init` sobre schema actual (authVersion de F2 + cambios F7 ya incluidos) → historial versionado
- [ ] package.json: `db:deploy` = `prisma migrate deploy` (producción); `db:push` queda SOLO para desarrollo con warning
- [ ] CI usa migrate deploy contra SQLite temporal
- [ ] Documentar: NUNCA accept-data-loss en producción

## FASE 16 — Backups [ ]
- [ ] `scripts/backup.ts`: SQLite backup online (VACUUM INTO), timestamp, retención configurable, verificación (integridad + row counts), rotación
- [ ] `scripts/restore.ts`: restauración con parada segura de servicios + verificación
- [ ] Backup manual desde admin (endpoint ADMIN + botón) y programado (systemd timer / tarea programada)
- [ ] Test REAL: backup → borrar tabla → restore → datos íntegros

## FASE 17 — Users/admin [ ]
- [ ] Política de contraseña (>=10 chars, mayús/minús/número) + validación email Zod
- [ ] Nunca devolver passwordHash (ya OK) ni secretos; auditoría en cambios de password/role/active (authVersion++)
- [ ] Protecciones existentes conservadas (último admin, auto-rol)
- [ ] Tests: política, últimos admin, invalidación de sesión tras cambio

## FASE 18 — Seed/production init [ ]
- [ ] `prisma/seed.ts` → SOLO datos demo opcionales sin usuarios (o con usuarios demo claramente flaggeados `--demo`)
- [ ] `scripts/init-production.ts`: crea primer ADMIN (password introducida por consola/one-time), Settings por defecto, genera secrets si faltan, ejecuta migrate deploy
- [ ] LoginScreen: quitar credenciales demo visibles (mostrarlas solo si NODE_ENV=development)
- [ ] Imágenes demo → assets locales (public/demo/) descargadas en instalación (no runtime)

## FASE 19 — 100% LAN/offline [ ]
- [ ] Eliminar URLs z-cdn.chatglm.cn del seed (usar /public/demo/); DEMO_HLS de StreamSection → quitar botón o marcarlo "requiere Internet"
- [ ] Google Fonts: self-host ya lo hace next/font en build; documentar que build requiere Internet UNA VEZ (o empaquetar .next ya construido)
- [ ] Barrido final de URLs externas (grep) + test de que /api/content no devuelve hosts externos salvo fallbacks configurados por el admin
- [ ] Documentar qué necesita Internet (nada en runtime salvo stream externo configurado)

## FASE 20 — Display 24/7 [ ]
- [ ] Auditoría de efectos (todos con cleanup), timers, sockets (1 sola conexión), instancias player (guard gen ya OK)
- [ ] Prueba de larga duración simulada: reconexión backend, visibilitychange, suspensión
- [ ] Corregir lo encontrado (ya identificado: duplicación teórica de socket si StrictMode activado — se prepara para F21)

## FASE 21 — StrictMode [ ]
- [ ] Hacer efectos idempotentes (reconnect socket tras double-mount, player guard ya existente, interval cleanup)
- [ ] Activar `reactStrictMode: true` en next.config.ts
- [ ] lint+tsc+test+build+verificación browser (TV+admin) tras activar

## FASE 22 — Testing ampliado [x]
- [x] Unit: auth/authVersion/permissions/timezone/validators/stream-state/rate-limit/backup — `tests/*.test.ts` (12 suites, 184 tests)
- [x] Integration (rutas API con fetch contra servidor): login, rate limiting, matriz de permisos, usuarios, pantallas, settings, uploads, stream endpoints — `tests/integration/api.test.ts` (skip visible si no hay servidor; FASE 24 los integra en CI con servidor real)
- [x] Realtime: handshake admin (con/sin token/cookie), screen auth (desconocida/inactiva/token), comandos, broadcast saneado, heartbeat/audioInfo — `tests/realtime-service.test.ts` (spawn real del servicio en :3103/3104)
- [x] E2E Playwright: **26 tests / 23 escenarios de la misión** — `e2e/` (auth-admin, content-crud, screens, stream, tv)
  - Stack real por corrida: app dev :3000 + realtime :3003/:3004 + stream :1935/:8000/:8100 (webServer de playwright.config.ts)
  - DB aislada `db/e2e.db` reseteada por `scripts/e2e-setup.ts` (migrate deploy + seed demo + VIEWER + streamKey)
  - Publicador RTMP ffmpeg real para #13/#14 (FLV bytes verificados por el proxy)
  - Runner: `bun run test:e2e` — dos corridas consecutivas 26/26 (estable)
  - `bunfig.toml [test] root=tests` → bun test NO ejecuta los specs de Playwright

## FASE 23 — Stream E2E real [ ]
- [ ] Test de integración: ffmpeg (RTMP publisher de prueba) → NMS → /api/stream/live.flv → consume FLV y valida bytes FLV header + continuidad; caída del publisher → 503; recuperación → 200
- [ ] En CI: contenedor con ffmpeg si disponible, si no → marca NOT VERIFIED (documentado)

## FASE 24 — CI/CD [ ]
- [ ] Cache bun/prisma; jobs: lint+tsc+unit+build, integration (dev server), services (realtime/stream), Playwright, `bun audit`
- [ ] Sin verde si falla algo crítico; artefactos de logs en fallo

## FASE 25 — Health [ ]
- [ ] `/api/health` real: {status: ok|degraded|unhealthy, database, storage(MEDIA_DIR writable+quota), realtime(:3004/health), stream(:8100/health)} — sin secretos, con timeout y fallback
- [ ] Health endpoints de ambos mini-servicios robustecidos (F13/F5)
- [ ] Supervisor usa /health reales

## FASE 26 — Logging [ ]
- [ ] `src/lib/logger.ts`: JSON estructurado (ts, level, event, actor, ip) a stdout + archivo rotativo en LOG_DIR
- [ ] Eventos de la misión (LOGIN, STREAM_KEY_ROTATED, UPLOAD_*) en todas las rutas; JAMÁS secrets/keys/JWT
- [ ] Quitar `.catch(()=>{})` silenciosos en rutas (log real de fallos)

## FASE 27 — Audit log [ ]
- [ ] Log model: + ip, resource, resourceId, success, metadata JSON segura (migración)
- [ ] Restringir /api/admin/logs a OPERATOR; VIEWER sin acceso
- [ ] Retención configurable + purga

## FASE 28 — Linux deployment [ ]
- [ ] `deploy/linux/`: systemd units (app, realtime, stream) con Restart=always, EnvironmentFile, usuario no-root, límites; install.sh (instala, migra, primer arranque, health wait); scripts start/stop/restart/status/logs/backup/restore/upgrade
- [ ] Documentar OPERATIONS (runbook)

## FASE 29 — Windows deployment [ ]
- [ ] Scripts multiplataforma: build sin `cp -r` (node script), start portable
- [ ] `docs/WINDOWS_PRODUCTION.md`: NSSM (o sc) para los 3 servicios, firewall, rutas C:\PantallaRestaurante\*
- [ ] `deploy/windows/` con .ps1 de instalación/servicio
- [ ] Verificar: app arranca en Windows (rutas, prisma, mpegts es cliente, NMS server-side OK)

## FASE 30 — Configuración [ ]
- [ ] `.env.example` final completo (PORT, DATABASE_URL, AUTH_SECRET, REALTIME_TOKEN, TIMEZONE, MEDIA_DIR, BACKUP_DIR, LOG_DIR, ALLOWED_ORIGINS, STREAM_TEST_ALLOWED_HOSTS, RTMP_*, HTTP_FLV_PORT, MEDIA_MAX_TOTAL_MB, LOGIN_RATE_LIMIT)
- [ ] Validar que .env/DB/tokens no se commitean (gitignore ya OK + gitleaks en CI)

## FASE 31 — Installer [ ]
- [ ] `scripts/install.ts` interactivo: deps → env (genera secrets) → migrate deploy → primer admin → seed opcional → health checks (app/realtime/stream) → resumen
- [ ] Probar en limpio (clone fresh)

## FASE 32 — Screen pairing [ ]
- [ ] Screen: + pairingCode temporal + screenTokenHash (hash del token; el token se muestra una vez) — migración
- [ ] Flujo: TV sin vincular → "Esta pantalla no está vinculada" + código 6 dígitos → Admin: Agregar pantalla → introduce código → nombre/ubicación → generar token → TV lo recibe y persiste (localStorage + registro autenticado)
- [ ] screen:register exige token válido (hash match, screen active) — junto a F5
- [ ] Reinicio de TV conserva identidad; token comprometible → regenerar desde admin
- [ ] E2E del flujo completo

## FASE 33 — Recovery [ ]
- [ ] Simulaciones scriptadas (deploy/linux/recovery-test.sh): matar Next/realtime/stream/DB bloqueada/red/OBS/TV socket → comprobar: restart automático, TV reconnect, stream reconnect, contenido en cache, sin corrupción, sin duplicación
- [ ] Documentar resultados reales

## FASE 34 — PWA/offline [ ]
- [ ] Service worker para TV: cache de shell + último /api/content (IndexedDB) → UI offline con último contenido conocido + banner "sin conexión"; sin streaming offline (nativo)
- [ ] Registrar manifest PWA (instalable en TVs con Chrome)

## FASE 35 — API security [ ]
- [ ] Headers de seguridad (next.config: CSP prudente para TV/admin, X-Frame-Options SAMEORIGIN salvo embed TV permitido, Referrer-Policy, HSTS solo si https documentado)
- [ ] CORS revisado (live.flv `*` → mismo host LAN permitido); cookies: Secure solo en https (documentado para LAN http)
- [ ] No introducir restricciones que rompan LAN (misión)

## FASE 36-38 — Perf/caching/DB [ ]
- [ ] /api/content: ETag + If-None-Match (payload hash) → 304 en TVs; conservar no-store solo para admin
- [ ] Reducir polling TV (status 10s→ mantiene, content solo con evento+watchdog)
- [ ] Índices justificados: Log.createdAt, Promotion(active,order), Dish(active,order), Screen(code unique ya), User(email unique ya)

## FASE 39-40 — Docs/firewall [ ]
- [ ] docs/: ARCHITECTURE, INSTALLATION, LINUX_PRODUCTION, WINDOWS_PRODUCTION, OBS_SETUP, TV_SETUP, SCREEN_PAIRING, BACKUP_RESTORE, TROUBLESHOOTING, SECURITY, OPERATIONS, UPGRADING
- [ ] README/README-LAN actualizados (Node 20.9+, sin credenciales demo, puertos+firewall exactos, qué es LAN-only vs localhost)

## FASE 41 — Security review [ ]
- [ ] Checklist completo de la misión (14 ítems) con evidencia archivo:línea

## FASE 42 — Final test matrix [ ]
- [ ] bun install/lint/typecheck/test/build + integration + E2E + services + health + recovery + backup/restore REAL; lo no ejecutable en este entorno → NOT VERIFIED explícito

## FASE 43 — Production readiness [ ]
- [ ] PRODUCTION_READINESS.md con tabla de áreas PASS/FAIL + guía completa (instalar/actualizar/backup/restaurar/recuperar) + limitaciones y riesgos restantes

---

## Reglas de control de regresión (recordatorio permanente)
- No eliminar flujos funcionales; no cambiar puertos/URLs sin actualizar consumidores; no migrar SQLite→PostgreSQL; no reemplazar Socket.IO/NMS sin pruebas; commit limpio por fase; máximo ~20 cambios verificados antes de checkpoint completo.
