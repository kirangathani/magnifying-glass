# Mock viewer harness

A standalone browser page that runs the **real** `PDFViewerComponent` from
`pdf-viewer.ts` outside Obsidian, so viewer layout, scrolling, zooming and the
comment-marker collision layout can be measured and iterated on with DevTools.

Obsidian's DOM helpers (`createDiv`, `setCssStyles`, `activeWindow`, …) are
polyfilled in `obsidian-shim.ts`; the page links the real `styles.css` and
defines stand-ins for the Obsidian theme variables. Comment cards are faked
(plain text instead of `MarkdownRenderer`) but positioned with the same greedy
downward sweep as `view.ts renderCommentMarkers()`.

## Usage

```bash
npm run mock                 # bundle to mock/mock.js (add `:watch` to rebuild on change)
cp <some.pdf> mock/test.pdf  # the harness loads ./test.pdf
python3 -m http.server 8099  # from the REPO ROOT, so ../styles.css resolves
# open http://localhost:8099/mock/index.html
```

`mock.js`, `pdf.worker.js` and `test.pdf` are gitignored build inputs/outputs.

## Measurement API

`window.mock` exposes:

| Call | Purpose |
|---|---|
| `mock.measure()` | Geometry snapshot: page vs viewport width, `scrollWidth`, `overflowBeyondPage` (scrollable dead space beyond the paper), `maxScrollLeft`, marker overlap count |
| `mock.countMarkerOverlaps()` | `0` means the collision sweep is holding |
| `mock.setScale(s)` | Commit a zoom the way the plugin does |
| `mock.setPaneWidth(px)` | Resize the comments pane programmatically |
| `mock.repositionMarkers()` | Re-run the collision sweep |
| `mock.timing` | Cold-load timings (fetch, eager all-page render) |
| `mock.auditPreviews()` | Per-card fitting measurements: `contentHeight`, `visibleHeight`, `truncated`, `chevronShown`, `straddlingLines`, `midWordBreaks` |
| `mock.auditSummary()` | Verdict over all cards: `pass` is true when no chevron disagrees with truncation, no line is cut by the clamp, no word is split unnecessarily, and no markers overlap |
| `mock.selectCard(i)` | Open card `i`'s real textarea (returns it) so bracket wrapping and live reflow can be driven from DevTools |
| `mock.markerTops()` | Placed top of every card, keyed by annotation id — for before/after comparisons while typing |
| `mock.trackHeights()` | `track` versus `pdfScrollHeight`, to check the track grows and reclaims space |
| `mock.sweepCount` | Sweeps triggered by the live-typing observer, for throttling assertions |
| `mock.alignmentReport()` | Per-card `yNorm`, `idealTop`, `placedTop` and `drift` — how far the collision sweep pushed each card off its anchor |

The stats strip under the zoom buttons shows the same numbers live.

Open `index.html?fixture=bsa` to load the real annotation set from
`Sandbox/CyanoCapture_BSA_TPP.pdf` (anchors from its sidecar, text from its comment
notes) with that PDF as `test.pdf`. That reproduces the reported card-versus-highlight
drift exactly, so `alignmentReport()` measures it instead of arguing about it.

The cards use the real `comment-fit.ts` pass, the real `marker-layout.ts` sweep, and the real `bracket-wrap.ts`/`WikilinkSuggest` wiring — only the note content is faked (static HTML instead of `MarkdownRenderer`), so these assertions test the shipped code paths. The `obsidian` module is aliased to `mock/obsidian-stub.ts` at build time.
