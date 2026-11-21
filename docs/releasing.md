# Releasing OneDrop

## Stable releases

Update the package version in `package.json`, `package-lock.json`, and `packages/core/src/config/app.ts`. Update both iOS build configurations in `apps/ios/native/App/App.xcodeproj/project.pbxproj`, increasing the native build number as well as the marketing version.

Run the relevant checks and merge the release changes before publishing a GitHub Release tagged `v<version>`.
The release workflow builds the desktop ZIP, mobile Edge CRX, signed Android APK, and native iOS IPA, then refreshes the LiveContainer source.

Release notes should describe user-visible changes and link to the downloadable packages and [installation guide](installation.md). Keep signing configuration and development instructions out of user-facing release notes.

## Native Android signing

Official APKs must retain the same signing key for compatible upgrades. Back up the key and passwords securely.
Android version codes derive from the package version as `major * 1000000 + minor * 1000 + patch`, with each component below 1000.

For a local signed build, set `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`, then run:

```bash
npm run pack:android -- --release
```

The APK is written to `.output/android/OneDrop-<version>-android.apk`. Missing signing configuration fails the build.
The release workflow restores the key from `ANDROID_KEYSTORE_BASE64` and uses the other three signing secrets.

## iOS beta

Publish a GitHub **pre-release** tagged `ios-beta-v<version>` with an increasing three-part numeric version, for example `ios-beta-v1.0.1`.
The workflow builds only the beta IPA from the tagged source and adds it to the **OneDrop Beta** entry in the existing LiveContainer subscription.
The beta has its own identity and version history, so it can be installed alongside the stable app.

## Manual Partner Center updates

Publishing a GitHub Release builds its downloadable packages and updates the LiveContainer source. The Edge Add-ons store has a separate release schedule.

### Compare desktop changes

Check the version currently published in Edge Add-ons and compare its tag with the candidate release using `git diff <last-store-tag> <candidate-tag>`. Review desktop Edge entry points, shared UI and runtime code, permissions and build configuration. Include desktop changes from any intervening GitHub releases. A native iOS-only fix can ship through GitHub and LiveContainer on its own.

### Prepare store notes

Add a short section to the candidate GitHub Release body covering the changes since the published store version:

```markdown
### Partner Center Notes

- Fixed history loading when the current month has no messages.
```

### Run the workflow

In GitHub Actions, open **Release assets → Run workflow**, select `main`, and enter the existing release tag. Choose the action with `partner_center_mode`:

- `skip` (default) rebuilds the GitHub release assets and refreshes the LiveContainer source.
- `validate` builds the store ZIP and checks the certification notes locally on the runner.
- `publish` builds the store ZIP and submits it to Partner Center for certification.

The two store actions leave GitHub release assets in place. The workflow generates the certification instructions from the script, reads only the test account’s `Username:` and `Password:` lines from the existing `EDGE_ADDONS_CERTIFICATION_NOTES` secret, and appends the release-specific notes. Tags beginning with `ios-beta-v` are reserved for the LiveContainer beta channel.
