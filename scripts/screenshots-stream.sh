#!/usr/bin/env bash
# screenshots-stream.sh — publicador RTMP para las capturas del README.
# Simula OBS Studio transmitiendo footage real (imagen cinematográfica con
# zoom lento Ken Burns + audio silencioso) hacia el stream-service local.
# Clave = la fijada por scripts/e2e-setup.ts (Settings.streamKey).
set -uo pipefail
RUN=/home/z/my-project/scripts/.run
SRC="$RUN/stream-src.png"
LOG="$RUN/publisher.log"

nohup ffmpeg -loglevel error -re -loop 1 -i "$SRC" \
  -f lavfi -i anullsrc=r=44100:cl=stereo \
  -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,zoompan=z='min(zoom+0.00045,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=24" \
  -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 48 \
  -b:v 4500k -maxrate 4500k -bufsize 9000k \
  -c:a aac -b:a 96k -ar 44100 \
  -f flv rtmp://127.0.0.1:1935/live/e2e-stream-key-0123456789 \
  > "$LOG" 2>&1 &
echo $! > "$RUN/publisher.pid"

# Esperar a que el stream-service registre la publicación (control :8100)
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8100/status 2>/dev/null | rg -q '"live":true|publishing|publishers'; then
    echo "✓ publicación RTMP activa (intento $i)"; exit 0
  fi
  sleep 2
done
echo "⚠ verificación de publicación no confirmada — revisa $LOG"
tail -n 5 "$LOG" 2>/dev/null || true
exit 0
