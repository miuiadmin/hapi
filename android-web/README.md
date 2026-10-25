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
- Build: `cd android-web && JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home" ANDROID_HOME="$HOME/android-sdk" ./gradlew assembleDebug testDebugUnitTest`
- `versionCode`/`versionName` injectable via `-PhapiVersionCode` / `-PhapiVersionName`
  (defaults 1 / 0.30.7).
