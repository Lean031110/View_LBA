# UPGRADING — actualizar a una nueva versión

> Regla: **backup antes de tocar nada** + migraciones versionadas (JAMÁS
> `db push --accept-data-loss`) + verificación de health antes de dar por
> buena la actualización.

## Actualización estándar (recomendada)

```bash
# Linux (hace backup → git pull → migrate deploy → build → restart → health):
sudo bash deploy/linux/manage.sh upgrade

# Windows:
.\deploy\windows\manage.ps1 upgrade
```

El gestor ejecuta exactamente:

1. **Backup de la DB** (timestamp) — restaurable con `manage.sh restore <archivo>`.
2. Obtener el código nuevo (`git pull` — o copiar el release).
3. `bun install --frozen-lockfile` (dependencias reproducibles).
4. `bunx prisma migrate deploy` — aplica SOLO migraciones pendientes (no destructivas por diseño; si una migración futura fuese destructiva, el proceso de deploy NO la ejecuta automáticamente sin confirmación).
5. Build standalone de producción (`bun scripts/build.ts`).
6. Restart de los servicios.
7. **Espera health real** (ok o degraded esperado) antes de continuar.

## Actualización manual (paso a paso)

```bash
bun scripts/backup.ts                      # 1. backup
git pull                                   # 2. código
bun install --frozen-lockfile              # 3. deps
bunx prisma migrate deploy                 # 4. migraciones versionadas
bun scripts/build.ts                       # 5. build
bun scripts/start.ts                       # 6. arrancar (o restart del gestor)
curl http://127.0.0.1:3000/api/health      # 7. verificar
```

## Notas de compatibilidad

- Las TVs se actualizan solas al recargar (comando "Reiniciar" del panel o el watchdog) — no requieren intervención física salvo cambios que rompan la URL (no ha ocurrido).
- La identidad de las TVs (localStorage) y el pairing SOBREVIVEN a las actualizaciones (no hay que re-vincular salvo que se regenere el token desde el panel).
- Variables nuevas del `.env`: consultar el CHANGELOG y `.env.example` (el instalador las repara automáticamente si faltan secretos).
- SQLite en WAL: no requiere pasos especiales — `migrate deploy` funciona en caliente; los lectores (realtime/stream) no se bloquean.

## Rollback

```bash
sudo bash deploy/linux/manage.sh restore <backup-del-paso-1>
# y volver al commit anterior:
git checkout <tag-anterior> && bun install --frozen-lockfile && bun scripts/build.ts
```

Las migraciones NO se revierten automáticamente (política prisma) — el restore de la DB del paso 1 es el mecanismo de rollback de datos.

## Verificación post-actualización (checklist)

- [ ] `curl http://127.0.0.1:3000/api/health` → ok (o degraded conocido)
- [ ] Login en el panel funciona
- [ ] Una TV muestra contenido y obedece "Reiniciar"
- [ ] OBS transmite y las TVs reproducen (si hay stream en uso)
- [ ] `journalctl -u pantalla-restaurante* --since "5 min ago"` sin errores nuevos
