# MISIÓN — PRODUCCIÓN REAL 24/7 (Documento maestro, NO BORRAR)

> **Propósito:** Este documento es la fuente única de verdad del encargo del usuario.
> Cualquier sesión futura DEBE leerlo al inicio y seguirlo al pie de la letra.
> Ubicación fija: `/home/z/my-project/MISSION.md` (raíz del proyecto, versionado en git).
> El progreso de cada fase se registra en `PRODUCTION_PLAN.md` y en `worklog.md`.

**Repo:** https://github.com/Lean031110/View_LBA
**Nota:** el repo fue renombrado en su día (GitHub redirige el nombre antiguo hacia el actual); usa siempre la URL de arriba.
**Fecha del encargo:** 2026-09-09
**Estado:** EN EJECUCIÓN (fases en orden obligatorio 0→43)

---

## # MISIÓN

Estás trabajando sobre el repositorio:

https://github.com/Lean031110/View_LBA

Tu objetivo es llevar el proyecto existente a un estado REALMENTE APTO PARA PRODUCCIÓN para un sistema de cartelería digital de restaurante 24/7, manteniendo la arquitectura actual siempre que sea viable.

NO debes reescribir el proyecto desde cero.
NO debes cambiar la arquitectura por capricho.
NO debes eliminar funcionalidades existentes para simplificar.
NO debes sustituir tecnologías importantes sin una razón técnica demostrable.

Tu prioridad máxima es:

1. No romper funcionalidades existentes.
2. Corregir vulnerabilidades y fallos reales.
3. Hacer el sistema estable durante ejecución 24/7.
4. Garantizar funcionamiento en LAN sin Internet.
5. Hacerlo desplegable tanto en Linux como en Windows.
6. Hacer que el flujo OBS → servidor de streaming → TV sea robusto.
7. Garantizar que el panel administrativo y las TVs puedan funcionar de forma segura.
8. Añadir pruebas suficientes para detectar regresiones.
9. Entregar documentación real de instalación, operación, recuperación y mantenimiento.

---

## REGLA ABSOLUTA DE TRABAJO

Antes de modificar código:

- Inspecciona TODO el repositorio.
- Entiende la arquitectura actual.
- Lee package.json.
- Lee prisma/schema.prisma.
- Revisa todas las rutas API.
- Revisa autenticación.
- Revisa realtime-service.
- Revisa stream-service.
- Revisa los componentes de display.
- Revisa el sistema de uploads.
- Revisa scripts.
- Revisa CI/CD.
- Revisa tests existentes.
- Revisa README.md y README-LAN.md.
- Identifica dependencias entre módulos.

No empieces a editar hasta tener un mapa de dependencias.

Antes de cada fase importante:

- ejecuta tests existentes;
- ejecuta typecheck;
- ejecuta lint;
- crea un checkpoint/commit limpio;
- documenta exactamente qué vas a cambiar.

Después de cada cambio:

- ejecuta pruebas específicas;
- ejecuta lint;
- ejecuta typecheck;
- ejecuta tests;
- ejecuta build;
- si algo falla, corrígelo antes de continuar.

Nunca acumules 20 cambios sin comprobar si rompiste algo.

---

## ESTADO ACTUAL A PRESERVAR

El proyecto ya tiene una arquitectura funcional basada aproximadamente en:

- Next.js
- React
- Prisma
- SQLite/DB configurable
- Socket.IO
- mini-services/realtime-service
- mini-services/stream-service
- Node Media Server
- RTMP
- HTTP-FLV
- mpegts.js
- panel administrativo
- display para TV
- promociones
- plato del día
- programación
- redes sociales
- ticker
- configuración de audio
- múltiples pantallas
- autenticación
- CI

El flujo principal que debe conservarse es:

```
OBS
  ↓
RTMP
  ↓
stream-service / Node Media Server
  ↓
HTTP-FLV / mecanismo actual de reproducción
  ↓
Next.js / proxy o ruta actual
  ↓
TV Display
  ↓
mpegts.js
```

Y:

```
Admin
  ↓
Next.js API
  ↓
Realtime Service
  ↓
TV Display
```

No elimines ninguno de estos flujos sin comprobar primero que existe una alternativa superior y compatible.

---

## FASE 0 - AUDITORÍA BASE

Primero crea un documento:

PRODUCTION_AUDIT.md

Incluye:

- arquitectura encontrada;
- servicios;
- puertos;
- variables de entorno;
- base de datos;
- rutas API;
- autenticación;
- realtime;
- streaming;
- almacenamiento;
- uploads;
- tests;
- CI;
- problemas encontrados;
- riesgos;
- prioridades P0/P1/P2.

Clasifica cada problema:

P0 = bloqueador de producción
P1 = importante
P2 = mejora

NO corrijas todavía todo.
Primero termina la auditoría.

Después genera:

PRODUCTION_PLAN.md

con el orden exacto de ejecución.

---

## FASE 1 - SEGURIDAD Y DEPENDENCIAS

Esta es la primera fase real de modificaciones.

1. Actualiza Next.js a una versión estable y parcheada compatible con el proyecto.

Actualmente Next.js 16 está en Active LTS.
La release de seguridad de agosto de 2026 incluye Next.js 16.3.3.
Verifica la versión estable/parcheada actual antes de modificar package.json.

NO hagas upgrade mayor innecesario.

Comprueba compatibilidad de:

- React
- React DOM
- Prisma
- Socket.IO
- mpegts.js
- Node Media Server
- zod
- TypeScript
- ESLint

2. Usa Node.js 20.9+ como mínimo para el entorno soportado.

Actualiza README si dice Node 18+.

3. Elimina todos los secrets por defecto.

NO permitir:

AUTH_SECRET || "signage-dev-secret-change-me"

NO permitir:

REALTIME_TOKEN || "signage-rt-internal-token"

En producción:

- si falta AUTH_SECRET → fallo de startup;
- si falta REALTIME_TOKEN → fallo de startup;
- nunca usar secretos hardcodeados;
- nunca generar secrets conocidos.

Crea una validación centralizada de variables de entorno.

Ejemplo conceptual:

src/lib/env.ts

Debe validar:

- AUTH_SECRET
- REALTIME_TOKEN
- DATABASE_URL
- STREAM_SECRET
- otros secretos necesarios

Utiliza Zod para validar variables.

4. No expongas secretos en logs.

5. Revisa dependencias vulnerables.

6. Añade herramientas de auditoría de dependencias compatibles con el proyecto.

---

## FASE 2 - AUTENTICACIÓN Y SESIONES

El sistema actual usa JWT/HMAC personalizado.

NO lo reemplaces completamente sin necesidad.

Pero debes convertirlo en una autenticación segura para producción.

Problemas a resolver:

- token válido durante demasiado tiempo;
- usuarios deshabilitados pueden conservar sesión;
- cambios de contraseña/rol no invalidan tokens antiguos;
- fallback de secret;
- ausencia de rate limiting.

Implementa:

authVersion o sessionVersion en User.

Cuando ocurra cualquiera de estas acciones:

- cambio de contraseña;
- deshabilitar usuario;
- habilitar usuario;
- cambio de rol;
- reset de seguridad;
- eliminación de usuario;

incrementar authVersion.

Incluye authVersion en el token.

En cada request protegido:

1. verificar firma;
2. verificar expiración;
3. cargar usuario;
4. comprobar usuario activo;
5. comprobar authVersion;
6. comprobar rol/permisos.

Si no coincide:

→ sesión inválida.

No hagas consultas innecesarias a DB en endpoints públicos.

Mantén la arquitectura limpia.

---

## FASE 3 - RATE LIMITING Y LOGIN

Protege:

POST /api/auth/login

Contra:

- brute force;
- múltiples intentos;
- abuso automatizado.

Implementa rate limiting compatible con LAN y SQLite.

Debe existir:

- límite por IP;
- backoff;
- límite por cuenta;
- respuestas consistentes;
- logs de intento fallido;
- sin revelar si el email existe.

No bloquees permanentemente a un usuario por errores normales.

Añade tests.

Prueba:

- login correcto;
- password incorrecta;
- demasiados intentos;
- recuperación después del cooldown;
- usuario deshabilitado;
- usuario inexistente.

---

## FASE 4 - AUTORIZACIÓN

Audita TODAS las rutas /api/admin/*.

Cada endpoint debe verificar:

1. autenticación;
2. sesión válida;
3. rol;
4. permiso específico si aplica.

No confíes en ocultar botones del frontend.

El backend debe impedir directamente:

VIEWER → modificar contenido.

VIEWER → modificar usuarios.

VIEWER → modificar configuración.

VIEWER → rotar stream key.

etc.

Audita especialmente:

- users
- screens
- settings
- stream
- promotions
- dishes
- schedules
- social
- ticker
- logs
- uploads.

---

## FASE 5 - REALTIME SERVICE

El servicio:

mini-services/realtime-service

debe quedar protegido.

PROBLEMA ACTUAL:

CORS demasiado permisivo.

No utilizar:

origin: "*"

En producción permite únicamente los orígenes configurados.

Implementa autenticación Socket.IO.

No permitir:

admin:register
ni
admin:command

sin autenticación válida.

Recomendación:

Handshake autenticado.

Ejemplo conceptual:

socket.auth = {
  token: ...
}

El servidor valida:

- token;
- usuario;
- rol;
- permisos.

Las TVs deben utilizar identidad propia.

Implementa pairing de pantalla.

Cada pantalla debe poseer un screen token único.

No utilizar únicamente screenCode como mecanismo de seguridad.

Debe existir:

Screen
- id
- screenCode
- screenTokenHash
- active
- lastSeenAt
- metadata

Nunca guardar tokens secretos en texto plano si no es necesario.

Implementa:

- heartbeat;
- offline detection;
- reconnect;
- command authentication;
- screen authentication.

Crea endpoint:

GET /health

para realtime service.

---

## FASE 6 - BUG DE ESTADO REALTIME

Corregir el bug existente en admin screens:

Actualmente existe una condición equivalente a:

live.length > 0 || screens.length >= 0

screens.length >= 0 siempre es true.

Por tanto el sistema puede informar realtimeOnline=true aunque el servicio esté caído.

Solución:

El estado realtime debe basarse en una comprobación real del servicio.

Crear:

GET /health

en realtime-service.

Desde el backend:

- timeout;
- respuesta clara;
- fallback false.

Nunca marcar servicio online simplemente porque existen pantallas.

Añadir test para:

realtime UP → true

realtime DOWN → false

timeout → false.

---

## FASE 7 - AUDIO OUTPUT

Este punto es MUY IMPORTANTE.

La arquitectura actual intenta seleccionar dispositivo de audio desde:

AudioSection.tsx

usando:

navigator.mediaDevices.enumerateDevices()

desde el navegador administrador.

Esto NO es correcto para controlar el dispositivo de audio de una TV remota.

El deviceId del navegador del administrador no representa el dispositivo de sonido de la TV.

NO mantener esta arquitectura.

La solución debe ser:

Cada TV:

1. enumera sus propios dispositivos de audio;
2. muestra dispositivos disponibles;
3. registra/actualiza su capacidad;
4. almacena su selección.

El administrador selecciona:

TV-001 → HDMI
TV-002 → Default
TV-003 → Speaker

No copiar deviceId de una máquina a otra.

En el navegador TV:

utilizar HTMLMediaElement.setSinkId()
cuando esté disponible.

Si no está disponible:

usar salida predeterminada.

La UI debe indicar:

"Salida específica no compatible. Se utilizará la salida predeterminada."

NO romper reproducción si setSinkId no existe.

NO pedir acceso al micrófono innecesariamente solo para enumerar dispositivos.

Añadir fallback correcto.

---

## FASE 8 - TIMEZONE

Todo el sistema debe utilizar la timezone configurada del restaurante.

Configuración actual aproximada:

America/Havana

El problema actual es que ciertas partes utilizan:

new Date()
getDay()
getHours()
getMinutes()

basándose en timezone local del navegador.

Esto puede causar errores en:

- schedule;
- promociones;
- plato del día;
- expiraciones;
- activaciones;
- horarios.

Crear utilidad centralizada:

src/lib/timezone.ts

Debe proporcionar funciones equivalentes a:

getCurrentTime(timezone)
getCurrentDate(timezone)
getCurrentWeekday(timezone)
getCurrentHour(timezone)

comparisons de fechas

No mezclar:

UTC
browser local time
restaurant time

sin una conversión explícita.

Auditar especialmente:

- DailySchedule.tsx
- promociones
- dishes
- schedules
- ticker
- contenido programado.

Añadir tests para:

America/Havana

y cambio de día.

También probar:

22:00 → 02:00

si se admite horario overnight.

---

## FASE 9 - VALIDACIÓN DE DATOS

Centralizar validación con Zod.

No depender únicamente de conversiones genéricas.

Validar semánticamente:

- fechas;
- horas;
- porcentajes;
- volúmenes;
- duración;
- velocidad del ticker;
- ratios;
- nombres;
- códigos de pantalla;
- URLs;
- contenido;
- límites de texto.

Ejemplos:

No aceptar:

volume = -500
volume = 100000
tickerSpeed = -10
startDate > endDate
horas inválidas
screenCode vacío
URLs peligrosas
IDs imposibles.

Todos los errores deben devolver respuestas API consistentes.

---

## FASE 10 - UPLOADS

Auditar:

/api/upload

y:

/api/files/[...path]

Problemas a corregir:

- confiar únicamente en MIME type;
- SVG potencialmente peligroso;
- falta de validación real;
- archivos huérfanos;
- tamaño;
- almacenamiento;
- consumo de disco;
- permisos.

Implementar:

1. límite máximo global;
2. límite por tipo;
3. validación de extensión;
4. validación de MIME real;
5. inspección de archivo;
6. sanitización;
7. nombres generados por servidor;
8. nunca usar filename del usuario directamente;
9. eliminar path traversal;
10. quotas;
11. limpieza;
12. logging.

Para SVG:

preferir:

- sanitización estricta;

o

- convertir a formato raster;

o

- deshabilitar SVG si no es necesario.

NO servir SVG arbitrario sin considerar XSS.

Los vídeos deben validarse.

Si es viable:

- contenedor;
- codec;
- duración;
- tamaño.

---

## FASE 11 - STORAGE

NO guardar uploads importantes dentro de una ruta que desaparezca durante un nuevo deploy.

Separar:

APP
DATA
MEDIA
BACKUPS
LOGS

Ejemplo conceptual:

/opt/pantalla-restaurante/app
/opt/pantalla-restaurante/data
/opt/pantalla-restaurante/media
/opt/pantalla-restaurante/backups
/opt/pantalla-restaurante/logs

Para Windows usar:

C:\PantallaRestaurante\app
C:\PantallaRestaurante\data
C:\PantallaRestaurante\media
C:\PantallaRestaurante\backups
C:\PantallaRestaurante\logs

No hardcodear rutas incompatibles.

Crear configuración:

MEDIA_DIR
DATA_DIR
BACKUP_DIR
LOG_DIR

---

## FASE 12 - STREAM TEST / SSRF

Auditar:

/api/admin/stream-test

Si el backend recibe una URL y hace fetch:

esto puede convertirse en SSRF.

Debe bloquear por defecto:

- localhost;
- 127.0.0.1;
- ::1;
- 0.0.0.0;
- link-local;
- RFC1918;
- metadata endpoints;
- direcciones internas no autorizadas.

Permitir solamente:

- hosts explícitamente autorizados;

o

- destinos LAN configurados.

NO permitir que el administrador convierta el servidor en un proxy arbitrario.

Añade tests de SSRF.

---

## FASE 13 - STREAMING

Mantener:

OBS → RTMP → Node Media Server → reproducción.

Verificar:

- publish;
- playback;
- stream key;
- rotación;
- desconexión;
- reconexión;
- múltiples viewers;
- stream offline;
- recuperación.

Crear:

GET /health

para stream-service.

Debe comprobar:

- proceso funcionando;
- listener;
- capacidad básica de servicio.

El endpoint público de estado NO debe exponer:

- publisherIp;
- información sensible;
- detalles innecesarios.

Públicamente:

```json
{ "live": true }
```

Para admin:

información detallada protegida.

Revisar también:

/api/stream/live.flv

porque es una conexión de larga duración.

Asegúrate de que el proxy:

- no mata la conexión;
- no bufferiza incorrectamente;
- no tiene timeout inapropiado;
- no rompe streaming continuo.

Probar con OBS real.

---

## FASE 14 - STREAM KEY

Auditar rotación de stream key.

Comprobar exactamente qué ocurre cuando:

- se rota;
- OBS está conectado;
- OBS está desconectado;
- existe una TV reproduciendo.

Documentar:

"rotation applies to new connections"

si ese es el comportamiento.

No fingir que una rotación desconecta mágicamente conexiones existentes si no lo hace.

Añade tests.

---

## FASE 15 - PRISMA / DATABASE

NO utilizar:

prisma db push --accept-data-loss

como mecanismo normal de producción.

Implementar:

Prisma migrations.

Crear:

prisma/migrations/

Los cambios de schema deben ser versionados.

Producción debe utilizar:

prisma migrate deploy

El proceso de deploy NO debe ejecutar migraciones destructivas automáticamente.

Eliminar dependencia de:

db push --accept-data-loss

en producción.

Implementar backup.

---

## FASE 16 - SQLITE Y BACKUPS

El proyecto debe funcionar bien en LAN con SQLite.

Añadir:

- backup automático;
- backup manual;
- restauración;
- verificación de backup;
- timestamps;
- retención configurable.

Documentar:

Backup diario

Backup antes de actualización

Restore

Recovery after crash

Probar REALMENTE restauración.

No basta con crear un archivo .db.

---

## FASE 17 - USERS / ADMIN

Auditar:

/api/admin/users

Requisitos:

- política mínima de contraseña;
- validación;
- no mostrar passwords;
- no devolver secretos;
- impedir eliminar/desactivar al último ADMIN;
- impedir estados peligrosos;
- auditoría.

Cuando cambie:

password
role
active

→ incrementar authVersion.

Registrar auditoría.

---

## FASE 18 - SEED

No dejar credenciales conocidas de producción como:

admin123
operador123

El seed de desarrollo puede contener usuarios demo solamente si está claramente separado del flujo de producción.

Crear:

DEV seed

y

PRODUCTION initialization

La instalación de producción debe permitir crear el primer administrador.

Nunca iniciar producción con contraseña pública conocida.

Eliminar dependencias de Internet en assets demo.

El sistema debe poder instalarse en una LAN sin Internet.

---

## FASE 19 - 100% LAN / OFFLINE

El sistema debe funcionar sin Internet después de la instalación.

Auditar TODAS las URLs externas.

Buscar:

http://
https://
CDNs
Google Fonts
imágenes externas
APIs externas
analytics
assets remotos

El seed actual contiene recursos externos.
Eliminar esa dependencia.

Todos los assets necesarios para funcionamiento local deben estar:

- embebidos;
- almacenados localmente;
- o descargados durante instalación.

La TV no debe depender de Internet.

---

## FASE 20 - DISPLAY 24/7

La pantalla es una aplicación que puede ejecutarse 24/7.

Auditar:

- timers;
- intervals;
- event listeners;
- websockets;
- media players;
- memory leaks;
- reconnect loops.

Particularmente:

StreamPlayer.tsx

Verificar:

- player destroy;
- reconnect;
- watchdog;
- cleanup;
- fallback;
- stream offline;
- stream online;
- suspensión/reanudación.

No crear múltiples instancias del player.

No crear múltiples Socket.IO connections accidentalmente.

Todos los efectos deben tener cleanup.

---

## FASE 21 - REACT STRICT MODE

Actualmente:

reactStrictMode: false

No mantenerlo desactivado solamente para ocultar problemas.

Auditar los efectos.

Hacerlos idempotentes.

Después:

activar StrictMode si el proyecto funciona correctamente.

Si aparece algún problema:

corregir la causa real.

No simplemente apagar StrictMode otra vez.

---

## FASE 22 - TESTING

El proyecto actualmente tiene tests básicos.

Debes ampliar la cobertura.

Mínimo:

UNIT

- auth
- authVersion
- permissions
- timezone
- validation
- stream state
- schedule
- uploads
- rate limiting

INTEGRATION

- login
- auth middleware
- admin endpoints
- users
- screens
- settings
- uploads
- stream endpoints
- realtime auth

REALTIME

- admin authentication
- screen authentication
- commands
- reconnect
- disconnect
- heartbeat

E2E CON PLAYWRIGHT

Crear escenarios:

1. Login.
2. Admin dashboard.
3. Crear pantalla.
4. Vincular pantalla.
5. Crear promoción.
6. Crear plato.
7. Crear schedule.
8. Modificar ticker.
9. Cambiar configuración.
10. TV carga contenido.
11. TV pierde realtime.
12. TV reconecta.
13. Stream offline.
14. Stream online.
15. Usuario sin permisos.
16. Logout.
17. sesión invalidada después de cambio de password.
18. sesión invalidada después de desactivar usuario.
19. upload válido.
20. upload malicioso/inválido.
21. timezone correcto.
22. ticker.
23. audio fallback.

---

## FASE 23 - STREAM E2E REAL

Crear una prueba de integración que reproduzca la cadena:

```
OBS / fuente RTMP de prueba
        ↓
Node Media Server
        ↓
stream endpoint
        ↓
TV player
```

Comprobar:

- stream live;
- reproducción;
- reconexión;
- caída;
- recuperación.

Si automatizar OBS real no es práctico en CI:

crear un publisher RTMP de prueba.

Pero DEBE existir una prueba real del pipeline.

---

## FASE 24 - CI/CD

Actualizar GitHub Actions.

CI debe incluir:

1. install reproducible;
2. Prisma generate;
3. lint;
4. typecheck;
5. unit tests;
6. integration tests;
7. build;
8. Playwright;
9. tests de mini-services;
10. security/dependency checks.

No marcar CI como verde si fallan servicios críticos.

Añadir cache correctamente.

Evitar que el pipeline dependa de Internet para tests funcionales salvo que sea estrictamente necesario.

---

## FASE 25 - HEALTH SYSTEM

Implementar health checks.

Backend:

GET /api/health

Debe comprobar:

- application;
- database;
- storage;
- realtime;
- stream.

Respuesta conceptual:

```json
{
  "status": "ok",
  "database": "ok",
  "realtime": "ok",
  "stream": "ok",
  "storage": "ok"
}
```

Distinguir:

healthy
degraded
unhealthy

No exponer secretos.

Añadir health endpoints también a:

- realtime-service
- stream-service

---

## FASE 26 - LOGGING

Implementar logs estructurados.

Eventos importantes:

LOGIN
LOGIN_FAILED
LOGOUT
USER_CREATED
USER_DISABLED
USER_ENABLED
PASSWORD_CHANGED
ROLE_CHANGED
SCREEN_PAIRED
SCREEN_OFFLINE
SCREEN_ONLINE
STREAM_STARTED
STREAM_STOPPED
STREAM_ERROR
STREAM_KEY_ROTATED
UPLOAD_CREATED
UPLOAD_REJECTED
SETTINGS_CHANGED
CONTENT_CREATED
CONTENT_UPDATED
CONTENT_DELETED

Nunca registrar:

- passwords;
- auth secrets;
- JWT completo;
- stream key completa.

---

## FASE 27 - AUDIT LOG

La tabla Log debe utilizarse como auditoría real.

Guardar:

- timestamp;
- userId cuando exista;
- action;
- resource;
- resourceId;
- success;
- metadata segura;
- IP si es útil y apropiado.

Restringir logs administrativos.

VIEWER no debería ver información sensible de auditoría salvo que el producto realmente lo necesite.

---

## FASE 28 - DEPLOYMENT LINUX

Crear soporte real de producción para Linux.

No depender solamente de:

scripts/stream-supervisor.sh

Crear servicios systemd:

- pantalla-restaurante.service
- pantalla-restaurante-realtime.service
- pantalla-restaurante-stream.service

Configurar:

- Restart=always;
- RestartSec;
- EnvironmentFile;
- WorkingDirectory;
- logs;
- usuario no-root;
- límites razonables.

No ejecutar toda la aplicación como root.

Documentar:

install
start
stop
restart
status
logs
backup
restore
upgrade

---

## FASE 29 - DEPLOYMENT WINDOWS

El proyecto debe poder correr en Windows.

Actualmente ciertos comandos shell son Linux-oriented.

No depender exclusivamente de:

cp
readlink
setsid
nohup
chmod
etc.

Reestructurar scripts para que sean multiplataforma cuando sea posible.

Crear soporte para:

- PowerShell;
- npm/bun scripts portables;
- servicio Windows.

Si se utiliza NSSM u otra solución:

documentarlo.

Crear:

docs/WINDOWS_PRODUCTION.md

---

## FASE 30 - CONFIGURACIÓN

Crear configuración claramente separada:

development
test
production

Ejemplo:

.env.example

Debe contener nombres de variables, nunca secretos reales.

Documentar:

PORT
DATABASE_URL
AUTH_SECRET
REALTIME_TOKEN
STREAM configuration
MEDIA_DIR
BACKUP_DIR
LOG_DIR
TIMEZONE

No committear:

.env
secret files
production DB
tokens
passwords

---

## FASE 31 - INSTALLER / ONBOARDING

Crear flujo de instalación para una máquina nueva.

Pasos:

1. instalar dependencias;
2. configurar entorno;
3. inicializar DB;
4. ejecutar migraciones;
5. crear primer admin;
6. configurar restaurante;
7. configurar stream;
8. configurar pantalla;
9. comprobar health;
10. comprobar realtime;
11. comprobar stream.

El usuario no debe tener que editar código.

---

## FASE 32 - SCREEN PAIRING

Crear un flujo profesional de pairing.

TV recién instalada:

"Esta pantalla no está vinculada."

Mostrar:

- código temporal;
- nombre;
- identificador.

Admin:

Agregar pantalla
→ introducir código
→ asignar nombre
→ asignar ubicación
→ generar token

TV recibe configuración.

Persistir identidad.

Reiniciar TV:

debe seguir vinculada.

---

## FASE 33 - RECOVERY

El sistema debe recuperarse automáticamente.

Simular:

- Next crash;
- realtime crash;
- stream crash;
- DB temporalmente indisponible;
- red caída;
- OBS desconectado;
- TV pierde conexión.

Comprobar:

- services restart;
- TV reconnect;
- stream reconnect;
- content cache;
- no corrupción;
- no duplicación.

---

## FASE 34 - PWA / OFFLINE CACHE

Auditar el offline actual.

La TV debe poder:

- cargar UI local;
- mantener último contenido;
- continuar mostrando layout;
- mostrar fallback si stream cae;
- reconectar automáticamente.

No intentar hacer streaming offline.

Pero sí mantener:

- contenido;
- configuración;
- branding;
- ticker;
- última programación conocida.

Usar IndexedDB/service worker cuando sea apropiado.

---

## FASE 35 - SEGURIDAD DE API

Auditar:

- CORS;
- CSRF si aplica;
- headers;
- content type;
- cache;
- cookies;
- SameSite;
- Secure;
- HttpOnly;
- XSS;
- SSRF;
- path traversal;
- IDOR;
- privilege escalation.

No introducir restricciones que rompan la LAN.

---

## FASE 36 - PERFORMANCE

Optimizar sin cambiar comportamiento.

Auditar:

- consultas Prisma;
- polling;
- sockets;
- requests;
- imágenes;
- vídeos;
- logs;
- memoria.

No hacer polling agresivo.

Realtime debe utilizar Socket.IO cuando tenga sentido.

TV debe minimizar requests repetitivas.

---

## FASE 37 - CACHING

Auditar:

/api/content

Debe evitar cargas innecesarias.

Utilizar:

- ETag;
- cache-control apropiado;
- versioning;
- conditional requests

cuando sea útil.

Nunca cachear información privada de admin de forma insegura.

---

## FASE 38 - DATABASE PERFORMANCE

Revisar índices Prisma.

Crear índices donde sean necesarios:

- user email;
- screen code;
- active;
- dates;
- schedules;
- relationships frecuentes.

No crear índices sin justificación.

---

## FASE 39 - DOCUMENTACIÓN

Actualizar completamente:

README.md
README-LAN.md

Crear:

```
docs/
  ARCHITECTURE.md
  INSTALLATION.md
  WINDOWS_PRODUCTION.md
  LINUX_PRODUCTION.md
  OBS_SETUP.md
  TV_SETUP.md
  SCREEN_PAIRING.md
  BACKUP_RESTORE.md
  TROUBLESHOOTING.md
  SECURITY.md
  OPERATIONS.md
  UPGRADING.md
```

Documentar:

arquitectura
puertos
firewall
OBS
stream key
TV
admin
backup
restore
logs
restarts
health
actualizaciones.

---

## FASE 40 - FIREWALL / PUERTOS

Documentar exactamente:

- puerto Next.js;
- puerto realtime;
- puerto RTMP;
- puerto HTTP-FLV;
- cualquier otro.

Indicar:

cuáles deben ser accesibles solo LAN;
cuáles deben ser accesibles únicamente localhost;
cuáles requieren firewall.

No exponer innecesariamente servicios de administración a Internet.

---

## FASE 41 - FINAL SECURITY REVIEW

Antes de declarar producción:

revisar:

- [ ] No default secrets
- [ ] No default passwords
- [ ] No SSRF
- [ ] No arbitrary upload execution
- [ ] No path traversal
- [ ] No admin sockets without auth
- [ ] No CORS *
- [ ] No stale sessions
- [ ] No role bypass
- [ ] No public sensitive stream status
- [ ] No external assets required for LAN
- [ ] No database destructive deployment
- [ ] No credentials in git
- [ ] No unsafe logs

---

## FASE 42 - FINAL TEST MATRIX

Ejecutar obligatoriamente:

bun install

bun run lint

bun run typecheck

bun test

bun run build

E2E

integration

service tests

health checks

Y si existen scripts equivalentes, ejecutarlos también.

No inventes resultados.

Si algo no se pudo probar, marcarlo claramente:

NOT VERIFIED

Nunca decir:

"production ready"

si existen pruebas críticas sin ejecutar.

---

## FASE 43 - PRODUCTION READINESS CHECK

Al final crear:

PRODUCTION_READINESS.md

Debe incluir:

1. Estado final.
2. Cambios realizados.
3. Archivos modificados.
4. Migraciones.
5. Nuevas variables de entorno.
6. Nuevos servicios.
7. Nuevos puertos.
8. Tests ejecutados.
9. Tests pasados.
10. Tests fallidos.
11. Limitaciones conocidas.
12. Riesgos restantes.
13. Cómo instalar.
14. Cómo actualizar.
15. Cómo hacer backup.
16. Cómo restaurar.
17. Cómo recuperar servicios.

Y una tabla:

| Área | Estado |
|------|--------|
| Security | PASS/FAIL |
| Auth | PASS/FAIL |
| Database | PASS/FAIL |
| Realtime | PASS/FAIL |
| Streaming | PASS/FAIL |
| Uploads | PASS/FAIL |
| Timezone | PASS/FAIL |
| Offline LAN | PASS/FAIL |
| Windows | PASS/FAIL |
| Linux | PASS/FAIL |
| Tests | PASS/FAIL |
| CI | PASS/FAIL |
| Backup | PASS/FAIL |
| Recovery | PASS/FAIL |

---

## REGLAS CONTRA REGRESIONES

MUY IMPORTANTE:

No eliminar código funcional solo porque parezca antiguo.

No cambiar APIs públicas sin comprobar consumidores.

No renombrar modelos Prisma arbitrariamente.

No cambiar puertos sin actualizar todos los consumidores.

No cambiar URLs sin actualizar TV, admin y servicios.

No cambiar el protocolo de streaming sin probar OBS.

No reemplazar Socket.IO sin pruebas.

No migrar SQLite → PostgreSQL solamente porque PostgreSQL "es más profesional".

La prioridad es estabilidad real.

---

## ORDEN OBLIGATORIO

Trabaja exactamente en este orden:

FASE 0 — Auditoría
FASE 1 — Dependencias y seguridad
FASE 2 — Auth y sesiones
FASE 3 — Rate limiting
FASE 4 — Autorización
FASE 5 — Realtime
FASE 6 — Bug realtimeOnline
FASE 7 — Audio
FASE 8 — Timezone
FASE 9 — Validation
FASE 10 — Uploads
FASE 11 — Storage
FASE 12 — SSRF
FASE 13 — Streaming
FASE 14 — Stream keys
FASE 15 — Prisma migrations
FASE 16 — Backup/restore
FASE 17 — Usuarios
FASE 18 — Seed/installer
FASE 19 — LAN/offline
FASE 20 — 24/7 display
FASE 21 — StrictMode
FASE 22 — Tests
FASE 23 — Streaming E2E
FASE 24 — CI/CD
FASE 25 — Health
FASE 26 — Logging
FASE 27 — Audit logs
FASE 28 — Linux deployment
FASE 29 — Windows deployment
FASE 30 — Configuration
FASE 31 — Installer
FASE 32 — Screen pairing
FASE 33 — Recovery
FASE 34 — PWA/offline
FASE 35 — API security
FASE 36 — Performance
FASE 37 — Caching
FASE 38 — DB performance
FASE 39 — Documentation
FASE 40 — Firewall
FASE 41 — Security review
FASE 42 — Final test matrix
FASE 43 — Production readiness

---

## REGLA FINAL

NO declares el proyecto terminado simplemente porque:

- compile;
- pase lint;
- pase unit tests;
- el frontend se vea bonito.

Este proyecto es un sistema de operación continua.

Debe demostrarse:

- autenticación segura;
- recuperación;
- realtime;
- streaming;
- persistencia;
- backup;
- offline LAN;
- Windows;
- Linux;
- seguridad;
- pruebas;
- operación 24/7.

Cuando termines:

1. Muestra resumen ejecutivo.
2. Lista de cambios.
3. Tests reales ejecutados.
4. Resultado real.
5. Problemas restantes.
6. Commit(s) creados.
7. Version final propuesta.

NO ocultes errores.
NO inventes pruebas.
NO marques PASS sin evidencia.

Tu objetivo no es producir mucho código.

Tu objetivo es producir un sistema que sobreviva a una instalación real de restaurante y funcione 24/7.
