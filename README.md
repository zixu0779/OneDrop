# OneDrop

OneDrop is a no-server app for sending text and files between your own devices through OneDrive.

It uses the user's Microsoft account and OneDrive App Folder as the storage boundary. The project currently ships shared React clients for desktop Edge, Android Edge, and iOS.

## Architecture

- Desktop and Mobile (Android & iOS) clients are Manifest V3 Edge extensions built with WXT.
- Native iOS runs the shared React UI in Capacitor.
- Microsoft Graph is the only cloud API.
- Messages are stored as monthly JSON chunks with ETag-protected writes.
- Files are stored separately in the OneDrive App Folder.
- Local IndexedDB data is cache, index, transfer state, and user preference data.

See [docs/architecture.md](docs/architecture.md) for the storage layout and synchronization rules.

## Installation

See [docs/installation.md](docs/installation.md) for platform-specific release and development installation instructions,
including Desktop Edge, Android Edge Canary, iOS Edge TestFlight, and native iOS through LiveContainer.

## Release packaging

Create the key-free universal Edge package for Partner Center:

```bash
npm run zip:store
```

The package is written to `.output/OneDrop-<version>-edge-store.zip`.

### Manual Partner Center updates

Publishing a GitHub Release builds its downloadable packages and updates the LiveContainer source. The Edge Add-ons store has a separate release schedule.

Before a store update, check the version currently published in Edge Add-ons and compare its tag with the candidate release using `git diff <last-store-tag> <candidate-tag>`. Review desktop Edge entry points, shared UI and runtime code, permissions and build configuration. Include desktop changes from any intervening GitHub releases. A native iOS-only fix can ship through GitHub and LiveContainer on its own.

For a store update, add a short section to the candidate GitHub Release body covering the changes since the published store version:

```markdown
### Partner Center Notes

- Fixed history loading when the current month has no messages.
```

In GitHub Actions, open **Release assets → Run workflow**, select `main`, and enter the existing release tag. Choose the action with `partner_center_mode`:

- `skip` (default) rebuilds the GitHub release assets and refreshes the LiveContainer source.
- `validate` builds the store ZIP and checks the certification notes locally on the runner.
- `publish` builds the store ZIP and submits it to Partner Center for certification.

The two store actions leave GitHub release assets in place. The workflow appends the release-specific notes to the fixed certification instructions stored in GitHub Actions secrets. Tags beginning with `ios-beta-v` are reserved for the LiveContainer beta channel.

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

Install or update Microsoft Edge Canary on the Android device. Open **Settings → About Microsoft Edge**, tap the Edge version number several times to enable **Developer options**, then open **Settings → Developer options**. Select **Extension install by CRX**, choose `.output/edge-mobile/edge-mv3.crx`, confirm the installation, and then open OneDrop from the extensions list or toolbar.

The regular stable Edge app may not expose this developer installation entry.

#### iOS Edge

Install the Microsoft Edge TestFlight build on the iOS device. Open **Extensions → Manage extensions**, tap the settings button in the upper-right corner, and enable **Developer mode**. Select **Load .crx Package**, choose `.output/edge-mobile/edge-mv3.crx`, confirm the installation, and then open OneDrop from the extensions list.

The regular App Store Edge build does not expose this developer installation entry. This CRX is the iOS Edge extension package, separate from the native iOS application.

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

The output is `.output/ios-beta/OneDrop-Beta-1.0.0.ipa`. To distribute a new beta, publish a GitHub **pre-release** tagged `ios-beta-v<version>` with an increasing numeric version, for example `ios-beta-v1.0.1`. The release workflow builds the IPA from the tagged source and adds it to the **OneDrop Beta** entry in the existing subscription.

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
