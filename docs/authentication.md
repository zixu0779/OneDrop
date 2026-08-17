# Authentication

This file exists so local development and release builds use the same Microsoft Entra setup. OneDrop is a public client: it uses Authorization Code with PKCE and never contains a client secret.

## Local configuration

Create `.env.local` in the repository root:

```dotenv
WXT_ONEDROP_ENTRA_CLIENT_ID=<Application client ID>
WXT_ONEDROP_ENTRA_AUTHORITY=https://login.microsoftonline.com/common
```

Restart `npm run dev` after changing these values. If the extension is already loaded, reload `.output/edge-mv3-dev` and reopen the Side Panel.

## Entra app registration

The app registration must allow personal Microsoft accounts and must include the redirect URI for each packaged client.

- Desktop and Android Edge builds use the exact `https://<extension-id>.chromiumapp.org/auth` URI shown by the build.
- iOS uses bundle ID `com.sycamore.onedrop` and redirect URI `msauth.com.sycamore.onedrop://auth`.
- Microsoft Graph delegated permission must include `Files.ReadWrite.AppFolder`.
- Do not create or ship a client secret.

A release build with a new stable extension ID needs its new redirect URI added before sign-in can work.

## Runtime behavior

- Desktop Edge starts sign-in with `browser.identity.launchWebAuthFlow`.
- Android Edge uses a temporary Edge tab for the same PKCE request because it cannot create the identity window.
- iOS uses the native redirect flow.
- Tokens are stored in `browser.storage.local`, private to the app or extension but not an operating-system credential vault.
- OneDrop requests `offline_access` and refreshes access tokens on demand.
- SPA refresh-token families expire after 24 hours; when that happens, OneDrop attempts silent authorization and otherwise asks the user to sign in again.
- Sign out clears local token storage but does not sign the user out of Microsoft in the browser.

## Troubleshooting

- `AADSTS50011`: the redirect URI in Entra does not exactly match the client.
- Token endpoint CORS failure: check that the redirect URI is registered with the correct platform type.
- Unconfigured UI: confirm `.env.local` exists, the variable name starts with `WXT_`, and the WXT process was restarted.
