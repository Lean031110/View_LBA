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
# Notas técnicas (aprendizajes de iteraciones anteriores de este script):
#   · resource-id de uiautomator NO lleva prefijo «@» (eso es sintaxis
#     Espresso). El volcado real confirmó pin1/pin2/btn_create visibles
#     con pantalla 320x640 del runner.
#   · Se verifica el FOCO tras cada tap (focused="true" del volcado)
#     antes de escribir: así el texto nunca cae en el campo equivocado
#     aunque el teclado redimensione la ventana.
#   · El submit usa la LÓGICA IME de la propia app: keyevent 66 (ENTER)
#     dispara actionDone → performClick(). Respaldo: tap por coordenadas
#     del volcado actualizado (scroll relativo a `wm size` si hiciera falta).
#   · PBKDF2 (150 000 iteraciones) + Keystore pueden tardar unos
#     segundos en el emulador: cada espera tiene su timeout propio.
# ============================================================================
set -uo pipefail

PIN="${1:-131313}"
APK="${2:-android-license-generator/app/build/outputs/apk/release/ViewLBA-License-Generator-v$(cat VERSION).apk}"
PKG="com.viewlba.licensegen"
ACT="$PKG/.ui.MainActivity"
EVIDENCE_DIR="${EVIDENCE_DIR:-/tmp/viewlba-first-screen}"

# resource-ids del volcado uiautomator (SIN «@» — no es sintaxis Espresso)
ID_PIN1="$PKG:id/pin1"
ID_PIN2="$PKG:id/pin2"
ID_CREATE="$PKG:id/btn_create"
ID_HOME_NEW="$PKG:id/btn_new_license"
ID_UNLOCK_PIN="$PKG:id/unlock_pin"
ID_UNLOCK_BTN="$PKG:id/btn_unlock"

mkdir -p "$EVIDENCE_DIR"
UI_XML="$EVIDENCE_DIR/ui.xml"

log()  { printf '\n[check] %s\n' "$*"; }
fail() {
  # Evidencia de fallo y salida con error.
  adb exec-out screencap -p > "$EVIDENCE_DIR/FAIL-$(date +%s).png" 2>/dev/null || true
  adb shell logcat -d -b crash > "$EVIDENCE_DIR/logcat-crash.txt" 2>/dev/null || true
  adb shell logcat -d | tail -200     > "$EVIDENCE_DIR/logcat-tail.txt" 2>/dev/null || true
  cp -f "$UI_XML" "$EVIDENCE_DIR/ui-at-failure.xml" 2>/dev/null || true
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

# node_tag ID → imprime el tag <node … resource-id="ID" …> del volcado.
node_tag() {
  local id="$1"
  grep -o "<node[^>]*resource-id=\"$id\"[^>]*>" "$UI_XML" 2>/dev/null | head -n1
}

# find_view ID → imprime "cx cy" (centro del control) o falla silenciosamente.
find_view() {
  local id="$1" tag bounds nums x1 y1 x2 y2 cx cy
  tag=$(node_tag "$id")
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

# focused_view ID → cierto si el control tiene el foco (focused="true").
focused_view() {
  local id="$1"
  grep -q "<node[^>]*resource-id=\"$id\"[^>]*focused=\"true\"" "$UI_XML" 2>/dev/null
}

# field_text ID → contenido (text="…") del control (diagnóstico).
field_text() {
  local tag
  tag=$(node_tag "$1")
  printf '%s' "$tag" | sed -n 's/.* text="\([^"]*\)".*/\1/p'
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

# submit_ime — keyevent 66 (ENTER): dispara actionNext/actionDone
# declarados por la app (performClick del botón correspondiente).
submit_ime() {
  adb shell input keyevent 66
}

# screenshot NAME → guarda PNG en la carpeta de evidencia.
screenshot() {
  adb exec-out screencap -p > "$EVIDENCE_DIR/$1.png" 2>/dev/null || true
}

# swipe_up — scroll ascendente RESOLUCIÓN-INDEPENDIENTE (wm size).
swipe_up() {
  local size w h
  size=$(adb shell wm size 2>/dev/null | grep -oE '[0-9]+x[0-9]+' | tail -n1)
  w="${size%x*}"; w="${w:-320}"
  h="${size#*x}"; h="${h:-640}"
  adb shell input swipe $((w / 2)) $((h * 3 / 4)) $((w / 2)) $((h / 2)) 300 \
    >/dev/null 2>&1 || true
}

# type_into_field ID TEXT → toca el campo, VERIFICA el foco y escribe.
# La verificación del foco evita que el texto caiga en otro campo si el
# teclado ha redimensionado/desplazado la ventana tras el tap.
type_into_field() {
  local id="$1" text="$2"
  dump_ui || fail "sin volcado UI antes de escribir en $id"
  tap_view "$id" || fail "no se pudo tocar $id"
  sleep 1
  dump_ui || true
  if ! focused_view "$id"; then
    # El tap no enfocó (p.ej. quedó tras el teclado) → scroll y reintento.
    log "foco no en $id tras el tap → scroll + reintento"
    swipe_up
    sleep 1
    dump_ui || true
    tap_view "$id" || fail "no se pudo tocar $id (2.º intento)"
    sleep 1
    dump_ui || true
  fi
  focused_view "$id" || fail "no se pudo enfocar $id — el texto no se escribiría en el campo correcto"
  adb shell input text "$text" || fail "input text falló en $id"
  sleep 1
}

# tap_button_with_fallback ID — tap directo; si el botón no está en el
# dump: ESC (cerrar teclado) → re-dump → tap; luego scroll → re-dump → tap.
tap_button_with_fallback() {
  local id="$1"
  dump_ui || true
  if tap_view "$id"; then return 0; fi
  adb shell input keyevent 111 >/dev/null 2>&1 || true   # ESC: ocultar teclado
  sleep 1
  dump_ui || true
  if tap_view "$id"; then return 0; fi
  swipe_up
  sleep 1
  dump_ui || true
  tap_view "$id"
}

# move_focus_to ID → garantiza el foco en ID. Orden seguro: primero
# actionNext por ENTER (nunca escribe caracteres), luego tap por coords.
# (Un tap sobre un campo tapado por el teclado podría teclear en el campo
# equivocado — por eso ENTER va primero.)
move_focus_to() {
  local id="$1"
  dump_ui || true
  focused_view "$id" && return 0
  submit_ime                    # actionNext (ENTER) sobre el campo actual
  sleep 1
  dump_ui || true
  focused_view "$id" && return 0
  tap_view "$id" || true
  sleep 1
  dump_ui || true
  focused_view "$id"
}

echo "── Verificación del primer arranque de la APK ─────────────────────"
echo "  APK     : $APK"
echo "  PIN     : $PIN (ejemplo)"
echo "  Paquete : $PKG"
echo "  evidencia: $EVIDENCE_DIR"
echo "  pantalla: $(adb shell wm size 2>/dev/null | tr -d '\r' | grep -oE '[0-9]+x[0-9]+' | tail -n1)"
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
type_into_field "$ID_PIN1" "$PIN"
dump_ui || true
log "pin1 contiene ${#PIN} caracteres escritos"
move_focus_to "$ID_PIN2" || fail "no se pudo enfocar pin2 (tap ni actionNext)"
adb shell input text "$PIN" || fail "input text falló en pin2"
sleep 1
dump_ui || true
log "pin2 text='$(field_text "$ID_PIN2")' (debe mostrar puntos/valor, no el hint)"

# ── 3. «Crear bóveda» → HOME ────────────────────────────────────────────
log "Enviando «Crear bóveda» (actionDone / tap)…"
submit_ime                      # actionDone → performClick() del botón
sleep 3
if ! wait_view "$ID_HOME_NEW" 45; then
  # Respaldo por coordenadas (los campos ya están rellenos).
  log "HOME no visible tras actionDone → respaldo por tap directo…"
  tap_button_with_fallback "$ID_CREATE" || true
  sleep 3
  wait_view "$ID_HOME_NEW" 45 || fail "No se llegó a HOME tras «Crear bóveda» — el PIN de la primera pantalla no funciona"
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
log "Desbloqueando con el MISMO PIN…"
type_into_field "$ID_UNLOCK_PIN" "$PIN"
submit_ime                      # actionDone → «Desbloquear»
sleep 3
if ! wait_view "$ID_HOME_NEW" 45; then
  log "HOME no visible tras actionDone → respaldo por tap directo…"
  tap_button_with_fallback "$ID_UNLOCK_BTN" || true
  sleep 3
  wait_view "$ID_HOME_NEW" 45 || fail "No se llegó a HOME tras desbloquear con el PIN — el desbloqueo no funciona"
fi
screenshot "04-home-after-unlock"
log "✓ Desbloqueo con el mismo PIN correcto → HOME"

# ── 5. PIN incorrecto debe FALLAR (control negativo) ─────────────────────
log "Control negativo: cerrar, relanzar y probar un PIN INCORRECTO…"
adb shell am force-stop "$PKG"
sleep 2
adb shell am start -W -n "$ACT" >/dev/null
sleep 3
wait_view "$ID_UNLOCK_PIN" 60 || fail "No apareció la pantalla de desbloqueo (control negativo)"
type_into_field "$ID_UNLOCK_PIN" "000000"
submit_ime                      # intento de desbloqueo (DEBE fallar)
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

# ── 6. Diagnóstico: logcat de la app (éxito O fallo) ────────────────────
# El fix defensivo de MasterKeyVault registra en ViewLBA-Vault cualquier
# fallo criptográfico inesperado (p.ej. el pbkdf2 que tiraba la app con un
# PIN incorrecto) — se captura SIEMPRE para poder auditarlo.
log "Capturando logcat de la app (diagnóstico)…"
adb logcat -d | grep -E "ViewLBA-Vault|AndroidRuntime|FATAL" \
  > "$EVIDENCE_DIR/logcat-app.txt" 2>/dev/null || true
if [ -s "$EVIDENCE_DIR/logcat-app.txt" ]; then
  echo "  (hallazgos en logcat-app.txt: $(grep -c . "$EVIDENCE_DIR/logcat-app.txt") líneas)"
fi

# ── 7. Limpieza final ───────────────────────────────────────────────────
adb uninstall "$PKG" >/dev/null 2>&1 || true
echo ""
echo "══════════════════════════════════════════════════════════════════"
echo " VERIFICACIÓN COMPLETA: la APK pasa la primera pantalla con el PIN"
echo " de ejemplo, llega a HOME, persiste y se desbloquea correctamente."
echo " Evidencia: $EVIDENCE_DIR"
echo "══════════════════════════════════════════════════════════════════"
