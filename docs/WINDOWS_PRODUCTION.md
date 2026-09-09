# Producción en Windows (NSSM) — FASE 29

> Guía de despliegue del sistema en un PC/mini-PC Windows del restaurante.
> Instalación: `deploy\windows\install.ps1` · Gestión: `deploy\windows\manage.ps1`.
> Para Linux con systemd: ver `docs/OPERATIONS.md`.

---

## Requisitos

| Componente | Versión | Cómo instalarlo |
|---|---|---|
| Windows | 10/11 o Server 2019+ (64 bits) | — |
| Bun | 1.1+ | `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| NSSM (servicios) | 2.24+ | `choco install -y nssm` o <https://nssm.cc> (nssm.exe al PATH) |
| Git (opcional, para updates) | cualquiera | <https://git-scm.com> |

No se necesita Node por separado: Bun ejecuta la app, Prisma y los mini-servicios. OBS Studio y las TVs son clientes externos (LAN).

## Arquitectura

| Servicio Windows (NSSM) | Qué ejecuta | Puertos |
|---|---|---|
| `PantallaRestaurante` | `bun scripts\start.ts` → build standalone (NODE_ENV=production) | 3000 (app/API/proxy FLV) |
| `PantallaRestauranteRealtime` | `bun mini-services\realtime-service\index.ts` | 3003 (websocket), 3004 (interno) |
| `PantallaRestauranteStream` | `bun mini-services\stream-service\index.ts` | 1935 (RTMP OBS), 8000/8100 (internos) |

Los tres servicios se reinician solos tras una caída (retraso 5 s — operación 24/7) y rotan sus logs por tamaño (5 MB).

**Layout:**

```
C:\PantallaRestaurante\
├─ app\              código + build standalone + .env (secretos, jamás al repo)
├─ data\             db\custom.db · media\ · backups\ · store\ (NMS)
└─ logs\             logs de servicios + JSON estructurado (rotativo)
```

## Instalación

```powershell
# 1. Copia el repo al equipo (git clone o zip) y ábrelo
cd C:\ruta\al\checkout

# 2. Instala (Administrador):
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1
```

El instalador verifica bun/NSSM, crea el layout, genera secretos criptográficos en `app\.env`, instala dependencias (raíz + mini-servicios), aplica **migraciones versionadas** (`prisma migrate deploy`), construye el standalone (script portable, sin comandos POSIX), instala los tres servicios NSSM, añade las reglas de firewall (3000/3003 para la LAN, 1935 para OBS) y espera el health real.

**Primer administrador** (una sola vez):

```powershell
cd C:\PantallaRestaurante\app
bun scripts\init-production.ts
```

> El instalador NO crea los usuarios demo (esos solo existen en desarrollo).

## Gestión diaria

```powershell
powershell -File C:\PantallaRestaurante\app\deploy\windows\manage.ps1 status
powershell -File ...\manage.ps1 restart realtime     # solo un servicio
powershell -File ...\manage.ps1 logs                  # seguir logs de la app
powershell -File ...\manage.ps1 backup                # backup manual YA
powershell -File ...\manage.ps1 restore C:\PantallaRestaurante\data\backups\pantalla-restaurante-....db
powershell -File ...\manage.ps1 upgrade C:\ruta\al\checkout-actualizado
```

Estados: `start` · `stop` · `restart [app|realtime|stream]` · `status` · `logs` · `health` · `backup` · `restore <db>` · `upgrade <ruta>`.

## Backup automático

NSSM no trae temporizadores como systemd: programa el backup diario con el Programador de tareas de Windows (una vez):

```powershell
$act = New-ScheduledTaskAction -Execute "C:\Users\...\bun.exe" `
  -Argument "C:\PantallaRestaurante\app\scripts\backup.ts" -WorkingDirectory "C:\PantallaRestaurante\app"
$trg = New-ScheduledTaskTrigger -Daily -At 03:00
Register-ScheduledTask -TaskName "PantallaRestaurante-Backup" -Action $act -Trigger $trg -RunLevel Highest
```

La purga de auditoría puede programarse igual (`scripts\logs-purge.ts`, 04:00).

## Firewall

El instalador crea las reglas para la red detectada; ajústalas si la máscara difiere:

```powershell
netsh advfirewall firewall set rule name="PantallaRestaurante-App" new remoteip=192.168.1.0/24
```

- `3000/tcp` → toda la LAN (TVs + equipos admin)
- `3003/tcp` → toda la LAN (websocket de pantallas y paneles)
- `1935/tcp` → solo el equipo con OBS
- 8000/8100 NO se abren (solo localhost — el proxy los consume)

## Recuperación ante fallos

| Síntoma | Acción |
|---|---|
| La app no arranca | `manage.ps1 logs` y `C:\PantallaRestaurante\logs\PantallaRestaurante.err.log` |
| TVs sin actualizaciones | `manage.ps1 health` → realtime caído → `manage.ps1 restart realtime` (las TVs reconectan solas) |
| OBS no conecta | `manage.ps1 health` → stream caído → `manage.ps1 restart stream`; verifica la clave en el panel (Transmisión) |
| DB dañada | `manage.ps1 restore <último-backup>` |
| Disco lleno | purgar `data\media` con `bun scripts\media-gc.ts` o ampliar `MEDIA_MAX_TOTAL_MB` en `app\.env` |

## Verificación en Windows (estado honesto)

- ✅ Verificado aquí: build portable (`scripts/build.ts`, sin `cp -r`), arranque portable (`scripts/start.ts`, sin prefijo `NODE_ENV=` ni `tee`), scripts de datos en Bun multiplataforma (backup/restore/purge), unidades de instalación/gestión redactadas.
- ⚠️ NOT VERIFIED: ejecución real en Windows (este entorno es Linux). Pendiente de validar en hardware: `install.ps1`, servicios NSSM, firewall, rutas `C:\PantallaRestaurante\*`. Marcado para la matriz final (FASE 42/43).
- Notas técnicas: `mpegts.js` es 100 % cliente (navegador de la TV — independiente del SO servidor); Node Media Server es Node puro (funciona en Windows); Prisma + SQLite usan rutas absolutas con `/` en `DATABASE_URL`.
