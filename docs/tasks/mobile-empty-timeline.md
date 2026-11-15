# Mobile refresh with an empty current month

The mobile CRX needs repeated refresh gestures to reach history and still displays “No messages yet” beside messages. Native iOS cannot pull to refresh from the empty timeline.

Acceptance: one pull reaches available history across empty months, the empty hint reflects the whole displayed timeline, and native iOS can start a pull on an empty or short list. Preserve paging on populated lists and report device verification separately.

Status: investigating the shared React timeline and both mobile entry points.

The CRX report can also refer to the header refresh button. Explicit mobile refresh should discover history if the synchronized timeline is empty. Initial display should continue to show the current month.

Baseline reproduced on the Android extension page in Edge mobile emulation with a mocked runtime. One CDP touch swipe requested the preceding month and left only the empty hint. Independent iPhone 17 simulator XCTest reproduced the empty-list failure on the old native WebView and verified that the revised gesture loads history, clears the hint and can page again on a short list.

Completed locally. Both runtime bridges list source and archive months. History reads skip empty results and stop at the nearest visible month. The hint follows the displayed timeline. Mobile touch and explicit refresh share the history loader.

All 221 tests, TypeScript, ESLint and diff checks passed. Independent acceptance reran 59 focused tests and two native simulator XCUITests on the final source. The packaged Android entry also passed single-swipe and header-refresh checks in mobile-emulated Microsoft Edge with a fixture runtime. In both cases one old message appeared and the empty hint disappeared. CRX and LiveContainer IPA were built locally. Physical devices and live OneDrive data were not tested.

Physical iPhone follow-up: imported the locally signed CRX using Edge’s Load .crx Package through iPhone Mirroring. Reopened the extension with its existing account. From “No messages yet”, one tap on the header refresh loaded August 22 text and file messages in November. No messages were created or deleted. This check exercised the header refresh entry point.
