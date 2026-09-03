#!/bin/bash
# Usage: ./session-demo.sh --session-id <id>

# Find session ID from arguments
SESSION_ID=""
for arg in "$@"; do
  if [[ "$arg" == --session-id=* ]]; then
    SESSION_ID="${arg#*--session-id=}"
    echo "Session ID from argument: $SESSION_ID"
    break
  fi
done

if [ -z "$SESSION_ID" ]; then
  echo "No session ID provided via argument"
fi

echo "Script session ID: ${sessionId}"
