# FIREWALL / PUERTOS — clasificación exacta (FASE 40)

> Regla de oro: **lo interno va a localhost, solo lo necesario a la LAN, nada a Internet.** El sistema está diseñado para operar 100% sin Internet.

## Tabla maestra de puertos

| Puerto | Servicio | ¿Quién debe alcanzarlo? | Clasificación | Firewall LAN | Firewall Internet |
|---|---|---|---|---|---|
| **3000** | App Next.js (panel + TV + API + proxy FLV + /api/health) | TVs, PCs admin, PCs OBS (panel) | **LAN** | ABIERTO a la LAN | BLOQUEADO |
| **3003** | realtime-service — WebSocket (Socket.io) | TVs y navegadores admin de la LAN | **LAN** | ABIERTO a la LAN | BLOQUEADO |
| **3004** | realtime-service — API interna (/health, /status, /broadcast) | SOLO la app Next.js (mismo host, 127.0.0.1) | **LOCALHOST** | BLOQUEADO | BLOQUEADO |
| **1935** | stream-service — RTMP ingest | PCs con OBS Studio (LAN) | **LAN** | ABIERTO solo a PCs con OBS (ideal) o a la LAN | BLOQUEADO |
| **8000** | stream-service — HTTP-FLV | SOLO el proxy de la app (bind 127.0.0.1) | **LOCALHOST** (bind real) | No aplica (no escucha en LAN) | BLOQUEADO |
| **8100** | stream-service — control interno (/health, /status, rotación) | SOLO la app (127.0.0.1) | **LOCALHOST** | BLOQUEADO | BLOQUEADO |

Notas:
- **8000 hace bind real a 127.0.0.1** (ver `HTTP_FLV_BIND` en `.env.example`): ni siquiera es alcanzable desde la LAN. Las TVs NUNCA consumen FLV directo — siempre vía proxy `/api/stream/live.flv` (misma-origin, sin CORS).
- **3003** es necesario en LAN: las TVs y los navegadores admin conectan el WebSocket directamente (`ws://<host>:3003`). El servicio valida orígenes (CORS LAN-only, sin `*`).
- **3004** solo lo usa la app para difundir eventos (POST /broadcast con token interno) y consultar /health — siempre 127.0.0.1.

## Ejemplo de reglas (Linux, ufw)

```bash
# Denegar por defecto lo entrante desde fuera de la LAN (ajustar subred)
sudo ufw default deny incoming
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp   # app
sudo ufw allow from 192.168.1.0/24 to any port 3003 proto tcp   # realtime ws
sudo ufw allow from 192.168.1.0/24 to any port 1935 proto tcp   # RTMP (ideal: solo IPs con OBS)
# 3004/8000/8100: NO abrir — son localhost por diseño/bind
```

## Ejemplo de reglas (Windows)

```powershell
New-NetFirewallRule -DisplayName "ViewLBA App"    -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow -RemoteAddress 192.168.1.0/24
New-NetFirewallRule -DisplayName "ViewLBA Realtime" -Direction Inbound -LocalPort 3003 -Protocol TCP -Action Allow -RemoteAddress 192.168.1.0/24
New-NetFirewallRule -DisplayName "ViewLBA RTMP"  -Direction Inbound -LocalPort 1935 -Protocol TCP -Action Allow -RemoteAddress 192.168.1.0/24
# 3004/8000/8100 sin regla: solo escuchan en 127.0.0.1
```

Los instaladores (`deploy/linux/install.sh`, `deploy/windows/install.ps1`) configuran estas reglas automáticamente.

## Health checks (para monitoreo/supervisores)

| Endpoint | Uso |
|---|---|
| `http://127.0.0.1:3000/api/health` | Estado global: DB, storage, realtime, stream (ok/degraded/unhealthy) |
| `http://127.0.0.1:3004/health` | Realtime (localhost) |
| `http://127.0.0.1:8100/health` | Stream (localhost — comprueba listeners RTMP/FLV vivos) |

Los tres son de solo lectura y NO exponen secretos. El estado público del stream (`/api/stream/status`) solo expone `{source, serverOk, live}`.
