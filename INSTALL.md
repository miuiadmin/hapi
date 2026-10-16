# Install — stripped hapi build

This is a build of [**hapi**](https://github.com/tiann/hapi) (KernelSU author's
decentralized remote-control tool for Claude Code / Codex / Cursor) with the
embedded **`tunwg` / WireGuard tunnel component removed**.

It behaves identically to upstream hapi for the **self-hosted hub + runner** setup
(connect a machine to your own hub). The only thing removed is the optional
`hapi hub --relay` public-relay feature, which embeds a WireGuard userspace tunnel
(`tunwg`) — that embedded binary is what makes network scanners flag the word
"wireguard", which some corporate infosec policies prohibit. Self-hosted setups
don't use the relay, so removing it costs nothing.

> Each published binary is scanner-clean: `grep -aci wireguard hapi-*` → `0`.

---

## One-click install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/miuiadmin/hapi/main/install.sh | bash
```

The installer will:
1. Download the latest stripped binary for your platform.
2. macOS: ad-hoc codesign + clear quarantine + make executable.
3. Install to `/usr/local/bin/hapi` (or `~/.local/bin`).
4. **Prompt you** for your hapi hub URL and CLI API token (token input is hidden —
   no secrets are baked into this repo or the binary).
5. Write the env to your shell rc + `~/.hapi-happy-guard/env.sh`.
6. Start the runner and (on macOS) install a launchd guard that keeps it alive and
   re-registers it if the hub restarts.

You need your **hub URL** and **CLI API token** ready — get them from whoever runs
your hapi hub (the token is shown once when the hub is deployed).

### Non-interactive (pre-seed)

```bash
HAPI_API_URL=https://hapi.supertoken.lol CLI_API_TOKEN=xxxx \
  curl -fsSL https://raw.githubusercontent.com/miuiadmin/hapi/main/install.sh | bash
```

### Pinned releases (stack builds)

`install.sh` always installs the **rolling `latest`** release, which tracks
upstream `main`. If your machine runs a **pinned stack build** (a custom deploy
stack with extra commits, e.g. `v14-stack`), do **not** re-run `install.sh` on
it — that would silently replace the stack build with the rolling one.

Pinned releases are published manually from a stack branch via the `tag` input:

```bash
gh workflow run build.yml -R miuiadmin/hapi --ref <stack-branch> -f tag=<tag>
```

On a pinned machine, upgrade by downloading the artifact directly (verify
against the `checksums.sha256` asset in the same release **before** any
re-signing — re-signing changes the file hash):

```
https://github.com/miuiadmin/hapi/releases/download/<tag>/hapi-<platform>
```

Pinned releases never take the `latest` badge, so the one-click install above
keeps tracking the rolling build for everyone else.

---

## Company network / infosec whitelist

For the install and the runner to work from a restricted corporate network, allow:

| Host | Why |
|---|---|
| `github.com` | repo + release metadata |
| `raw.githubusercontent.com` | `install.sh` download |
| `objects.githubusercontent.com` | release binary download |
| **your hub host** (e.g. `hapi.supertoken.lol`) | the hapi hub the runner connects to |

The runner maintains a single persistent HTTPS connection to your hub.

---

## What's removed, what's kept

| | status |
|---|---|
| Self-hosted hub (`hapi hub`) | ✅ unchanged |
| Runner + sessions + web UI | ✅ unchanged |
| Direct-connect (`hapi` / `auth`) | ✅ unchanged |
| `hapi hub --relay` (public relay via WireGuard) | ❌ neutered (the `tunwg` binary is replaced with a placeholder) |

The strip patch is [`patches/strip-tunwg.patch`](patches/strip-tunwg.patch) — it
replaces the build-time download of the `tunwg` binary with a tiny neutral
placeholder, so the single-file executable still resolves its file-asset imports
but contains no WireGuard code or trademark.

## Rebuild

Builds happen automatically on every push to `main` and daily (tracking upstream)
via `.github/workflows/build.yml`, publishing a rolling `latest` release. The
`sync-upstream.yml` workflow merges `tiann/hapi` daily so this fork stays current.

Manual local build:
```bash
git apply patches/strip-tunwg.patch
bun install
bun run build:single-exe          # current platform
# or: bun run build:single-exe:all   # all platforms
```

## License

hapi is **AGPL-3.0**. This fork's only modification (the strip patch) is disclosed
above and in `patches/`. Upstream credit and full license: [tiann/hapi](https://github.com/tiann/hapi).
