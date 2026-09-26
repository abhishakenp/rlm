#!/usr/bin/env bash
# Grade any workspace with the real test.sh in the real image — identical to how
# a codex rollout is graded, so a screen result is comparable to a measurement.
#   grade_workspace.sh <candidate-dir> <workspace>
set -uo pipefail
d="$(cd "${1:?candidate}" && pwd)"; w="$(cd "${2:?workspace}" && pwd)"
hidden=$(python3 -c "import json;print(json.load(open('$d/meta.json'))['hidden'])")
tsh=$(python3 -c "import json;print(json.load(open('$d/meta.json'))['test_sh'])")
img=$(cat "$d/image.txt")
cp "$hidden" "$tsh" "$w/" && chmod +x "$w/test.sh"
for t in 1 2 3; do
  docker run --rm --entrypoint cat "$img" /app/.base_tests.txt > "$w/.base_tests.txt" 2>/dev/null
  [ -s "$w/.base_tests.txt" ] && break; sleep 3
done
out=$(docker run --rm --network none -v "$w:/app" "$img" bash -c '
  cd /app
  ./test.sh --output_path /tmp/b.xml base >/tmp/b.log 2>&1; echo "BASE_RC=$?"
  ./test.sh --output_path /tmp/n.xml new  >/tmp/n.log 2>&1; echo "NEW_RC=$?"
  echo "NEWFAIL=$(grep -ac "^\s*--- FAIL: " /tmp/n.log)"
  grep -aE "^\s*--- FAIL: " /tmp/n.log | head -6 | sed "s/^/D /"' 2>&1)
brc=$(sed -n 's/^BASE_RC=//p' <<<"$out"); nrc=$(sed -n 's/^NEW_RC=//p' <<<"$out")
nf=$(sed -n 's/^NEWFAIL=//p' <<<"$out")
[ "$nrc" = "0" ] && v=SOLVED || v=FAILED
echo "  screen result: $v   baselinePassed=$([ "$brc" = 0 ] && echo true || echo false)   newFailures=$nf"
[ "$nrc" != "0" ] && grep "^D " <<<"$out" | sed 's/^D/    missed:/'
