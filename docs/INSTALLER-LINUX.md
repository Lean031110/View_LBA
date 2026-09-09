# Installer de ViewLBA Server — Linux

## Requisitos del host

- Linux x86_64 con **systemd** (Debian/Ubuntu/RHEL/Fedora…).
- **root** (o sudo): el installer crea usuario de sistema, unidades systemd
  y reglas de firewall.
- Nada más: **Bun va dentro del paquete** (`runtime/`), el build va
  precompilado y ffmpeg es opcional (OBS codifica en el cliente).

## Instalar (con AppImage)

```bash
chmod +x ViewLBA-Server.AppImage

# Con entorno gráfico: doble clic o
./ViewLBA-Server.AppImage

# Servidor headless (sin display) — CLI directo:
sudo ./ViewLBA-Server.AppImage --cli

# Variante CLI pura (sin GUI):
sudo ./ViewLBA-Server-CLI.AppImage
```

El asistente (GUI o terminal) recorre los 12 pasos y termina con:

```
Application ✓  Realtime ✓  Stream ✓  Database ✓  Backup (timer) ✓
```

verificados contra `/api/health` — si algo falla, NO se declara correcta y
se muestra diagnóstico + rollback no destructivo.

## Qué crea (layout FHS — convención de deploy/linux)

| Ruta | Contenido |
|---|---|
| `/opt/pantalla-restaurante` | Código + build standalone (rsync-equivalente con exclusiones) |
| `/var/lib/pantalla-restaurante` | `db/custom.db` · `media/` · `backups/` · `data/` |
| `/var/log/pantalla-restaurante` | Logs estructurados (rotación) |
| `/etc/pantalla-restaurante.env` | Entorno + secretos (root:600) |
| systemd | `pantalla-restaurante{,-realtime,-stream}.service` + `.target` + timers de backup/purga |

El usuario de servicio `pantalla` (sin login, sin root) ejecuta TODO.
Las unidades se **renderizan desde `deploy/linux/`** (única fuente de verdad)
sustituyendo `__BUN_BIN__` por el bun incluido y las rutas del layout
elegido (directorios personalizados soportados).

## Firewall

Reglas automáticas (3000/3003/1935 → subred LAN) con **ufw** o
**firewalld**. Si no hay gestor, WARNING con las instrucciones exactas de
`docs/FIREWALL.md` (la instalación continúa; los puertos internos
3004/8000/8100 son localhost por diseño).

## Gestión diaria

```bash
# CLI (sidecar compilado o AppImage --cli):
viewlba-installer services status|start|stop|restart
viewlba-installer health
viewlba-installer logs
viewlba-installer backup
viewlba-installer restore /var/lib/.../backup.db --confirm
viewlba-installer diagnostics
viewlba-installer update <payload-nuevo>   # código nuevo, datos intactos
viewlba-installer repair                   # reinstala servicios/entorno
viewlba-installer uninstall                # casillas; datos por defecto intactos
```

`deploy/linux/manage.sh` sigue funcionando (misma semántica, capa shell).

## Desatendido

```bash
sudo ./ViewLBA-Server-CLI.AppImage --cfg cfg.json
# o con el binario del paquete:
sudo dist/release/linux/ViewLBA-Server/viewlba-installer --config cfg.json
```

## Actualizar

1. `viewlba-installer update /ruta/al/payload-nuevo` (o `manage.sh upgrade`):
   sincroniza código, aplica migraciones versionadas (migrate deploy),
   re-renderiza unidades y reinicia. **Los datos no se tocan.**
2. Desde el release nuevo: descargar el AppImage y ejecutar con modo
   "Actualizar instalación" en el asistente.

## Verificación local realizada (sandbox, evidencia)

- Payload offline: `migrate deploy` con `runtime/bun` incluido ✓
- Arranque del standalone precompilado con `runtime/bun` ✓
- `GET /api/health` → `{"status":"degraded","database":true,"storage":true,…}`
  (realtime/stream sin iniciar — semántica correcta) ✓
- `GET /` (TV) → 200 ✓
- `ViewLBA-Server-CLI.AppImage --cli --json detect` → JSON correcto ✓
- Instalación con systemd real: **CI / host con systemd** (sandbox sin
  systemd NO VERIFIED por diseño — el preflight lo exige y aborta).

## Compilar el paquete localmente

```bash
bun installer/package/bundle-server.ts --platform=linux   # payload (fuera del repo)
bash installer/package/appimage.sh                        # ViewLBA-Server-CLI.AppImage
```

La GUI (`ViewLBA-Server.AppImage` con Tauri) se construye en CI con Rust +
webkit2gtk (ver `docs/RELEASE.md`).
