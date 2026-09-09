# PRODUCTION_PLAN — Orden exacto de ejecución

> Plan maestro derivado de `PRODUCTION_AUDIT.md` y la misión (MISSION.md). Se ejecuta EN ORDEN, sin saltos. Cada fase termina con checkpoint: lint + typecheck + tests + (build en hitos) + commit limpio.
> Convención: cada fase se marca [ ] pendiente / [~] en curso / [x] completada + evidencia.

---

## Checkpoint de partida (hecho)

> **Nota de sincronización (2026-09-09, re-aplicada tras reset del entorno):**
> fases 1-30 verificadas por commits y muestreo de código. Evidencia: F1 `1c3e303` ·
> F2 `af07d41` · F3 `592bf63` · F4 `6a0ffe5` · F5+6 `45d6f91` · F7 `78f8ab4` ·
> F8 `fd6fd52` · F9 `aee0af9` · F10+11 `39c06ed` · F12 `a51d717` · F13+14 `deddaae` ·
> F15+16 `b538eef` · F17-19 `34a5ed7` · F20+21 `862f9ca` · F22 `a65d93e` ·
> F23 `0cb4b00` · F24 `c1af82c` · F25 `0981324` · F26+27 `c6ed1c1` ·
> F28 `4f11058` · F29 `6a419dd` · F30 `4b6201d`. Post-sync: `c6c2a80` (FASE 31
> PASO 1-4: core initializeProduction + protección DATABASE_URL + 24 tests) y
> `af7318a` (bun.lock + .env.example). La BD dev fue baselined
> (`prisma migrate resolve --applied 0_init` + `audit_log_fields`) para que
> `migrate deploy` sea idempotente también localmente.
- [x] Auditoría completa del repositorio → `PRODUCTION_AUDIT.md`
- [x] Commit base: `48f9583` + `276ec6c` (misión)
- [x] Servicios corriendo: Next :3000, realtime :3003/:3004, stream :1935/:8000/:8100

## FASE 1 — Seguridad y dependencias [x]
- [ ] `bun add next@16.3.4` (parche de seguridad, misma major) — verificar compat react19/prisma/zod/mpegts/NMS/socket.io — lint+tsc+tests+build
- [ ] Crear `src/lib/env.ts` con Zod: AUTH_SECRET, REALTIME_TOKEN, DATABASE_URL, NODE_ENV; en production → fail-fast si faltan; en dev → error claro. **Quitar** fallbacks de auth.ts/realtime.ts/realtime-service/stream-service (leer del validador)
- [ ] Mini-servicios: validar entorno al arranque (realtime: REALTIME_TOKEN; stream: REALTIME_TOKEN + DATABASE_URL)
- [ ] `.env.example` actualizado (PORT, TIMEZONE, MEDIA_DIR, BACKUP_DIR, LOG_DIR adelantados)
- [ ] README: Node 20.9+/Bun 1.1+
- [ ] `bun audit` + registro; quitar `log:['query']` de Prisma en producción (P1-15)
- Checkpoint: lint+tsc+test+build+commit

## FASE 2 — Auth y sesiones [x]
- [ ] Prisma: `User.authVersion Int @default(0)` → **migración inicial** (base de F15, se crea aquí la carpeta migrations con `prisma migrate dev --name auth_version`)
- [ ] `signSession` incluye `av` (authVersion); TTL reducido a 24h + renovación deslizante opcional
- [ ] `requireAuth`: firma → exp → cargar usuario DB → active → authVersion → rol (con caché en memoria de 30s para no golpear la DB en cada request público-privado)
- [ ] Incrementar authVersion en: password change, disable, enable, role change, delete
- [ ] Tests unit: sign/verify, expiración, authVersion mismatch, usuario inactivo

## FASE 3 — Rate limiting y login [x]
- [ ] `src/lib/rate-limit.ts`: límite por IP (p.ej. 10 intentos/5min) + por cuenta (5/10min) con backoff exponencial y cooldown, en memoria (MAP) + tabla `LoginAttempt` opcional en SQLite para persistencia multi-proceso
- [ ] Login: respuestas idénticas 401 genérico, log LOGIN_FAILED, sin revelar existencia de email
- [ ] Tests: correcto, incorrecto, flood, recuperación tras cooldown, deshabilitado, inexistente

## FASE 4 — Autorización [x]
- [ ] Auditar/ajustar roles de TODAS las rutas (tabla en AUDIT §5): settings PUT streamKey → prohibir (solo endpoint dedicado); screens PUT code → prohibir cambiar code; logs GET → OPERATOR (VIEWER fuera); PATCH payload → validar esquema del comando
- [ ] Helper `requireRole` homogéneo + respuestas 403 consistentes
- [ ] Frontend: ocultar acciones según rol (ScreensSection) para coherencia UX
- [ ] Tests: matriz VIEWER/OPERATOR/ADMIN × endpoints críticos

## FASE 5 — Realtime service [x]
- [ ] CORS: origen configurable (env `ALLOWED_ORIGINS` o inferido del host de Next) — no `*`
- [ ] Auth de sockets: `socket.auth.token` (admin → token de sesión verificado contra DB con authVersion/rol; pantallas → screen token propio)
- [ ] `screen:register` exige par + token de pantalla (F32 adelanta el modelo: `Screen.screenTokenHash`); `admin:register`/`admin:command` exigen sesión válida
- [ ] `stream:server` a pantallas SIN publisherIp (payload sanitizado por audiencia)
- [ ] GET /health en realtime-service
- [ ] Tests del servicio (bun test del mini-service): handshake sin token rechazado, admin con rol, broadcast token incorrecto → 401

## FASE 6 — Bug realtimeOnline [x]
- [ ] Backend: `realtimeOnline` = health check real (:3004/health, timeout 1.5s, fallback false) — eliminar condición `|| screens.length >= 0`
- [ ] Test: UP→true, DOWN→false, timeout→false

## FASE 7 — Audio output [x]
- [ ] NUEVO: `AudioOutputSection` por pantalla — la TV enumera SUS dispositivos (sin micrófono si es posible: `enumerateDevices` directo; getUserMedia solo como último recurso), registra lista en realtime (`screen:audioDevices`), el admin elige por pantalla `TV-001 → HDMI` (etiqueta+deviceId guardados POR pantalla, no global)
- [ ] StreamPlayer: aplica setSinkId del deviceId de SU pantalla; fallback claro "Salida específica no compatible…" si no existe setSinkId o el deviceId ya no está
- [ ] Mantener volumen/mute globales como están (comportamiento actual conservado)
- [ ] Migración: `Screen.audioDeviceId`, `Screen.audioDevices` (JSON) — vía migration

## FASE 8 — Timezone [x]
- [ ] `src/lib/timezone.ts`: getCurrentParts(tz) → {minutes, weekday, isoDate, hour}, comparisons; conversión explícita única fuente
- [ ] TvDisplay: promoVisible/pickDishes usan tz de Settings (props); DailySchedule usa tz (nuevo prop) — el reloj ya está bien
- [ ] serverTime de /api/content usado para skew (opcional)
- [ ] Tests: America/Havana, cambio de día, overnight 22:00→02:00, DST edge

## FASE 9 — Validación de datos [x]
- [ ] `src/lib/validators.ts` (Zod): settings (rangos: volume 0-100, tickerSpeed 15-150, fontScale 0.7-1.6, streamRatio 0.45-0.8, animationSpeed 0.5-2, clockFormat 12|24, timezone no vacía, colores hex, urls http(s) seguras), promotions (duration 4-60, horas HH:MM, startDate<=endDate, dayOfWeek 0-6), schedules (HH:MM, end puede ser < start = overnight), socials (network enum, url http(s)), ticker (text<=200), screens (code regex ^[A-Z0-9-]{2,16}$)
- [ ] Aplicar en TODAS las rutas POST/PUT con respuestas 400 consistentes {error, field?}
- [ ] Tests unit de validators

## FASE 10 — Uploads [x]
- [ ] Extensiones permitidas por tipo (png/jpg/webp/gif/mp4/webm); **SVG deshabilitado por defecto** (env `ALLOW_SVG` con sanitización si se activa) — los logos pueden ser PNG
- [ ] Magic bytes reales (PNG/JPEG/WebP/GIF/MP4 ftyp) — no confiar en MIME declarado
- [ ] Cuota global configurable (MEDIA_MAX_TOTAL_MB) + límites por tipo ya existentes; limpieza de huérfanos (script `scripts/media-gc.ts`); logging de UPLOAD_CREATED/REJECTED
- [ ] Files route: nunca servir SVG como imagen (Content-Disposition/neutral si existiera)
- [ ] Tests: upload válido, SVG rechazado, MIME mentiroso rechazado, path traversal, demasiado grande

## FASE 11 — Storage [x]
- [ ] env: MEDIA_DIR/BACKUP_DIR/LOG_DIR/DATA_DIR con defaults portables (Linux `/var/lib/pantalla-restaurante` o relativo `./data` en dev; Windows via env) — upload/ migra a MEDIA_DIR (symlink/copia en dev)
- [ ] /api/files y /api/upload usan MEDIA_DIR; stream-service DB path via DATA_DIR
- [ ] Documentar layout estándar Linux/Windows (AUDIT §P1-10)

## FASE 12 — SSRF [x]
- [ ] `src/lib/ssrf-guard.ts`: bloquear localhost/127/::1/0.0.0.0/link-local/RFC1918/metadata/169.254.169.254 por defecto; permitir solo hosts explícitos (env `STREAM_TEST_ALLOWED_HOSTS` o IPs LAN del servidor)
- [ ] stream-test usa el guard; respuesta 400 con motivo
- [ ] Tests: bloqueo localhost/RFC1918/metadata, permitir host autorizado

## FASE 13 — Streaming [x]
- [ ] stream-service /health real: comprueba NMS corriendo (listener RTMP vivo) — endpoint interno con detalle, público mínimo
- [ ] /api/stream/status público: SOLO {source, streamEnabled, serverOk, live} (sin viewers/since) — detalle para admin
- [ ] publisherIp: eliminar de broadcast a pantallas; en /api/admin/stream/rtmp GET → solo ADMIN
- [ ] HTTP-FLV :8000 → bind 127.0.0.1 (el proxy ya fetchea localhost) + documentar
- [ ] Verificar proxy FLV bajo carga (2+ viewers), reconexión, OBS real
- [ ] Test de integración del pipeline (con ffmpeg publicando, base de F23)

## FASE 14 — Stream keys [x]
- [ ] Documentar y TESTEAR comportamiento de rotación: OBS conectado sigue transmitiendo (NMS no corta sesión activa) → clave nueva aplica a NUEVAS conexiones; OBS desconectado con TV reproduciendo: la reproducción sigue hasta donePublish
- [ ] Opcional (solo si es factible sin riesgo): cerrar sesión activa al rotar vía control API de NMS — documentar la decisión
- [ ] Test: rotar con OBS vivo → publicación sigue; nueva conexión con clave vieja → rechazada

## FASE 15 — Prisma migrations [x]
- [ ] `prisma migrate dev --name init` sobre schema actual (authVersion de F2 + cambios F7 ya incluidos) → historial versionado
- [ ] package.json: `db:deploy` = `prisma migrate deploy` (producción); `db:push` queda SOLO para desarrollo con warning
- [ ] CI usa migrate deploy contra SQLite temporal
- [ ] Documentar: NUNCA accept-data-loss en producción

## FASE 16 — Backups [x]
- [ ] `scripts/backup.ts`: SQLite backup online (VACUUM INTO), timestamp, retención configurable, verificación (integridad + row counts), rotación
- [ ] `scripts/restore.ts`: restauración con parada segura de servicios + verificación
- [ ] Backup manual desde admin (endpoint ADMIN + botón) y programado (systemd timer / tarea programada)
- [ ] Test REAL: backup → borrar tabla → restore → datos íntegros

## FASE 17 — Users/admin [x]
- [ ] Política de contraseña (>=10 chars, mayús/minús/número) + validación email Zod
- [ ] Nunca devolver passwordHash (ya OK) ni secretos; auditoría en cambios de password/role/active (authVersion++)
- [ ] Protecciones existentes conservadas (último admin, auto-rol)
- [ ] Tests: política, últimos admin, invalidación de sesión tras cambio

## FASE 18 — Seed/production init [x]
- [ ] `prisma/seed.ts` → SOLO datos demo opcionales sin usuarios (o con usuarios demo claramente flaggeados `--demo`)
- [ ] `scripts/init-production.ts`: crea primer ADMIN (password introducida por consola/one-time), Settings por defecto, genera secrets si faltan, ejecuta migrate deploy
- [ ] LoginScreen: quitar credenciales demo visibles (mostrarlas solo si NODE_ENV=development)
- [ ] Imágenes demo → assets locales (public/demo/) descargadas en instalación (no runtime)

## FASE 19 — 100% LAN/offline [x]
- [ ] Eliminar URLs z-cdn.chatglm.cn del seed (usar /public/demo/); DEMO_HLS de StreamSection → quitar botón o marcarlo "requiere Internet"
- [ ] Google Fonts: self-host ya lo hace next/font en build; documentar que build requiere Internet UNA VEZ (o empaquetar .next ya construido)
- [ ] Barrido final de URLs externas (grep) + test de que /api/content no devuelve hosts externos salvo fallbacks configurados por el admin
- [ ] Documentar qué necesita Internet (nada en runtime salvo stream externo configurado)

## FASE 20 — Display 24/7 [x]
- [ ] Auditoría de efectos (todos con cleanup), timers, sockets (1 sola conexión), instancias player (guard gen ya OK)
- [ ] Prueba de larga duración simulada: reconexión backend, visibilitychange, suspensión
- [ ] Corregir lo encontrado (ya identificado: duplicación teórica de socket si StrictMode activado — se prepara para F21)

## FASE 21 — StrictMode [x]
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

## FASE 23 — Stream E2E real [x]
- [x] Test de integración: ffmpeg (RTMP publisher de prueba) → NMS → /api/stream/live.flv → consume FLV y valida bytes FLV header + continuidad; caída del publisher → 503; recuperación → 200 — `tests/stream-pipeline.test.ts`
  - Autocontenido: DB temporal + spawn de stream-service (1935/8000/8100) + spawn de next dev (:3100) con kill por grupo de procesos
  - Validado: live (estado), reproducción (200 + video/x-flv + "FLV" + >150KB en 5s de lectura continua), reconexión rápida (corte <gracia NMS → live NO baja, FLV sigue), caída (live=false a los 32.6s = gracia documentada), recuperación (live=true + FLV fluye)
  - Nota de diseño: sin publicador el proxy abre 200 y corta por watchdog de inactividad (15s) — NMS no da 503 en ese estado; la semántica de bytes ya está validada por continuidad/caída/recuperación
  - SKIP VISIBLE si no hay ffmpeg o puertos ocupados (E2E en marcha comparte .next)
- [x] En CI: ubuntu-latest de GitHub incluye ffmpeg (validado localmente; si CI no lo tuviera → skip visible NOT VERIFIED)

## FASE 24 — CI/CD [x]
- [x] GitHub Actions con 4 jobs paralelos (todos requeridos para el verde):
  - **quality**: install reproducible (--frozen-lockfile + cache bun) · prisma generate · lint · typecheck · bun test (12 suites unit + realtime-service spawn + stream-pipeline con ffmpeg) · build standalone
  - **integration**: e2e-setup (DB + seed demo) → dev server :3000 real → `bun test tests/integration/api.test.ts` (19/19 validados localmente) → teardown + logs como artefacto en fallo
  - **e2e**: cache de navegadores Playwright · chromium --with-deps · e2e-setup · `bunx playwright test` (bootea app+realtime+stream) · traces/screenshots como artefactos en fallo
  - **security**: `bun audit --audit-level=critical` BLOQUEANTE (0 hoy) + reporte completo registrado como warning
- [x] Sin verde si falla algo crítico: los 4 jobs son required; audit crítico bloquea
- [x] Artefactos de logs en fallo: dev-server.log + playwright failures
- [x] Saneamiento de runtime (evidencia del audit): eliminadas `lodash` y `@reactuses/core` (0 imports en src — la segunda arrastraba js-cookie ≤3.0.5 HIGH). Las 30 restantes viven SOLO en cadenas dev/CLI (eslint→babel→browserslist, prisma-config, picomatch) — no forman parte del binario standalone
- Registro: `bun update` sin cambios (todo en último semver compatible)

## FASE 25 — Health [x]
- [x] `/api/health` REAL: {status: ok|degraded|unhealthy, database(SELECT 1 con timeout), storage(MEDIA_DIR writable+uso/cuota con caché 60s), realtime(:3004/health), stream(:8100/health)} — sin secretos, probes con timeout 1.5s, 503 solo si la DB cae (degraded = la app sigue sirviendo contenido con polling de respaldo)
- [x] Health de mini-servicios ya reales: realtime (:3004/health FASE 5) y stream (TCP listeners de RTMP/FLV FASE 13 — un proceso zombi da 503)
- [x] Supervisor realtime actualizado a /health (antes /status)
- [x] Tests: integración (degraded sin servicios + DB viva + sin secretos) y E2E (ok con stack completo) — suite 210/210 estable ×2

## FASE 26 — Logging [x]
- [x] `src/lib/logger.ts`: JSON estructurado {ts, level, event, actor, ip, resource, resourceId, success, meta} → stdout (journald-ready) + archivo rotativo por tamaño en LOG_DIR (5 MB × 5)
- [x] Vocabulario de la misión en TODAS las rutas: LOGIN, LOGIN_FAILED, LOGOUT, USER_CREATED/UPDATED/DELETED/DISABLED/ENABLED, PASSWORD_CHANGED, ROLE_CHANGED, SCREEN_CREATED/UPDATED/DELETED/COMMAND/PAIRED, STREAM_SETTINGS, STREAM_KEY_ROTATED, UPLOAD_CREATED/REJECTED/FAILED, SETTINGS_CHANGED, CONTENT_CREATED/UPDATED/DELETED (promos/platos/horarios/redes/ticker)
- [x] JAMÁS secrets: `redact()` elimina password/secret/token/JWT/cookies y TRUNCA claves de stream a 4 chars (defensa en profundidad); strings >512 truncados
- [x] `.catch(()=>{})` silenciosos ELIMINADOS de las rutas (login/logout/upload ahora registran fallos reales por logError; AUDIT_WRITE_FAILED si la auditoría misma falla); los dos restantes del proxy FLV son clean-up best-effort documentado
- [x] Tests: tests/logger.test.ts (8: redact anidado, truncado de stream key, JSON válido, meta sanitizado, logError, rotación real por tamaño)

## FASE 27 — Audit log [x]
- [x] Migración `20260909023931_audit_log_fields`: Log + ip, resource, resourceId, success, metadata (JSON seguro) — preserva filas existentes
- [x] `logAction` única vía: escribe fila DB (campos nuevos) + evento estructurado stdout/archivo; fallo de auditoría → AUDIT_WRITE_FAILED (nunca rompe la petición)
- [x] /api/admin/logs sigue restringido a OPERATOR+ (VIEWER fuera, FASE 4); UI muestra ip + indicador ✗ en fallos + colores por acción del vocabulario
- [x] Retención: `scripts/logs-purge.ts` (LOG_RETENTION_DAYS default 90, --dry-run) — systemd timer en FASE 28
- [x] Evidencia: 218 tests/0 fail · E2E 26/26 · lint ✓ · typecheck ✓

## FASE 28 — Linux deployment [x]
- [x] `deploy/linux/`: 8 unidades systemd VERIFICADAS con `systemd-analyze verify` (0 warnings)
  - app (standalone production: `bun .next/standalone/server.js`), realtime, stream — todas: Restart=always + RestartSec=5, StartLimit en [Unit], EnvironmentFile=/etc/pantalla-restaurante.env, WorkingDirectory, usuario de sistema `pantalla` (sin login, sin root), límites (MemoryMax/CPUQuota/NOFILE) y endurecimiento (ProtectSystem=strict + ReadWritePaths solo var/lib+var/log, NoNewPrivileges, ProtectHome, PrivateTmp)
  - target de grupo + backup.timer (diario 03:00, Persistent) + logs-purge.timer (diario 04:00)
- [x] `install.sh` idempotente: deps check → usuario → layout estándar (/opt código · /var/lib datos · /var/log logs · /etc entorno root:600) → secretos openssl → install root+mini-servicios → prisma generate → **migrate deploy** → build standalone → unidades (sustituye __BUN_BIN__) → enable+start → health wait real
- [x] `manage.sh`: start/stop/restart/status/logs/health/backup/restore/upgrade (documentados y con ejemplos en docs/OPERATIONS.md)
- [x] docs/OPERATIONS.md (runbook): arquitectura, puertos, instalación, primer admin (init-production), comandos diarios, interpretación de health, backups, auditoría, upgrade, tabla de recuperación ante fallos, firewall
- [x] Verificación del runtime REAL: build standalone + arranque con NODE_ENV=production + DATABASE_URL absoluta + PORT → health 200 (degraded sin mini-servicios, database/storage ok) — mismo binario que ejecuta el servicio systemd
- NOT VERIFIED (hardware): arranque de systemd en máquina real — este entorno no tiene systemd; unidades validadas sintácticamente y runtime del binario verificado. Marcar para FASE 42/43 (test matrix) en hardware destino

## FASE 29 — Windows deployment [x]
- [x] Scripts multiplataforma: `scripts/build.ts` (next build + fs.cpSync portable — sin `cp -r`) y `scripts/start.ts` (arranca standalone con NODE_ENV/PORT + reenvío de señales — sin prefijo env ni `tee`) — ambos VERIFICADOS en Linux (bun run build desde cero + arranque health 200); package.json actualizado (dev/build/start)
- [x] `deploy/windows/install.ps1`: deps (bun/nssm con guía) · layout C:\PantallaRestaurante\{app,data,logs} · secretos RNG · .env único (lo consumen los 3 servicios) · install raíz+mini-servicios · prisma generate · migrate deploy · build portable · 3 servicios NSSM (reinicio 5s, logs rotativos 5MB) · firewall (3000/3003 LAN, 1935 OBS) · arranque + health wait
- [x] `deploy/windows/manage.ps1`: start/stop/restart/status/logs/health/backup/restore/upgrade
- [x] `docs/WINDOWS_PRODUCTION.md`: requisitos, arquitectura, instalación, primer admin, gestión, backup programado (Task Scheduler), firewall, recuperación, notas de portabilidad (mpegts cliente · NMS Node puro · rutas Prisma con /)
- [x] Los supervisores .sh quedan como utilidades Linux-opcionales (NSSM/systemd los sustituyen en producción)
- NOT VERIFIED: ejecución real en Windows (sin Windows en este entorno) — install.ps1/manage.ps1 sin validar en PS (sin pwsh); marcado para FASE 42/43. El runtime del código es multiplataforma verificado en la parte ejecutable aquí
- Extra: sampler FLV del pipeline hecho determinista (reconexión como el player real; bytes como métrica de continuidad) — 4/4 estable

## FASE 30 — Configuración [x]
- [x] `.env.example` FINAL completo con las ~24 variables reales que el código lee (inventario verificado con grep): obligatorias (AUTH_SECRET/REALTIME_TOKEN/DATABASE_URL) · app (PORT/TIMEZONE) · almacenamiento (MEDIA_DIR/BACKUP_DIR/LOG_DIR/DATA_DIR) · seguridad (LOGIN_RATE_LIMIT_IP_MAX/ALLOW_SVG/ALLOWED_ORIGINS/STREAM_TEST_ALLOWED_HOSTS/MEDIA_MAX_TOTAL_MB) · realtime (REALTIME_PORT/REALTIME_INTERNAL_PORT) · stream (RTMP_PORT/HTTP_FLV_PORT/HTTP_FLV_BIND) · auditoría/backups (LOG_RETENTION_DAYS/BACKUP_RETENTION) · health (REALTIME_HEALTH_URL/STREAM_HEALTH_URL) — con referencias a los instaladores que lo generan
- [x] No-commit verificado: .gitignore cubre .env*/db/*.db/worklog ✓; grep del HISTORIAL git completo: 0 secretos reales (solo fixtures DUMMY de tests y placeholders documentados)
- [x] gitleaks en CI (security job, BLOQUEANTE) con .gitleaks.toml — allowlist estricto solo para fixtures de tests

## FASE 31 — Installer [x]
- [x] Arquitectura en 3 capas: `scripts/install.ts` (CLI + preflight: bun/node/git/disco/permisos) → `scripts/lib/production-init.ts` (`initializeProduction(options)` SIN stdin/readline/process.exit) → resultado estructurado. CLI interactivo delgado encima (`scripts/init-production.ts`)
- [x] PASO 1 (bug Bun/readline): protocolo rl.close() + process.stdin.unref() + cleanup posterior; process.exit SOLO como watchdog de seguridad unref'd con evidencia en log (nunca mecanismo normal)
- [x] PASO 3-4 (protección DATABASE_URL): .env leído directamente como fuente de verdad (dotenv NO pisa variables existentes → shell contaminado hace silenciosamente que se ignore el .env local); target aplicado explícitamente a process.env y a cada hijo (spawnSync con env explícito); VERIFICACIÓN REAL del datasource vía `prisma migrate status` → abort exacto "Database target mismatch: aborting to prevent modifying another database." si difiere
- [x] Reparación de .env incompleto (solo los secretos que faltan; los existentes jamás se regeneran); DATABASE_URL absoluta (rutas relativas se resuelven contra CWD, no contra el schema); permisos 600
- [x] Multiplataforma: solo APIs fs/path/child_process (sin cp/rm/nohup embebidos); wrappers .sh/.ps1 siguen como capas por SO
- [x] Tests: `tests/initialize-core.test.ts` 24/24 — incluye el test EXIGIDO: entorno con DATABASE_URL externa distinta + .env local → target seleccionado aplicado, DB contaminante INTACTA (verificación con prisma real + sqlite)
- [x] Clone limpio REAL: escenario A (instalación completa con flags, Bun cargó el .env del directorio padre = contaminación real → guard funcionó, warning con evidencia, migraciones solo al target, EXIT=0, admin creado) y escenario B (re-run idempotente con stdin EOF: .env respetado, admin existente omitido, EXIT=0)
- [x] Dogfooding: install.ts reparó el .env del entorno dev (secrets perdidos tras reset) y creó el admin; health de la app verificado (database/storage ok)

## FASE 32 — Screen pairing [x]
> Auditoría previa: el modelo Screen YA tenía tokenHash/lastSeenAt/metadata/audioDeviceId (F5/F7) y screen:register YA validaba code+active+sha256(token) — NO se creó arquitectura paralela; se COMPLETÓ el flujo que faltaba (la TV leía el token de localStorage pero NADIE lo escribía: el emparejamiento verificado era imposible).

- [x] Flujo completo de la misión: TV nueva → selector muestra código temporal de 6 dígitos (crypto.getRandomValues, TTL 10 min con renovación automática) → Admin: Nueva pantalla con el código (code TV-### auto) o Vincular en tarjeta existente → token generado (randomBytes 24, sha256 en DB) → entrega por room `pair:<código>` del realtime (POST /broadcast interno, solo prefijo pair: permitido) → la TV lo persiste (localStorage) → re-registro VERIFICADO → reinicio conserva identidad
- [x] Órden crítico corregido (carrera REAL encontrada en E2E): el hash rige en la DB ANTES del broadcast — la TV re-registra al instante y el realtime valida contra la DB; hash huérfano revertido a null si nadie recibió el token
- [x] Robustez ante carreras: re-join periódico del pair room desde la TV (heartbeat 15s) + reintento del broadcast (600ms) — la TV muestra el código ANTES de que su socket (fallback ws→polling) se una al room
- [x] Regeneración invalida el token anterior (hash sustituido); la TV con token viejo queda rechazada (bad-token) → identidad limpiada → selector con código nuevo para re-vincular
- [x] screenCode NUNCA es el secreto (el token es independiente); el token claro NO se guarda (solo sha256); rate-limit de pair:wait (5 intentos/socket, 1 room activo)
- [x] audioDevices persistidos en Screen.metadata (throttled 60s) — el admin los ve aunque la TV esté offline
- [x] UI admin: campo "Código de vinculación de la TV" en Nueva pantalla + botón "Vincular" (solo ADMIN) por tarjeta + instrucciones actualizadas
- [x] Tests realtime (16/16): código inválido, room vacío (clients:0), flujo COMPLETO (pair:wait → pair:complete → register verificado), regeneración (token antiguo rechazado + nuevo funciona) — se suman a los 5 ya existentes (desconocida/inactiva/token malo/token bueno/sin token)
- [x] E2E (29/29 con DB fresca): 3 specs nuevos — vinculación completa con persistencia tras recarga, re-vinculación a otra TV con invalidación del token anterior, código sin TV esperando → pantalla creada sin entrega; los 26 existentes sin regresión

## FASE 33 — Recovery [x]
> Verificación REAL (no simulaciones de papel): `tests/recovery.test.ts` levanta el stack completo (app dev :3200, realtime :3203/3204, stream-service, DB temporal con migraciones reales) y SIGKILL-ea cada pieza. La caída del publicador OBS + reconexión del player ya estaban cubiertas por `tests/stream-pipeline.test.ts` (caída ~33s documentada + recuperación); la pérdida de socket de la TV por E2E #11/#12.

- [x] **Next cae** (SIGKILL al grupo de procesos) → conexión rechazada verificada → restart → health 200 → `/api/content` devuelve EXACTAMENTE el mismo contenido (DB sin corrupción) — 5.3s
- [x] **Realtime cae** (SIGKILL) → health muerto verificado → MIENTRAS está caído la app SIGUE sirviendo contenido (la TV conserva el último estado conocido + polling de respaldo) → restart → la "TV" (socket.io-client con reconnection infinita + re-registro por connect, mismo protocolo que TvDisplay) se reconecta SOLA → **exactamente UNA entrada en /status** (sin sockets duplicados) y verificada — 0.8s
- [x] **DB bloqueada** (BEGIN EXCLUSIVE desde otra conexión — simula backup/lock externo) → registro nuevo rechazado (degradado, JAMÁS crash del servicio: exitCode null) → COMMIT → registro vuelve a funcionar
- [x] **Stream-service cae** (SIGKILL con publicador activo) → status muerto → restart del servicio → ffmpeg ("OBS") reconecta → live=true + `/api/stream/status` de la app refleja serverOk+live — 1.1s
- [x] **OBS se desconecta** → cubierto por stream-pipeline (caída del publisher → live=false tras gracia; recuperación → live=true + FLV fluye)
- [x] **TV pierde socket** → cubierto por E2E #11/#12 (corte de realtime → contenido intacto → reconexión automática)
- [x] **Integridad final**: PRAGMA integrity_check=ok + counts de tablas idénticos tras TODAS las caídas (sin duplicación ni pérdida)
- [x] Suite completa estable: 230 pass / 0 fail (recovery incluido); lint ✓; typecheck ✓
- NOT VERIFIED: arranque real de systemd ante caída (este entorno no tiene systemd — las unidades F28 están validadas sintácticamente; el mecanismo Restart=always es el equivalente productivo del "restart" simulado aquí)

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
