#!/usr/bin/env bash
# ============================================================================
# apk-first-screen-check.sh — Verificación FUNCIONAL del primer arranque
#
# MISIÓN: comprobar que la APK del Generador de Licencias NO se queda
# atascada en su primera pantalla. El smoke anterior solo probaba
# «proceso vivo» (pidof); esto demuestra que el flujo COMPLETO funciona:
#
#   1. Instalación limpia → primera pantalla «Configura tu PIN»
#   2. PIN de ejemplo (por defecto 131313) escrito en pin1 + pin2
#   3. «Crear bóveda» → llega a HOME (botón «Nueva licencia» visible)
#   4. Reinicio de la app → pantalla de desbloqueo → mismo PIN → HOME
#      (persistencia del vault y desbloqueo real)
#   5. Control negativo: un PIN INCORRECTO no desbloquea la app.
#
# Todo falla con exit != 0 si ALGUNA etapa no se alcanza en el timeout.
# Evidencia (screenshots + volcados UI + logcat) en $EVIDENCE_DIR.
#
# Uso (CI, tras compilar y firmar la APK):
#   bash scripts/apk-first-screen-check.sh [PIN] [RUTA_APK]
#   (el script instala y lanza la APK él mismo)
#
# Notas técnicas:
#   · Coordenadas de los controles extraídas de `uiautomator dump`
#     (recurso-estable: no dependen de idioma ni de resolución).
#   · El teclado se cierra con ESC (keyevent 111) para que el botón
#     quede visible; como respaldo se envía ENTER (keyevent 66), que
#     dispara el IME_ACTION_DONE declarado en pin2/unlock_pin.
#   · PBKDF2 (150 000 iteraciones) + Keystore pueden tardar unos
#     segundos en el emulador: cada espera tiene su timeout propio.
# ============================================================================
set -uo pipefail

PIN="${1:-131313}"
APK="${2:-android-license-generator/app/build/outputs/apk/release/ViewLBA-License-Generator-v$(cat VERSION).apk}"
PKG="com.viewlba.licensegen"
ACT="$PKG/.ui.MainActivity"
EVIDENCE_DIR="${EVIDENCE_DIR:-/tmp/viewlba-first-screen}"

ID_PIN1="@$PKG:id/pin1"
ID_PIN2="@$PKG:id/pin2"
ID_CREATE="@$PKG:id/btn_create"
ID_HOME_NEW="@$PKG:id/btn_new_license"
ID_UNLOCK_PIN="@$PKG:id/unlock_pin"
ID_UNLOCK_BTN="@$PKG:id/btn_unlock"

mkdir -p "$EVIDENCE_DIR"
UI_XML="$EVIDENCE_DIR/ui.xml"

log()  { printf '\n[check] %s\n' "$*"; }
fail() {
  # Evidencia de fallo y salida con error.
  adb exec-out screencap -p > "$EVIDENCE_DIR/FAIL-$(date +%s).png" 2>/dev/null || true
  adb shell logcat -d -b crash > "$EVIDENCE_DIR/logcat-crash.txt" 2>/dev/null || true
  adb shell logcat -d | tail -200     > "$EVIDENCE_DIR/logcat-tail.txt" 2>/dev/null || true
  echo "::error::$*"
  echo "[FAIL] $*"
  echo "[FAIL] Evidencia en $EVIDENCE_DIR (screenshot + UI dump + logcat)"
  exit 1
}

# dump_ui — vuelca la jerarquía de ventanas a $UI_XML (con reintentos:
# uiautomator puede fallar con «could not get idle state» transitorio).
dump_ui() {
  local i
  for i in 1 2 3 4 5; do
    adb shell uiautomator dump /sdcard/viewlba_ui.xml >/dev/null 2>&1 || true
    adb pull /sdcard/viewlba_ui.xml "$UI_XML" >/dev/null 2>&1 || true
    if [ -s "$UI_XML" ] && grep -q '<node' "$UI_XML"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# find_view ID → imprime "cx cy" (centro del control) o falla silenciosamente.
# Busca el tag <node … resource-id="ID" … bounds="[x1,y1][x2,y2]" …> y calcula
# el centro. uiautomator escribe TODO el XML en una línea: extraemos el tag
# completo del node que contiene el resource-id.
find_view() {
  local id="$1" tag bounds nums x1 y1 x2 y2 cx cy
  tag=$(grep -o "<node[^>]*resource-id=\"$id\"[^>]*>" "$UI_XML" 2>/dev/null | head -n1)
  [ -n "$tag" ] || return 1
  bounds=$(printf '%s' "$tag" | grep -o 'bounds="\[[0-9,]*\]\[[0-9,]*\]"' | head -n1)
  [ -n "$bounds" ] || return 1
  nums=$(printf '%s' "$bounds" | grep -oE '[0-9]+')
  [ "$(printf '%s' "$nums" | grep -c .)" -eq 4 ] || return 1
  { read -r x1; read -r y1; read -r x2; read -r y2; } <<< "$nums"
  cx=$(( (x1 + x2) / 2 ))
  cy=$(( (y1 + y2) / 2 ))
  echo "$cx $cy"
}

# wait_view ID TIMEOUT_S → espera a que el control exista en pantalla.
wait_view() {
  local id="$1" timeout_s="$2" elapsed=0
  while [ "$elapsed" -lt "$timeout_s" ]; do
    dump_ui || true
    if find_view "$id" >/dev/null; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

# tap_view ID → toca el centro del control.
tap_view() {
  local id="$1" coords
  coords=$(find_view "$id") || return 1
  # shellcheck disable=SC2086
  adb shell input tap $coords
}

# type_into ID TEXT → enfoca el campo, escribe y cierra el teclado (ESC).
type_into() {
  local id="$1" text="$2"
  tap_view "$id" || return 1
  sleep 1
  adb shell input text "$text" || return 1
  sleep 1
  adb shell input keyevent 111 >/dev/null 2>&1 || true   # ESC: ocultar teclado
  sleep 1
}

# screenshot NAME → guarda PNG en la carpeta de evidencia.
screenshot() {
  adb exec-out screencap -p > "$EVIDENCE_DIR/$1.png" 2>/dev/null || true
}

echo "── Verificación del primer arranque de la APK ─────────────────────"
echo "  APK     : $APK"
echo "  PIN     : $PIN (ejemplo)"
echo "  Paquete : $PKG"
echo "  evidencia: $EVIDENCE_DIR"
[ -f "$APK" ] || fail "APK no encontrada: $APK (¿se compiló antes de este script?)"

# ── 0. Instalación limpia (por si quedara un resto de una corrida previa) ──
adb uninstall "$PKG" >/dev/null 2>&1 || true
log "Instalando APK…"
adb install -r "$APK" || fail "adb install falló"
adb shell pm list packages | grep -q "$PKG" || fail "el paquete no aparece en 'pm list packages' tras instalar"

# ── 1. Primer arranque → pantalla «Configura tu PIN» ────────────────────
log "Lanzando la app por primera vez…"
adb shell am start -W -n "$ACT" >/dev/null || fail "am start falló"
sleep 3
log "Esperando la pantalla de primer uso (pin1)…"
wait_view "$ID_PIN1" 60 || fail "No apareció la pantalla «Configura tu PIN» (pin1) en 60 s — la APK no pasa de la primera pantalla"
screenshot "01-first-use-screen"
log "✓ Primera pantalla visible: «Configura tu PIN»"

# ── 2. PIN de ejemplo en ambos campos ───────────────────────────────────
log "Escribiendo el PIN de ejemplo en pin1 y pin2…"
type_into "$ID_PIN1" "$PIN" || fail "no se pudo escribir el PIN en pin1"
type_into "$ID_PIN2" "$PIN" || fail "no se pudo escribir el PIN en pin2"

# ── 3. «Crear bóveda» → HOME ────────────────────────────────────────────
log "Pulsando «Crear bóveda»…"
if ! tap_view "$ID_CREATE"; then
  # El botón puede haber quedado fuera de viewport tras abrir el teclado:
  # scroll up + re-dump + reintento; como última vía, ENTER sobre pin2
  # dispara IME_ACTION_DONE → performClick() del botón (lógica de la app).
  log "btn_create no visible → scroll + ENTER (IME_ACTION_DONE)"
  adb shell input swipe 540 1500 540 600 300 >/dev/null 2>&1 || true
  sleep 1
  dump_ui || true
  tap_view "$ID_CREATE" || adb shell input keyevent 66
fi
sleep 2

log "Esperando HOME (btn_new_license) — PBKDF2 + Keystore pueden tardar…"
if ! wait_view "$ID_HOME_NEW" 90; then
  # Reintento vía IME_ACTION_DONE (algunos teclados ignoran el ESC).
  dump_ui || true
  if ! find_view "$ID_HOME_NEW" >/dev/null; then
    adb shell input keyevent 66 >/dev/null 2>&1 || true
    sleep 2
  fi
  wait_view "$ID_HOME_NEW" 30 || fail "No se llegó a HOME tras «Crear bóveda» — el PIN de la primera pantalla no funciona"
fi
screenshot "02-home-after-create"
log "✓ La APK PASÓ la primera pantalla: HOME visible (btn_new_license)"

# ── 4. Cierre + relanzamiento → desbloqueo con el MISMO PIN ─────────────
log "Forzando cierre y relanzando (verificar desbloqueo + persistencia)…"
adb shell am force-stop "$PKG"
sleep 2
adb shell am start -W -n "$ACT" >/dev/null || fail "am start (relanzamiento) falló"
sleep 3
log "Esperando pantalla de desbloqueo (unlock_pin)…"
wait_view "$ID_UNLOCK_PIN" 60 || fail "No apareció la pantalla de desbloqueo tras relanzar"
screenshot "03-unlock-screen"

# Nota: el emulador de CI no tiene biometría inscrita → el prompt
# biométrico NO se muestra; el desbloqueo es 100 % por PIN.
type_into "$ID_UNLOCK_PIN" "$PIN" || fail "no se pudo escribir el PIN en unlock_pin"
log "Pulsando «Desbloquear»…"
if ! tap_view "$ID_UNLOCK_BTN"; then
  adb shell input swipe 540 1500 540 600 300 >/dev/null 2>&1 || true
  sleep 1
  dump_ui || true
  tap_view "$ID_UNLOCK_BTN" || adb shell input keyevent 66
fi
sleep 2
wait_view "$ID_HOME_NEW" 60 || fail "No se llegó a HOME tras desbloquear con el PIN — el desbloqueo no funciona"
screenshot "04-home-after-unlock"
log "✓ Desbloqueo con el mismo PIN correcto → HOME"

# ── 5. PIN incorrecto debe FALLAR (control negativo) ─────────────────────
log "Control negativo: cerrar, relanzar y probar un PIN INCORRECTO…"
adb shell am force-stop "$PKG"
sleep 2
adb shell am start -W -n "$ACT" >/dev/null
sleep 3
wait_view "$ID_UNLOCK_PIN" 60 || fail "No apareció la pantalla de desbloqueo (control negativo)"
type_into "$ID_UNLOCK_PIN" "000000" || fail "no se pudo escribir el PIN incorrecto"
dump_ui || true
tap_view "$ID_UNLOCK_BTN" || adb shell input keyevent 66
sleep 3
dump_ui || true
if find_view "$ID_HOME_NEW" >/dev/null; then
  fail "Un PIN INCORRECTO desbloqueó la app — comportamiento inaceptable"
fi
if ! find_view "$ID_UNLOCK_PIN" >/dev/null; then
  fail "Tras el PIN incorrecto no vuelve a mostrarse la pantalla de bloqueo"
fi
screenshot "05-wrong-pin-rejected"
log "✓ PIN incorrecto rechazado (sigue bloqueada)"

# ── 6. Limpieza final ───────────────────────────────────────────────────
adb uninstall "$PKG" >/dev/null 2>&1 || true
echo ""
echo "══════════════════════════════════════════════════════════════════"
echo " VERIFICACIÓN COMPLETA: la APK pasa la primera pantalla con el PIN"
echo " de ejemplo, llega a HOME, persiste y se desbloquea correctamente."
echo " Evidencia: $EVIDENCE_DIR"
echo "══════════════════════════════════════════════════════════════════"
