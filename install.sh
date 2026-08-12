#!/usr/bin/env bash
# install.sh — one-click installer for the stripped hapi build.
#
# Downloads the scanner-clean hapi binary (embedded tunwg/WireGuard tunnel removed)
# for your platform, installs it, and sets it up as a runner connected to YOUR
# self-hosted hapi hub.
#
# No secrets are baked in. The hub URL and CLI API token are read interactively
# from /dev/tty (so this works under `curl ... | bash`).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/miuiadmin/hapi/main/install.sh | bash
#
# Non-interactive (CI / pre-seeded):
#   HAPI_API_URL=https://hapi.supertoken.lol CLI_API_TOKEN=xxxx \
#     curl -fsSL .../install.sh | bash
set -euo pipefail

REPO="miuiadmin/hapi"
BASE="https://github.com/${REPO}/releases/latest/download"
WORKSPACE_ROOT="${HAPI_WORKSPACE_ROOT:-$HOME}"

# ── helpers ──────────────────────────────────────────────────────────────────
say()  { printf '\033[1;36m==>\033[0m %s\n' "$*" >&2; }
note() { printf '    %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# read from /dev/tty so prompts work when the script body comes through a pipe
ask() {  # $1=prompt  $2=varname  $3=hidden(y/n)
  local prompt="$1" var="$2" hidden="${3:-n}" val
  printf '\033[1;36m==>\033[0m %s' "$prompt" >/dev/tty
  if [ "$hidden" = "y" ]; then read -rs val </dev/tty; echo >/dev/tty
  else read -r val </dev/tty; fi
  printf -v "$var" '%s' "$val"
}

sha256() {  # portable: shasum (macOS) or sha256sum (linux)
  if command -v shasum   >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else die "neither shasum nor sha256sum found"; fi
}

# ── 1. detect platform ───────────────────────────────────────────────────────
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)   PLATFORM=darwin-arm64 ;;
  Darwin/x86_64)  PLATFORM=darwin-x64 ;;
  Linux/aarch64)  PLATFORM=linux-arm64 ;;
  Linux/x86_64)   PLATFORM=linux-x64 ;;
  *) die "unsupported platform: $(uname -s) $(uname -m)" ;;
esac
ASSET="hapi-${PLATFORM}"
[ "$PLATFORM" = "linux-x64" ] && ASSET="hapi-linux-x64"   # keep explicit
say "platform: $PLATFORM  (asset: $ASSET)"

# ── 2. download ──────────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "downloading latest stripped build…"
curl -fL --retry 3 -o "$TMP/$ASSET"       "${BASE}/${ASSET}"
curl -fsL --retry 3 -o "$TMP/checksums.sha256" "${BASE}/checksums.sha256" || true

# ── 3. verify checksum (if manifest present) ─────────────────────────────────
if [ -s "$TMP/checksums.sha256" ]; then
  exp="$(awk -v a="$ASSET" '$2==a{print $1}' "$TMP/checksums.sha256" | head -1)"
  if [ -n "$exp" ]; then
    got="$(sha256 "$TMP/$ASSET")"
    [ "$exp" = "$got" ] || die "checksum mismatch for $ASSET (expected $exp got $got)"
    note "checksum OK"
  fi
fi

# ── 4. prepare executable ────────────────────────────────────────────────────
chmod +x "$TMP/$ASSET"
if [ "$(uname -s)" = "Darwin" ]; then
  say "ad-hoc codesign + clear quarantine (Apple Silicon requirement)…"
  codesign --force --sign - "$TMP/$ASSET" 2>/dev/null || true
  xattr -c "$TMP/$ASSET" 2>/dev/null || true
fi

# ── 5. install into PATH ─────────────────────────────────────────────────────
if [ -w /usr/local/bin ]; then INSTALL_DIR=/usr/local/bin
else
  INSTALL_DIR="$HOME/.local/bin"; mkdir -p "$INSTALL_DIR"
fi
mv "$TMP/$ASSET" "$INSTALL_DIR/hapi"
note "installed → $INSTALL_DIR/hapi"
case ":$PATH:" in *":$INSTALL_DIR:"*) ;; *) note "add $INSTALL_DIR to your PATH" ;; esac
HAPI="$INSTALL_DIR/hapi"

# ── 6. version check ─────────────────────────────────────────────────────────
say "installed: $("$HAPI" --version 2>&1 || echo 'failed to run')"
if ! ("$HAPI" --version >/dev/null 2>&1); then
  die "binary won't execute. On macOS run: codesign --force --sign - $HAPI && xattr -c $HAPI"
fi

# ── 7. hub URL + token (interactive unless pre-seeded) ───────────────────────
if [ -z "${HAPI_API_URL:-}" ]; then
  ask "hapi hub URL (e.g. https://hapi.supertoken.lol): " HAPI_API_URL n
fi
if [ -z "${CLI_API_TOKEN:-}" ]; then
  ask "CLI API token (input hidden): " CLI_API_TOKEN y
fi
[ -n "$HAPI_API_URL" ] || die "no hub URL provided"
[ -n "$CLI_API_TOKEN" ] || die "no token provided"

# ── 8. persist env (shell rc + guard env.sh) ─────────────────────────────────
GUARD_DIR="$HOME/.hapi-happy-guard"; mkdir -p "$GUARD_DIR"
cat > "$GUARD_DIR/env.sh" <<EOF
# sourced by guard.sh and written by hapi install.sh
export HAPI_API_URL="$HAPI_API_URL"
export CLI_API_TOKEN="$CLI_API_TOKEN"
export HAPI_CLIBEIN="$HAPI"
export HAPI_WORKSPACE_ROOT="$WORKSPACE_ROOT"
export PATH="$INSTALL_DIR:/usr/local/bin:/usr/bin:/bin:\$PATH"
export HOME="$HOME"
EOF
chmod 600 "$GUARD_DIR/env.sh"

write_rc() {  # append once
  local rc="$1"
  [ -f "$rc" ] || return 0
  grep -q 'HAPI_API_URL' "$rc" 2>/dev/null && return 0
  {
    echo ''
    echo '# hapi runner env (added by install.sh)'
    echo "export HAPI_API_URL=\"$HAPI_API_URL\""
    echo 'export CLI_API_TOKEN="'"$CLI_API_TOKEN"'"'
  } >> "$rc"
}
case "$(uname -s)" in
  Darwin) write_rc "$HOME/.zshrc" ;;
  Linux)  write_rc "$HOME/.bashrc"; write_rc "$HOME/.profile" ;;
esac
note "env written → $GUARD_DIR/env.sh (+ shell rc)"
export HAPI_API_URL CLI_API_TOKEN

# ── 9. start runner ──────────────────────────────────────────────────────────
say "starting runner (workspace root: $WORKSPACE_ROOT)…"
"$HAPI" runner stop >/dev/null 2>&1 || true
"$HAPI" runner start --workspace-root "$WORKSPACE_ROOT" >/dev/null 2>&1 || \
  die "runner start failed. Run: $HAPI runner start --workspace-root $WORKSPACE_ROOT"
sleep 3

MACHINE_ID=""
STATE="$HOME/.hapi/runner.state.json"
if [ -f "$STATE" ]; then
  MACHINE_ID="$(grep -oE '"machineId"[[:space:]]*:[[:space:]]*"[^"]+"' "$STATE" \
    | head -1 | sed 's/.*"machineId"[[:space:]]*:[[:space:]]*"//; s/"$//')"
fi
note "machineId: ${MACHINE_ID:-(not found yet)}"

# ── 10. launchd guard (macOS) — keep runner alive + re-register on hub restart ─
if [ "$(uname -s)" = "Darwin" ]; then
  say "installing launchd guard…"
  cat > "$GUARD_DIR/guard.sh" <<'GUARD'
#!/usr/bin/env bash
set -u
source "$(dirname "$0")/env.sh" || exit 1
HAPI="${HAPI_CLIBEIN:-hapi}"
WS="${HAPI_WORKSPACE_ROOT:-$HOME}"
ID="$(grep -oE '"machineId"[[:space:]]*:[[:space:]]*"[^"]+"' "$HOME/.hapi/runner.state.json" 2>/dev/null | head -1 | sed 's/.*"machineId"[[:space:]]*:[[:space:]]*"//; s/"$//')"
COOL=1800; LAST=0
while true; do
  local_ok=0
  "$HAPI" runner status 2>/dev/null | grep -q 'is running' && local_ok=1
  hub_ok=0
  if [ -n "$ID" ]; then
    resp="$(curl -sf -m 10 -H "Authorization: Bearer $CLI_API_TOKEN" "$HAPI_API_URL/cli/machines/$ID" 2>/dev/null || true)"
    echo "$resp" | grep -q '"active"[[:space:]]*:[[:space:]]*true' && \
    echo "$resp" | grep -q '"status"[[:space:]]*:[[:space:]]*"running"' && hub_ok=1
  fi
  now="$(date +%s)"
  if [ "$local_ok" != "1" ] || [ "$hub_ok" != "1" ]; then
    if [ $((now - LAST)) -gt "$COOL" ]; then
      echo "$(date) re-registering runner (local=$local_ok hub=$hub_ok)"
      "$HAPI" runner start --workspace-root "$WS" >/dev/null 2>&1 &
      LAST="$now"
    fi
  fi
  sleep 60
done
GUARD
  chmod 755 "$GUARD_DIR/guard.sh"

  PLIST="$HOME/Library/LaunchAgents/com.user.hapi-happy-guard.plist"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.user.hapi-happy-guard</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$GUARD_DIR/guard.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$GUARD_DIR/guard.log</string>
  <key>StandardErrorPath</key><string>$GUARD_DIR/guard.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/com.user.hapi-happy-guard" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  note "guard → $GUARD_DIR/guard.sh (logs: $GUARD_DIR/guard.log)"
fi

# ── 11. summary ──────────────────────────────────────────────────────────────
say "done."
note "binary : $HAPI  ($("$HAPI" --version 2>&1))"
note "hub    : $HAPI_API_URL"
note "control: open $HAPI_API_URL in a browser and sign in with the token"
note "stop   : $HAPI runner stop"
note "logs   : $HOME/.hapi/logs/  (guard: $GUARD_DIR/guard.log)"
