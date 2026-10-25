# webdist/ — bundled web fallback layer

This directory is a **placeholder**. The real `web/dist` bundle (~9.9 MB) is
**injected at build time** by the android-web build tasks (`syncWebDist`,
Implement B) into `app/build/generated/web-dist/webdist/` (an extra assets
srcDir — not here) and is **never committed**. Only this README is tracked
under `assets/webdist/`; at APK-merge time both merge into the same
`assets/webdist/` namespace.

## Serving order (fixed architecture)

Static resources for the hub origin are resolved by
`ShellWebViewClient.shouldInterceptRequest` → `run.hapi.web.static` in three
layers:

1. **OTA directory** — newest dist downloaded at runtime
   (`filesDir/web-ota/versions/<sha256(sw.js)>`, atomic staging+rename,
   `current-version` pointer, 2 versions retained);
2. **APK-bundled dist** — `assets/webdist/<rel>`, whitelist from the generated
   `assets/webdist-manifest.json` (dist listing minus `sw.js`);
3. **Network** — fall through to the real hub origin.

## Rules that must hold

- The WebView always loads the **real hub origin**; the app never serves the
  document from a local origin (`appassets.androidplatform.net`, `file://`)
  — that would split CORS and per-origin localStorage auth away from the
  PWA behavior.
- Only whitelisted static paths are ever intercepted: `/api/*`, SSE and
  socket.io requests always go straight to the network.
- Path safety: request paths are segment-validated (no `..`, no `\`, no `:`,
  no `%`, no empty segments) and every layer lookup is set-membership against
  a restricted enumeration plus a canonical-path prefix check on open.
- `sw.js` is deliberately NOT served from the bundle (only via OTA/network)
  so the service worker is always the hub's current one.
