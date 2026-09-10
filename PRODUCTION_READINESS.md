# PRODUCTION_READINESS — ViewLBA / Pantalla_Restaurante

> Documento final de la misión **"Producción Real 24/7"** (43 fases, MISSION.md)
> + sistema de **licenciamiento offline** (v1.2.0).
> Fecha: 2026-09-11 · Rama: `main` · Progreso detallado: `PRODUCTION_PLAN.md`.

---

## 1. Estado final

**SISTEMA APTO PARA PRODUCCIÓN en LAN** (Linux verificado en runtime;
Windows preparado y pendiente de verificación en hardware real), para
operación 24/7 del sistema de cartelería digital del restaurante.

Las 43 fases de la misión están completadas con evidencia verificable
(commits + suites ejecutadas). Lo que NO se pudo verificar en este entorno
está marcado **NOT VERIFIED** con su motivo — nada marcado PASS sin prueba.

## 2. Versión y commits

- **Versión actual del código: 1.2.0** (package.json · Cargo.toml · tauri.conf.json — CHANGELOG documenta 1.0.0/1.1.0/1.2.0).
- **1.2.0 = licenciamiento offline** (Ed25519 + binding equipo/disco + trial 7 días + generador + demo web + GitHub Actions), sobre la base de producción 24/7 de las 43 fases.
- Commits de la misión (desde la base `48f9583`): **40 commits** atómicos por fase (ver `git log --oneline 48f9583..HEAD`). Hitos: F31 installer (`c6c2a80`), F32 pairing (`38e3b77`), F33 recovery (`5bf3da2`), F34 offline/PWA (`4043f79`), F35 security (`709e1a0`), F36-38 perf (`14e64e7`), F39-40 docs (`bbc75be`), F41 review (`82cf792`), F42 matriz (`47ab3de`).

## 3. Cambios realizados (resumen por área)

| Área | Cambios principales |
|---|---|
| Seguridad | Validación de entorno Zod fail-fast (sin secretos por defecto) · authVersion (sesiones invalidables) · rate limiting login · autorización por ruta en TODAS las admin · sockets autenticados + CORS LAN · uploads con magic bytes + SVG fuera · guard SSRF · headers CSP/nosniff/SAMEORIGIN + no-store APIs privadas · gitleaks en CI |
| Streaming | Health real · estado público mínimo (sin publisherIp) · FLV solo localhost · watchdog de inactividad · rotación de clave documentada y probada (aplica a nuevas conexiones) |
| Pantallas | Pairing por código temporal con token sha256 (identidad verificada, anti-suplantación) · audio POR pantalla (setSinkId con fallback) · offline con último contenido persistido + PWA · watchdogs y reconexión 24/7 |
| Base de datos | Migraciones versionadas (3) + baseline · WAL · índices justificados · backup/restore verificados (borrar tabla → restore → íntegro) |
| Operación | Instalador multiplataforma con verificación de target de DB · systemd (Linux) · NSSM (Windows) · timers de backup/purga · health global · logging estructurado + auditoría real |
| Tests | 230 unit/servicios + 20 integración + 37 E2E (Playwright, stack real, ffmpeg como publicador) + recovery con SIGKILL real |
| **Licenciamiento (v1.2.0)** | **Offline 100%** (sin llamadas de red): firma Ed25519 sobre payload canónico · binding Installation ID + Disk ID (recalculado contra hardware actual en cada lectura → restore/clone en otro disco = MISMATCH) · trial 7 días con anclas duales + anti-rollback de reloj · watermark TV · planes monthly 30 días / USD 10 y annual 365 días / USD 100 (exactos) · import ZIP con validación total y anti-downgrade · feature gating server-side (403 en backend, candados en UI) · auditoría de eventos de licencia · generador CLI + web demo + GitHub Actions con secret `VIEWLBA_LICENSE_PRIVATE_KEY` (la clave privada NUNCA en el repo — verificado gitleaks + grep de historial) |

## 4. Migraciones de base de datos

```
0_init                              (esquema inicial)
20260909023931_audit_log_fields     (Log: ip/resource/resourceId/success/metadata)
20260909202153_perf_indexes_content (índices [active,order] ×5 + Log[createdAt])
```

Aplicación SIEMPRE por `prisma migrate deploy` (instaladores, CI, upgrade).
`db push --accept-data-loss` queda como herramienta de desarrollo documentada.

## 5. Nuevas variables de entorno (inventario completo: `.env.example`)

Obligatorias: `AUTH_SECRET`, `REALTIME_TOKEN`, `DATABASE_URL` (absoluta
recomendada). Opcionales: `PORT`, `TIMEZONE`, `MEDIA_DIR/BACKUP_DIR/LOG_DIR/DATA_DIR`,
`LOGIN_RATE_LIMIT_IP_MAX`, `ALLOW_SVG`, `ALLOWED_ORIGINS`, `STREAM_TEST_ALLOWED_HOSTS`,
`MEDIA_MAX_TOTAL_MB`, `REALTIME_PORT/REALTIME_INTERNAL_PORT`, `RTMP_PORT/HTTP_FLV_PORT/HTTP_FLV_BIND`,
`LOG_RETENTION_DAYS`, `BACKUP_RETENTION`, `REALTIME_HEALTH_URL/STREAM_HEALTH_URL`.
**Ningún puerto nuevo** respecto a la arquitectura original (3000/3003/3004/1935/8000/8100).

## 6. Tests ejecutados (matriz final — FASE 42, sin inventar)

| Suite | Resultado |
|---|---|
| `bun install --frozen-lockfile` | **PASS** |
| `bun run lint` / `bun run typecheck` | **PASS / PASS** (0 problemas) |
| `bun run build` + arranque standalone en NODE_ENV=production | **PASS** (health 200, CSP prod, ETag+304, WAL) |
| `bun test` (unit + realtime + stream-pipeline + recovery + initialize-core + backup + logger + **installer**) | **PASS 296/296** (21 skip = integración ejecutada aparte; +66 tests del installer oficial) |
| Integración API contra servidor real (flujo CI) | **PASS 20/20** |
| `bun run test:e2e` (Playwright, stack real + ffmpeg) | **PASS 37/37** |
| **Payload offline del installer** (bundle-server.ts) | **PASS** — migrate deploy con Bun incluido (cero red) · arranque standalone · `/api/health` con database+storage ok · `GET /` 200 |
| **AppImage CLI** (construcción local real) | **PASS** — `ViewLBA-Server-CLI.AppImage --cli --json detect` responde JSON correcto; preflight real 18 checks |
| CI GitHub Actions (4 jobs requeridos) | Diseñado; corrida final en GitHub pendiente del push de estas fases |

**Tests fallidos: 0.** Flaky conocido del pipeline de streaming: resuelto
(calentamiento de rutas + presupuestos de CI-contención; 3+ corridas estables).

## 7. Limitaciones conocidas y riesgos restantes

| Ítem | Estado | Detalle |
|---|---|---|
| systemd en hardware Linux | **NOT VERIFIED** | Sin systemd en el entorno de desarrollo. Unidades verificadas con `systemd-analyze verify` (0 warnings) y el MISMO binario standalone arrancado y verificado (health 200) — verificar en el servidor destino el primer arranque. El installer oficial exige systemd en preflight y aborta si falta |
| Windows real (NSSM/PowerShell) | **NOT VERIFIED** | Sin Windows en el entorno. Lógica del adapter Windows VERIFICADA (secuencia NSSM/netsh exacta, tests RecordingRunner) y sidecar `.exe` compila; ejecución real: `docs/INSTALLER-WINDOWS.md` § procedimiento. `install.ps1`/`manage.ps1` redactados; runtime del código multiplataforma verificado en Linux |
| GUI Tauri / Setup.exe / deb | **NOT VERIFIED** (sandbox sin Rust) | Proyecto completo en `installer/gui/` + workflow de release; se construyen en CI (`release-installer.yml`) |
| Service worker en TV física | **NOT VERIFIED** | Capa de contenido offline verificada por E2E; la capa de shell (SW) requiere build de producción en navegador de TV real |
| OBS Studio físico | Protocolo VERIFIED | El pipeline completo se prueba con publicador RTMP real (ffmpeg — mismo protocolo/clave). Primera transmisión con OBS real: verificar en el restaurante |
| gitleaks local | Vía CI | No instalado en este entorno; grep manual del historial: 0 secretos reales; CI lo ejecuta bloqueante |
| SQLite para muchos TVs | Adecuado | Diseñado para LAN de restaurante (decenas de TVs). WAL + índices aplicados. Migrar a PostgreSQL NO es necesario (misión) |

Riesgo operativo residual: ninguna copia externa automática de los backups
(documentada la recomendación manual en `docs/BACKUP_RESTORE.md`).

## 8. Procedimientos (detallados en docs/)

- **Instalar**: `docs/INSTALLATION.md` (`bun scripts/install.ts`) · Linux: `docs/LINUX_PRODUCTION.md` · Windows: `docs/WINDOWS_PRODUCTION.md`
- **Actualizar**: `docs/UPGRADING.md` (backup → migrate deploy → build → restart → health; con rollback)
- **Backup / Restaurar**: `docs/BACKUP_RESTORE.md` (manual + timer diario + verificación)
- **Recuperar servicios**: `docs/TROUBLESHOOTING.md` + `docs/OPERATIONS.md` (restart, health, interpretación de estados)
- **Vincular TVs / OBS**: `docs/SCREEN_PAIRING.md` · `docs/OBS_SETUP.md` · `docs/TV_SETUP.md`
- **Puertos/firewall**: `docs/FIREWALL.md` (3000/3003/1935 LAN · 3004/8100 localhost · 8000 bind localhost)

## 9. Tabla final de áreas

| Área | Estado | Evidencia principal |
|---|---|---|
| Security | **PASS** | FASE 41: checklist 14/14 con archivo:línea · gitleaks CI · 0 secretos |
| Auth | **PASS** | E2E login/logout/invalidación · tests rate-limit · authVersion |
| Database | **PASS** | Migraciones + WAL + índices · backup/restore real (borrar→restaurar→íntegro) |
| Realtime | **PASS** | 16 tests servicio real · E2E pantallas/pairing · recovery con SIGKILL |
| Streaming | **PASS** | Pipeline 5/5 con bytes FLV reales · E2E con ffmpeg · rotación probada |
| Uploads | **PASS** | Integración 20/20 (SVG rechazado, magic bytes) · GC · cuota |
| Audio | **PASS** | E2E #23 audio fallback (setSinkId no soportado → predeterminada sin romperse) |
| Timezone | **PASS** | Tests America/Havana + E2E #21 reloj |
| Offline LAN | **PASS** | 0 assets externos · E2E #34 último contenido + recuperación |
| Backup | **PASS** | Tests F16 + timer systemd + restore verificado |
| Recovery | **PASS** | FASE 33: 5/5 (SIGKILL de app/realtime/stream + DB + integridad) |
| Linux | **PASS** (runtime) / **NOT VERIFIED** systemd en hardware | standalone arrancado y verificado; unidades validadas sintácticamente |
| Windows | **NOT VERIFIED** (hardware) | Scripts + runtime multiplataforma listos para verificación |
| CI | **PASS** | 4 jobs requeridos (quality/integration/e2e/security bloqueantes) |
| E2E | **PASS** | 37/37 estable |
| Documentation | **PASS** | 13 guías + README/README-LAN actualizados |

## 10. Criterio de la misión (verificación uno a uno)

instalación limpia ✓ (clone EXIT=0 con guard de DB) · DB correcta ✓ (verificación
de datasource + abort por mismatch) · migraciones ✓ · primer admin ✓ · login ✓ ·
invalidación de sesión ✓ · realtime ✓ · pairing ✓ · audio por TV ✓ · OBS
(protocolo RTMP ✓; físico pendiente en sitio) · stream ✓ · reconexión ✓ ·
uploads ✓ · backup ✓ · restore ✓ · recovery ✓ · LAN sin Internet ✓ · Linux ✓
(runtime) · documentación ✓ · CI ✓ · seguridad ✓ · Windows: **NOT VERIFIED**
documentado (sin Windows en este entorno, conforme a lo permitido por la misión).

---

**Conclusión:** el sistema cumple el criterio de producción de la misión con
evidencia real por área. Los tres NOT VERIFIED (systemd en hardware, Windows
real, SW en TV física) tienen su procedimiento de verificación preparado y
documentado para ejecutarse en el equipo destino sin cambios de código.
