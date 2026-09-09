# OBS_SETUP — transmitir al sistema desde OBS Studio (VERIFIED)

> El pipeline completo (publicar → estado live → proxy FLV → bytes en la TV →
> caída → recuperación) está verificado con publicador RTMP real
> (`tests/stream-pipeline.test.ts`) y E2E con ffmpeg. OBS usa el mismo
> protocolo (RTMP con clave).

## Configuración en OBS (una vez)

1. **Ajustes → Transmisión (Stream)**:
   - Servicio: **Personalizado…**
   - Servidor: `rtmp://<IP-del-servidor>:1935/live`
   - Clave de transmisión: la que muestra el panel → **Sección Transmisión → "Ver clave"** (solo ADMIN puede revelarla).
2. **Ajustes → Salida (Output)**:
   - Modo de salida: Avanzado · Rescaler desactivado
   - Codificador: x264 (o hardware si hay GPU)
   - Bitrate de vídeo: **3000–6000 kbps** (LAN soporta más; ajustar al TV/bucle)
   - Keyframe interval: **2 s** (crítico para baja latencia en el carrusel FLV)
   - Rate control: CBR
3. **Ajustes → Vídeo**: resolución de salida = resolución del canvas (p. ej. 1920×1080; la TV lo escala).
4. **Audio**: 44.1/48 kHz estéreo. El sonido llega a la TV junto al vídeo; la salida por TV se elige desde el panel (Sección Audio, por pantalla).

## Iniciar / detener

- **Iniciar transmisión** en OBS → en 1–3 s el panel y las TVs pasan a EN VIVO (evento realtime `stream:server`).
- **Detener** → las TVs muestran el fallback configurable ("LA TRANSMISIÓN SE REANUDARÁ EN BREVE" por defecto) y reintentan automáticamente.

## Reconexión de OBS (VERIFIED)

- **Caída breve de OBS** (reinicio de red, <30 s): el servicio mantiene `live=true` durante la ventana de gracia (~30 s) y el stream se reanuda sin que las TVs hagan nada.
- **Caída larga**: `live=false` a los ~33 s; al reconectar OBS, el estado y el vídeo se recuperan solos (las TVs reconectan el player automáticamente).

## Rotación de la clave de transmisión (solo ADMIN)

Panel → Transmisión → **Rotar clave**.

- El panel genera una clave nueva y la muestra UNA vez.
- **Semántica (documentada y verificada): la rotación aplica a NUEVAS conexiones** — una sesión RTMP ya establecida SIGUE transmitiendo hasta que OBS se detenga o reconecte; con la clave vieja, un nuevo intento de publicación es RECHAZADO.
- Tras rotar: actualizar la clave en OBS ANTES de detener/reiniciar la transmisión.

## Diagnóstico rápido

| Síntoma | Ver |
|---|---|
| OBS rechaza la clave ("Invalid stream key") | Clave mal copiada o rotada — regenerar desde el panel |
| OBS conecta pero las TVs no ven nada | `http://<IP>:3000/api/stream/status` → `live:true`? → `docs/TROUBLESHOOTING.md` |
| Latencia alta | Keyframe 2 s + CBR; bitrate acorde; cable en vez de Wi-Fi para OBS si es posible |
