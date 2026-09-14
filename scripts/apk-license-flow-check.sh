#!/usr/bin/env bash
# ============================================================================
# apk-license-flow-check.sh — FLUJO COMPLETO de crear una licencia
#
# MISIÓN (pedido explícito del usuario): «test del flujo completo de crear
# una licencia desde abrir la APK hasta copiar la licencia ya lista,
# inventa los datos solo para probar todo».
#
#   1. Instalación limpia → primer uso → PIN de ejemplo (2025 — valida la
#      política NUEVA de PIN simple 4-16 chars) → HOME
#   2. HOME → «Nueva licencia»
#   3. Pegar código de solicitud DEMO (VLDEMO-CI-SMOKE — datos inventados,
#      solo disponible en builds de CI con -PdemoRequests=true) → validar
#      → aparece el cliente + opciones de duración
#   4. GENERAR (plan anual por defecto) → token VLBA2-… visible en pantalla
#   5. «Copiar token» → toast «Copiado al portapapeles» + sin crash
#   6. Historial → la licencia emitida aparece listada
#
# Requiere: APK compilada con -PdemoRequests=true (CI emulator smoke) y
# `scripts/apk-first-screen-check.sh` ya validado (mismas técnicas UI).
# Evidencia (screenshots + volcados UI + logcat) en $EVIDENCE_DIR.
#
# Uso: bash scripts/apk-license-flow-check.sh [PIN] [RUTA_APK]
# ============================================================================
set -uo pipefail

PIN="${1:-2025}"
APK="${2:-android-license-generator/app/build/outputs/apk/release/ViewLBA-License-Generator-v$(cat VERSION).apk}"
PKG="com.viewlba.licensegen"
ACT="$PKG/.ui.MainActivity"
EVIDENCE_DIR="${EVIDENCE_DIR:-/tmp/viewlba-license-flow}"
DEMO_CODE="VLDEMO-CI-SMOKE-1234"

# resource-ids del volcado uiautomator (SIN «@»)
ID_PIN1="$PKG:id/pin1"
ID_PIN2="$PKG:id/pin2"
ID_CREATE="$PKG:id/btn_create"
ID_HOME_NEW="$PKG:id/btn_new_license"
ID_REQ_CODE="$PKG:id/request_code"
ID_VALIDATE="$PKG:id/btn_validate"
ID_CUSTOMER="$PKG:id/req_customer"
ID_OPTIONS="$PKG:id/issue_options"
ID_GENERATE="$PKG:id/btn_generate"
ID_RESULT="$PKG:id/token_result"
ID_COPY="$PKG:id/btn_copy_token"
ID_STATUS="$PKG:id/new_license_status"
ID_BACK="$PKG:id/btn_back"
ID_HISTORY="$PKG:id/btn_history"

mkdir -p "$EVIDENCE_DIR"
UI_XML="$EVIDENCE_DIR/ui.xml"

log()  { printf '\n[flow] %s\n' "$*"; }
fail() {
  adb exec-out screencap -p > "$EVIDENCE_DIR/FAIL-$(date +%s).png" 2>/dev/null || true
  adb shell logcat -d -b crash > "$EVIDENCE_DIR/logcat-crash.txt" 2>/dev/null || true
  adb shell logcat -d | tail -200     > "$EVIDENCE_DIR/logcat-tail.txt" 2>/dev/null || true
  cp -f "$UI_XML" "$EVIDENCE_DIR/ui-at-failure.xml" 2>/dev/null || true
  echo "::error::$*"
  echo "[FAIL] $*"
  echo "[FAIL] Evidencia en $EVIDENCE_DIR (screenshot + UI dump + logcat)"
  exit 1
}

# ── helpers (mismas técnicas verificadas de apk-first-screen-check.sh) ────
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

node_tag() {
  local id="$1"
  grep -o "<node[^>]*resource-id=\"$id\"[^>]*>" "$UI_XML" 2>/dev/null | head -n1
}

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

focused_view() {
  local id="$1"
  grep -q "<node[^>]*resource-id=\"$id\"[^>]*focused=\"true\"" "$UI_XML" 2>/dev/null
}

field_text() {
  local tag
  tag=$(node_tag "$1")
  printf '%s' "$tag" | sed -n 's/.* text="\([^"]*\)".*/\1/p'
}

wait_view() {
  local id="$1" timeout_s="$2" elapsed=0
  while [ "$elapsed" -lt "$timeout_s" ]; do
    dump_ui || true
    if find_view "$id" >/dev/null; then
      return 0
    fi
    # el control puede estar bajo el scroll visible
    if grep -q "resource-id=\"$id\"" "$UI_XML" 2>/dev/null; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

# wait_text ID SUBSTR TIMEOUT → espera a que el texto del control contenga SUBSTR
wait_text() {
  local id="$1" substr="$2" timeout_s="$3" elapsed=0 txt
  while [ "$elapsed" -lt "$timeout_s" ]; do
    dump_ui || true
    txt=$(field_text "$id")
    case "$txt" in
      *"$substr"*) return 0 ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

tap_view() {
  local id="$1" coords
  coords=$(find_view "$id") || return 1
  # shellcheck disable=SC2086
  adb shell input tap $coords
}

screenshot() {
  adb exec-out screencap -p > "$EVIDENCE_DIR/$1.png" 2>/dev/null || true
}

swipe_up() {
  local size w h
  size=$(adb shell wm size 2>/dev/null | grep -oE '[0-9]+x[0-9]+' | tail -n1)
  w="${size%x*}"; w="${w:-320}"
  h="${size#*x}"; h="${h:-640}"
  adb shell input swipe $((w / 2)) $((h * 3 / 4)) $((w / 2)) $((h / 2)) 300 \
    >/dev/null 2>&1 || true
}

# tap_button_with_fallback ID → toca un botón, OCULTANDO ANTES el teclado
#
# LECCIÓN (fallo real del primer run del flujo completo): un IME abierto
# tapa los botones del final de la pantalla y `input tap` sobre sus
# coordenadas cae en una TECLA del teclado, no en el botón — tap_view
# devuelve 0 igualmente y el handler nunca corre (el status no cambiaba
# tras «GENERAR»). ESC inofensivo si no hay teclado: siempre se envía
# ANTES del primer intento.
tap_button_with_fallback() {
  local id="$1"
  adb shell input keyevent 111 >/dev/null 2>&1 || true   # ESC: ocultar teclado
  sleep 1
  dump_ui || true
  if tap_view "$id"; then return 0; fi
  swipe_up
  sleep 1
  dump_ui || true
  tap_view "$id"
}

# ime_open → cierto si el teclado en pantalla está visible (dumpsys IME)
ime_open() {
  adb shell dumpsys input_method 2>/dev/null | grep -q "mInputShown=true"
}

# close_ime → ESC (hasta 3) hasta que dumpsys confirme el IME oculto.
# Un swipe sobre el teclado abierto ESCRIBE en el campo enfocado (por eso
# aparecía basura «GT GT…» en el código de solicitud durante los scrolls).
close_ime() {
  local i
  for i in 1 2 3; do
    adb shell input keyevent 111 >/dev/null 2>&1 || true   # ESC: ocultar IME
    sleep 1
    ime_open || return 0
  done
  return 0
}

type_into_field() {
  local id="$1" text="$2" before after
  dump_ui || fail "sin volcado UI antes de escribir en $id"
  before=$(field_text "$id")
  tap_view "$id" || fail "no se pudo tocar $id"
  sleep 1
  dump_ui || true
  if ! focused_view "$id"; then
    log "foco no en $id tras el tap → scroll + reintento"
    swipe_up
    sleep 1
    dump_ui || true
    tap_view "$id" || fail "no se pudo tocar $id (2.º intento)"
    sleep 1
    dump_ui || true
  fi
  adb shell input text "$text" || fail "input text falló en $id"
  sleep 1
  dump_ui || true
  after=$(field_text "$id")
  if [ -z "$after" ] || [ "$after" = "$before" ]; then
    log "el texto no llegó a $id → ESC + retap + reintento"
    adb shell input keyevent 111 >/dev/null 2>&1 || true
    sleep 1
    dump_ui || true
    tap_view "$id" || true
    sleep 1
    adb shell input text "$text" >/dev/null 2>&1 || true
    sleep 1
    dump_ui || true
    after=$(field_text "$id")
  fi
  if [ -z "$after" ] || [ "$after" = "$before" ]; then
    fail "no se pudo escribir en $id"
  fi
}

# toast_visible SUBSTR TIMEOUT → cierto si algún volcado contiene el texto
# (los toasts viven ~3 s en el árbol de accesibilidad).
toast_visible() {
  local substr="$1" timeout_s="$2" elapsed=0
  while [ "$elapsed" -lt "$timeout_s" ]; do
    dump_ui || true
    if grep -q "$substr" "$UI_XML" 2>/dev/null; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

echo "── Flujo COMPLETO: abrir APK → crear licencia → copiar ───────────"
echo "  APK     : $APK"
echo "  PIN     : $PIN (ejemplo — política nueva 4-16)"
echo "  Código  : $DEMO_CODE (datos inventados, solo builds CI)"
echo "  evidencia: $EVIDENCE_DIR"
[ -f "$APK" ] || fail "APK no encontrada: $APK (¿se compiló antes de este script?)"

# ── 0. Instalación limpia ────────────────────────────────────────────────
adb uninstall "$PKG" >/dev/null 2>&1 || true
log "Instalando APK…"
adb install -r "$APK" || fail "adb install falló"

# ── 1. Abrir la APK → configurar el PIN simple → HOME ────────────────────
log "Lanzando la app (primer uso)…"
adb shell am start -W -n "$ACT" >/dev/null || fail "am start falló"
sleep 3
wait_view "$ID_PIN1" 60 || fail "No apareció la pantalla «Configura tu PIN» — la APK no pasa de la primera pantalla"
screenshot "01-first-use"

type_into_field "$ID_PIN1" "$PIN"
dump_ui || true
tap_view "$ID_PIN2" || fail "no se pudo tocar pin2"
sleep 1
dump_ui || true
adb shell input text "$PIN" || fail "input text falló en pin2"
sleep 1
dump_ui || true
PIN2_TXT=$(field_text "$ID_PIN2")
[ -n "$PIN2_TXT" ] || fail "el PIN no llegó a pin2"
screenshot "02-pin-escrito"

tap_button_with_fallback "$ID_CREATE" || fail "no se pudo tocar «Crear bóveda»"
log "Esperando HOME (PBKDF2 en bg puede tardar)…"
wait_view "$ID_HOME_NEW" 120 || fail "No se llegó a HOME tras crear la bóveda (btn_new_license invisible tras 120 s)"
screenshot "03-home"
log "✓ HOME alcanzado — la bóveda se creó con el PIN simple"

# ── 2. «Nueva licencia» ──────────────────────────────────────────────────
log "Abriendo «Nueva licencia»…"
tap_view "$ID_HOME_NEW" || fail "no se pudo tocar btn_new_license"
wait_view "$ID_REQ_CODE" 30 || fail "no apareció el campo del código de solicitud"
screenshot "04-new-license"

# ── 3. Pegar el código DEMO (datos inventados) y validar ─────────────────
log "Escribiendo el código de solicitud demo ($DEMO_CODE)…"
type_into_field "$ID_REQ_CODE" "$DEMO_CODE"
# El teclado queda abierto tras escribir: cerrarlo ANTES de validar para
# que el tap de VALIDAR caiga en el botón (el código queda ya asentado).
close_ime || true
screenshot "05-codigo-pegado"
tap_button_with_fallback "$ID_VALIDATE" || fail "no se pudo tocar «Validar»"
log "Esperando validación (cliente visible)…"
wait_text "$ID_CUSTOMER" "Cliente Demo" 30 \
  || fail "La solicitud demo no validó: req_customer no muestra «Cliente Demo» (¿build sin -PdemoRequests=true?)"
screenshot "06-solicitud-valida"
log "✓ Solicitud validada: «$(field_text "$ID_CUSTOMER")»"

# ── 4. GENERAR la licencia (plan anual por defecto) ──────────────────────
log "Buscando el botón GENERAR (scroll si hace falta)…"
wait_view "$ID_GENERATE" 20 || { swipe_up; sleep 1; wait_view "$ID_GENERATE" 20 || fail "no se encontró btn_generate"; }

# VERIFICACIÓN del tap (lección del primer run): el handler de GENERAR
# limpia el status al instante → si tras tocar sigue el texto de
# «Solicitud válida», el tap NO llegó al botón (IME abierto tapando
# GENERAR — el tap caía en una tecla del teclado). Protocolo: cerrar el
# teclado, tocar, esperar 3 s y comprobar token/status; si nada cambió →
# scroll + reintento (hasta 3). Con el IME cerrado el primer tap llega y
# las comprobaciones son solo una red de seguridad.
STATUS_BEFORE=$(field_text "$ID_STATUS")
GEN_TRIES=0
while [ "$GEN_TRIES" -lt 3 ]; do
  close_ime || true          # el teclado NO puede tapar GENERAR
  dump_ui || true
  tap_view "$ID_GENERATE" || true
  sleep 3
  dump_ui || true
  TOKEN=$(field_text "$ID_RESULT")
  case "$TOKEN" in VLBA2-*) break ;; esac
  STATUS_NOW=$(field_text "$ID_STATUS")
  if [ -n "$STATUS_NOW" ] && [ "$STATUS_NOW" != "$STATUS_BEFORE" ]; then
    break   # el handler corrió (status cambió) → el token llega abajo
  fi
  GEN_TRIES=$((GEN_TRIES + 1))
  log "el tap de GENERAR no llegó al botón (intento $GEN_TRIES) → scroll + reintento"
  swipe_up >/dev/null 2>&1 || true
  sleep 1
done
log "Esperando el token VLBA2-…"
TOKEN=""
for i in $(seq 1 45); do
  dump_ui || true
  TOKEN=$(field_text "$ID_RESULT")
  case "$TOKEN" in
    VLBA2-*) break ;;
    *) TOKEN="" ;;
  esac
  [ -n "$TOKEN" ] && break
  # el cuadro del resultado puede quedar BAJO el área visible → scroll,
  # pero NUNCA con el teclado abierto (el swipe escribiría en el campo)
  if [ $((i % 5)) -eq 0 ]; then
    if ime_open; then close_ime || true; else swipe_up; sleep 1; fi
  fi
  sleep 2
done
[ -n "$TOKEN" ] || fail "El token VLBA2-… no apareció tras GENERAR (status: $(field_text "$ID_STATUS"))"
screenshot "07-licencia-generada"
log "✓ Licencia generada: ${TOKEN:0:32}… (${#TOKEN} caracteres)"
# el estado debe informar la emisión (con nombre, días y vencimiento)
wait_text "$ID_STATUS" "Licencia emitida" 10 || log "aviso: status sin «Licencia emitida»: $(field_text "$ID_STATUS")"

# ── 5. COPIAR la licencia ya lista ───────────────────────────────────────
log "Copiando el token (btn_copy_token)…"
tap_button_with_fallback "$ID_COPY" || fail "no se pudo tocar «Copiar token»"
if toast_visible "Copiado" 8; then
  screenshot "08-token-copiado"
  log "✓ Token copiado al portapapeles (toast «Copiado al portapapeles» detectado)"
else
  # reintento: el toast pudo perderse por timing — el tap debe volver a copiar
  log "toast no capturado → reintento de copia…"
  tap_button_with_fallback "$ID_COPY" || true
  toast_visible "Copiado" 8 \
    || fail "No se detectó el toast «Copiado al portapapeles» tras dos intentos — el flujo de copiar NO se verificó"
  screenshot "08-token-copiado"
  log "✓ Token copiado al portapapeles (2.º intento)"
fi

# ── 6. Historial: la licencia emitida queda registrada ───────────────────
log "Volviendo a HOME y abriendo el Historial…"
tap_button_with_fallback "$ID_BACK" || fail "no se pudo volver (btn_back)"
sleep 2
tap_view "$ID_HISTORY" || fail "no se pudo tocar btn_history"
wait_view "$PKG:id/history_list" 30 || fail "no apareció la lista del historial"
sleep 2
dump_ui || true
screenshot "09-historial"
if grep -q "Cliente Demo" "$UI_XML" 2>/dev/null; then
  log "✓ La licencia «Cliente Demo CI» aparece en el historial"
else
  fail "La licencia emitida NO aparece en el historial (persistencia rota)"
fi

# ── 7. Sin crashes en todo el flujo ──────────────────────────────────────
CRASHES=$(adb shell logcat -d -b crash 2>/dev/null | grep -c "FATAL EXCEPTION" || true)
[ "${CRASHES:-0}" -eq 0 ] || fail "FATAL EXCEPTION en logcat durante el flujo ($CRASHES)"

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  ✓ FLUJO COMPLETO VERIFICADO"
echo "    abrir APK → PIN simple → Nueva licencia → validar solicitud"
echo "    → GENERAR → token VLBA2 copiado → historial persistido"
echo "═══════════════════════════════════════════════════════════════════"
