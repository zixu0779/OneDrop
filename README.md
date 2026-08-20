# OneDrop

OneDrop is a no-server app for sending text and files between your own devices through OneDrive.

It uses the user's Microsoft account and OneDrive App Folder as the storage boundary. The project currently ships shared React clients for desktop Edge, Android Edge, and iOS.

## Architecture

- Desktop and Android clients are Manifest V3 Edge extensions built with WXT.
- iOS runs the shared React UI in Capacitor.
- Microsoft Graph is the only cloud API.
- Messages are stored as monthly JSON chunks with ETag-protected writes.
- Files are stored separately in the OneDrive App Folder.
- Local IndexedDB data is cache, index, transfer state, and user preference data.

See [docs/architecture.md](docs/architecture.md) for the storage layout and synchronization rules.

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

Create a production desktop build:

```bash
npm run build
```

### Android Edge

Build the Android Edge extension:

```bash
npm run build:android
```

Generate a CRX for device installation:

```bash
npm run pack:android
```

The CRX is written to `.output/edge-android/edge-mv3.crx`. The signing key is kept at `.keys/android-dev.pem` so reinstalling future CRX builds keeps the same extension ID.

Install Microsoft Edge Canary on the Android device. Open Edge Canary settings, enable Developer options, then use **Extension install by crx** to select and install the generated CRX.

### iOS Edge popup preview

Generate the first-stage iOS Edge CRX used only to verify that Edge can open
an extension popup:

```bash
npm run pack:ios-edge
```

Upload `.output/edge-ios/edge-mv3.crx` through the iOS Edge developer testing
entry. This preview intentionally does not sign in, access OneDrive, or
download files. Its signing key is kept separately at
`.keys/ios-edge-dev.pem`.

### iOS

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
