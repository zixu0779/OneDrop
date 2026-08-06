# Authentication decision record

Status: proposed; implementation intentionally deferred.

OneDrop is a public client and must never contain a client secret. The target protocol is OAuth 2.0 Authorization Code with PKCE, initiated through the browser extension identity API.

The implementation gate is a focused compatibility spike covering:

- a stable packaged Edge extension ID;
- the redirect URL returned by `browser.identity.getRedirectURL()`;
- Microsoft Entra redirect URI configuration;
- PKCE authorization and token exchange;
- `Files.ReadWrite.AppFolder` consent;
- personal Microsoft accounts;
- work and school accounts, including conditional access behavior;
- token refresh and explicit sign-out cleanup;
- trusted-context-only access to persisted token material.

No authentication code should be merged before these points are demonstrated in a packaged development extension.
