# OneDrop

OneDrop is a Microsoft Edge extension that will provide cross-device text and file sharing through the user's own OneDrive. It has no application server and no SaaS data layer.

This repository contains the working Edge side-panel foundation, Microsoft identity and OneDrive App Folder validation, current-month synchronization, conditional text-message writes, small-file transfer, and user-owned local downloads.

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

The current side panel automatically restores Microsoft identity, verifies the OneDrive App Folder, reads the current month, and supports conditional text and file messages. Current-month metadata uses deterministic 256 KiB-target chunks with a 320 KiB hard ceiling. Files up to 4 MiB use direct deterministic-path upload; larger files use Microsoft Graph upload sessions with 5 MiB chunks, bounded retries, visible progress, cancellation, and explicit Resend after interruption. Final metadata commit is reconciled automatically without exposing a separate Message not sent state. Other foreground devices temporarily refresh at 2, 5, 8, and 10 seconds when they observe an uploading record. Clicking an attachment opens a still-existing Edge download or downloads it again; Save as is available from the message menu, and filename conflicts use the browser's `uniquify` behavior. OneDrop records download IDs but never deletes user-owned files. Malformed monthly chunks are skipped for display and surfaced in a pinned repair-or-delete notice. The obsolete `messages/YYYY-MM.json` layout is not read or migrated. Validated snapshots and folder IDs are cached in IndexedDB. Historical months load lazily and are archived once by a persisted, non-blocking scheduler; a later synchronization reverifies the immutable archive before deleting its source chunks. Inactive-Edge background delivery remains deferred.
