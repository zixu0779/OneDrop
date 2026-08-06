# Authentication compatibility check

Status: implemented as a development validation; production token lifecycle is deferred.

OneDrop is a public client and contains no client secret. The validation flow uses OAuth 2.0 Authorization Code with PKCE, initiated through `browser.identity.launchWebAuthFlow` in the MV3 service worker.

## Register a development application

1. Open the Microsoft Entra admin center and go to **Identity > Applications > App registrations**.
2. Select **New registration**.
3. Name it `OneDrop Development`.
4. Select **Accounts in any organizational directory and personal Microsoft accounts**.
5. Complete the registration and copy the **Application (client) ID**.
6. In OneDrop's loaded Side Panel, copy the displayed Redirect URI. It has the form `https://<extension-id>.chromiumapp.org/auth`.
7. In the Entra registration, open **Authentication > Add a platform > Single-page application** and add that exact URI.
8. Under **API permissions**, add the Microsoft Graph delegated permission `Files.ReadWrite.AppFolder`. Retain the OpenID scopes requested dynamically by the application.
9. Do not create a client secret.

The redirect URI must match exactly, including the `/auth` path. A separately packaged production extension will have a different stable extension ID and should use a separate production registration.

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
- the extension can keep token material in `browser.storage.session`.

After authentication succeeds, the Side Panel presents a separate, explicit OneDrive App Folder verification action. Authentication by itself does not call Graph or create OneDrive data.

## Deliberate validation limitations

- Access and refresh tokens are stored only in `browser.storage.session` and disappear when the Edge session ends.
- Expired tokens return the UI to signed-out state; refresh-token handling is not implemented.
- **Sign out locally** clears extension session storage but does not terminate the Microsoft Entra browser session.
- ID-token claims are decoded only for display. Authorization decisions must never rely on these unverified display claims.
- Errors are shown in the Side Panel so redirect-type and CORS incompatibilities can be recorded before production auth design is finalized.

## Troubleshooting

- `AADSTS50011` means the displayed redirect URI does not exactly match the registered URI.
- A token endpoint CORS failure means the redirect URI platform type or extension-origin exchange is incompatible; record the Edge console error before changing flows.
- If the UI remains unconfigured, confirm `.env.local` exists, the variable is prefixed with `WXT_`, and the WXT process was restarted.
