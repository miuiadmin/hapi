---
title: Privacy Policy
aside: false
---

# Privacy Policy

**Effective date: August 19, 2026** · Applies to the HAPI mobile companion apps (Android and iOS) and the self-hosted HAPI hub.

::: tip The short version
HAPI is self-hosted software. The apps talk only to the hub server **you** run. We — the HAPI developers — operate no servers that receive your conversations, your code, or your personal data. The apps contain no analytics, no advertising, and no tracking SDKs, and there is no account with us to create.
:::

## What the app stores on your device

- The address of your hub and the access credentials you pair with (kept in the app's private storage).
- App preferences (theme, language, notification choices).
- Cached session content fetched from your hub, so the app works offline.

Uninstalling the app removes all of this from the device. Your sessions themselves live on your own hub server, under your control.

## Where your data travels

Session content, files, and commands move directly between the app and your hub over the connection you configure. No copy is sent to us or to any third party by the app itself.

## Push notifications

**Android:** notifications are delivered through Google's Firebase Cloud Messaging (FCM). Your hub sends the notification (session title, status text) to FCM, which routes it to your device; Google processes this traffic per its own privacy policy. The FCM device token is stored only by your hub. Builds compiled without a Firebase configuration send nothing to Google and simply have no push.

**iOS:** notifications are end-to-end encrypted. Your hub encrypts the content with a key that exists only on your device and your hub; Apple's push service — and the optional HAPI relay, if you use it instead of your own APNs credentials — carry ciphertext and routing metadata only, and cannot read the notification. Self-hosters can bypass the relay entirely with their own Apple developer credentials.

## Camera

Used only to scan the pairing QR code, processed on the device. No images are stored or transmitted, and pairing works without the camera via manual entry.

## Microphone

Used only for voice dictation in the message composer, and only while you hold the dictation button. Speech recognition is performed by your device's system speech service (for example, the platform speech recognizer), which may process audio according to its provider's policy. HAPI does not record, store, or transmit the audio itself; only the resulting text is placed in the composer.

## What we collect

Nothing. The apps have no telemetry, crash reporting, analytics, or advertising SDKs. If you install from an app store, the store operator (Google or Apple) may collect install and crash statistics under its own policies, independently of us.

## Data deletion

Unpair a hub or uninstall the app to remove everything held on the device. Data on your hub is yours to delete at any time — it is your server.

## Children

HAPI is a developer tool and is not directed at children under 13.

## Open source

The complete source code of the apps and the hub is available at [github.com/tiann/hapi](https://github.com/tiann/hapi) — the claims above can be verified in the code.

## Changes & contact

If this policy changes, the updated version will be published at this address with a new effective date. Questions and concerns: open an issue on [GitHub](https://github.com/tiann/hapi/issues) or email [twsxtd@gmail.com](mailto:twsxtd@gmail.com).
