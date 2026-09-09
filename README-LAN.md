# Guía de Despliegue en LAN — Señalización Digital para Restaurante

Sistema completo de señalización digital con **servidor de streaming RTMP integrado**:
todo funciona en la red local del restaurante, **sin depender de Internet**.

```
 ┌──────────────┐   RTMP (clave validada)   ┌─────────────────────────┐
 │ OBS Studio   │ ─────────────────────────▶ │  stream-service         │
 │ (cualquier   │   rtmp://IP:1935/live     │  RTMP :1935             │
 │  PC en LAN)  │                            │  HTTP-FLV :8000         │
 └──────────────┘                            │  control :8100 (local)  │
                                             └───────────┬─────────────┘
                                                         │ proxy (oculta la clave)
                                             ┌───────────▼─────────────┐
 ┌──────────────┐    contenido + realtime    │  Aplicación Next.js :3000│
 │ Administración│◀─────────────────────────▶│  /?view=admin            │
 │ (PC/tableta)  │    WebSocket :3003        │  /?view=tv (pantallas)  │
 └──────────────┘                            └───────────┬─────────────┘
                                             ┌───────────▼─────────────┐
 │ Televisores  │◀──── HTTP-FLV + contenido ──│  Navegador de la TV      │
 │ (salón, etc.)│                            │  mpegts.js (baja lat.)  │
 └──────────────┘                            └─────────────────────────┘
```

## Requisitos

| Componente | Requisito |
|---|---|
| Servidor | PC/mini-PC en la LAN con Node.js 20.9+ (LTS) o Bun 1.1+ |
| OBS Studio | Cualquier versión 28+ en el PC que transmitirá |
| Televisores | Navegador Chrome/Edge/Firefox (PC conectado al TV, Chromecast con navegador, o Smart TV con navegador moderno) |

## Puertos utilizados (abrir en el firewall del servidor)

| Puerto | Servicio | Acceso |
|---|---|---|
| **3000** | Aplicación web (TV + administración + health) | Toda la LAN |
| **1935** | RTMP ingest (OBS) | PCs con OBS |
| **8000** | HTTP-FLV (lo consume solo el servidor vía proxy; bind 127.0.0.1) | Solo localhost |
| **3003** | Realtime WebSocket (TVs y paneles) | Toda la LAN |
| **3004** | API interna del realtime (/health, /status, /broadcast) | Solo localhost |
| **8100** | Control interno del stream-service | Solo localhost |

Clasificación completa de firewall: `docs/FIREWALL.md`.

## Puesta en marcha

### Instalación completa (recomendado — máquina nueva)

```bash
bun scripts/install.ts
# preflight → dependencias → .env con secretos aleatorios → migraciones
# (prisma migrate deploy, JAMÁS db push) → primer admin → build → health
```

Multiplataforma e idempotente. Detalles: `docs/INSTALLATION.md`.

### Producción 24/7

| Plataforma | Instalación | Guía |
|---|---|---|
| Linux (systemd) | `sudo bash deploy/linux/install.sh` | `docs/LINUX_PRODUCTION.md` + runbook `docs/OPERATIONS.md` |
| Windows (NSSM) | `deploy\windows\install.ps1` | `docs/WINDOWS_PRODUCTION.md` |

### Desarrollo manual

```bash
bun install
bun run db:generate && bun run db:deploy     # migraciones versionadas
bun run db:seed                               # contenido demo (dev)
bun run dev                                   # app :3000
bun scripts/realtime-supervisor.sh &          # realtime (o bun mini-services/realtime-service/index.ts)
bun scripts/stream-supervisor.sh &            # stream
```

> `db:push` queda SOLO para desarrollo experimental; producción usa migraciones.

## Conectar OBS (una sola vez)

1. Abre la administración: `http://IP-DEL-SERVIDOR:3000/?view=admin`
   (en desarrollo: `bun prisma/seed.ts --with-demo-users` crea el demo; en
   producción: `bun scripts/init-production.ts` pide tu contraseña propia).
2. Entra en **Transmisión** → copia la **URL RTMP** y la **Clave de transmisión**
   (botones *Copiar*; la clave solo la ve un administrador).
3. En OBS: **Configuración → Emisión → Servicio: Personalizado…**
   → pega la URL en *Servidor* y la clave en *Clave de transmisión*.
4. **Iniciar transmisión**. Las pantallas pasan a **EN VIVO** en 1–3 segundos
   (latencia típica HTTP-FLV con GOP cache: 1–3 s).

La clave se puede **regenerar** desde el panel (sección Transmisión); surte
efecto para nuevas conexiones de OBS y las publicaciones con clave antigua
son rechazadas automáticamente.

## Configurar los televisores

1. En el navegador de cada TV abre `http://IP-DEL-SERVIDOR:3000/?view=tv`.
2. La primera vez, la TV muestra un **código de 6 dígitos**: en el panel →
   **Pantallas → Nueva pantalla** → introduce el código y un nombre (p. ej.
   "TV Salón Principal"). La TV queda **verificada** automáticamente (token
   de pairing — nadie más puede suplantarla). Detalles: `docs/SCREEN_PAIRING.md`.
3. Activa pantalla completa (tecla F o el botón de la esquina).
4. Para modo kiosco 24/7: configura el navegador para arrancar en
   pantalla completa y restaurar la sesión (extensión *kiosk* o flags de Chrome).
5. La TV sobrevive caídas: reconexión automática, último contenido conocido
   y PWA instalable (`docs/TV_SETUP.md`).

Cada pantalla aparece en el panel con su estado (ONLINE, resolución,
estado del stream) y recibe los cambios del contenido **en tiempo real**
(sin recargar).

## Contenido de respaldo (fallback)

Cuando OBS deja de transmitir, las pantallas muestran automáticamente un
mensaje / imagen / video configurable (sección *Transmisión → Contenido de
respaldo*) y **vuelven al vivo solas** cuando OBS se reconnecta.

## Seguridad

- La **clave de transmisión** nunca llega al navegador de las pantallas:
  el reproductor usa el proxy `/api/stream/live.flv` que la inyecta del lado
  del servidor.
- Solo los administradores pueden ver/copiar/regenerar la clave.
- Cambia los secretos de `.env` (`AUTH_SECRET`, `REALTIME_TOKEN`) en producción.
- La administración requiere login con roles (ADMIN / OPERATOR / VIEWER).

## Notas técnicas

- **Reproductor**: mpegts.js sobre HTTP-FLV con *live buffer latency chasing*
  (mantiene la latencia ~1–2 s), sin Web Worker para máxima compatibilidad
  con navegadores de TV.
- **Watchdogs**: el reproductor se auto-repara (congelamiento, errores de red,
  eventos perdidos), reintenta con backoff 5/10/15 s → fallback con reintento
  cada 30 s, y el proxy corta flujos muertos tras 15 s de inactividad.
- **Multipantalla**: cada TV se registra vía WebSocket (heartbeats cada 15 s);
  el panel ve qué pantallas están online y puede enviarles comandos.
- **Sin Internet**: ni el video, ni el contenido, ni el realtime salen de la LAN.
