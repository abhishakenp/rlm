#!/bin/bash
cd "$(dirname "$0")" || exit 1
for a in "$@"; do
  src="arena/s$a"; [ -d "$src" ] || { echo "s$a: MISSING"; continue; }
  work="$(mktemp -d)/app"; cp -R "$src" "$work"
  cp gojq/556b82_test.go gojq/test.sh "$work/"; chmod +x "$work/test.sh"
  out=$(docker run --rm --network none -v "$work:/app" olympus-gojq2 bash -c '
    cd /app
    ./test.sh --output_path /tmp/base.xml base > /tmp/base.log 2>&1; echo "BASE_RC=$?"
    ./test.sh --output_path /tmp/new.xml  new  > /tmp/new.log  2>&1; echo "NEW_RC=$?"
    echo "NEWFAILS=$(grep -c "^\s*--- FAIL: " /tmp/new.log)"
    grep -E "^\s*--- FAIL: |cannot use|undefined: |syntax error" /tmp/new.log | head -5 | sed "s/^/D /"
  ' 2>&1)
  brc=$(sed -n 's/^BASE_RC=//p' <<<"$out"); nrc=$(sed -n 's/^NEW_RC=//p' <<<"$out")
  nf=$(sed -n 's/^NEWFAILS=//p' <<<"$out")
  files=$(diff -rq --exclude=.git --exclude=Dockerfile --exclude='556b82_test.go' --exclude='test.sh' freshq "$src" 2>/dev/null | grep -c ".")
  [ "$nrc" = "0" ] && v=PASS_LEGITIMATE || v=FAIL
  [ "$brc" = "0" ] && b=true || b=false
  echo "s$a: $v  baselinePassed=$b  filesChanged=$files  newFailures=$nf"
  [ "$nrc" != "0" ] && grep "^D " <<<"$out" | head -4 | sed 's/^D/   /'
  rm -rf "$(dirname "$work")"
done
