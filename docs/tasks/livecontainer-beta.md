# LiveContainer beta channel
Use the existing apps.json source for an independently installable OneDrop Beta. A beta IPA must have its own bundle identifier and display name, track only beta versions, and include local mobile fixes. Stable versions and release behavior must remain intact. Verify catalog rendering and real package metadata. Public deployment is a separate action.

Implemented and independently checked against a built IPA, Jekyll source rendering, and LiveContainer’s source decoder. The Beta uses a separate bundle identifier and Keychain service and displays its own version. The public rollout and physical-device verification follow release publication.
