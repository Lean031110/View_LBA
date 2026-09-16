#!/usr/bin/env bash
# Monitor del run de release: poll cada 60s, imprime progreso de jobs/steps.
# Uso: monitor-release.sh <run_id> [max_minutos]
set -uo pipefail
RUN="${1:?run_id requerido}"
MAX_MIN="${2:-45}"
TOKEN="${GITHUB_TOKEN:?}"
API="https://api.github.com/repos/Lean031110/View_LBA/actions"
START=$(date +%s)
LAST=""

while true; do
  NOW=$(date +%s)
  ELAPSED=$(( (NOW - START) / 60 ))
  if [[ "$ELAPSED" -ge "$MAX_MIN" ]]; then
    echo "⏱ timeout de monitoreo (${MAX_MIN}min) — el run sigue; re-ejecutar el monitor"
    exit 2
  fi
  STATUS_JSON=$(curl -s -H "Authorization: Bearer ${TOKEN}" "$API/runs/$RUN" 2>/dev/null)
  STATUS=$(echo "$STATUS_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
  CONCL=$(echo "$STATUS_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('conclusion') or '')" 2>/dev/null)

  SUMMARY=$(curl -s -H "Authorization: Bearer ${TOKEN}" "$API/runs/$RUN/jobs" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print('parse-error'); raise SystemExit
lines=[]
for j in d.get('jobs',[]):
    step=''
    for s in j.get('steps',[]):
        if s.get('status')=='in_progress': step=f\" ▶ {s['name'][:55]}\"
    icon={'success':'✓','failure':'✗','cancelled':'⊘'}.get(j.get('conclusion'),'…')
    lines.append(f\"{icon} {j['name'][:52]} [{j['status']}]{step}\")
print(' | '.join(lines) if lines else 'sin jobs aún')
" 2>/dev/null)

  LINE="[$ELAPSED min] run=$STATUS ${CONCL:+→ $CONCL} :: $SUMMARY"
  if [[ "$LINE" != "$LAST" ]]; then
    echo "$LINE"
    LAST="$LINE"
  fi

  if [[ "$STATUS" == "completed" ]]; then
    echo "RUN COMPLETADO: conclusion=$CONCL"
    [[ "$CONCL" == "success" ]] && exit 0 || exit 1
  fi
  sleep 60
done
