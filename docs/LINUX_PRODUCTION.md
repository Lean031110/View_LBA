# LINUX_PRODUCTION — despliegue con systemd (FASE 28)

> Instalación real de producción en Linux. **Runbook diario: `docs/OPERATIONS.md`** (comandos, health, backups, recuperación). Windows: `docs/WINDOWS_PRODUCTION.md`.

## Instalación

```bash
# desde el checkout del repositorio, como root:
sudo bash deploy/linux/install.sh
```

Idempotente: deps → usuario `pantalla` (sin login, sin root) → layout estándar
(`/opt` código · `/var/lib` datos · `/var/log` logs · `/etc` entorno root:600) →
secretos `openssl rand` → `prisma migrate deploy` → build standalone →
unidades systemd → enable+start → **espera health real**.

## Unidades systemd (VERIFIED con `systemd-analyze verify`, 0 warnings)

| Unidad | Puerto(s) | Endurecimiento |
|---|---|---|
| `pantalla-restaurante.service` (app standalone) | 3000 | `Restart=always` +5s, usuario `pantalla`, `MemoryMax`/`CPUQuota`, `ProtectSystem=strict` + `ReadWritePaths` solo var-lib/var-log, `NoNewPrivileges`, `ProtectHome`, `PrivateTmp` |
| `pantalla-restaurante-realtime.service` | 3003/3004 | ídem |
| `pantalla-restaurante-stream.service` | 1935/8000/8100 | ídem |
| `pantalla-restaurante-backup.timer` | — | diario 03:00, `Persistent` |
| `pantalla-restaurante-logs-purge.timer` | — | diario 04:00 |

NOT VERIFIED (este entorno no tiene systemd): arranque en máquina física real — unidades validadas sintácticamente y el runtime del binario standalone verificado (health 200 con NODE_ENV=production). Pendiente de verificación en hardware destino (FASE 42/43).

## Comandos diarios

```bash
sudo bash deploy/linux/manage.sh {start|stop|restart|status|logs|health|backup|restore|upgrade}
```

## Primer administrador

```bash
sudo -u pantalla bun /opt/pantalla-restaurante/scripts/init-production.ts --email=admin@mirestaurante.com
# (pide contraseña oculta; o --password= para automatizar)
```

## Firewall

Ver `docs/FIREWALL.md` (el instalador configura ufw automáticamente).

## Backup / restauración

```bash
sudo bash deploy/linux/manage.sh backup     # manual (además del timer diario)
sudo bash deploy/linux/manage.sh restore <archivo>
```

Detalles y verificación: `docs/BACKUP_RESTORE.md`.
