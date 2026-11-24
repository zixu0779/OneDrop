# Website release notes

The homepage is rendered by GitHub Pages/Jekyll from `site.github.releases`. It lists published, non-draft, non-prerelease tags in `vMAJOR.MINOR.PATCH` form, sorted by numeric version rather than publication time. Components must be canonical nonnegative integers with at most ten digits. Dates come from GitHub's `published_at` timestamp (UTC).

## Writing a website summary

Write and review a short summary when preparing a Release. Put this block in the GitHub Release body; the markers are invisible in GitHub's rendered notes, while its title and bullets remain readable:

```markdown
<!-- website-summary:start -->

### A short, user-facing title.

- New: One useful addition.
- Improved: One practical improvement.
- Fixed: One visible problem that is now resolved.

<!-- website-summary:end -->
```

Use exactly one start/end marker pair, one `### ` title of at most 80 characters, then one to three single-line bullets. Allowed labels are exactly `New`, `Improved`, and `Fixed`; each bullet's text is at most 240 characters. Blank lines and CRLF line endings are accepted. Keep the text plain: Markdown links, emphasis and HTML are not interpreted. All summary text is HTML-escaped on the website.

These are author-written and reviewed summaries. The site automatically synchronizes them; it does not generate summaries or copy the complete technical Release body. Keep installation instructions, certification details, test logs and internal notes outside the block.

A valid explicit block takes precedence over historical copy. Missing, incomplete, duplicate or malformed blocks fall back to the approved summary in `docs/_data/release_summaries.json` for the original eight versions. Other versions show a short generic heading, version, publication date and the full Release link. Bad summaries never cause the long Release body to appear. Existing historical summaries are only fallback copy, not a separate release list: deleting or unpublishing a Release removes it from the timeline.

## Refresh behavior

`refresh-release-notes.yml` requests a Pages rebuild on published, edited, deleted and unpublished release events. This workflow does not build application packages or submit the Edge store. The existing release-assets workflow still refreshes Pages after package upload; it remains triggered only by publication or explicit manual invocation.

Release-event workflows are evaluated at the event's tag commit. Historical tags created before the refresh workflow may therefore not trigger it when edited. A daily default-branch schedule requests a rebuild as a fallback (03:17 UTC; GitHub may delay scheduled jobs). For immediate refresh of old-tag edits, run **Refresh website release notes** with **Run workflow** from the default branch. New releases whose tag contains the workflow use the event trigger. Updates become visible when Pages finishes its build; instant synchronization is not guaranteed.

Do not edit remote Releases, trigger publication or submit the Edge store merely to test this integration.

## Local validation and preview

Install the same Jekyll version as GitHub Pages once:

```sh
gem install jekyll -v 3.10.0 --no-document
ruby tests/release/website-release-notes.rb
npm test -- tests/unit/website-release-notes.test.ts tests/unit/website-installation.test.ts
```

The timeline JavaScript tests render the real Jekyll homepage using local release fixtures. CI installs Ruby/Jekyll before running them. The fixtures test summary safety, fallback behavior, version sorting, edits/deletions and zero/one/three/four/eight entries without contacting GitHub.

A raw static server on `docs/` cannot render this page or the existing `/apps.json` feed. Supply a JSON array of real GitHub Release metadata, then build and serve the output:

```sh
ruby tests/release/website-release-notes.rb --preview /tmp/onedrop-current-releases.json /tmp/onedrop-rendered-site
python3 -m http.server 8768 --bind 127.0.0.1 --directory /tmp/onedrop-rendered-site
```

Use a fresh snapshot for a current preview. `tests/release/fixtures/website-releases.json` is sufficient for deterministic layout checks, but intentionally has no package assets and must not be presented as the live installation source. A real metadata snapshot includes the assets needed by the existing LiveContainer catalog template.
