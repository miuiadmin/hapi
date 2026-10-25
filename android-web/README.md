# hapi-android-web

`run.hapi.web` — a thin Android **WebView shell** around the real hub origin,
living on branch `android/web-shell`. Fork-only long line: **never pushed as
an upstream PR, never merged into `stack`'s upstream sync**. It does not touch
`android/` (native app) or `web/` sources — everything is contained here plus
a surgical CI addition in `.github/workflows/build.yml`.

No Compose, no Material library — system `Theme.Material.Light.NoActionBar`,
system widgets only, a small APK. Toolchain mirrors `../android`
(AGP 8.11.1, Kotlin 2.1.21, Gradle 8.14.2 wrapper, compileSdk 36, minSdk 26,
targetSdk 36, JVM 17).

## Architecture (fixed — do not change)

The WebView **loads the real hub origin directly** (`https://<host>/`). The app
shell, API, SSE and socket.io traffic is same-origin to the hub — identical to
the PWA in a browser, so CORS, auth (per-origin `localStorage`) and the service
worker behave exactly the same. The document is **never** loaded from a local
origin (`appassets://`, `file://`) — that would break per-origin storage auth
and CORS.

## Three-layer static serving + hot updates

`shouldInterceptRequest` is the single seam (`run.hapi.web.static`):

1. **OTA dir** — `filesDir/web-ota/<sha256(origin)>/versions/<sha256(sw.js)>`
   (namespaced per hub origin — a re-pair to another hub never sees the
   previous hub's dist)
2. **Bundled** — `assets/webdist` (the web dist baked into the APK at build time)
3. **Network** — fall through to the hub origin

The whitelist is the generated `assets/webdist-manifest.json` (dist listing,
minus `sw.js`) ∪ runtime constants (`/`, `/index.html`, `/sw.js`,
`/manifest.webmanifest`) ∪ files present in the current OTA version dir.
Everything else (API/SSE/socket.io) is never intercepted.

**Hot update**: `HotUpdateManager` (15 s budget, silent failure) fetches
`<hub>/sw.js`, parses the workbox precache manifest (<3 entries = bail),
downloads 4-wide into `staging-<sha>` (30 s/file), atomically renames to
`versions/<sha>`, re-points `current-version`, prunes to 2 versions. Runs at
app start and right after pairing — so a hub-side web deploy reaches the shell
without a Play/APK update.

## Pairing

First launch shows the pairing screen: enter the hub URL (**https:// enforced**),
optionally paste a JWT access token (collapsed field) for auto-login, then
open. Without a token the web app's own login prompt handles auth. Credentials
(`hub_url`, `access_token`) are stored in EncryptedSharedPreferences.

Boot URL: `https://<host>/?hub=<enc>&token=<enc>` (the web app's supported URL
params); history is cleared around the load so the token never survives in the
back/forward list. The `⋮` corner button clears pairing.

## Native bridges

- **File choosing** (`onShowFileChooser`): `<input type=file>` launches the
  system `ACTION_GET_CONTENT` picker (accept types normalized by
  `AcceptTypes`, multi-select honored). The one capability a WebView cannot
  serve itself.
- **getUserMedia** (`onPermissionRequest`): only `audio_capture` (RECORD_AUDIO)
  and `video_capture` (CAMERA) are allowed, and only after the matching
  runtime permission is granted; any other resource (midi, protected media, …)
  is denied (`WebPermissionGate`).
- **Downloads** (`DownloadListener`): attachment URLs go to the system
  `DownloadManager` (cookies forwarded, filename derived by `DownloadNaming`,
  `ACTION_VIEW` fallback) — never swallowed (`DownloadRouter`).

## Offline behavior

- **UI is frozen into the APK**: the bundled `assets/webdist` layer serves the
  app shell instantly on every launch — no network needed to paint the UI.
- **Data needs the network**: sessions, messages and pairing all ride the hub
  API/SSE, which is never intercepted or cached by the shell.
- **Offline reads**: the web app's own service worker (NetworkFirst API cache)
  can serve recently seen sessions while offline — same as the PWA in a
  browser; the shell neither adds nor subtracts there.

## Build

```bash
# 1. web dist first (bundled layer input — the build fails loud without it)
cd web && bun install && bun run build && cd ..

# 2. the shell
cd android-web && JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home" \
  ANDROID_HOME="$HOME/android-sdk" ./gradlew assembleDebug testDebugUnitTest assembleRelease
```

The dist is injected via `build/generated/web-dist` (an extra assets srcDir) —
nothing is copied into `src/`, the 9.9 MB bundle never enters git.

Version injection mirrors `../android/app` exactly: `-PhapiVersionCode` /
`-PhapiVersionName` (defaults `1` / `0.30.7`). Release signing uses the same
chain (`-PhapiUploadKeystore*` / `HAPI_UPLOAD_KEYSTORE*` env / `local.properties`)
and the same fork upload keystore as the native app; all unset → unsigned
release (local dev needs no secrets).

## CI

`.github/workflows/build.yml` job **`android-web`** (parallel to `android`,
independent of `binaries`): builds `web/dist` itself (`bun install
--frozen-lockfile` + `bun run --cwd web build`, like `webapp.yml`), then builds
and signs the APK with the fork keystore secrets. Rolling `latest` produces
`hapi-web-latest.apk`; a dispatched pinned tag produces
`hapi-web-<version>-<versionCode>.apk` — same formula as the native APK
(`versionName` from `cli/package.json`, `versionCode` = `yyyymmddNN`). The
`release` job collects `dist-android-web` into the release and `checksums.sha256`.

## Coexistence with the native app

Both can be installed side by side: distinct `applicationId`s (`run.hapi.web`
vs `run.hapi.companion`) make them separate apps with separate data and
pairing stores. Both are signed with the same fork upload key — irrelevant to
coexistence, since Android compares signatures only within one package name.
The shell is a browser-equivalent view of the hub; the native app remains the
full-featured client (push, background sync, hardware integrations). Removing
either leaves the other untouched.
