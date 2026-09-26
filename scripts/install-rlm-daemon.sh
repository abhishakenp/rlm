#!/bin/bash
# Install (or remove) a launchd agent that keeps rlm's daemon supervisor running.
#
# Why launchd: the supervisor is what lets sessions outlive their terminal, and
# rlm-integration's :20130 lives in it (the daemon is the default). Clients still start a
# supervisor on demand; this one runs as a hot standby when a client-started
# supervisor already owns the socket (RLM_DAEMON_STANDBY=1), so KeepAlive never
# churns — it takes over the moment the lock frees.
#
# Limits (worker W's scale test): launchd's default of 256 open files runs out
# around 240 subagents, so the plist raises NumberOfFiles; Bun's 256-request
# HTTP cap is lifted with BUN_CONFIG_MAX_HTTP_REQUESTS (workers inherit it).
#
# Usage:
#   scripts/install-rlm-daemon.sh                 # install com.abhi.rlm-daemon
#   scripts/install-rlm-daemon.sh --dry-run       # print the plist, change nothing
#   scripts/install-rlm-daemon.sh --uninstall
# Test options: --label <label> --agent-dir <dir> --socket <path> --plist-dir <dir>
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.abhi.rlm-daemon"
PLIST_DIR="$HOME/Library/LaunchAgents"
AGENT_DIR=""
SOCKET=""
DRY_RUN=0
UNINSTALL=0
NOFILE=65536

while [ $# -gt 0 ]; do
	case "$1" in
		--label) LABEL="$2"; shift 2 ;;
		--agent-dir) AGENT_DIR="$2"; shift 2 ;;
		--socket) SOCKET="$2"; shift 2 ;;
		--plist-dir) PLIST_DIR="$2"; shift 2 ;;
		--dry-run) DRY_RUN=1; shift ;;
		--uninstall) UNINSTALL=1; shift ;;
		*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done

PLIST="$PLIST_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "$UNINSTALL" = 1 ]; then
	launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
	rm -f "$PLIST"
	echo "removed $LABEL"
	exit 0
fi

BUN_BIN=""
for candidate in "$HOME/.bun/bin/bun" "/opt/homebrew/bin/bun" "$(command -v bun 2>/dev/null || true)"; do
	if [ -n "$candidate" ] && [ -x "$candidate" ]; then BUN_BIN="$candidate"; break; fi
done
[ -n "$BUN_BIN" ] || { echo "bun not found" >&2; exit 1; }

# The socket clients will look for: resolved with rlm's own rule, now, so the
# plist doesn't depend on launchd's environment (TMPDIR) matching the shell's.
if [ -z "$SOCKET" ]; then
	SOCKET="$(cd "$REPO_DIR" && ${AGENT_DIR:+RLM_CODING_AGENT_DIR="$AGENT_DIR"} "$BUN_BIN" -e 'import { defaultDaemonSocketPath } from "./packages/coding-agent/src/modes/daemon/daemon-socket.ts"; console.log(defaultDaemonSocketPath())')"
fi
LOG_DIR="${AGENT_DIR:-$HOME/.rlm/agent}/logs"
mkdir -p "$LOG_DIR"

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
env_entry() { printf '    <key>%s</key><string>%s</string>\n' "$1" "$(printf '%s' "$2" | xml_escape)"; }

PLIST_CONTENT="$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN_BIN</string>
    <string>$REPO_DIR/cordis-shell.mjs</string>
    <string>--mode</string>
    <string>daemon</string>
    <string>--daemon-socket</string>
    <string>$(printf '%s' "$SOCKET" | xml_escape)</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
$(env_entry PATH "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.bun/bin")
$(env_entry HOME "$HOME")
$(env_entry RLM_DAEMON "1")
$(env_entry RLM_DAEMON_STANDBY "1")
$(env_entry BUN_CONFIG_MAX_HTTP_REQUESTS "4096")
$( [ -n "$AGENT_DIR" ] && env_entry RLM_CODING_AGENT_DIR "$AGENT_DIR" )
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>SoftResourceLimits</key>
  <dict><key>NumberOfFiles</key><integer>$NOFILE</integer></dict>
  <key>HardResourceLimits</key>
  <dict><key>NumberOfFiles</key><integer>$NOFILE</integer></dict>
  <key>StandardOutPath</key><string>$LOG_DIR/rlm-daemon.launchd.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/rlm-daemon.launchd.log</string>
</dict>
</plist>
EOF
)"

if [ "$DRY_RUN" = 1 ]; then
	printf '%s\n' "$PLIST_CONTENT"
	exit 0
fi

mkdir -p "$PLIST_DIR"
TMP="$(mktemp "$PLIST_DIR/.$LABEL.XXXXXX")"
printf '%s\n' "$PLIST_CONTENT" > "$TMP"
plutil -lint "$TMP" >/dev/null
mv "$TMP" "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL → $PLIST (socket $SOCKET)"
