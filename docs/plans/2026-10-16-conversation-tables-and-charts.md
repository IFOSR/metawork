# Conversation tables and charts

Plan date: 2026-10-16. Status: complete. Completion date: 2026-10-16.

## Goals and ownership

- Render valid GFM tables as readable, accessible tables in current conversation replies and history, including cells containing delivered-file references. Wide tables scroll within the reply.
- Render explicit, data-backed inline charts (line, bar, area, pie) offline, with legends, tooltips, an accessible data table, Web SVG export and Desktop PNG save. Preserve missing values and negative values where meaningful; do not invent data.
- Give all Executor backends the same presentation guidance. Inline charts do not request file outputs or change Planner/Kernel/storage ownership.
- Reject invalid/unbounded chart specifications with a readable source fallback. Never execute model-supplied JavaScript or fetch resources from chart specifications.
- Preserve existing image/file previews and slim desktop packaging.

## Implementation and gates

1. Fix shared Markdown rendering and artifact references without splitting Markdown blocks. Browser gate: real production conversation/history, table alignment/borders, artifact cell, narrow viewport.
2. Add a bounded chart specification and lazy modular local renderer. Gate: schema adversarial tests; production browser line/bar/area/pie, gaps/negatives, interactions, export, light/dark, resize, malformed input and reload.
3. Add Executor guidance and verify completion processing preserves inline charts without creating file deliverables. Run owning prompt/completion tests and rich-document preview regression.
4. Build, review screenshots, record results and update current documentation. If a new desktop candidate is packaged, verify its resources/size and run isolated packaged checks before delivery.

## Completion record

Implemented 2026-10-16:

- Fixed the current `.markdown-content` table styling (the previous styling targeted a legacy chat class), including headers, borders, alignment and horizontal scrolling.
- Replaced raw Markdown splitting around file references with whole-document parsing, sanitization and authorized artifact buttons in text nodes. Plain and inline-code filenames inside tables preserve their cells; code blocks and chart specifications remain intact.
- Added a bounded chart schema, lazy local ECharts modules, four chart types, gaps for missing values, accessible original-value tables, keyboard legends, tooltips, theme/resize updates and export. Schema errors show readable fallback data. Parent callback changes no longer remount chart portals during interaction.
- Added shared Executor guidance for data-backed charts without extra file deliverables. Completion processing preserves the chart/table body with an empty `fileOutputs` array. No Planner, Kernel or storage policy changes.
- Added owned-frame Desktop PNG save, strict payload/dimension bounds, native decode/re-encode, a native destination dialog and atomic writes; updated ADR-0045/current contracts. SVG/arbitrary URLs and filesystem paths are not accepted by this bridge.

Validation already passed:

- Root runtime/Web build; final Web build; root typecheck; Desktop build/typecheck.
- 77 owning tests: schema, artifact reference matching, shared prompt and completion protocol.
- 23 Desktop tests, including 6 image payload boundary tests.
- Actual production Server + Chrome E2E: table cells containing artifact links open the CSV preview; all four chart types; missing/negative data; keyboard legend and scrolling; tooltip; SVG download; malformed schema and script sanitization; no external chart requests; dark/light and 390 px viewport; reload and live persisted-body replacement without stale portals. No browser runtime errors.
- Rich-document production regression: HTML, Word, PowerPoint, Excel/XLS/CSV, PDF, sandbox isolation, broken-file fallback, uploaded attachments and original download.
- Electron shell smoke: native PNG save/reveal/cancel and rejecting SVG payloads.
- Screenshots reviewed in `.tmp/conversation-charts-evidence/` (table, dark/light chart, narrow viewport); chart browser results in `result.json`.

Scope and limits: deterministic data was seeded into isolated production history; this is not an official-account/live-model analyst acceptance run. Existing valid tables render without rerunning tasks. Older prose answers do not automatically gain charts; new Executor responses can emit the documented schema. TUI/Feishu and Markdown-to-PDF keep chart JSON and explanatory prose. The internal DMG is arm64 and ad-hoc sealed, not Apple notarized.

Packaged acceptance completed 2026-10-16 with `Release/MetaWork-darwin-arm64-conversation-charts-20261016.dmg` (291,984,002 bytes; SHA-256 `fb2414e8a0aa6337fb9be5f47c746bf89699ecb10fbe4d33db7098bb8d8349d5`). The clean isolated packaged smoke verified rich-document readers, menu recovery, table rendering, all four chart types, native PNG save and Finder reveal, settings activation, and server survival. The final export fix serializes the rendered SVG DOM so quoted font stacks remain valid XML before PNG conversion.

No closing commit: the working tree contains unrelated ongoing changes; no commit was requested.
