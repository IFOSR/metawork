# TUI Scrolling And Phantom Web Turn Repair

Status: Completed
Plan date: 2026-09-25

## Scope And Evidence

The TUI renders a bounded viewport, so terminal scrollback cannot recover text
outside that viewport. Its editor only intercepts literal legacy PgUp/PgDn
sequences, not protocol-aware keys, and no mouse-wheel input is enabled.

Web replay creates running Turn state for arbitrary Turn-scoped event fragments
with an empty user input. `emitInFlightTurns` then announces those fragments as
new user Turns. The local journal contains a trace-only retained running Turn
without its original intake. A presentation fragment is not execution authority.

## Implementation

1. Add and run failing regression tests for protocol paging, mouse scrolling,
   retained orphan events, real in-flight replay and rejected cancellation.
2. Use the existing Pi key decoder and a lifecycle-scoped mouse-wheel handler.
   Preserve the editor, bounded viewport, reading position and Task panel.
3. Require an actual input source before replaying a running Web Turn; retain
   real query intake and persisted Turn context, ignore orphan event fragments,
   and surface rejected cancellation receipts. Do not modify Kernel/Task state.
4. Run focused TUI, Management, Web, Gateway and cancellation tests, type checks
   and builds. Validate against the installed Server and real client surfaces.

## Validation And Closure

Scroll, replay, and live cancellation checks passed on 2026-09-25.

Delivered:

- TUI supports legacy, Kitty, Shift, keypad and mouse-wheel scrolling while
  preserving the bounded viewport, editor draft and reading position.
- Web replay requires real intake evidence before announcing an in-flight Turn.
  TUI buffers retained result fragments until authoritative Turn context arrives;
  neither surface creates a blank running Turn from result fragments.
- Rejected cancellation receipts surface as errors instead of leaving the Web
  Composer in a false running state.
- Cancellation remains latched across binding/home preparation and late
  Executor results; local CLI cancellation escalates from SIGTERM to SIGKILL
  without releasing the Task slot before child exit is observed.

Validation:

- Root TypeScript check passed with `npm run lint`.
- Root Web/Gateway/Management/Session regression passed: 499 tests.
- Vendored TUI/Gateway regression passed: 120 tests.
- Native Planner build and main/Web builds passed.
- Installed release `1.2.0-preview.5-build-3723377-1790303802154` started
  successfully.
- Real Unix socket scroll verification passed for 80/120 columns, all supported
  paging and wheel sequences, draft preservation, and zero work submissions.
- Installed release
  `1.2.0-preview.5-build-3723377-1790305736959` started successfully.
- Real Web Stop verification produced a non-empty cancelled Turn, no blank
  Turn, no Stop control after settlement, an editable Composer, a cancelled
  Task/dispatch, zero unreleased resource leases, and a free Conversation slot.

Closing commit: none; no commit requested.
