# TV_SETUP — instalar un televisor (VERIFIED)

> Cómo poner una TV a mostrar el sistema y que sobreviva 24/7. Emparejamiento
> (identidad verificada): `docs/SCREEN_PAIRING.md`.

## 1. Abrir la pantalla

En el navegador del dispositivo conectado al TV (mini-PC, Android TV, Chromecast con navegador, Smart TV con navegador moderno):

```
http://<IP-del-servidor>:3000/?view=tv
```

Recomendado: crear un acceso directo/arranque automático que abra esa URL al encender.

## 2. Vincular la pantalla (primera vez)

La TV nueva muestra un **código de 6 dígitos** y espera. En el panel:

- **Pantallas → Nueva pantalla** → introduce el código + nombre/ubicación → la TV recibe su token automáticamente y queda **verificada** (nadie más puede suplantarla).
- Alternativa para una pantalla ya creada: botón **Vincular** en su tarjeta + el código que muestre la TV.

Detalles y seguridad: `docs/SCREEN_PAIRING.md`.

## 3. Modo kiosco (24/7)

La pantalla soporta operación continua:

- **Tecla `F`** o el botón de esquina: pantalla completa (recomendado).
- **Tecla `S`**: reabrir el selector de identidad (re-vinculación).
- Cursor oculto automáticamente tras 4 s de inactividad; Wake Lock (evita que el TV se apague/a oscurezca) cuando el navegador lo soporta.
- Watchdog de auto-recuperación: si el backend o la red fallan, reintenta solo y conserva el último contenido.

## 4. Audio por TV (VERIFIED — E2E audio fallback)

Cada TV enumera **sus propios** dispositivos de salida y los reporta al panel
(Sección Audio). El admin elige por pantalla (p. ej. TV-001 → HDMI). Si el
navegador del TV no soporta `setSinkId`, usa la salida predeterminada y el
panel lo indica — **nunca rompe la reproducción**.

## 5. Offline / sin servidor (FASE 34)

- **LAN caída con la TV abierta**: sigue mostrando el último contenido + banner "Sin conexión".
- **Recarga/reinicio con el servidor caído**: la TV arranca con el **último contenido conocido** (persistido localmente, TTL 24 h) — nunca pantalla vacía.
- El stream obviamente no se reproduce sin fuente: se muestra el fallback.
- PWA instalable (Chrome): "Instalar aplicación" en el navegador del TV para arranque directo a pantalla completa. NOT VERIFIED: instalación en Smart TV física específica.

## 6. Diagnóstico rápido

| Síntoma | Ver |
|---|---|
| "No se pudo conectar con el servidor" | Red/IP del servidor; `http://<IP>:3000/api/health` |
| Banner "Reconectando con el servidor…" | El backend se recupera solo; ver `docs/TROUBLESHOOTING.md` si persiste |
| La TV no aparece ONLINE en el panel | ¿Está vinculada? ¿Puerto 3003 accesible? (`docs/FIREWALL.md`) |
| El vídeo no se ve pero el resto sí | ¿OBS transmitiendo? `docs/OBS_SETUP.md` |
