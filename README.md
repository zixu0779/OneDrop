# OneDrop

OneDrop is a no-server app for sending text and files between your own devices through OneDrive.

It uses the user's Microsoft account and OneDrive App Folder as the storage boundary. The project currently provides shared React clients for desktop Edge, Android Edge, native Android, and iOS.

## Architecture

- Desktop and Mobile (Android & iOS) clients are Manifest V3 Edge extensions built with WXT.
- Native Android and iOS run the shared React UI and native runtime in Capacitor.
- Microsoft Graph is the only cloud API.
- Messages are stored as monthly JSON chunks with ETag-protected writes.
- Files are stored separately in the OneDrive App Folder.
- Local IndexedDB data is cache, index, transfer state, and user preference data.

See [docs/architecture.md](docs/architecture.md) for the storage layout and synchronization rules.

## Installation

For native iOS (using [LiveContainer](https://github.com/LiveContainer/LiveContainer)), the source URL is `https://onedrop.sycamore.top/apps.json`.

See [docs/installation.md](docs/installation.md) for platform-specific release and development installation instructions,
including Desktop Edge, Android Edge Canary, native Android, iOS Edge TestFlight, and native iOS through LiveContainer.

Download the signed native Android APK from the [latest GitHub Release](https://github.com/zixu0779/OneDrop/releases/latest).

## Release packaging

Create the key-free universal Edge package for Partner Center:

```bash
npm run zip:store
```

The package is written to `.output/OneDrop-<version>-edge-store.zip`.

See [the release guide](docs/releasing.md) for distribution and Partner Center updates.

## Development

Install dependencies:

```bash
npm install
```

### Desktop Edge

This is the primary development target.

```bash
npm run dev
```

If Edge does not open automatically, load `.output/edge-mv3-dev` from `edge://extensions`.

Create the production Edge build. The same output contains the desktop side panel and the separate Android and iOS mobile entrypoints:

```bash
npm run build
```

### Edge Mobile

Generate the shared CRX for Android and iOS device installation:

```bash
npm run pack:mobile-edge
```

The CRX is written to `.output/edge-mobile/edge-mv3.crx` and uses one signing identity on both mobile platforms.

#### Android Edge

1. Install or update Microsoft Edge Canary on Android.
2. Open **Settings → About Microsoft Edge** and tap the version number several times.
3. Open **Settings → Developer options → Extension install by CRX**.
4. Choose `.output/edge-mobile/edge-mv3.crx`, confirm, and open OneDrop from the extensions list or toolbar.

The regular stable Edge app may not expose this developer installation entry.

#### iOS Edge

1. Install the Microsoft Edge TestFlight build.
2. Open **Extensions → Manage extensions** and tap the settings button in the upper-right corner.
3. Enable **Developer mode** and select **Load .crx Package**.
4. Choose `.output/edge-mobile/edge-mv3.crx`, confirm, and open OneDrop from the extensions list.

The regular App Store Edge build does not expose this developer installation entry.

This CRX is the iOS Edge extension package, separate from the native iOS application.

### Native Android

Install JDK 21 and Android SDK platform 36 with build-tools 35.0.0. Set `JAVA_HOME` and `ANDROID_HOME`, then build:

```bash
npm run pack:android
```

The debug APK is written to `.output/android/OneDrop-<version>-android-debug.apk`.

Use `npm run open:android` to open the project in Android Studio.

For signed distribution, see [the release guide](docs/releasing.md#native-android-signing).

### Native iOS

Install Xcode, connect the iPhone, and wait until Xcode finishes device preparation.

Build the iOS web bundle:

```bash
npm run build:ios
```

Sync the web bundle and Capacitor plugins into the native iOS project:

```bash
npm run sync:ios
```

Open the iOS project in Xcode:

```bash
npm run open:ios
```

Select the connected device in Xcode, confirm signing settings, and run the app from Xcode.

Generate an unsigned IPA for import into LiveContainer:

```bash
npm run pack:ios
```

The IPA is written to `.output/ios-native/onedrop-ios-livecontainer.ipa`.
It is the native iOS package, separate from the iOS Edge CRX, and is not signed for direct installation; LiveContainer signs imported apps with its own active certificate.

To build a side-by-side LiveContainer beta, use its independent three-part version:

```bash
npm run pack:ios -- --beta 1.0.0
```

The output is `.output/ios-beta/OneDrop-Beta-1.0.0.ipa`. See [the release guide](docs/releasing.md#ios-beta) to distribute a beta.

### Checks

Before submitting changes, run the checks that match the area you touched:

```bash
npm run compile
npm test
npm run build
```

## Authentication

Copy `.env.example` to `.env.local` and set the Microsoft Entra client ID used by your build:

```dotenv
WXT_ONEDROP_ENTRA_CLIENT_ID=<Application client ID>
WXT_ONEDROP_ENTRA_AUTHORITY=https://login.microsoftonline.com/common
```

Redirect URIs must match the Microsoft Entra app registration exactly. See [docs/authentication.md](docs/authentication.md) before packaging a new release build.

## Privacy

The release privacy policy is published at [Privacy Policy](https://onedrop.sycamore.top/privacy-policy.html).
