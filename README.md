# OneDrop

OneDrop is a Microsoft Edge extension that will provide cross-device text and file sharing through the user's own OneDrive. It has no application server and no SaaS data layer.

This repository currently contains the approved project foundation and a minimal Microsoft identity compatibility check. Microsoft Graph synchronization, messaging, uploads, downloads, and cache lifecycle behavior are intentionally not implemented.

## Architecture baseline

- Microsoft Edge extension, Manifest V3
- WXT, React, and TypeScript
- Edge Side Panel as the primary UI
- MV3 service worker as the privileged orchestration boundary
- Microsoft Graph REST with OneDrive App Folder
- Monthly message metadata documents with ETag optimistic concurrency
- IndexedDB for local indexes and Cache Storage for managed preview files
- No backend server and no offline delivery queue

See [docs/architecture.md](docs/architecture.md) for the complete proposal.

## Requirements

- Node.js 22 or newer
- Microsoft Edge 114 or newer

## Commands

```bash
npm install
npm run dev
npm run compile
npm test
npm run build
```

`npm run dev` starts the Edge-targeted WXT development build. If WXT does not start Edge automatically, follow its terminal instruction and load `.output/edge-mv3-dev` from `edge://extensions` as an unpacked extension. The production unpacked extension is emitted at `.output/edge-mv3` by `npm run build`.

## Configuration

Copy `.env.example` to `.env.local` and add the development Microsoft Entra Application (client) ID before running the authentication check. Never commit Microsoft Entra environment values or token material. See [docs/authentication.md](docs/authentication.md).

## Current scope

The current side panel exposes Microsoft identity and OneDrive App Folder checks followed by a read-only current-month message check. It may create the dedicated app folder, but it does not create message metadata or upload user files.
