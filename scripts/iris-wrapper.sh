#!/usr/bin/env bash
# Iris CLI wrapper

# Determine the command
CMD="${1:-help}"

if [ "$CMD" = "help" ] || [ "$CMD" = "" ]; then
  cat <<'EOF'
Iris Commands:
--------------
list           List all iris resources
get            Get iris resource by ID
create         Create new iris resource
proc list      List running subagents
rlm inflight   Get in-flight subagents
commands       List all available iris commands
terminal.status  Get status of terminal windows
desktop.find   Search for windows/tabs
config.speech  Configure speech recognition
config.voice   Configure voice synthesis
config.brain   Configure AI model settings
recall.match   Match stored patterns
transcript     Manage agent transcripts
error          View and manage agent errors
evolve         Trigger harness self-evolution
EOF
  exit 0
fi

echo "Unknown command: $CMD"
exit 1

