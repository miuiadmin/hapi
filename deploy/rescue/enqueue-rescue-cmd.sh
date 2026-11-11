#!/bin/bash
# enqueue-rescue-cmd.sh — hub-side operator tool for the hapi rescue channel.
#
# Purpose:
#   Build a signed rescue command and publish it as a static file that the
#   machine-side pollers (deploy/rescue/rescue.sh) fetch over HTTPS.
#   Run on the hub host (38.76.198.224) as root, typically via SSH.
#
# Timing contract (must match rescue.sh):
#   - Machines poll every 60s (LaunchAgent StartInterval), so pickup happens
#     within ~60s after this script returns.
#   - The payload is valid for 600s from ts (machine-side freshness check);
#     after that machines silently ignore it until `clear` removes the file.
#   - nonce dedup on the machine guarantees each signed command executes at
#     most once per machine; re-running this script always generates a fresh
#     nonce+ts, so enqueueing the same cmd twice DOES execute twice.
#
# Security model:
#   - HMAC-SHA256 over the canonical string "cmd|nonce|ts" with the shared
#     secret (/root/.hapi-rescue/secret, chmod 600)
#   - strict whitelist: restart-runner | kill-agents | runner-status
#   - the secret URL path itself lives in the nginx location
#     (nginx-rescue.conf.snippet) and in each machine's env.sh — this script
#     never needs to know it
#
# Install (summary — full SOP in deploy/rescue/README.md):
#   umask 077 && mkdir -p /root/.hapi-rescue
#   openssl rand -hex 32 > /root/.hapi-rescue/secret
#   chmod 600 /root/.hapi-rescue/secret
#   # distribute the same hex string to each machine's
#   # ~/.hapi-rescue/env.sh (RESCUE_SECRET) over SSH, never by other means
#
# Usage:
#   ./enqueue-rescue-cmd.sh restart-runner   # kill + restart the runner
#   ./enqueue-rescue-cmd.sh kill-agents      # kill runaway agent sessions
#   ./enqueue-rescue-cmd.sh runner-status    # read-only diag snapshot
#   ./enqueue-rescue-cmd.sh clear            # remove the pending command
#
# Path mapping note (1Panel openresty):
#   CMD_FILE defaults to the HOST path /opt/1panel/www/hapi-diag/rescue.cmd.
#   The openresty container maps host /opt/1panel/www -> /www, which is the
#   `root /www/hapi-diag/` used by nginx-rescue.conf.snippet — writing the
#   host file publishes it at the secret URL. Override both paths via
#   RESCUE_CMD_FILE / RESCUE_SECRET_FILE env vars for local testing.

set -u

SECRET_FILE="${RESCUE_SECRET_FILE:-/root/.hapi-rescue/secret}"
CMD_FILE="${RESCUE_CMD_FILE:-/opt/1panel/www/hapi-diag/rescue.cmd}"
VALIDITY_SECONDS=600

die() {
  echo "enqueue-rescue-cmd: $*" >&2
  exit 1
}

usage() {
  echo "Usage: $0 <restart-runner|kill-agents|runner-status|clear>" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage
cmd="$1"

# --- clear: remove any pending command (machines get 204 => no-op) ----------
if [ "$cmd" = "clear" ]; then
  rm -f "$CMD_FILE" || die "failed to remove $CMD_FILE"
  echo "cleared: $CMD_FILE removed (pollers now get 204 and do nothing)"
  exit 0
fi

case "$cmd" in
  restart-runner|kill-agents|runner-status) ;; # whitelist
  *) usage ;;
esac

# --- shared secret ------------------------------------------------------------
[ -f "$SECRET_FILE" ] || die "secret file not found: $SECRET_FILE (see install steps in the header)"
secret="$(cat "$SECRET_FILE" 2>/dev/null)" || die "cannot read $SECRET_FILE"
# Trim stray whitespace defensively (secret is generated hex).
secret="$(printf '%s' "$secret" | tr -d '[:space:]')"
[ -n "$secret" ] || die "secret file is empty: $SECRET_FILE"

# --- build the signed payload ---------------------------------------------------
nonce="$(openssl rand -hex 8)" || die "openssl rand failed"
ts="$(date +%s)"
# Exactly the same canonical string rescue.sh verifies: "cmd|nonce|ts".
sig="$(printf '%s' "$cmd|$nonce|$ts" | openssl dgst -sha256 -hmac "$secret" | awk '{print $NF}')"
[ -n "$sig" ] || die "openssl dgst failed"

# All fields as strings (ts = decimal epoch seconds) — matches the parser.
payload="$(python3 -c 'import json,sys; print(json.dumps({"cmd":sys.argv[1],"nonce":sys.argv[2],"ts":sys.argv[3],"sig":sys.argv[4]}))' "$cmd" "$nonce" "$ts" "$sig")" \
  || die "python3 payload assembly failed"

# --- atomic publish ---------------------------------------------------------------
# Write to a temp file in the target directory, then rename, so nginx can
# never serve a partially written payload.
dir="$(dirname "$CMD_FILE")"
mkdir -p "$dir" || die "cannot create directory $dir"
tmp="$CMD_FILE.tmp.$$"
printf '%s\n' "$payload" > "$tmp" || die "cannot write $tmp"
mv -f "$tmp" "$CMD_FILE" || die "cannot move $tmp -> $CMD_FILE"

expire_at=$((ts + VALIDITY_SECONDS))
echo "delivered rescue command:"
echo "  file:    $CMD_FILE"
echo "  payload: $payload"
echo "  note:    machines poll every 60s; signature valid for ${VALIDITY_SECONDS}s (until epoch $expire_at); executes at most once per machine (nonce dedup)."
exit 0
