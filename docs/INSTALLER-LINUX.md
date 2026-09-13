# Installer de ViewLBA Server — Linux

> **v3.2 — .deb NATIVO (dpkg-deb puro, sin Tauri/Rust/linuxdeploy).**
> `dpkg -i` y listo: instala TODO, registra y ARRANCA el servicio systemd,
> genera credenciales y deja accesos en el escritorio/menú. Como un
> programa nativo de Linux. CI lo valida INSTALÁNDOLO de verdad en un
> runner (servicio activo + `/api/health` 200 + start/stop + purge).

## Requisitos del host

- Linux x86_64 con **systemd** (Debian/Ubuntu/RHEL/Fedora…).
- **root** (o sudo): el postinst crea usuario de sistema y unidades systemd.
- **NADA MÁS**: **Bun va dentro del paquete** (`/opt/viewlba-server/runtime`),
  el build va precompilado y ffmpeg es opcional (OBS codifica en el
  cliente). No se necesita Node.js, npm ni Bun instalados — 100 % offline.

## Instalar

```bash
sudo dpkg -i ViewLBA-Server-<ver>-x86_64.deb
```

El postinst hace TODO automáticamente (sin preguntas):

1. Crea el usuario de sistema `pantalla` (sin login, sin root).
2. Copia la app a `/opt/pantalla-restaurante` y prepara `.env`, DB SQLite
   y el administrador (credenciales generadas en tu máquina:
   `/opt/viewlba-server/CREDENCIALES.txt`).
3. Registra y **ARRANCA** los servicios systemd
   (`pantalla-restaurante.target` + timers de backup/purga) — el servidor
   se reinicia automáticamente con el equipo.
4. Instala los accesos directos (menú de aplicaciones + escritorio del
   usuario que instala): **Panel · Iniciar servidor · Detener servidor**.
5. Al final imprime en la terminal: URL del panel, dónde están las
   credenciales y cómo controlar el servicio.

## Uso diario (simple)

```bash
viewlba-server start        # o el acceso directo del escritorio
viewlba-server stop
viewlba-server restart
viewlba-server status
viewlba-server health       # /api/health
viewlba-server logs
viewlba-server panel        # abre http://localhost:3000 en el navegador
viewlba-server credentials  # usuario + contraseña del admin
```

Panel: `http://localhost:3000` (espera ~30 s tras el primer arranque).

## Qué crea

| Ruta | Contenido |
|---|---|
| `/opt/viewlba-server` | Paquete: sidecar `viewlba-installer` + `runtime/bun` + manifest + `CREDENCIALES.txt` |
| `/opt/pantalla-restaurante` | App (código + build standalone + `.env`) |
| `/var/lib/pantalla-restaurante` | DB, media, backups |
| `/var/log/pantalla-restaurante` | Logs (rotación por timer) |
| `/etc/systemd/system/pantalla-restaurante*` | 3 servicios + target + 2 timers |
| `/usr/bin/viewlba-server` | Comando de control simple |
| `/usr/share/applications/viewlba-*.desktop` | Accesos (menú + escritorio) |

Tras la instalación el paquete PODA el payload duplicado
(`resources/server`, ~400 MB): la app es autosuficiente en
`/opt/pantalla-restaurante`.

## Desinstalar

```bash
sudo apt remove viewlba-server    # conserva /var/lib (datos + backups)
sudo apt purge  viewlba-server    # quita también el paquete completo
                                  # (los DATOS se conservan: avisa la ruta)
```

## Build (CI)

```bash
# payload (sidecar + runtime + servidor + plantillas systemd)
bun installer/package/bundle-server.ts --platform=linux --version=3.2.0
bun installer/package/smoke-payload.sh dist/release/linux/ViewLBA-Server
# .deb nativo
bun installer/linux/build-deb.ts --staging=dist/release/linux/ViewLBA-Server \
                                 --version=3.2.0
```

## Alternativa headless: AppImage CLI

```bash
sudo ./ViewLBA-Server-CLI-<ver>-x86_64.AppImage   # asistente de terminal
```
