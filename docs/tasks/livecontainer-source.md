# LiveContainer subscription source

Generate apps.json from the existing v1.0.3 IPA, update the source automatically for future releases, document the URL and installation steps, and provide a release-note sentence.

Acceptance requires accurate published IPA metadata, a stable public URL, repeatable updates that preserve version history and the newest entry, and install instructions consistent with the actual source URL.

Implemented locally and independently reviewed. The checked-in v1.0.3 catalog and Jekyll template generate /apps.json from published release assets. The iOS workflow validates the IPA, requests a Pages rebuild and checks the public listing after upload. Installation instructions cover subscription and manual import.

Verified the downloaded v1.0.3 archive, generated JSON against GitHub release metadata using Jekyll 3.10, numeric version ordering, repeat builds and prerelease filtering. Deployment and on-device installation remain unverified.
