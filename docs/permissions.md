# Extension permission budget

OneDrop follows least privilege. Every permission added to the manifest must have a user-facing justification and an owning feature.

| Permission  | Initial justification                                 |
| ----------- | ----------------------------------------------------- |
| `sidePanel` | Host OneDrop's persistent Edge interface.             |
| `identity`  | Initiate Microsoft identity authentication.           |
| `storage`   | Persist preferences and small extension-owned state.  |
| `alarms`    | Run best-effort refresh and cache maintenance events. |

| Host permission                       | Initial justification                            |
| ------------------------------------- | ------------------------------------------------ |
| `https://graph.microsoft.com/*`       | Access the user's consented OneDrive App Folder. |
| `https://login.microsoftonline.com/*` | Complete Microsoft identity protocol requests.   |

Explicitly excluded from the initial manifest: `tabs`, `activeTab`, `scripting`, `downloads`, `unlimitedStorage`, content scripts, and arbitrary host access.
