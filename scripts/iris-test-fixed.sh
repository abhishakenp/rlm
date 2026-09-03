#!/usr/bin/env bash
FIRST_OUTPUT=$(/Users/abhi/.local/bin/iris speak text="test voice working" 2>&1)
echo "Output: $FIRST_OUTPUT"
if echo "$FIRST_OUTPUT" | grep -q "spoken.*:.*true"; then
  echo "CHECK PASSED"
  exit 0
else
  echo "CHECK FAILED"
  exit 1
fi
