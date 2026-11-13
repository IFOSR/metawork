# Executor Idle Timeout And Retry Presentation Implementation Plan

> **Status:** Completed
> **Plan date:** 2026-09-10
> **Completion date:** 2026-09-10

**Goal:** Preserve unlimited active Executor work while timing out genuinely idle local CLI processes, and keep Web turns live across Kernel-authorized automatic retry.

**Architecture:** Harness Drivers classify authoritative lifecycle events as active-operation start/end signals. The local CLI runner pauses its only idle watchdog while any operation is active; no attempt-duration, tool-count, cycle-count, or global shell timeout is introduced. Conversation and Web presentation derive automatic-recovery state from durable Task facts and never treat `kernel_retry` as terminal.

**Tech Stack:** Node.js 22, TypeScript ESM, Vitest, React.

---

### Task 1: Define Harness Activity Signals

**Files:**
- Modify: `src/executor/harness-driver.ts`
- Modify: `src/executor/pi-cli-driver.ts`
- Modify: `src/executor/codex-cli-driver.ts`
- Test: `tests/executor/pi-cli-driver.test.ts`
- Test: `tests/executor/codex-cli-driver.test.ts`

1. Add failing tests for Pi turn and Codex item activity start/end signals.
2. Run the focused Driver tests and verify the new expectations fail.
3. Add the minimal Driver activity contract and parsers.
4. Run the focused Driver tests and verify they pass.

### Task 2: Make The Watchdog Idle-Only

**Files:**
- Modify: `src/executor/local-cli-executor-adapter.ts`
- Test: `tests/executor/local-cli-executor-adapter.test.ts`

1. Add a failing process-runner test showing that an active operation can remain silent beyond the idle threshold.
2. Add a failing test showing that the watchdog starts again when the operation ends.
3. Pass Driver activity signals through the Adapter to the process runner.
4. Pause the idle timer while active operations exist and restart it after the last operation ends.
5. Run the focused Adapter tests.

### Task 3: Rename The Runtime Policy

**Files:**
- Modify: `src/configuration/types.ts`
- Modify: `src/configuration/schema.ts`
- Modify: `src/configuration/application-config-projection.ts`
- Modify: `src/configuration/smoke-configuration.ts`
- Modify: `src/account/account-execution-services.ts`
- Test: `tests/configuration/schema.test.ts`
- Test: `tests/configuration/projections.test.ts`
- Test: `tests/configuration/smoke-configuration.test.ts`

1. Replace `attemptTimeoutMs` with `executorIdleTimeoutMs`.
2. Project only the legacy `executor.timeout` compatibility field and stop deriving `max_duration`.
3. Update focused configuration tests and run them.

### Task 4: Keep Automatic Retry Non-Terminal

**Files:**
- Modify: `src/session/conversation-session.ts`
- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/management/execution-projector.ts`
- Modify: `src/management/web-conversation-projector.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Test: `tests/session/conversation-session.test.ts`
- Test: `tests/execution/kernel-execution-runtime-recovery.test.ts`
- Test: `tests/management/web-conversation-projector.test.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`

1. Add failing tests proving a `kernel_retry` Task remains background work.
2. Add failing tests proving `waiting_retry` is non-terminal in Web projection.
3. Replace the generic blocked output for retry with an automatic-recovery message.
4. Derive `waiting_retry` from durable Task dependencies.
5. Rehydrate historical turn status from the current durable timeline.
6. Run the focused Session, Runtime, and Management tests.

### Task 5: Reduce Misleading Heartbeat Presentation

**Files:**
- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `web/src/components/LiveExecutionPanel.tsx`
- Modify: `web/src/executor-health.ts`
- Test: `tests/execution/kernel-execution-runtime-recovery.test.ts`
- Test: `tests/web/executor-health.test.ts`

1. Keep heartbeat presentation-only and explicitly distinguish active execution from idle silence.
2. Avoid claiming that a long-running active operation is lost solely because no new public progress event arrived.
3. Run the focused Runtime and Web tests.

### Task 6: Validation And Closure

1. Run all focused tests touched by the implementation.
2. Run `npm run lint`.
3. Run `npm test` when the host environment supports the full suite.
4. Record completion date, delivered behavior, validation, and closing commit if one is created.

## Delivered Behavior

- Replaced `attemptTimeoutMs` with `runtimePolicy.executorIdleTimeoutMs` and
  stopped projecting `executor.max_duration`.
- Added Pi and Codex Harness operation lifecycle signals. The local CLI idle
  watchdog pauses while any operation is active and restarts after the final
  operation ends.
- Kept Kernel automatic retry non-terminal through `waiting_retry`,
  `backgroundWorkPending`, same-turn durable rehydration, and Task-to-turn trace
  ownership.
- Marked Runtime heartbeat as presentation-only and removed unsupported Web
  lost-executor inference unless activity is explicitly idle.
- Closed `request_clarification` turns after the clarification is prepared for
  delivery, leaving the Conversation ready for the user's next submission.
- Made Web turn status monotonic so late Planner trace events can enrich a
  terminal turn without changing it back to `running`.

## Validation

- Focused Executor and configuration tests: 78 passed.
- Focused Session, Runtime, Management, Web, and Workspace tests: 87 passed.
- Clarification terminal-state regression tests: 2 passed.
- Expanded Gateway, Management, and Session tests: 539 passed, 3 skipped, with
  only the previously documented unrelated scripted-session expectation
  failing.
- Retry TUI acceptance tests: 2 passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- Native installation updated to
  `1.2.0-preview.0-build-53abccf-1789028566578`; Server restarted ready and
  the live Web API reprojected the affected clarification turn as `completed`.
- Full `npm test`: 2113 passed, 20 skipped, 3 failed in the initial run. The
  two retry TUI failures were updated to the approved non-terminal wording and
  pass independently. One independently reproducible, unrelated
  `tests/session/scripted-session.test.ts` uncertified-result expectation
  remains outside this plan.

## Closing Commit

Not committed.
