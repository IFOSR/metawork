# Web Stop Live State Fix

Status: Implemented; automated verification passed
Plan date: 2026-09-21
Completion date: 2026-09-21

## Diagnosis

The Web Composer derives its running state from the current live Turn.
`cancel_turn` publishes a cancellation request, but when Planning has already
returned and only Executor work remains, the cancellation drain previously
published no terminal trace. Task cleanup could complete while the browser's
Turn remained running. Reloading rehydrates durable Task facts, explaining why
the refreshed view can differ from the live view.

Two related projection issues could also overwrite a cancelled Turn: the Web
final-answer callback unconditionally assigned running/completed, and the
Management final-answer projection converted cancellation to completion.
Late trace snapshots or deltas could reopen the browser's terminal Turn.

## Delivered Behavior

1. The existing cancellation drain publishes a Task-scoped `turn_cancelled`
   trace only after recovery finishes, the Task is durably cancelled and
   completion-blocking residue is empty. It uses a stable event key.
2. The existing Gateway trace subscription carries the terminal status to
   clients; no new command, event envelope or wire version is introduced.
3. Web state-merging functions are extracted from App for direct testing.
   Late answers and progress cannot reopen terminal Turns or overwrite a
   confirmed cancellation. The Composer remains driven by server facts,
   not the stop request's admission.
4. Management preserves cancellation and its completion timestamp when a
   late answer arrives.

Kernel cancellation decisions, cleanup/retry policy, scheduler behavior,
database schema and historical presentation format are unchanged. No forced
page reload, polling workaround or optimistic completion is added.

## Validation

- Reproduced five failing regression cases before implementing the fixes.
- Root regression run: 87 files, 638 tests passed, covering cancellation,
  Session, Management, Gateway, Web, Feishu and architecture boundaries.
- Cancellation tests cover pending cleanup, cleanup failure, remaining
  residue, noncancelled Tasks and repeated drain deduplication.
- Composer rendering verifies that the cancellation trace restores Send and
  removes Stop even after a late background-work answer.
- `npm run lint`: passed.
- `./node_modules/.bin/tsc --noEmit -p web/tsconfig.json`: passed.
- `npm --prefix web run build`: passed.
- `git diff --check`: passed.

No live provider task was submitted or cancelled for verification. Browser
manual acceptance and external Feishu delivery were not repeated. The local
installed application and running Server were not updated or restarted.

Closing commit: none; changes remain uncommitted.
