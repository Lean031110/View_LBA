# Arquitectura Windows Service Host — ViewLBA Server

> **Decisión arquitectónica Fase 2 misión §3-§5.** Define por qué ViewLBA
> usa un ÚNICO servicio Windows nativo (host) que gestiona internamente
> App + Realtime + Stream, en lugar de 3 servicios SCM separados.
>
> Fecha: 2026-09-30 · Estado: ACEPTADO · Branch: `feature/production-master-audit`

## 1. Contexto

El instalador Windows actual (commit `fcb7428`) usa **NSSM 2.24** para
registrar 3 servicios SCM independientes:

- `PantallaRestaurante`        → `bun scripts/start.ts`  (app Next.js, :3000)
- `PantallaRestauranteRealtime` → `bun mini-services/realtime-service/index.ts` (:3003/:3004)
- `PantallaRestauranteStream`  → `bun mini-services/stream-service/index.ts` (RTMP :1935, HTTP-FLV :8000)

La misión §0.8 prohíbe NSSM, §0.9 prohíbe PowerShell como bandeja, §3 exige
`Program Files` + `ProgramData`, §4 exige service host nativo Rust y §5 pide
evaluar si conviene 1 o 3 servicios SCM.

Este documento responde a la pregunta: **¿1 servicio SCM o 3?**

## 2. Análisis: ¿Stream necesita aislamiento de proceso?

### 2.1 Argumentos a favor de aislar Stream

El stream-service envuelve `node-media-server` (NMS). NMS tiene
comportamientos conocidos que justifican barreras de proceso fuertes:

| Comportamiento de NMS | Riesgo si comparte proceso con App |
|---|---|
| Memory leaks documentados (issues NMS #449, #580, #714) | OOM mata el proceso contenedor → App admin panel también cae |
| File handle leaks en desconexión abrupta de clientes RTMP | `EMFILE` puede bloquear también las rutas API de App |
| Crash on malformed RTMP handshake (NMS issue #244) | Un cliente malicioso tiraría App, no solo Stream |
| CPU intensiva si se habilita transcoding | Scheduler starvation del event loop de App |
| Posibilidad de recibir input externo (puerto 1935 expuesto a LAN) | Mayor superficie de ataque en el mismo proceso que maneja auth |

**Veredicto Stream: SÍ necesita aislamiento de proceso.**

### 2.2 Argumentos a favor de aislar Realtime

El realtime-service es socket.io + hub de pantallas/admins. También tiene
su propio `node_modules` aislado. Razones para aislar:

- Estado de conexiones en memoria (si App reinicia, no perder pantallas).
- Comunicación por token interno (X-Internal-Token HMAC) — aislamiento de
  credenciales.
- Diferente ciclo de vida: App puede reiniciarse para hot-reload del
  panel sin afectar pantallas conectadas.

**Veredicto Realtime: SÍ necesita aislamiento de proceso.**

### 2.3 Argumentos a favor de aislar App

App es el Next.js standalone. Puede reiniciarse para despliegues de
nuevo código sin afectar pantallas conectadas a Realtime ni stream activo.

**Veredicto App: SÍ necesita aislamiento de proceso.**

## 3. Decisión

**1 servicio SCM (host) que gestiona internamente 3 procesos hijos.**

```
Windows Service Control Manager (SCM)
    ↓
ViewLBA (single SCM-registered service)
    binario: C:\Program Files\ViewLBA Server\bin\viewlba-service.exe
    account: LocalSystem (con covertura de firewall + ProgramData ACL)
    recovery: restart 5s, 10s, 60s (backoff)
    ↓
    [internal watchdog + supervisor]
    ↓                                  ↓                                  ↓
    app child                         realtime child                     stream child
    bun.exe scripts/start.ts          bun.exe mini-services/             bun.exe mini-services/
    cwd: Program Files\ViewLBA Server\app realtime-service\index.ts      stream-service\index.ts
                                       cwd: ...\app                      cwd: ProgramData\ViewLBA
    logs: ProgramData\ViewLBA\logs\   logs: ...\logs\                    logs: ...\logs\
    backoff: 5s/30s/5min              backoff: 5s/30s/5min               backoff: 5s/30s/5min
    health: http://localhost:3000/   health: http://localhost:3003/    health: http://localhost:8100/
            api/health                       health                            health
```

### 3.1 Por qué un único SCM service y no tres

| Criterio | 1 servicio host | 3 servicios SCM separados |
|---|---|---|
| Aislamiento de proceso entre App/Realtime/Stream | ✅ (3 hijos separados) | ✅ (3 servicios separados) |
| Recuperación independiente por child | ✅ (watchdog interno reinicia hijo, SCM no se entera) | ✅ (cada uno tiene su propio recovery en SCM) |
| Complejidad SCM | 1 servicio a instalar/desinstalar | 3 servicios — 3 starts, 3 stops, 3 deletes, 3 dependencies |
| IPC tray ↔ host | ✅ Una sola named pipe con status agregado | ❌ 3 pipes o un proceso agregador aparte |
| Orden de arranque (stream → realtime → app) | ✅ Coordinado por el host | ⚠️ SCM dependencies son frágiles, mejor evitar |
| Backoff granular por child | ✅ Cada hijo tiene su propio backoff state | ✅ SCM lo da pero con menos control |
| Health real por child | ✅ Host hace HTTP a cada child + SCM status | ✅ Cada SCM tiene health propio |
| Upgrade de un solo componente | ✅ Host puede matar/reiniciar hijo individualmente | ⚠️ Requiere reiniciar servicio SCM específico |
| NSSM-free | ✅ Sin NSSM por diseño | ❌ Sin NSSM necesitaría 3 service hosts Rust |
| Logs estructurados centralizados | ✅ Host logea eventos de los 3 hijos en un solo sitio | ❌ 3 logs SCM separados |
| Single-instance guarantee | ✅ Host único por diseño | ❌ 3 servicios pueden quedar en estados inconsistentes |

**Conclusión**: el único beneficio REAL de 3 SCM services sería poder
reiniciarlos con `sc.exe stop/start` individualmente desde afuera — pero
eso es exactamente lo que la misión §5 PROHÍBE (no usar `sc.exe`, ni
`net.exe`, ni `cmd.exe`). La bandeja y el CLI deben hablar con el host
vía IPC, no vía SCM.

### 3.2 Excepción documentada (misión §3)

**¿Por qué NO se aplica la excepción de separar Stream a su propio SCM
service, pese a §2.1?**

Porque el aislamiento de PROCESO (que Stream SÍ necesita) no requiere
aislamiento de SCM SERVICE. El host Rust genera `bun.exe` para cada
child con `CreateProcessW` + `CREATE_NEW_PROCESS_GROUP` lo que da:

- Heap aislado (un OOM en Stream no afecta App)
- File descriptor table aislada
- Signal handling aislado
- Exit code independiente observable
- Watchdog por child con backoff propio

Todo esto es EXACTAMENTE el mismo aislamiento que daría un SCM service
separado, sin la complejidad de coordinar 3 entradas SCM.

**Excepción sería válida si**: una futura funcionalidad requiriera que
Stream se ejecute en una cuenta de Windows distinta (p.ej. Network
Service para acceso a red cruda) — en ese caso sí se justificaría un
SCM service aparte con su propio `ServiceInstall`. Hoy no aplica.

## 4. Binarios resultantes

| Binario | Ubicación instalación | Fuente | Rol |
|---|---|---|---|
| `viewlba-service.exe` | `C:\Program Files\ViewLBA Server\bin\` | `installer/native/windows-service/` (Rust) | Service host: SCM dispatcher + supervisor + IPC server + health |
| `viewlba-tray.exe` | `C:\Program Files\ViewLBA Server\bin\` | `installer/native/windows-tray/` (Rust) | Bandeja: icono, menú, IPC client, single-instance |
| `bun.exe` | `C:\Program Files\ViewLBA Server\runtime\` | payload (ya existe) | Runtime para los 3 hijos |
| `viewlba-installer.exe` | `C:\Program Files\ViewLBA Server\bin\` | `installer/cli/` (TS) | Sidecar de instalación (DB, .env, admin) |

## 5. Layout de rutas (Program Files + ProgramData)

```
C:\Program Files\ViewLBA Server\           <- solo binarios, runtime, assets estáticos
├── bin\
│   ├── viewlba-service.exe                <- service host
│   ├── viewlba-tray.exe                   <- tray binario
│   └── viewlba-installer.exe              <- sidecar de install
├── runtime\
│   ├── bun.exe                            <- runtime (incluido, offline-first)
│   └── *.dll                              <- deps de bun
├── app\                                   <- Next.js standalone
│   ├── server.js
│   ├── .next\standalone\
│   └── node_modules\.prisma\              <- Prisma client + engines
├── mini-services\
│   ├── realtime-service\
│   │   ├── index.ts
│   │   └── node_modules\
│   └── stream-service\
│       ├── index.ts
│       └── node_modules\
├── themes\                                <- assets estáticos del tema
└── public\                                <- logos, icons

C:\ProgramData\ViewLBA\                    <- datos, config, logs, backups
├── config\
│   ├── viewlba.env                        <- AUTH_SECRET, REALTIME_TOKEN, DATABASE_URL (ACL: SYSTEM only)
│   ├── install-config.json                <- último config aplicado
│   └── service-host.toml                  <- config del host (puertos, paths, backoff)
├── data\
│   ├── db\custom.db                       <- SQLite
│   ├── media\                             <- uploads
│   ├── backups\                           <- db backups
│   └── store\                             <- NMS media storage
├── logs\
│   ├── service-host.log                   <- log del host Rust (structured)
│   ├── app.log + app.err.log              <- stdout/stderr del child app
│   ├── realtime.log + realtime.err.log
│   ├── stream.log + stream.err.log
│   └── tray.log
├── credentials\
│   └── CREDENCIALES.txt                   <- admin email + password (ACL: SYSTEM +Administrators)
├── cache\
│   └── .views                            <- cache de views generadas
└── run\
    ├── viewlba-service.pid                <- pid del host (info only, no coordination)
    ├── viewlba-tray.pid                    <- pid del tray (single-instance)
    └── viewlba-service.ipc                 <- named pipe handle marker
```

**ACLs**:
- `Program Files\ViewLBA Server\`: `SYSTEM` + `Administrators` (read/exec).
  `Users` read/exec solo. **NUNCA escribir secretos aquí.**
- `ProgramData\ViewLBA\config\`: `SYSTEM` + `Administrators` full.
  `Users` sin acceso. **Aquí viven los secretos.**
- `ProgramData\ViewLBA\logs\`: `SYSTEM` + `Administrators` full.
  `Users` read. **No secretos pero info de diagnosis.**
- `ProgramData\ViewLBA\credentials\CREDENCIALES.txt`: `SYSTEM` + `Administrators` full + `Users` sin acceso. Solo el owner del servicio y el tray (que corre como el usuario activo) pueden leerlo vía ACL elevada.

## 6. IPC tray ↔ service host

Mecanismo: **Windows Named Pipe** con DACL restrictiva.

```
Pipe name: \\.\pipe\viewlba-service

Protocolo (JSON line-delimited, una request por línea):

Tray → Host:
  {"cmd":"status"}                            → estado agregado de los 3 hijos
  {"cmd":"start","svc":"all|app|realtime|stream"}
  {"cmd":"stop","svc":"..."}
  {"cmd":"restart","svc":"..."}
  {"cmd":"health"}                            → forzar health check ahora
  {"cmd":"open-panel"}                        → host responde con URL
  {"cmd":"open-logs","which":"app|realtime|stream|host"}
  {"cmd":"quit"}                              → solo el tray se cierra, host sigue

Host → Tray (eventos async):
  {"event":"state","app":"running","realtime":"starting","stream":"running"}
  {"event":"health","app":"ok","realtime":"ok","stream":"degraded"}
  {"event":"restart","svc":"app","reason":"exit_code_1","attempt":1}
  {"event":"log","level":"info","msg":"Stream child respawned"}
```

**Seguridad**:
- DACL de la pipe: solo `SYSTEM` + `Administrators` + el SID del usuario
  que lanzó el tray (query on connect).
- Tamaño máximo de mensaje: 8 KB (defensa contra abuso).
- Timeout de conexión: 5 s (el tray no se cuelga si el host está ocupado).

## 7. Watchdog y backoff por child

Cada child tiene su propio estado de backoff:

```
attempt 0: child exit code != 0
  → wait 5s, respawn
attempt 1: child exit code != 0 within 60s of respawn
  → wait 30s, respawn
attempt 2+: child exit code != 0
  → wait 5min, respawn
  → emit {"event":"degraded","svc":"...","reason":"backoff_5min"}
attempt 10 (consecutivos): child sigue muriendo
  → status del child = "failed"
  → host NO abandona: sigue en bucle de 5min
  → tray muestra "fallido" (rojo)
  → host sigue ejecutando los otros 2 hijos
```

Exit code 0 del child se considera shutdown limpio (no respawn).
Exit code 130 (SIGINT en Unix) — en Windows no aplica, pero si el
child hace `process.exit(0)` intencional, no se respawnea.

## 8. Health real (misión §0.10)

El host ejecuta cada 5s (configurable):

```rust
fn check_health() -> HealthReport {
    let app = http_get("http://127.0.0.1:3000/api/health", 2_000);
    let realtime = http_get("http://127.0.0.1:3003/health", 2_000);
    let stream = http_get("http://127.0.0.1:8100/health", 2_000);
    let db = check_sqlite_writable(&layout.db_path);
    let storage = check_dir_writable(&layout.media_dir);
    HealthReport {
        app: app.status,         // ok | degraded | down
        database: db,            // ok | down
        storage: storage,        // ok | down
        realtime: realtime.status,
        stream: stream.status,
        overall: worst_of_all(),
    }
}
```

Si `overall == down` por >60s, el host entra en modo diagnóstico:
- Reinicia el child con peor estado
- Emite evento `{"event":"degraded",...}` al tray

## 9. Shutdown limpio (graceful shutdown)

```
SCM STOP → host recibe SERVICE_CONTROL_STOP
  → host envía SIGTERM-equivalente (CtrlEvent CTRL_BREAK_EVENT) a cada child
  → wait 30s para que cada child haga process.exit(0)
  → si child no sale en 30s: kill con TerminateProcess (forceful)
  → host cierra named pipe server
  → host reporta SERVICE_STOPPED a SCM
  → exit(0)
```

`TimeoutStopSec=30` se documenta como contrato del servicio.

## 10. Logging estructurado (misión §2)

El host Rust logea a `C:\ProgramData\ViewLBA\logs\service-host.log` en
formato JSON lines, un evento por línea:

```json
{"ts":"2026-09-30T12:34:56.789Z","level":"info","phase":"services","msg":"Stream child respawned","attempt":1,"exit_code":1,"binary":"bun.exe","argv":["mini-services/stream-service/index.ts"],"cwd":"C:\\Program Files\\ViewLBA Server","service":"ViewLBAStream","runtime_version":"bun 1.3.14","duration_ms":4321}
```

**NUNCA** logea:
- passwords, tokens, AUTH_SECRET, REALTIME_TOKEN
- DATABASE_URL con credenciales
- Bearer tokens
- el contenido de `viewlba.env`

Para diagnosticar un fallo del host, los campos obligatorios son
(misión §2): `phase`, `command`, `argv`, `cwd`, `exit_code`, `stdout`,
`stderr`, `timed_out`, `timeout_ms`, `service`, `binary_path`,
`runtime_version`.

## 11. Single-instance tray

El tray `viewlba-tray.exe` crea un mutex con nombre
`Global\viewlba-tray-single-instance` al arrancar. Si ya existe, el
segundo proceso sale inmediatamente con exit 0.

## 12. Ciclo de vida del service host

```
1. installer corre: viewlba-service.exe --install
   → host se registra con SCM (CreateServiceW)
   → host sale con exit 0
2. installer corre: viewlba-service.exe --start
   → host hace StartServiceW sobre sí mismo
   → host sale con exit 0
3. SCM arranca el servicio (como LocalSystem):
   → host arranca en modo servicio (StartServiceCtrlDispatcher)
   → host crea named pipe server
   → host crea 3 child processes (bun)
   → host supervisa + health-check loop
4. SCM STOP o shutdown del sistema:
   → host recibe SERVICE_CONTROL_STOP
   → graceful shutdown de los 3 hijos
   → host sale con exit 0
5. Child cae:
   → host detecta exit code != 0
   → backoff + respawn
   → no afecta a los otros 2 children
6. Host cae (crash):
   → SCM recovery: restart 5s
   → host arranca de nuevo, levanta los 3 hijos
7. Uninstall:
   → host recibe SERVICE_CONTROL_STOP
   → host sale
   → installer hace DeleteServiceW
   → installer marca SCM para borrar al cerrar
```

## 13. Alternativas consideradas y rechazadas

| Alternativa | Razón de rechazo |
|---|---|
| 3 SCM services + NSSM | Prohibido por §0.8 |
| 3 SCM services + Rust host por service | 3 hosts separados, IPC complejo, no aporta nada vs 1 host |
| 1 SCM service + Bun como supervisor principal | Bun tiene issues conocidos con procesos hijos de larga duración (lección del build 15-18 de v3.2.0 documentada en windows-exit-diag.yml). Rust es más estable para supervisor. |
| Tauri como service host | Tauri está pensado para apps GUI, no para service hosts. El repo YA tiene Tauri en `installer/gui/` para la GUI del instalador, pero NO para el service. |
| Worker service + Win32 service | Worker service (.NET) requiere .NET runtime — misión §0.5 exige offline-first sin instalar runtimes externos. Rust compila a nativo, sin runtime. |

## 14. Riesgos residuales

| Riesgo | Mitigación |
|---|---|
| Rust toolchain MSVC no disponible en CI Windows runner | GitHub Actions windows-latest incluye MSVC Build Tools; rustup instala Rust stable; target `x86_64-pc-windows-msvc` se añade en el workflow |
| `windows-rs` API surface cambia entre versiones | Pin a una versión en `Cargo.toml` |
| Named pipe DACL mal configurada | Tests de packaging verifican que un usuario no-admin no puede conectarse a la pipe del servicio |
| El host colgándose por un panic de Rust | SCM recovery reinicia el host; tests de packaging fuerzan un panic y verifican que SCM lo levanta |
| Stream child zombie si el host muere abruptamente | En arranque, el host hace `taskkill /F /IM bun.exe` solo sobre los PIDs que tenga registrados en `run\*.pid` — opcional, documentado |
| Upgrade in-place puede dejar children viejos corriendo | El host al arrancar mata los bun.exe hijos que estén corriendo bajo su ruta de instalación |

---

**Fin del documento.** Implementación del host: `installer/native/windows-service/`.
