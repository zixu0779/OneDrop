# OneDrop

OneDrop is a Microsoft Edge extension that will provide cross-device text and file sharing through the user's own OneDrive. It has no application server and no SaaS data layer.

This repository currently contains the approved project foundation only. Authentication, Microsoft Graph synchronization, messaging, uploads, downloads, and cache lifecycle behavior are intentionally not implemented.

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

`npm run dev` launches the Edge-targeted WXT development build. The production unpacked extension is emitted under `.output/` by `npm run build`.

## Configuration

Copy `.env.example` to `.env.local` only when authentication implementation begins. Never commit Microsoft Entra environment values or token material.

## Current scope

The current side panel is a deliberately minimal project-foundation screen. It proves that the Edge entrypoints and build configuration are connected without prematurely implementing product functionality.
