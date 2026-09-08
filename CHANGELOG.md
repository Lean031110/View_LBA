# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/),
y este proyecto adhiere a [SemVer](https://semver.org/lang/es/).

## [1.0.0] — 2026-09-09

### Añadido

- **Pantalla TV** (`/?view=tv`) — interfaz de señalización para televisores:
  transmisión de video en vivo como elemento dominante, reloj/fecha, horario del
  día con turno activo destacado, carrusel de promociones con ventanas de
  fecha/hora, plato del día, redes sociales, ticker (izquierda → derecha),
  identificación de pantalla (TV-001…), modo kiosco (wake lock, cursor oculto,
  tecla `S`), pantalla completa y watchdog de auto-recuperación.
- **Panel de administración** (`/?view=admin`) con 13 secciones: Dashboard,
  Transmisión, Promociones, Plato del Día, Horarios, Redes Sociales, Ticker,
  Logotipo, Audio (remoto), Pantallas, Apariencia, Usuarios y Registros.
- **Servidor de streaming RTMP integrado** (`mini-services/stream-service`,
  node-media-server): ingest RTMP :1935 con validación de clave, HTTP-FLV :8000,
  control interno :8100, rotación de clave sin reinicio y notificación en vivo
  a pantallas/admins.
- **Servicio realtime** (`mini-services/realtime-service`, Socket.io): registro
  y heartbeat de pantallas, snapshot de estado, comandos remotos (reload/audio),
  difusión de cambios de contenido y estado del stream.
- **Autenticación con roles** (ADMIN / OPERATOR / VIEWER) — sesiones firmadas
  HMAC + scrypt, cookies httpOnly.
- **Proxy server-side del FLV** (`/api/stream/live.flv`): la clave de
  transmisión nunca llega al navegador de la TV.
- **Multisección de contenido con actualización instantánea** (editar en admin
  → la TV se refresca sin recargar).
- **Fallback elegante** cuando no hay transmisión: mensaje configurable,
  imagen o video, con reconexión automática (5/10/15 s → fallback).
- **Branding ViewLBA**: logo, isotipo, favicon y presencia en administración;
  en la TV solo se muestra fuera de pantalla completa.
- **CI** (GitHub Actions): lint, typecheck, tests y build de producción.
- **Tests unitarios** (bun test) para validación de campos, red LAN y branding.
- Documentación: README, guía de despliegue LAN, seguridad, contribución.

### Seguridad

- Clave de transmisión enmascarada y revelable solo por ADMIN.
- Secretos fuera del repositorio (`.env` ignorado, `.env.example` documentado).
- Guard anti path-traversal en el servicio de archivos.
