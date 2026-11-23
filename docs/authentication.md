# Authentication

This file exists so local development and release builds use the same Microsoft Entra setup. OneDrop is a public client: it uses Authorization Code with PKCE and never contains a client secret.

## Local configuration

Create `.env.local` in the repository root:

```dotenv
WXT_ONEDROP_ENTRA_CLIENT_ID=<Application client ID>
WXT_ONEDROP_ENTRA_AUTHORITY=https://login.microsoftonline.com/common
# Optional override for clients without browser.identity:
WXT_ONEDROP_TAB_REDIRECT_URI=https://onedrop.sycamore.top/auth.html
```

Restart `npm run dev` after changing these values. If the extension is already loaded, reload `.output/edge-mv3-dev` and reopen the Side Panel.

## Entra app registration

The app registration must allow personal Microsoft accounts and must include the redirect URI for each packaged client.

- Desktop and Android Edge builds use the exact `https://<extension-id>.chromiumapp.org/auth` URI shown by the build.
- iOS Edge currently lacks the Identity API and uses the reachable SPA redirect `https://onedrop.sycamore.top/auth.html` with a temporary Edge tab.
- Stable iOS uses bundle ID `com.sycamore.onedrop`, and OneDrop Beta uses `com.sycamore.onedrop.beta`. Both use the registered redirect URI `msauth.com.sycamore.onedrop://auth` with separate Keychain services. Apple routes the callback to the app that started the authentication session. [ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)
- Microsoft Graph delegated permission must include `Files.ReadWrite`.
- Do not create or ship a client secret.

A release build with a new stable extension ID needs its new redirect URI added before sign-in can work.

## Runtime behavior

- Desktop Edge starts sign-in with `browser.identity.launchWebAuthFlow`.
- Android Edge and iOS Edge can fall back to a temporary Edge tab for the same PKCE request when the identity window cannot be created.
- Native iOS uses ASWebAuthenticationSession; native Android uses AppAuth in an external browser.
- Edge tokens are stored in `browser.storage.local`, private to the extension but not an operating-system credential vault.
- Native iOS tokens are stored in Keychain. Native Android token state is encrypted with an Android Keystore AES-GCM key and stored in private preferences.
- OneDrop requests `offline_access` and refreshes access tokens on demand.
- For the Edge SPA redirect flow, refresh-token families expire after 24 hours; when that happens, OneDrop attempts silent authorization and otherwise asks the user to sign in again.
- Sign out removes the active account’s saved credentials and selects the most recently used remaining account, or returns to the sign-in page. Forgetting an inactive account removes only its saved credentials. Both preserve local messages, drafts, files, and settings and do not sign the user out of Microsoft in the browser.

## Troubleshooting

- `AADSTS50011`: the redirect URI in Entra does not exactly match the client.
- Token endpoint CORS failure: check that the redirect URI is registered with the correct platform type.
- Unconfigured UI: confirm `.env.local` exists, the variable name starts with `WXT_`, and the WXT process was restarted.

## Native Android

Android uses the shared Entra public client and `msauth.com.sycamore.onedrop://auth` redirect. This URI must be registered as a native/public-client redirect for that client. The implementation uses AppAuth authorization-code flow with S256 PKCE in an external browser. AppAuth verifies OAuth state and exchanges the code without a client secret. Access and refresh tokens are encrypted using an Android Keystore AES-GCM key, with app backup disabled.

Android keeps its session in its own app sandbox. Login compatibility with the configured Entra tenant and browser requires a device login check.
