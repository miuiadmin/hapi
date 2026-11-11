#!/bin/bash
# rescue.sh — machine-side out-of-band rescue poller for the hapi runner.
#
# Purpose:
#   Poll the hub over HTTPS for a signed rescue command and execute it.
#   The whole loop is plain bash + curl + python3 + openssl (all in the
#   macOS baseline): ZERO dependency on Bun or the hapi binary, so it keeps
#   working even when the runner's event loop is starved to death
#   (2026-11-11 incident: runner process alive, zero heartbeat/log for 39
#   minutes under a load-39 storm; remote repair impossible, manual
#   on-site intervention required — this channel exists so that never
#   repeats).
#
# Security model (full SOP in deploy/rescue/README.md):
#   - Secret random URL path (knowledge of it is one shared secret)
#   - HMAC-SHA256 signature over "cmd|nonce|ts" with a shared secret
#   - 600s freshness window on ts (both directions, tolerates clock skew)
#   - nonce dedup against ~/.hapi-rescue/executed.nonces (last 100 entries)
#     => each signed command executes at most once per machine, even while
#     the same file keeps being served on every poll
#   - Strict whitelist: restart-runner | kill-agents | runner-status.
#     No arbitrary execution, no argument pass-through.
#   - Secret files installed with chmod 600 (~/.hapi-rescue/env.sh here,
#     /root/.hapi-rescue/secret on the hub)
#
# Install (summary — full steps in README.md):
#   ~/.hapi-rescue/env.sh                          RESCUE_URL / RESCUE_SECRET / RUNNER_WORKSPACE_ROOT (chmod 600)
#   ~/.hapi-rescue/rescue.sh                       this file (chmod 700)
#   ~/Library/LaunchAgents/com.hapi.rescue.plist   RunAtLoad + StartInterval 60
#
# Silence policy: a machine with no config, an empty hub response, a fetch
# failure, or an expired/duplicate command exits 0 without output — the
# poller must never spam launchd logs during normal operation. Only real
# events (executions, unknown commands, bad signatures) are logged.

set -u

# --- Static paths ----------------------------------------------------------
CONF_DIR="$HOME/.hapi-rescue"
ENV_FILE="$CONF_DIR/env.sh"
NONCE_FILE="$CONF_DIR/executed.nonces"
LOG_DIR="$HOME/.hapi/logs"
LOG_FILE="$LOG_DIR/rescue.log"
UA="hapi-rescue/1.0"

# launchd runs us with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that
# does not include the user-local install dir of the hapi binary; add the
# common locations before "hapi runner start" is invoked below.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# --- Config ----------------------------------------------------------------
# Missing config = machine not enrolled: silent exit by design.
[ -f "$ENV_FILE" ] || exit 0
. "$ENV_FILE"
[ -n "${RESCUE_URL:-}" ] && [ -n "${RESCUE_SECRET:-}" ] && [ -n "${RUNNER_WORKSPACE_ROOT:-}" ] || exit 0

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
}

mkdir -p "$LOG_DIR"

# --- Fetch ------------------------------------------------------------------
# -s silent, -m 10 hard timeout: a hung fetch must never block the poller.
# Empty body (204 / no pending command) or fetch failure => nothing to do.
body="$(curl -sm 10 -A "$UA" "$RESCUE_URL" 2>/dev/null)" || exit 0
[ -n "$body" ] || exit 0

# --- Parse -------------------------------------------------------------------
# Extract cmd/nonce/ts/sig as four lines. python3 only (no jq dependency,
# python3 is part of the macOS baseline). Any non-JSON body (CDN error page,
# garbage) makes python exit non-zero => silent exit.
if ! parsed="$(printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d["cmd"])
    print(d["nonce"])
    print(d["ts"])
    print(d["sig"])
except Exception:
    sys.exit(1)
' 2>/dev/null)"; then
  exit 0
fi
cmd="$(printf '%s' "$parsed" | sed -n 1p)"
nonce="$(printf '%s' "$parsed" | sed -n 2p)"
ts="$(printf '%s' "$parsed" | sed -n 3p)"
sig="$(printf '%s' "$parsed" | sed -n 4p)"

# Defensive: all four fields must be present, ts must be decimal epoch
# seconds (enqueue sends every field as a string).
[ -n "$cmd" ] && [ -n "$nonce" ] && [ -n "$ts" ] && [ -n "$sig" ] || exit 0
case "$ts" in *[!0-9]*|"") exit 0 ;; esac

# --- Verify signature ---------------------------------------------------------
# Canonical string is exactly "cmd|nonce|ts". Plain string compare is fine
# for this threat model (timing leakage of a digest comparison is
# irrelevant: without the secret an attacker cannot forge any valid digest).
calc="$(printf '%s' "$cmd|$nonce|$ts" | openssl dgst -sha256 -hmac "$RESCUE_SECRET" 2>/dev/null | awk '{print $NF}')"
if [ -z "$calc" ] || [ "$calc" != "$sig" ]; then
  # Abnormal (wrong secret or tampering): never execute, leave an audit line.
  log "rejected bad signature (cmd=$cmd)"
  exit 0
fi

# --- Verify freshness (600s window) --------------------------------------------
now="$(date +%s)"
age=$((now - ts))
if [ "$age" -gt 600 ] || [ "$age" -lt -600 ]; then
  # An expired command sitting on the hub is the steady state until the
  # operator clears it; silent to avoid one log line per poll.
  exit 0
fi

# --- Verify nonce (anti-replay) --------------------------------------------------
# The hub keeps serving the same signed file on every poll until it is
# cleared or overwritten; the nonce store makes it execute exactly once.
if [ -f "$NONCE_FILE" ] && grep -qxF "$nonce" "$NONCE_FILE" 2>/dev/null; then
  # Already consumed: silent (normal steady state, avoids log spam).
  exit 0
fi

# Consume the nonce BEFORE dispatch: a validly signed command is spent at
# most once even if the dispatch itself later fails.
touch "$NONCE_FILE"
chmod 600 "$NONCE_FILE"
echo "$nonce" >> "$NONCE_FILE"
# Keep only the last 100 entries (600s validity / 60s poll => 100 covers
# the dedup window with a wide margin).
tail -n 100 "$NONCE_FILE" > "$NONCE_FILE.tmp" 2>/dev/null && mv "$NONCE_FILE.tmp" "$NONCE_FILE"
# The rename above brings in a temp file created with the default umask;
# re-assert 600 so the nonce store never widens permissions.
chmod 600 "$NONCE_FILE"

# --- Dispatch (strict whitelist) -------------------------------------------------
case "$cmd" in
  restart-runner)
    # Kill the (possibly wedged) runner, then start a fresh one detached.
    # Bracket patterns like 'st[a]rt' keep pkill from matching processes
    # whose command line merely contains the pattern text (self-kill /
    # innocent-bystander protection; same convention as guard.sh).
    # guard.sh (60s watchdog) is the backstop if this start ever fails.
    log "action=restart-runner: killing existing runner"
    pkill -9 -f 'hapi runner st[a]rt' || true
    sleep 2
    log "action=restart-runner: starting runner at $RUNNER_WORKSPACE_ROOT"
    cd "$RUNNER_WORKSPACE_ROOT" && nohup hapi runner start --workspace-root "$RUNNER_WORKSPACE_ROOT" >/dev/null 2>&1 &
    ;;
  kill-agents)
    # Nuke runaway agent sessions (claude / resumed claude / dsh) that are
    # starving the machine — the actual root cause of the 2026-11-11 storm.
    # Brackets prevent self-matching.
    log "action=kill-agents: killing agent processes"
    pkill -9 -f 'hapi cl[a]ude' || true
    pkill -9 -f 'claude --res[u]me' || true
    pkill -9 -f 'hapi ds[h]' || true
    log "action=kill-agents: done"
    ;;
  runner-status)
    # Read-only diagnosis: freeze the current runner/agent/load snapshot
    # into the rescue log. The operator reads it via SSH afterwards; the
    # value is that the snapshot is taken at poll time, even if the machine
    # state has already changed by the time someone logs in.
    log "action=runner-status: snapshot begin"
    {
      echo "runner processes (pgrep -fl 'hapi runner st[a]rt'):"
      pgrep -fl 'hapi runner st[a]rt' || echo "(none)"
      echo "claude agent processes: $(pgrep -f 'hapi cl[a]ude' | wc -l | tr -d ' ')"
      echo "resumed claude processes: $(pgrep -f 'claude --res[u]me' | wc -l | tr -d ' ')"
      echo "dsh agent processes: $(pgrep -f 'hapi ds[h]' | wc -l | tr -d ' ')"
      echo "uptime/load: $(uptime)"
    } >> "$LOG_FILE"
    log "action=runner-status: snapshot end"
    ;;
  *)
    # Anything outside the whitelist is never executed; recorded for audit.
    log "rejected unknown cmd: $cmd"
    ;;
esac

exit 0
