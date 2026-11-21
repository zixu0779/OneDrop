# Installation

OneDrop currently distributes development and release packages for Desktop Edge, Android Edge, iOS Edge, and native iOS through LiveContainer.
The Desktop Edge extension is available from Microsoft Edge Add-ons; the other extension store listings are not available yet.

## Desktop Edge

### Edge Add-ons

The Desktop Edge extension is available from [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/onedrop/omfponfedcemkidfmpkojmhfofgmfmgh).

### Install a downloaded ZIP

1. Download the `desktop-edge.zip` attachment from the GitHub Release.
2. Extract the ZIP into a local folder. Keep the extracted folder in place while using the extension.
3. Open `edge://extensions` in Microsoft Edge.
4. Enable **Developer mode**.
5. Select **Load unpacked** and choose the extracted extension folder.
6. Pin OneDrop from the Extensions menu and open it from the toolbar.

The ZIP is an unpacked extension archive.
When installing a newer release, remove or reload the previous unpacked folder after selecting the new folder.

## Android Edge

### Edge Add-ons

Android Edge Add-ons distribution is planned but is not available yet.

### Install the CRX in Edge Canary

The Android CRX requires the Android Edge Canary build with developer options enabled. The regular stable Edge app may not expose this developer entry.

1. Install or update **Microsoft Edge Canary** on Android.
2. Open **Settings → About Microsoft Edge**.
3. Tap the Edge version number several times to enable **Developer options**.
4. Open **Settings → Developer options**.
5. Select **Extension install by CRX**.
6. Select the `OneDrop-<version>-mobile-edge.crx` attachment downloaded from the GitHub Release.
7. Confirm the installation, then open OneDrop from the Extensions list.

Keep using the same release signing identity when upgrading.
A CRX generated with a different signing key is treated as a different extension.

## iOS Edge

### Edge Add-ons

iOS Edge Add-ons distribution is planned but is not available yet.

### Install the CRX in the Edge TestFlight build

The iOS Edge CRX package is available and can be installed through the Microsoft Edge TestFlight build. It is not the regular App Store Edge build.

1. Install the Microsoft Edge TestFlight build.
2. Open **Extensions → Manage extensions**.
3. Tap the settings button in the upper-right corner.
4. Enable **Developer mode**, and the option **Load .crx Package** will appear.
5. Select the `OneDrop-<version>-mobile-edge.crx` attachment downloaded from the GitHub Release.
6. Confirm the installation and open OneDrop from the extensions list.

## Native iOS through LiveContainer

The native iOS package in the Release is an unsigned IPA intended for import into [LiveContainer](https://github.com/LiveContainer/LiveContainer). It is not a directly installable or App Store-signed IPA.
There is currently no plan to publish the native iOS application on the App Store.

Use the official [LiveContainer installation guide](https://livecontainer.github.io/docs/installation) to install LiveContainer and its supported sideloading setup first.
The guide covers the required iOS version, AltStore/SideStore prerequisites, and the certificate/JIT-less setup. After LiveContainer is working, subscribe to the OneDrop source:

1. In LiveContainer, open **Sources**, tap **+**, and enter `https://onedrop.sycamore.top/apps.json`.
2. Confirm the source, expand **OneDrop**, and tap **Install**.
3. Open **Apps** and launch OneDrop. For later releases, refresh the OneDrop source and select the new version.

When a beta is available, the same source also lists **OneDrop Beta**. Install it alongside OneDrop to test upcoming changes. Each app updates from its own version history. Both apps access the OneDrive data of the account you sign into.

You can also import the IPA manually:

1. Download the `OneDrop-<version>.ipa` attachment from the GitHub Release.
2. Open LiveContainer and use its **Add/Import IPA** action.
3. Select the downloaded OneDrop IPA.
4. Choose OneDrop in LiveContainer and launch it.

The IPA is unsigned so LiveContainer can apply its own active signing setup.
With a free Apple Personal Team, the sideloading certificate normally needs to be refreshed periodically.
OneDrop does not require JIT, but LiveContainer limitations may affect custom URL schemes, extensions, push notifications, or guest-app entitlements.

## Native Android

Download `OneDrop-<version>-android.apk` from the GitHub Release. Open it on Android 7.0 (API 24) or newer, allow installation from the app used to open the APK, and launch OneDrop. An installed system browser handles Microsoft sign-in.

Use **Open** to preview a downloaded attachment in a compatible installed app, **Save as** to choose a persistent destination, or **Share file** to send the downloaded attachment to another app. Private downloads and the local login session are removed when the app is uninstalled.

Official releases use a stable signing key so later official APKs can update the installed app. Earlier local test APKs used a different debug key. To switch from a debug build to the official release, uninstall the test build before installing the official APK, then sign in again. Export any private downloads you want to keep before uninstalling. Messages and files stored in OneDrive remain available after signing in.

For local development, `npm run pack:android` produces `OneDrop-<version>-android-debug.apk`. Release packaging uses `npm run pack:android -- --release` and requires `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Keep the signing key and passwords backed up securely. Android version codes derive from the package version as `major * 1000000 + minor * 1000 + patch`, with each component below 1000.
