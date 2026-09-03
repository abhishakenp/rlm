#!/usr/bin/env bash
# Fixed iris check script
# This version handles the actual JSON output format from iris speak

FIRST_OUTPUT=$(/Users/abhi/proj/rlm/../.local/bin/iris speak text="test voice working" 2>&1)

# Check for "spoken": true with optional whitespace after the colon
if echo "$FIRST_OUTPUT" | grep -q "spoken.*:.*true"; then
  echo "CHECK PASSED"
  exit 0
else
  echo "CHECK FAILED: $FIRST_OUTPUT"
  exit 1
fi
