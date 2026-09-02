#!/bin/zsh
# Keeps a drive working the backlog.
#
# The one-shot drive exits when it has worked everything it can reach. That is
# correct behaviour, and it is also why the backlog stopped moving overnight:
# nothing started it again. This restarts it, and stands down the moment the
# kill switch appears so it stays exactly as interruptible as the drive itself.
#
# launchd gives a job a minimal PATH — no /opt/homebrew/bin — so every tool is
# named by its full path here. The first version of this script called
# `timeout` and died on "command not found" instantly, which read in the log
# as a sweep that started and ended in the same second.
N=/Users/abhi/.local/share/fnm/node-versions/v22.23.1/installation/bin/node
TIMEOUT=/opt/homebrew/bin/timeout
LOG="$HOME/.rlm/agent/delegate/drive.log"
cd /Users/abhi/proj/rlm || exit 1
mkdir -p "$(dirname "$LOG")"

# Everything the drive's children need to find. A delegated agent inherits this
# environment, and a tool missing from it looks like an agent that cannot do
# the job rather than a PATH that was never set.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname $N)"

[ -x "$N" ] || { echo "[$(date +%H:%M:%S)] no node at $N" >> "$LOG"; exit 1; }
[ -x "$TIMEOUT" ] || TIMEOUT=""

while true; do
  stood_down=0
  for f in "$HOME/Desktop/.iris-autonomy-off" "$HOME/.rlm/agent/delegate/drive.stop"; do
    if [ -f "$f" ]; then
      echo "[$(date +%H:%M:%S)] stood down — $f is there" >> "$LOG"
      stood_down=1
      break
    fi
  done
  if [ "$stood_down" = "1" ]; then sleep 60; continue; fi

  echo "[$(date +%H:%M:%S)] sweep starting" >> "$LOG"
  if [ -n "$TIMEOUT" ]; then
    "$TIMEOUT" 3600 "$N" cordis-shell.mjs drive >> "$LOG" 2>&1
  else
    "$N" cordis-shell.mjs drive >> "$LOG" 2>&1
  fi
  rc=$?
  echo "[$(date +%H:%M:%S)] sweep ended rc=$rc" >> "$LOG"
  sleep 45
done
