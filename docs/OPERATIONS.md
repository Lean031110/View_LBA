# OPERATIONS — Runbook de producción (Linux)

> Guía operativa del despliegue en Linux con systemd (FASE 28).
> Instalación inicial: `deploy/linux/install.sh` · Gestión diaria: `deploy/linux/manage.sh`.
> Para Windows: ver `docs/WINDOWS_PRODUCTION.md` (FASE 29).

---

## Arquitectura del despliegue

| Servicio systemd | Qué es | Puerto(s) |
|---|---|---|
| `pantalla-restaurante.service` | App Next.js (build standalone, producción) | 3000 (HTTP app + API + proxy FLV) |
| `pantalla-restaurante-realtime.service` | Hub Socket.io (pantallas + paneles admin) | 3003 (websocket), 3004 (API interna) |
| `pantalla-restaurante-stream.service` | RTMP ingest + HTTP-FLV (OBS → TVs) | 1935 (RTMP), 8000 (FLV, solo localhost), 8100 (control) |
| `pantalla-restaurante-backup.timer` | Backup diario de SQLite (03:00) | — |
| `pantalla-restaurante-logs-purge.timer` | Purga de auditoría (04:00) | — |

**Layout de directorios:**

| Ruta | Contenido | Permisos |
|---|---|---|
| `/opt/pantalla-restaurante` | Código + build (standalone) | root:pantalla (servicio solo lectura) |
| `/var/lib/pantalla-restaurante` | DB SQLite (`db/`), medios (`media/`), backups, datos NMS | pantalla:pantalla 750 |
| `/var/log/pantalla-restaurante` | Logs JSON estructurados (rotativos 5 MB × 5) | pantalla:pantalla 750 |
| `/etc/pantalla-restaurante.env` | Entorno + secretos | root:pantalla 600 |

**Usuario:** `pantalla` (cuenta de sistema, sin login, sin root). Los servicios corren con `ProtectSystem=strict`, `NoNewPrivileges`, límites de memoria/CPU y `Restart=always` (caída → reinicio en 5 s; operación 24/7).

---

## Instalación inicial

```bash
# Desde el checkout del repositorio, como root:
sudo bash deploy/linux/install.sh
```

El instalador es idempotente: verifica dependencias (bun/openssl/curl/rsync), crea el usuario `pantalla`, genera secretos reales con `openssl rand` si no existían, sincroniza el código a `/opt/pantalla-restaurante`, instala dependencias (raíz + mini-servicios), aplica **migraciones versionadas** (`prisma migrate deploy`), construye el build standalone, instala las unidades systemd, habilita el arranque automático y los timers, y espera el health real antes de dar por buena la instalación.

**Primer administrador** (solo una vez, tras instalar):

```bash
sudo -u pantalla -H bash -lc \
  'cd /opt/pantalla-restaurante && set -a && source /etc/pantalla-restaurante.env && set +a && bun scripts/init-production.ts'
```

> Nunca uses los usuarios demo (`admin@restaurante.com/admin123`) fuera de desarrollo: el instalador de producción no los crea.

---

## Comandos diarios

Todos vía `sudo bash /opt/pantalla-restaurante/deploy/linux/manage.sh <cmd>` (o directamente con `systemctl`/`journalctl`):

| Comando | Qué hace |
|---|---|
| `start` | Arranca stream → realtime → app (orden de dependencia) y muestra health |
| `stop` | Detiene app → realtime → stream |
| `restart` | Reinicia todo; `restart app` / `restart realtime` / `restart stream` para uno solo |
| `status` | `systemctl status` de los tres + timers + health |
| `logs` | `journalctl -f` de los tres servicios (Ctrl+C para salir) |
| `health` | `/api/health` + health interno de realtime (:3004) y stream (:8100) |
| `backup` | Backup manual inmediato (online: VACUUM INTO, verificado) |
| `restore <archivo.db>` | Detiene servicios → restaura → verifica → arranca → health |
| `upgrade <ruta/checkout>` | Re-ejecuta install.sh desde un checkout actualizado (datos intactos) |

### Ejemplos

```bash
# Ver qué pasa ahora mismo
sudo bash /opt/pantalla-restaurante/deploy/linux/manage.sh logs

# Health completo (JSON con database/storage/realtime/stream)
sudo bash /opt/pantalla-restaurante/deploy/linux/manage.sh health

# Backup antes de un cambio grande
sudo bash /opt/pantalla-restaurante/deploy/linux/manage.sh backup

# Restaurar un backup concreto
sudo bash /opt/pantalla-restaurante/deploy/linux/manage.sh restore \
  /var/lib/pantalla-restaurante/backups/pantalla-restaurante-2026-09-09T03-00-00.db
```

---

## Estados de salud e interpretación

`GET /api/health` responde:

- `status: "ok"` — todo operativo.
- `status: "degraded"` — la app SIRVE contenido pero falta un componente (realtime y/o stream caídos, o almacenamiento no escribible). Las TVs siguen funcionando con el polling de respaldo; revisa el servicio caído.
- `status: "unhealthy"` (HTTP 503) — base de datos caída: la plataforma NO funciona. Revisa espacio en disco y permisos de `/var/lib/pantalla-restaurante`.

Estados HTTP de las unidades: `systemctl is-active pantalla-restaurante{,-realtime,-stream}`.

---

## Backups

- **Automáticos**: diariamente a las 03:00 (`pantalla-restaurante-backup.timer`), backup online con verificación de integridad + conteo de filas, retención configurable (`BACKUP_RETENTION` en el entorno).
- **Manuales**: `manage.sh backup` o desde el panel de administración (ADMIN).
- **Restauración**: `manage.sh restore <archivo>` (para el servicio, restaura con verificación y rearranca). Se recomienda probar una restauración en un entorno de prueba tras cambios mayores (misión: el backup no verificado no es backup).
- Ubicación: `/var/lib/pantalla-restaurante/backups/` (separado del código, sobrevive a upgrades).

## Auditoría (logs)

- **Estructurados**: JSON por evento (FASE 26) → stdout (journald) + `/var/log/pantalla-restaurante/app.log` con rotación por tamaño (5 MB × 5 archivos).
- **Tabla Log** (SQLite): auditoría de acciones admin (FASE 27) con retención `LOG_RETENTION_DAYS` (default 90) purgada diariamente a las 04:00.
- **Consulta**: panel admin → Registros (OPERATOR+), o `journalctl -t pantalla-restaurante --since "1 hour ago"`.
- Nunca contienen contraseñas, secretos ni claves de stream completas.

---

## Actualización (upgrade)

```bash
# 1. En el CHECKOUT de origen (donde sincronizaste el repo):
cd /ruta/al/checkout && git pull origin main

# 2. Actualizar la instalación (datos intactos: DB/medios/logs NO se tocan)
sudo bash /ruta/al/checkout/deploy/linux/manage.sh upgrade /ruta/al/checkout
```

El upgrade re-ejecuta `install.sh` (idempotente): nuevo código, `bun install --frozen-lockfile`, `prisma migrate deploy` (migraciones versionadas — nunca `db push`), build y reinicio con espera de health. Los secretos y datos permanecen.

> Antes de un upgrade mayor: `manage.sh backup` manual por seguridad.

## Recuperación ante fallos

| Síntoma | Diagnóstico | Acción |
|---|---|---|
| App caída | `systemctl status pantalla-restaurante` + `journalctl -u pantalla-restaurante -n 50` | systemd la reinicia sola (Restart=always); si entra en loop, revisa `/etc/pantalla-restaurante.env` y espacio en disco |
| TVs sin actualizaciones | `manage.sh health` → realtime caído | `manage.sh restart realtime` (las TVs reconectan solas) |
| OBS no conecta | `manage.sh health` → stream caído / clave rotada | `manage.sh restart stream`; la clave se ve en el panel admin (Transmisión) |
| DB corrupta / borrada | health `unhealthy` | `manage.sh restore <último-backup>` |
| Disco lleno (medios) | health `storage` con quota | purgar medios antiguos (`bun scripts/media-gc.ts` desde `/opt`) o ampliar `MEDIA_MAX_TOTAL_MB` |

## Firewall (puertos a abrir en la LAN)

| Puerto | Servicio | Origen permitido |
|---|---|---|
| 3000/tcp | App + API + proxy FLV | LAN completa (TVs + equipos admin) |
| 3003/tcp | Socket.io (pantallas/admin) | LAN completa |
| 1935/tcp | RTMP ingest (OBS) | Solo el equipo con OBS (o LAN) |
| 8000/8100 | FLV/control | NO abrir — solo localhost (el proxy los consume) |

Ejemplo (ufw): `ufw allow from 192.168.1.0/24 to any port 3000,3003 proto tcp && ufw allow from <IP-OBS> to any port 1935 proto tcp`
