#!/usr/bin/env bash
# The pre-rollout repair loop.
#
# Runs EVERY check the platform runs before rollouts, feeds each failure back to
# a generator, applies the fix, re-verifies deterministically, and repeats until
# the whole suite is clean. Only then is a candidate eligible for rollouts.
#
# Ordered cheapest-first so a broken artifact is caught by grep before it costs a
# container, and by a container before it costs a codex call:
#
#   1  structural lint          milliseconds, deterministic
#   2  deterministic checks     milliseconds, deterministic
#   3  repo compliance          one gh call
#   4  originality              gh search + repo grep
#   5  4-phase verify           docker, ~1 min
#   6  platform rubrics         a2 codex, metered
#
# Generation uses omni (non-frontier); validation uses codex. Rollouts are never
# touched here.
#
#   refine.sh <candidate-dir> [max-rounds]
set -uo pipefail
d="$(cd "${1:?candidate dir}" && pwd)"; max="${2:-6}"
T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

for round in $(seq 1 "$max"); do
  log "════ round $round/$max ════"
  fails=""; report=""

  run(){   # run <label> <cmd...>
    local label="$1"; shift
    local out rc
    out=$("$@" 2>&1); rc=$?
    if [ $rc -eq 0 ]; then
      echo "  PASS  $label"
    elif [ $rc -eq 3 ]; then
      echo "  SKIP  $label (could not evaluate - infrastructure, not a verdict)"
    else
      echo "  FAIL  $label"
      fails="$fails $label"
      report="$report

### $label
$out"
    fi
  }

  run "structural lint"     python3 "$T/lint_candidate.py" "$d"
  run "deterministic"       bash -c "cd '$d' && python3 '$T/det_checks.py' | grep -q 'ALL PASS'"
  run "repo compliance"     python3 "$T/repo_compliance.py" "$d"
  run "originality"         python3 "$T/originality.py" "$d"
  run "4-phase verify"      bash "$T/run_gates.sh" "$d"
  run "platform rubrics"    python3 "$T/judge.py" "$d" --jobs 3

  if [ -z "$fails" ]; then
    log "ALL PRE-ROLLOUT CHECKS PASS after $round round(s) - eligible for rollouts"
    exit 0
  fi

  log "failing:$fails - requesting repairs"
  python3 "$T/repair.py" "$d" "$report" || {
    echo "  repair step could not produce a fix; stopping"; exit 2; }
done
log "still failing after $max rounds - candidate needs human attention"
exit 1
