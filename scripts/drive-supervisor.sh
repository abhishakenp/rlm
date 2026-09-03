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

  # One sweep at a time, across processes.
  #
  # There is no cross-process lock on the store, so two drives can pick up the
  # same task and both work it. That used to be prevented only by there being
  # exactly one supervisor — which stopped being true the moment a supervisor
  # died and left its sweep running with ppid 1, and again the moment this
  # became a launchd job that starts whether or not an orphan is still going.
  # `pgrep -f` sees every drive on the machine, orphan or not, so this holds
  # even when nothing is anybody's child any more. The pattern allows flags
  # between the entry and the subcommand: the literal "cordis-shell.mjs drive"
  # stopped matching the moment `--headless` was inserted between them, which
  # would have switched this guard off silently and let two drives share one
  # store — the exact thing it exists to prevent.
  others=$(/usr/bin/pgrep -f "cordis-shell\\.mjs( .*)? drive" | /usr/bin/grep -v "^$$\$" | /usr/bin/wc -l | /usr/bin/tr -d ' ')
  if [ "$others" != "0" ]; then
    echo "[$(date +%H:%M:%S)] a drive is already sweeping ($others) — standing by" >> "$LOG"
    sleep 30
    continue
  fi

  echo "[$(date +%H:%M:%S)] sweep starting" >> "$LOG"
  # `--headless`, and the node flags hoisted in front of the entry.
  #
  # Two things measured on the live sweep, both of them this script's fault:
  #
  #   1. The drive was never told it is headless. `detect()` in @rlm/headless
  #      found no flag and no environment variable, concluded somebody is
  #      watching, and mounted the real HMR plugin — so a sweep nobody is
  #      looking at held **1,715 open file descriptors under packages/**,
  #      chokidar's one-fs.watch-per-file fallback, for the whole 3600s. Every
  #      delegated child has passed `--headless` for hours; the drive that
  #      spawns them never did. Measured: 131 MB -> 119 MB boot dirty, plus the
  #      1,715 descriptors and 0.82 MB of FSEventWrap in the heap snapshot.
  #
  #   2. `cordis-shell.mjs` re-execs itself when `--expose-internals` is
  #      missing, so this line cost a whole extra process: a stub that does
  #      nothing but spawn the real one and forward signals, measured at 12 MB
  #      — 11 MB of Node's own floor plus 1 MB of module graph. Passing the two
  #      flags here makes the re-exec condition false. `--expose-internals`
  #      itself is free (11 MB with and without); tsx is the whole +15 MB, and
  #      that stays, because the loader is what reads the .ts composition.
  #
  # The re-exec block in cordis-shell.mjs stays for direct invocations. Headless
  # is reversible at runtime with `rlmHeadless.set(false)` if a row ever needs
  # editing against a running drive.
  TSX="/Users/abhi/proj/rlm/node_modules/tsx/dist/loader.mjs"
  if [ -f "$TSX" ]; then
    NODEFLAGS=(--expose-internals --import "$TSX")
  else
    NODEFLAGS=()
    echo "[$(date +%H:%M:%S)] no tsx loader at $TSX — letting cordis-shell re-exec itself" >> "$LOG"
  fi
  if [ -n "$TIMEOUT" ]; then
    "$TIMEOUT" 3600 "$N" "${NODEFLAGS[@]}" cordis-shell.mjs --headless drive >> "$LOG" 2>&1
  else
    "$N" "${NODEFLAGS[@]}" cordis-shell.mjs --headless drive >> "$LOG" 2>&1
  fi
  rc=$?
  echo "[$(date +%H:%M:%S)] sweep ended rc=$rc" >> "$LOG"
  sleep 45
done
