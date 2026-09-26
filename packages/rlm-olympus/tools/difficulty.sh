#!/usr/bin/env bash
# Measure a candidate's real pass rate: n independent codex_cli rollouts,
# each graded in the Olympus base image. Costs a2 compute only — never shipd.
#   difficulty.sh <candidate-dir> [n]
set -uo pipefail
d="$(cd "${1:?candidate dir}" && pwd)"; n="${2:-4}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
m="$d/meta.json"; [ -f "$m" ] || { echo "difficulty: $d/meta.json required"; exit 2; }
get(){ python3 -c "import json,sys;print(json.load(open('$m'))['$1'])"; }
id=$(get id); repo=$(get repo); title=$(get title); hidden=$(get hidden); tsh=$(get test_sh)
img=$(cat "$d/image.txt")
# Rollouts are independent, so run them concurrently. Serial 4x1.5h was six
# hours of wall clock for one number.
# The a2 allowance is far smaller than a full agentic rollout, so 6 runs cannot
# be taken in one window: three concurrent rollouts exhausted a fresh reset
# instantly. Runs are therefore taken ONE at a time and ACCUMULATED across
# windows in verdicts.txt, and any run that hits the usage limit is discarded
# rather than scored (a starved run exits in seconds and looks like 0% solved).
touch "$d/verdicts.txt"
have=$(grep -c "baselinePassed=" "$d/verdicts.txt" 2>/dev/null | head -1); have=${have:-0}
echo "already accumulated: $have/$n valid run(s)"
k=$have
while [ "$k" -lt "$n" ]; do
  k=$((k+1))
  echo "=== run $k/$n ==="
  rid="${id}r${k}"
  bash "$here/codex_rollout.sh" "$rid" "$repo" "$title" "$d/description.txt" \
       "$hidden" "$tsh" "$img" > "$d/rollout.$k.log" 2>&1
  # Discard on ANY usage-limit hit, including runs that did substantial work
  # first. Two runs logged 163s/228s and 1000+ lines before being cut off; they
  # look like genuine failures -- varied files, varied LOC -- but they failed on
  # budget, not on difficulty, and would corrupt the pass rate.
  if grep -aq "usage limit" "/tmp/$rid.agent.log" 2>/dev/null; then
    if grep -aq "tokens used" "/tmp/$rid.agent.log" 2>/dev/null; then
      echo "  TRUNCATED mid-run by the usage limit — discarded (not a difficulty signal)"
    else
      echo "  usage limit hit before any work — discarded"
    fi
    k=$((k-1)); break
  fi
  line=$(grep -a -E ':\s+(PASS_LEGITIMATE|FAIL)\s+baselinePassed=' "$d/rollout.$k.log" | tail -1)
  if grep -aq "ABORT_HARNESS" "$d/rollout.$k.log" 2>/dev/null; then
    echo "  harness aborted (not an agent failure) - discarded"; k=$((k-1)); continue
  fi
  case "$line" in
    *baselinePassed=*) echo "  $line"; echo "$line" >> "$d/verdicts.txt" ;;
    *) echo "  <no parseable verdict - run discarded>"; k=$((k-1)) ;;
  esac
done
pass=$(grep -c "PASS_LEGITIMATE" "$d/verdicts.txt" 2>/dev/null | head -1); pass=${pass:-0}
runs=$(grep -c "baselinePassed=" "$d/verdicts.txt" 2>/dev/null | head -1); runs=${runs:-0}
echo
echo "valid runs accumulated: $runs/$n   passes: $pass"
if [ "$runs" -lt "$n" ]; then
  echo "INCOMPLETE — need $((n-runs)) more run(s); rerun when quota returns"
  exit 2
fi
n="$runs"
rate=$(python3 -c "print(round($pass/$n*100))")
python3 -c "import json;json.dump({'runs':$n,'passed':$pass,'rate_pct':$rate},open('$d/difficulty.json','w'))"
echo; echo "pass rate: $pass/$n = ${rate}%"
