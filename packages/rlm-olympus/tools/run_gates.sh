#!/usr/bin/env bash
# Run every free Olympus gate against a prepared candidate.
#   run_gates.sh <candidate-dir>
# Expects: description.txt test.patch solution.patch Dockerfile image.txt repo/
set -uo pipefail
d="${1:?candidate dir}"; cd "$d" || exit 1
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0
say(){ if [ "$1" = 0 ]; then echo "  PASS  $2"; pass=$((pass+1)); else echo "  FAIL  $2 ${3:+-- $3}"; fail=$((fail+1)); fi; }

echo "== deterministic =="
python3 "$here/det_checks.py" >/tmp/og_det.txt 2>&1
grep -q "ALL PASS" /tmp/og_det.txt; say $? "deterministic checks" "$(grep -c '^FAIL' /tmp/og_det.txt) failing"

echo "== spec lint =="
# every exported symbol named in the description must also appear in the test patch
missing=""
for sym in $(grep -ohE '\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b' description.txt | sort -u); do
  grep -q "$sym" test.patch || missing="$missing $sym"
done
[ -z "$missing" ]; say $? "described symbols are exercised by tests" "unexercised:$missing"

echo "== 4-phase verification =="
img="$(cat image.txt 2>/dev/null)"
out=$(docker run --rm --network none \
  -v "$PWD/test.patch:/patches/test.patch:ro" \
  -v "$PWD/solution.patch:/patches/solution.patch:ro" \
  -v "$here/verify_4phase.sh:/verify.sh:ro" "$img" bash /verify.sh 2>&1)
echo "$out" | grep -qE "^base1: exit=0"; say $? "base passes without solution"
echo "$out" | grep -qE "^new1: exit=1"; say $? "new fails without solution"
echo "$out" | grep -qE "^base2: exit=0"; say $? "base still passes with solution"
echo "$out" | grep -qE "^new2: exit=0"; say $? "new passes with solution"
n1=$(sed -n 's/^new1:.*cases=\([0-9]*\) fail[a-z]*=\([0-9]*\).*/\1 \2/p' <<<"$out")
set -- $n1; [ -n "${1:-}" ] && [ "${1:-0}" = "${2:-x}" ]; say $? "100% of new tests fail at base" "cases=${1:-?} fails=${2:-?}"

echo
echo "free gates: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && echo "READY FOR DIFFICULTY" || echo "BLOCKED — do not spend a rollout"
exit $fail
