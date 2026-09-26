#!/usr/bin/env bash
# The full Olympus factory loop: iterate until ALL SEVEN submission criteria hold.
#
#   ┌─> refine.sh          every pre-rollout check, repaired until clean
#   │   accumulate 6 runs  one at a time across quota windows
#   │   second pass        Nova evaluator over every run
#   │   evaluate 7 criteria
#   │      all pass ──────> promote, exit 0
#   └── diagnose and act ─┘
#
# Each criterion has a DIFFERENT remedy, so the loop diagnoses before acting:
#
#   Difficulty too high (too easy)   -> add INDEPENDENT failure modes
#   Solvable = 0 passes (too hard)   -> the task may be unsolvable or unfair;
#                                       read the evaluator's reasoning first
#   Fair failed                      -> ambiguity, missing context, or an
#                                       environment blocker in the image
#   No cheating failed               -> the tests are gameable; strengthen them
#   Median LOC / files too low       -> scope is too small; widen the family
#
# An iteration costs 6 rollouts, so it never guesses: it acts on the evaluator's
# own verdict fields.
#
#   factory.sh <candidate-dir> [max-iterations] [target-pass-rate-pct]
set -uo pipefail
d="$(cd "${1:?candidate dir}" && pwd)"; maxit="${2:-4}"; target="${3:-20}"
T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R=~/proj/olympus-runs
say(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

for it in $(seq 1 "$maxit"); do
  say "════════ factory iteration $it/$maxit ════════"

  say "phase 1 - pre-rollout checks (repair loop)"
  bash "$T/refine.sh" "$d" 6 || { echo "pre-rollout checks did not converge"; exit 2; }

  say "phase 2 - accumulate 6 valid rollouts"
  rm -f "$d/verdicts.txt" "$d/difficulty.json"
  bash "$R/accumulate.sh" "$d" 6 || { echo "could not accumulate 6 runs"; exit 3; }

  say "phase 3 - second pass (Nova evaluator over every run)"
  for rid in $(grep -oE '^\s*\S+:' "$d/verdicts.txt" | tr -d ' :'); do
    python3 "$T/evaluate_run.py" "$d" "$rid" || true
  done

  say "phase 4 - submission criteria"
  verdict=$(python3 "$T/criteria.py" "$d" "$target"); rc=$?
  echo "$verdict"
  if [ $rc -eq 0 ]; then
    say "ALL CRITERIA SATISFIED - promoting"
    bash "$R/promote.sh" "$d" claude 6 && exit 0
    exit 0
  fi

  say "phase 5 - diagnose and act"
  action=$(python3 "$T/criteria.py" "$d" "$target" --action)
  echo "  remedy: $action"
  case "$action" in
    HARDEN*)  python3 "$T/adjust.py" "$d" harden "$verdict" || exit 4 ;;
    SOFTEN*)  python3 "$T/adjust.py" "$d" soften "$verdict" || exit 4 ;;
    FAIRNESS*)python3 "$T/adjust.py" "$d" fairness "$verdict" || exit 4 ;;
    CHEAT*)   python3 "$T/adjust.py" "$d" antigame "$verdict" || exit 4 ;;
    SCOPE*)   python3 "$T/adjust.py" "$d" scope "$verdict" || exit 4 ;;
    *) echo "  no automatic remedy for: $action"; exit 5 ;;
  esac
done
say "did not converge in $maxit iterations - needs human attention"
exit 1
