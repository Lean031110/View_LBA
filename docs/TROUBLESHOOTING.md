# TROUBLESHOOTING — diagnóstico por síntomas

> Empezar SIEMPRE por el health: `http://<IP-del-servidor>:3000/api/health`
> (responde `{status: ok|degraded|unhealthy, database, storage, realtime, stream}`).

## Índice por síntoma

| Síntoma | Sección |
|---|---|
| No puedo abrir el panel / la TV | [1](#1-conexión) |
| Health degradado o unhealthy | [2](#2-health) |
| No puedo iniciar sesión | [3](#3-login) |
| Una TV no aparece ONLINE / no obedece comandos | [4](#4-tv-offline) |
| La TV no muestra el vídeo en vivo | [5](#5-streaming) |
| OBS no puede transmitir | [6](#6-obs) |
| Subidas de imágenes fallan | [7](#7-uploads) |
| Un servicio se cae repetidamente | [8](#8-servicios) |
| La TV se queda con contenido viejo | [9](#9-contenido-viejo) |

## 1. Conexión

- ¿Ping al servidor? ¿`http://<IP>:3000` responde? → si no: servicio caído (ver [8](#8-servicios)) o firewall (`docs/FIREWALL.md`).
- ¿IP del servidor cambió? Las TVs tienen la IP en su URL de arranque — actualizar accesos directos.

## 2. Health

```bash
curl http://127.0.0.1:3000/api/health
```

- `database: ok:false` → unhealthy: revisar disco lleno (`df -h`), permisos de `DATA_DIR`, o restaurar backup (`docs/BACKUP_RESTORE.md`).
- `realtime: ok:false` (degraded) → la app y las TVs siguen (polling de respaldo); reiniciar el realtime:
  `sudo bash deploy/linux/manage.sh restart` (Linux) · `.\deploy\windows\manage.ps1 restart` (Windows).
- `stream: ok:false` (degraded) → sin OBS o servicio caído: ver [6](#6-obs).
- `storage` con `quotaExceeded:true` → cuota de medios llena: purgar (`bun scripts/media-gc.ts`) o subir `MEDIA_MAX_TOTAL_MB`.

## 3. Login

- **"Credenciales inválidas"** idéntico para email existente/no existente (diseño: no revela cuál falla).
- **"Demasiados intentos"** → rate limiting activo (FASE 3): esperar el cooldown (indicado en `Retry-After`) — no bloqueo permanente.
- Usuario desactivado o contraseña cambiada por otro admin → pedir restablecimiento (ADMIN desde el panel; ver `docs/UPGRADING.md` para reset de emergencia con `init-production` si queda un admin).
- Contraseña olvidada y queda UN solo admin bloqueado: en el servidor, crear admin adicional:
  `sudo -u pantalla bun scripts/init-production.ts --email=nuevo@mirestaurante.local` (la política exige 10+ chars con mayúscula/minúscula/número).

## 4. TV offline

1. ¿El navegador del TV está abierto en `/api/health` → ok? ¿La TV muestra el banner "Reconectando"?
2. **Puerto 3003** accesible desde la TV (`docs/FIREWALL.md` — el WebSocket del realtime).
3. ¿La TV fue rechazada? (token regenerado/pantalla inactiva): pulsar **S** en la TV → aparece código → "Vincular" desde el panel (`docs/SCREEN_PAIRING.md`).
4. Realtime caído → ver [2](#2-health); las TVs se reconectan solas al volver.

## 5. Streaming

1. `/api/stream/status` → ¿`live:true`? Si NO: OBS no está transmitiendo (ver [6](#6-obs)).
2. Si `live:true` pero la TV no reproduce: recargar la TV (tecla S no; F5 o comando "Reiniciar" desde el panel); comprobar que el navegador del TV soporta MSE (Chrome/Edge/Firefox modernos).
3. ¿Audio sin vídeo / viceversa? OBS debe codificar audio+vídeo; revisar `docs/OBS_SETUP.md` (keyframes 2 s, CBR).
4. Cortes intermitentes: el player reintenta solo (5/10/15 s → fallback); red Wi-Fi del TV saturada → cable.

## 6. OBS

- **"Invalid stream key"**: clave mal copiada o rotada → regenerar/ver desde el panel (solo ADMIN).
- **Conecta y expulsa al segundo**: la clave se rotó mientras OBS estaba conectado — la rotación aplica a nuevas conexiones: actualizar OBS y retransmitir.
- No llega a conectar: puerto **1935** bloqueado (`docs/FIREWALL.md`).
- `curl http://127.0.0.1:8100/status` en el servidor → `live` y `hasKey` (localhost).

## 7. Uploads

- Formato no permitido: png/jpg/webp/gif/mp4/webm/ogg (SVG deshabilitado por defecto — los logos pueden ser PNG).
- "Archivo demasiado grande": imágenes 15 MB · vídeos 120 MB · cuota global `MEDIA_MAX_TOTAL_MB` (ver health `storage`).
- El archivo pesa pero falla: los **magic bytes** se validan de verdad (un .jpg renombrado desde .exe se rechaza) — usar archivos reales.
- Huérfanos tras borrar contenido desde el panel: `bun scripts/media-gc.ts` (limpieza).

## 8. Servicios

```bash
sudo bash deploy/linux/manage.sh status && sudo bash deploy/linux/manage.sh logs
```

- Caída → reinicio automático en 5 s (systemd/NSSM `Restart=always`).
- Crash repetido: leer el log (`journalctl -u pantalla-restaurante*` / logs de NSSM) — lo más común: `.env` corrupto (falta un secreto → mensaje claro al arranque), disco lleno, permisos.
- Reinicio completo verificado ante caídas SIGKILL de los tres servicios (tests de recovery, FASE 33).

## 9. Contenido viejo

- La TV revalida el contenido en cada evento realtime — si el panel dice "guardado" y la TV no cambia: ¿TV offline? ([4](#4-tv-offline)).
- Comando manual: Pantallas → "Reiniciar" en la tarjeta de esa TV (o "Reiniciar todas").
- Banner "mostrando el último contenido conocido": el servidor no responde — la TV arrancó con el contenido persistido (FASE 34); al volver el servidor se refresca solo.
- Cambios de horario/promos que "no aplican a tiempo": la programación se evalúa en la timezone del restaurante (Ajustes → Apariencia), no la del navegador.
