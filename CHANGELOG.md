# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/),
y este proyecto adhiere a [SemVer](https://semver.org/lang/es/).

## [1.1.0] — 2026-09-09

### Añadido

- **Banner rotativo de Sugerencias del Día**: con varias sugerencias activas,
  el banner compacto rota automáticamente en bucle (7 s, ajustable con la
  velocidad de animación) con indicadores clicables y transición de
  deslizamiento suave.
- **Destellos en redes sociales**: barrido de luz sobre cada tarjeta, estrella
  titilante sobre la insignia de marca y respiración de glow — todo sutil,
  GPU-friendly (transform/opacity) y sincronizado con la velocidad global.
- Migración `scripts/update-ui-v1.1.ts`: limpia redes retiradas, ajusta
  `streamRatio` y añade sugerencias demo.

### Cambiado

- **Ofertas y Promociones ahora ocupa media pantalla** (`streamRatio`
  0.62 → 0.5): la columna de contenido pasa del 38 % al 50 % del ancho, con
  imagen de promoción más grande (42 % → 46 % de la tarjeta) y descripción en
  dos líneas.
- **Sugerencias del Día más estrecha**: de tarjeta flexible (~70 % de la
  columna) a banner horizontal fijo (~10.5 vh) con imagen cuadrada compacta,
  nombre y precio en una línea.
- **Arreglo importante**: el área de contenido del carrusel de promociones
  quedaba a altura 0 (la sección no crecía dentro de la columna) — ahora la
  sección es `flex-1` y las imágenes se ven a tamaño real.
- **Redes sociales**: solo Facebook · Instagram · WhatsApp (YouTube y TikTok
  fuera por ahora), franja más estrecha y compacta, insignias circulares con
  degradados oficiales de marca e iconos blancos.
- Panel: sección renombrada "Plato del Día" → "Sugerencias del Día"
  (sidebar y encabezado); slider de proporción de transmisión ampliado
  (45 %–80 %).

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
