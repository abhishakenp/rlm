#!/usr/bin/env bash
# Verify Flakiness — the check that BLOCKS EVERYTHING DOWNSTREAM.
#
# Platform: "runs the suites multiple times, with and without the solution, and
# fails if any test changes its result between identical runs. A flaky suite
# can't grade agents fairly, so this blocks everything downstream until it's
# fixed."
#
# We had no equivalent. A suite that flips even one test between identical runs
# poisons every difficulty measurement -- an agent scored FAIL by a coin flip
# looks like difficulty, and a metered rollout is spent proving nothing.
#
#   verify_flakiness.sh <candidate-dir> [repeats]
set -uo pipefail
d="$(cd "${1:?candidate dir}" && pwd)"; n="${2:-3}"
img=$(cat "$d/image.txt")
hidden=$(python3 -c "import json;print(json.load(open('$d/meta.json'))['hidden'])")

run_suite() {   # run_suite <apply-solution:0|1> <iteration>
  docker run --rm --network none \
    -v "$d/test.patch:/patches/test.patch:ro" \
    -v "$d/solution.patch:/patches/solution.patch:ro" "$img" bash -c '
      cd /app
      git apply /patches/test.patch 2>/dev/null
      [ "'"$1"'" = "1" ] && git apply /patches/solution.patch 2>/dev/null
      chmod +x test.sh 2>/dev/null
      ./test.sh --output_path /tmp/b.xml base >/dev/null 2>&1; echo "base=$?"
      ./test.sh --output_path /tmp/n.xml new  >/dev/null 2>&1; echo "new=$?"
      # per-test outcomes, sorted so ordering differences are not false alarms
      grep -ao "<testcase[^>]*name=\"[^\"]*\"" /tmp/n.xml 2>/dev/null \
        | sed "s/.*name=\"//;s/\"//" | sort | tr "\n" "," ' 2>/dev/null
}

echo "Verify Flakiness — $n identical repeats in each condition"
for cond in 0 1; do
  label=$([ "$cond" = 0 ] && echo "WITHOUT solution" || echo "WITH solution")
  first=""; flaky=0
  for i in $(seq 1 "$n"); do
    out=$(run_suite "$cond" "$i")
    sig=$(echo "$out" | tr -d '\n')
    if [ -z "$first" ]; then first="$sig"
    elif [ "$sig" != "$first" ]; then
      flaky=1
      echo "  FLAKY  $label: repeat $i differs from repeat 1"
      echo "    run1: $(echo "$first" | cut -c1-100)"
      echo "    run$i: $(echo "$sig"  | cut -c1-100)"
    fi
  done
  [ "$flaky" = 0 ] && echo "  stable  $label ($n identical results)"
  [ "$flaky" = 1 ] && FAIL=1
done
if [ "${FAIL:-0}" = 1 ]; then
  echo; echo "FLAKY — this blocks everything downstream. A suite that changes its"
  echo "result between identical runs cannot grade agents fairly."
  exit 1
fi
echo; echo "STABLE — results are reproducible across identical runs"
