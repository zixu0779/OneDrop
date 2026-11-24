# Automatic website release notes

## Request

Automatically obtain website Release notes from GitHub Releases, retaining the approved timeline and concise editorial content.

## Acceptance

- Published stable versions update without editing homepage markup; exclude drafts and prereleases, sort numeric versions descending.
- Preserve existing eight concise summaries. Future releases carry an explicit short website summary; missing summary still exposes version/date/full notes without copying full technical release text.
- Preserve timeline layout, selection, hover, first/last connectors, three visible entries, Show/Hide placement, animations, reduced motion and scroll behavior. Handle fewer than four releases.
- Publishing or editing releases refreshes Pages without rebuilding app packages for text-only changes or submitting Partner Center.
- Safe rendering and meaningful automated tests; independent final acceptance and working rendered preview.

## Status

Implementation complete and independently accepted. The user explicitly authorized publication to the official website. Publishing from `feat/automatic-release-notes`; pull-request CI, merge, deployment and live verification are tracked in the publication PR.

## Approach

Prefer existing Jekyll GitHub release metadata and build-time rendering. Retain historical editorial summaries in repository data; future concise summaries live in GitHub Release bodies. No client-side GitHub API dependency. Reuse existing release build integration and add minimal refresh coverage as needed.

## Implementation

- `docs/index.html` now has Jekyll front matter and includes the build-time timeline. The approved CSS is unchanged; the interaction script only adds a guard when there are no archive controls.
- `docs/_includes/release-timeline.liquid` filters published stable canonical numeric tags, sorts by version, and handles zero through three entries without archive controls.
- `docs/_includes/release-entry.liquid` validates and safely escapes the explicit short summary block. It accepts exactly one marker pair, an 80-character title and one to three 240-character bullets; malformed/missing blocks use historical fallback or a generic heading/link, never full technical body text.
- `docs/_data/release_summaries.json` preserves the original eight editorial summaries. It is fallback text only, so deleted/unpublished releases disappear. There is no new global timezone setting or change to existing source feeds; current eight publication dates remain identical.
- `docs/release-notes.md` documents author-written summaries, fallback, refresh limitations and rendered local previews. `AGENTS.md` links the release-author requirement.
- `.github/workflows/refresh-release-notes.yml` requests only a Pages rebuild for publication/edit/deletion/unpublication and manual dispatch. A daily default-branch request covers historical tags lacking this workflow; GitHub schedule/build delays mean it is not an instant-sync guarantee. Existing package workflow remains unchanged and still requests Pages after assets upload.
- CI installs Ruby/Jekyll before JavaScript tests. Ruby fixtures exercise the real homepage, and JavaScript tests consume actual rendered cases rather than a handwritten duplicate timeline.

## Validation

- New Jekyll fixtures passed: historical copy, numeric ordering vs backfilled publication dates, draft/prerelease/invalid-tag exclusion, 0/1/3/4/8 entries, explicit override, escaped HTML/pipe/CRLF content, duplicate/partial/out-of-order markers, length limits, malformed fallback, edits and deletions.
- Both existing LiveContainer catalog and update-feed Ruby checks passed.
- 18 targeted JavaScript tests passed, including original installation interactions and rendered timeline selection, animation/scroll-preserving focus, reduced motion and short release lists.
- TypeScript compile, ESLint, full-repository formatting and diff whitespace checks passed. The full suite passed: 50 test files, 348 tests.
- Real release metadata preview built with `ruby tests/release/website-release-notes.rb --preview /tmp/onedrop-current-releases.json /tmp/onedrop-automatic-release-site`. Independent acceptance rebuilds `/tmp/onedrop-auto-acceptance-site` and serves it at http://127.0.0.1:8768/ without network interception.
- During development the Ruby safety fixtures caught Prettier collapsing a literal captured newline. Templates now use `%0A | url_decode` and `.liquid` includes, matching the repository's existing template convention.
- No external Release edits, Pages rebuild requests, publication or store actions were performed.

## Final independent acceptance

- The real Jekyll build at http://127.0.0.1:8768/ uses the current real GitHub Release snapshot and no browser network interception. The eight historical entries match the previous homepage text exactly after whitespace normalization.
- Independent Ruby fixtures and 18 targeted JavaScript tests passed. Desktop/mobile expansion leaves scrollY unchanged, all eight node centers/connectors and endpoints are correct, Hide remains at the bottom, and selection/reduced-motion behavior is preserved.
- The rendered apps.json responds 200 with the current 1.2.0 IPA, and installation copying still works.
- `/tmp/onedrop-timeline-acceptance/automatic-final-{1440,375}.png` passed independent visual review; the implementer also reviewed the desktop image.
- External release events and scheduled Pages rebuilds were not triggered live. The old-tag fallback and GitHub schedule/build-delay limitations remain as documented. No publication, remote Release edits or Edge store actions occurred.

## Publication authorization

The user explicitly requested publishing this automatic Release notes implementation to the official website. Scope is this website/template/workflow change only; no remote Release content changes or Edge store submission. The branch was checked against the latest `origin/main` before committing, with no base divergence or unrelated work. Existing local checks and independent acceptance remain valid; required CI and live deployment verification will be recorded with the PR.
