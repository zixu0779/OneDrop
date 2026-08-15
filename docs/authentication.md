# Authentication compatibility check

Status: persistent sign-in and refresh-token rotation implemented for OneDrop.

OneDrop is a public client and contains no client secret. The validation flow uses OAuth 2.0 Authorization Code with PKCE, initiated through `browser.identity.launchWebAuthFlow` in the MV3 service worker. Android Edge cannot create that identity window, so OneDrop opens the same SPA authorization request in a normal Edge tab, observes only its exact registered callback URI, and closes the tab after the callback arrives.

## Microsoft Entra application

1. Open the Microsoft Entra admin center and go to **Identity > Applications > App registrations**.
2. Select the `OneDrop` registration (application/client ID `1cef78e3-cd82-4c41-bd05-71e00bf1bd3f`).
3. Keep **Accounts in any organizational directory and personal Microsoft accounts** enabled.
4. Under **Authentication**, retain the desktop and Android **Single-page application** redirect URIs displayed by their respective builds.
5. Retain the **iOS/macOS** platform with bundle ID `com.sycamore.onedrop` and redirect URI `msauth.com.sycamore.onedrop://auth`.
6. Under **API permissions**, retain the Microsoft Graph delegated permission `Files.ReadWrite.AppFolder` and the OpenID scopes requested dynamically by the application.
7. Do not create a client secret.

Every redirect URI must match exactly. A newly packaged browser build with a different stable extension ID must have its exact `https://<extension-id>.chromiumapp.org/auth` URI added to this registration before release.

## Configure the local build

Create `.env.local` in the repository root:

```dotenv
WXT_ONEDROP_ENTRA_CLIENT_ID=<Application client ID>
WXT_ONEDROP_ENTRA_AUTHORITY=https://login.microsoftonline.com/common
```

Restart `npm run dev` after changing environment variables, reload `.output/edge-mv3-dev` if necessary, and reopen the Side Panel.

## What the check proves

A successful sign-in proves:

- Edge intercepted the `chromiumapp.org` callback;
- state validation succeeded;
- Entra accepted the PKCE verifier;
- the browser-origin token exchange passed Entra CORS enforcement;
- the account consented to `Files.ReadWrite.AppFolder`;
- the extension can persist its refresh credential in extension-local storage and restore the session after Edge restarts.

After authentication succeeds, the Side Panel automatically verifies the OneDrive App Folder and reads the current UTC month. The manual actions remain available as recovery and refresh controls.

## Token lifecycle

- Access and refresh tokens are stored in `browser.storage.local`, which is private to the extension but is not an operating-system credential vault.
- OneDrop requests `offline_access` and refreshes the access token on demand shortly before expiry. A rotated refresh token replaces the previous value atomically.
- Because the extension redirect URI is registered as an SPA, Microsoft limits that refresh-token family to 24 hours; rotated tokens do not extend that original deadline.
- When that grant expires, OneDrop first runs a non-interactive authorization-code flow with `prompt=none`. Desktop Edge uses the identity window; Android Edge uses a temporary inactive tab. If the Microsoft browser session is still active, this obtains a fresh token family without asking for credentials and closes the tab automatically. If silent authorization requires interaction, OneDrop clears the unusable local grant and shows the normal sign-in state.
- Device Code tokens are deliberately not used by the browser extension. Although Device Code can complete the first Android sign-in, Entra rejects their later redemption from an extension origin with `AADSTS90023`.
- Temporary refresh failures are reported without deleting the refresh token.
- **Sign out locally** clears both local and legacy session token storage but does not terminate the Microsoft Entra browser session.
- Uninstalling the extension clears its local token storage.
- ID-token claims are decoded only for display. Authorization decisions must never rely on these unverified display claims.
- Errors are shown in the Side Panel so redirect-type and CORS incompatibilities can be recorded before production auth design is finalized.

## Troubleshooting

- `AADSTS50011` means the displayed redirect URI does not exactly match the registered URI.
- A token endpoint CORS failure means the redirect URI platform type or extension-origin exchange is incompatible; record the Edge console error before changing flows.
- If the UI remains unconfigured, confirm `.env.local` exists, the variable is prefixed with `WXT_`, and the WXT process was restarted.
