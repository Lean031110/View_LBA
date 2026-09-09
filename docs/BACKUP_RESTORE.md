# BACKUP_RESTORE — copias de seguridad de SQLite (FASE 16, VERIFIED)

> Restauración probada de verdad: backup → borrar tabla → restore → datos
> íntegros (tests de FASE 16; pipeline verificado en el plan).

## Qué incluye cada backup

- Base de datos completa (`VACUUM INTO` — copia online consistente sin bloquear el servicio).
- Nombre con timestamp: `pantalla-YYYYMMDD-HHMMSS.db`.
- Verificación automática: integridad SQLite + conteo de filas por tabla.

## Backups automáticos

| Plataforma | Mecanismo |
|---|---|
| Linux (systemd) | `pantalla-restaurante-backup.timer` — diario 03:00 (Persistent: se ejecuta aunque el servidor estuviera apagado) |
| Windows | Tarea programada (la crea `install.ps1`) — diario |

Retención: `BACKUP_RETENTION` (default 14) — los backups más antiguos se rotan solos.

## Backup manual

```bash
bun scripts/backup.ts          # desde la raíz del proyecto
# o con el gestor:
sudo bash deploy/linux/manage.sh backup      # Linux
.\deploy\windows\manage.ps1 backup            # Windows
```

Variables: `BACKUP_DIR` (directio destino, ver `.env.example`).

## Restauración

```bash
bun scripts/restore.ts <ruta/al/backup.db>
# o con el gestor (detiene servicios de forma segura, restaura, verifica y arranca):
sudo bash deploy/linux/manage.sh restore /var/lib/pantalla-restaurante/backups/pantalla-20260909-030000.db
```

El restaurador:
1. Para los servicios de forma segura (Linux: systemd; desde CLI: aviso claro).
2. Copia la DB actual a un sidecar de seguridad (por si el backup resultara malo).
3. Restaura el backup con verificación de integridad + conteos.
4. Arranca y comprueba health.

## Recomendaciones operativas

- **Backup antes de cada actualización** (el flujo de `docs/UPGRADING.md` lo hace automáticamente).
- Copiar ocasionalmente los backups a otro disco/USB (rotación fuera del servidor).
- Probar la restauración al menos una vez por trimestre en una máquina de pruebas.
- Los medios subidos (logos/imágenes) viven en `MEDIA_DIR` — incluirlos en la copia externa si se desea recuperación completa del branding.

## Recuperación ante desastres (resumen)

| Escenario | Recuperación |
|---|---|
| DB corrupta | restore del último backup + `prisma migrate deploy` |
| Servidor muerto | instalar en máquina nueva (`docs/INSTALLATION.md`) + restore del backup + re-vincular TVs (tecla S → Vincular) |
| Borrase accidental de contenido | restore (o regenerar desde el panel) |
