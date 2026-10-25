# hapi-android-web

Thin Android WebView shell (`run.hapi.web`) around the real hub origin —
fork-only long line on branch `android/web-shell`. No Compose, no Material
library; system `Theme.Material.Light.NoActionBar`. Versions mirror `../android`
(AGP 8.11.1, Kotlin 2.1.21, Gradle 8.14.2 wrapper, compileSdk 36, minSdk 26).

Architecture (fixed): the WebView loads the hub origin directly; API/SSE/socket
are same-origin exactly like the PWA. Static resources are intercepted by
`ShellWebViewClient.shouldInterceptRequest` (OTA dir > bundled `assets/webdist`
> network). Never load the document from a local origin.

- Pairing UI + credentials (`hub_url`, `access_token`) in EncryptedSharedPreferences.
- Boot URL: `https://<host>/?hub=<enc>&token=<enc>`; history is cleared so the
  token never survives in back/forward state.
- Three-layer static serving (`run.hapi.web.static`):
  - whitelist = generated `assets/webdist-manifest.json` (dist listing, minus
    `sw.js`) ∪ runtime constants (`/`, `/index.html`, `/sw.js`,
    `/manifest.webmanifest`) ∪ files present in the current OTA version dir —
    everything else (API/SSE/socket.io) is never intercepted;
  - layers: OTA `filesDir/web-ota/versions/<sha256(sw.js)>` > bundled assets >
    network;
  - hot update: `HotUpdateManager` (15 s budget, silent failure) hashes
    `<hub>/sw.js`, parses the workbox precache manifest (<3 entries = bail),
    downloads 4-wide into `staging-<sha>` (30 s/file), atomically renames to
    `versions/<sha>`, re-points `current-version`, prunes to 2 versions. Runs
    at app start and right after pairing.
- Build-time dist injection: `checkWebDist` (fail-loud when `../web/dist` is
  missing — build the web app first), `syncWebDist` (dist →
  `build/generated/web-dist/webdist/`, an extra assets srcDir, never committed)
  and `generateWebDistManifest` (`webdist-manifest.json`), wired into
  merge*Assets and lint tasks.
- Build: `cd android-web && JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home" ANDROID_HOME="$HOME/android-sdk" ./gradlew assembleDebug testDebugUnitTest`
- `versionCode`/`versionName` injectable via `-PhapiVersionCode` / `-PhapiVersionName`
  (defaults 1 / 0.30.7).
