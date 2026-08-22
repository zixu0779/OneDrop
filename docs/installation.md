# Installation

OneDrop currently distributes development and release packages for Desktop Edge, Android Edge, iOS Edge, and native iOS through LiveContainer.
The Desktop Edge extension is available from Microsoft Edge Add-ons; the other extension store listings are not available yet.

## Desktop Edge

### Edge Add-ons

The Desktop Edge extension is available from [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/onedrop/omfponfedcemkidfmpkojmhfofgmfmgh).

### Install a downloaded ZIP

1. Download the `desktop-edge.zip` attachment from the GitHub Release.
2. Extract the ZIP into a local folder. Keep the extracted folder in place
   while using the extension.
3. Open `edge://extensions` in Microsoft Edge.
4. Enable **Developer mode**.
5. Select **Load unpacked** and choose the extracted extension folder.
6. Pin OneDrop from the Extensions menu and open it from the toolbar.

The ZIP is an unpacked extension archive, not a CRX. When installing a newer
release, remove or reload the previous unpacked folder after selecting the new folder.

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
6. Select the `android-edge.crx` attachment downloaded from the GitHub Release.
7. Confirm the installation, then open OneDrop from the Extensions list or
   toolbar.

Keep using the same release signing identity when upgrading. A CRX generated
with a different signing key is treated as a different extension.

## iOS Edge

### Edge Add-ons

iOS Edge Add-ons distribution is planned but is not available yet.

### Install the CRX in the Edge TestFlight build

The iOS Edge CRX package is available and can be installed through the
Microsoft Edge TestFlight build. It is not the regular App Store Edge build.

1. Install the Microsoft Edge TestFlight build.
2. Open **Extensions → Manage extensions**.
3. Tap the settings button in the upper-right corner.
4. Enable **Developer mode**, and the option **Load .crx Package** will appear.
5. Select the `ios-edge.crx` attachment downloaded from the GitHub Release.
6. Confirm the installation and open OneDrop from the extensions list.

## Native iOS through LiveContainer

The native iOS package in the Release is an unsigned IPA intended for import
into [LiveContainer](https://github.com/LiveContainer/LiveContainer). It is not a directly installable or App Store-signed IPA.
There is currently no plan to publish the native iOS application on the App Store.

Use the official [LiveContainer installation guide](https://livecontainer.github.io/docs/installation) to install LiveContainer and its supported sideloading setup first.
The guide covers the required iOS version, AltStore/SideStore prerequisites, and the certificate/JIT-less setup. After LiveContainer is working:

1. Download the `ios-livecontainer.ipa` attachment from the GitHub Release.
2. Open LiveContainer and use its **Add/Import IPA** action.
3. Select the downloaded OneDrop IPA.
4. Choose OneDrop in LiveContainer and launch it.

The IPA is unsigned so LiveContainer can apply its own active signing setup.
With a free Apple Personal Team, the sideloading certificate normally needs to be refreshed periodically.
OneDrop does not require JIT, but LiveContainer limitations may affect custom URL schemes, extensions, push notifications, or guest-app entitlements.
