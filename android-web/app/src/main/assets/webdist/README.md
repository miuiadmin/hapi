# webdist/ — bundled web fallback layer

This directory is a **placeholder**. The real `web/dist` bundle (~9.9 MB) is
**injected at build time** by the android-web build tasks (Implement B/C) and is
**never committed** — `.gitignore` blocks everything here except this README.

## Serving order (fixed architecture)

Static resources for the hub origin are resolved by
`ShellWebViewClient.shouldInterceptRequest` in three layers:

1. **OTA directory** — newest dist downloaded at runtime (OTA task);
2. **APK-bundled dist** — this directory, packed into the APK by a build task
   that copies `web/dist` here (`app/src/main/assets/webdist/...`);
3. **Network** — fall through to the real hub origin.

## Rules that must hold

- The WebView always loads the **real hub origin**; the app never serves the
  document from a local origin (`appassets.androidplatform.net`, `file://`)
  — that would split CORS and per-origin localStorage auth away from the
  PWA behavior.
- The injected bundle must match the hub's `workbox` `sw.js` precache manifest
  shape (url + revision) so OTA and bundled layers stay interchangeable.
