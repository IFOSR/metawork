# Web Interaction Trace And Planner Socket Reliability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent Planner Host socket ownership races and add a streaming, refresh-safe, redacted query-to-delivery execution trace to the Web right pane.

**Architecture:** Keep Planner, Kernel, Runtime, and Executor ownership unchanged. Add defensive socket ownership checks at the Application-Shell adapter, preserve structured Planner transport failures, then build a read-only trace projector over existing durable facts with a bounded live Session event stream for pre-persistence updates.

**Tech Stack:** Node 22, TypeScript ESM, better-sqlite3, Vitest, React 18, Vite 6, native HTTP/WebSocket transport.

> Status: Completed
> Plan date: 2026-08-17
> Completion date: 2026-08-17
> Design: [Web Interaction Trace And Planner Socket Reliability Design](2026-08-17-web-interaction-trace-and-planner-socket-reliability-design.md)

---

## Completion Record

Delivered commits:

- `66561ef` lock scripted composition sessions;
- `139de3a` preserve live Planner Host sockets;
- `a9b6f7f` preserve Planner transport uncertainty;
- `54a8170` stream interaction lifecycle events;
- `038f174` stream Web interaction traces and exact routing;
- `aa1e57b` render the detailed right-pane trace;
- `7e90f26` persist and project safe Executor progress summaries.

Validation completed with 59 focused socket/planning/trace/Web tests, root
TypeScript lint/build, and Web TypeScript/build. The full
`planning-kernel-path` file contains pre-existing environment-sensitive
capacity and long-wait fixtures; the unchanged `a9b6f7f` baseline reproduces
the background-Executor timeout. A full `npm test` run was attempted and
stopped after unrelated existing failures in TUI/session acceptance suites and
multi-minute Git/Executor fixtures; the task-focused suites above remained
green. No new schema table or second policy authority was introduced.

### Task 1: Lock Every Composition Mode

**Files:**
- Modify: `src/index.ts`
- Create: `src/installation/composition-runtime.ts`
- Test: `tests/installation/composition-runtime.test.ts`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`

**Step 1: Write the failing test**

Add a pure `requiresCompositionLock(cliArgs)` seam and assert that TUI, Web,
Gateway, and `--script` require the lock while pure admin/connect/setup commands
do not.

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/installation/composition-runtime.test.ts
```

Expected: FAIL because `requiresCompositionLock` does not exist.

**Step 3: Write minimal implementation**

Move the lock-mode decision out of `main()` and acquire `runtime.lock` for every
path that continues into configuration/database/Planner Host composition,
including `scriptPath`.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run tests/installation/composition-runtime.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/index.ts src/installation/composition-runtime.ts tests/installation/composition-runtime.test.ts docs/current/technical-overview.md docs/current/technical-overview.zh-CN.md
git commit -m "fix: lock scripted composition sessions"
```

### Task 2: Protect Planner Host Socket Ownership

**Files:**
- Modify: `src/tui-bridge/planner-host-bridge.ts`
- Modify: `tests/tui-bridge/planner-host-bridge.test.ts`

**Step 1: Write the failing tests**

Add tests proving:

- a second bridge cannot replace a reachable live bridge;
- a stale socket is still reclaimed;
- stopping one bridge cannot unlink a pathname whose device/inode no longer
  matches the socket it created.

**Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/tui-bridge/planner-host-bridge.test.ts
```

Expected: the live-bridge and ownership tests FAIL because start/stop currently
unlink by pathname only.

**Step 3: Write minimal implementation**

Probe existing sockets with a bounded Planner Host `ping`/connection check.
Fail with an explicit active-socket error when reachable. Record the socket
`dev`/`ino` after listen and compare before unlink during stop.

**Step 4: Run tests to verify they pass**

Run the same focused test command. Expected: PASS.

**Step 5: Commit**

```bash
git add src/tui-bridge/planner-host-bridge.ts tests/tui-bridge/planner-host-bridge.test.ts
git commit -m "fix: preserve live planner host sockets"
```

### Task 3: Preserve Planner Transport Failure Details

**Files:**
- Modify: `src/planning/planner-audit-contract.ts`
- Modify: `src/planning/planner-process-supervisor.ts`
- Modify: `src/planning/anyfusion-planning-agent.ts`
- Modify: `tests/planning/planner-process-supervisor.test.ts`
- Modify: `tests/planning/anyfusion-planning-agent.test.ts`

**Step 1: Write the failing tests**

Simulate a Planner turn that calls `submit_planning_proposal`, receives
`transport_uncertain` with `connect ENOENT`, and ends. Assert that:

- the returned result preserves `turnId`, `submissionId`, and message;
- the partial tool-call trace is retained in Planner audit;
- no generic "without an accepted" error replaces the authoritative result.

**Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/planning/planner-process-supervisor.test.ts tests/planning/anyfusion-planning-agent.test.ts
```

Expected: FAIL because `PlannerRunResult` accepts only `accepted` and failed
runs discard partial traces.

**Step 3: Write minimal implementation**

Allow the runner to return any structured terminal `PlannerProposalResult`.
Track the latest proposal result, and attach partial tool traces to process
errors that genuinely have no structured result. Keep `plan()` fail-closed for
non-accepted validation turns while `submit()` returns the authoritative
structured result.

**Step 4: Run tests to verify they pass**

Run the same focused command. Expected: PASS.

**Step 5: Commit**

```bash
git add src/planning/planner-audit-contract.ts src/planning/planner-process-supervisor.ts src/planning/anyfusion-planning-agent.ts tests/planning/planner-process-supervisor.test.ts tests/planning/anyfusion-planning-agent.test.ts
git commit -m "fix: preserve planner transport uncertainty"
```

### Task 4: Define The Interaction Trace Contract And Live Stream

**Files:**
- Create: `src/management/interaction-trace.ts`
- Create: `src/session/interaction-trace-stream.ts`
- Modify: `src/session/metaclaw-session.ts`
- Test: `tests/session/interaction-trace-stream.test.ts`
- Modify: `tests/session/planning-kernel-path.test.ts`

**Step 1: Write the failing tests**

Assert stable event IDs/sequences, bounded detail redaction, query intake before
Planner start, explicit accepted/rejected/transport terminal events, and
snapshot replay to a late subscriber.

**Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/session/interaction-trace-stream.test.ts tests/session/planning-kernel-path.test.ts
```

Expected: FAIL because the trace contract and stream do not exist.

**Step 3: Write minimal implementation**

Create a bounded per-session current-turn stream owned by the Application
Shell. Emit intake/planning/authorization/delivery boundary events from
`MetaclawSession` without changing Kernel or Runtime policy.

**Step 4: Run tests to verify they pass**

Run the same focused command. Expected: PASS.

**Step 5: Commit**

```bash
git add src/management/interaction-trace.ts src/session/interaction-trace-stream.ts src/session/metaclaw-session.ts tests/session/interaction-trace-stream.test.ts tests/session/planning-kernel-path.test.ts
git commit -m "feat: stream interaction lifecycle events"
```

### Task 5: Project Durable Planner, Routing, And Executor Facts

**Files:**
- Create: `src/management/interaction-trace-projector.ts`
- Modify: `src/storage/planner-run-repo.ts`
- Modify: `src/storage/planner-proposal-repo.ts`
- Modify: `src/storage/work-unit-repo.ts`
- Modify: `src/storage/executor-attempt-runtime-repo.ts`
- Modify: `src/storage/skill-usage-event-repo.ts`
- Modify: `src/storage/kernel-workflow-repo.ts`
- Test: `tests/management/interaction-trace-projector.test.ts`

**Step 1: Write the failing tests**

Build direct-reply and durable-task fixtures and assert the projector emits:

- user query and intent/action summary;
- Planner tools and proposal result;
- Kernel decision;
- exact authorized AgentClass/Harness/Provider/Model and fallback order;
- WorkUnit/attempt/Skill/workspace/verification/publication events;
- deterministic order and secret redaction.

**Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/management/interaction-trace-projector.test.ts
```

Expected: FAIL because the projector and required read methods do not exist.

**Step 3: Write minimal implementation**

Add bounded read methods to the owning repositories and implement a pure
Application-Shell projector. Reuse existing records; do not add a schema table
or infer missing policy.

**Step 4: Run tests to verify they pass**

Run the same focused command. Expected: PASS.

**Step 5: Commit**

```bash
git add src/management/interaction-trace-projector.ts src/storage/planner-run-repo.ts src/storage/planner-proposal-repo.ts src/storage/work-unit-repo.ts src/storage/executor-attempt-runtime-repo.ts src/storage/skill-usage-event-repo.ts src/storage/kernel-workflow-repo.ts tests/management/interaction-trace-projector.test.ts
git commit -m "feat: project durable interaction traces"
```

### Task 6: Persist Safe Executor Progress

**Files:**
- Modify: `src/execution/execution-progress-service.ts`
- Modify: `src/executor/error-utils.ts`
- Modify: `src/storage/work-unit-repo.ts`
- Test: `tests/execution/execution-progress-and-workspace-services.test.ts`

**Step 1: Write the failing tests**

Assert that normalized status/log/Skill progress becomes bounded WorkUnit trace
events, secret-like content is redacted, duplicate/noisy lines are sampled, and
raw output is not persisted.

**Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/execution/execution-progress-and-workspace-services.test.ts
```

Expected: FAIL because non-Skill progress is currently discarded.

**Step 3: Write minimal implementation**

Persist only sanitized trace summaries through existing `work_unit_events`.
Keep verifier evidence behavior unchanged and cap per-event text and per-attempt
event count.

**Step 4: Run tests to verify they pass**

Run the same focused command. Expected: PASS.

**Step 5: Commit**

```bash
git add src/execution/execution-progress-service.ts src/executor/error-utils.ts src/storage/work-unit-repo.ts tests/execution/execution-progress-and-workspace-services.test.ts
git commit -m "feat: persist safe executor progress summaries"
```

### Task 7: Stream Trace Snapshots And Deltas Over WebSocket

**Files:**
- Modify: `src/management/server.ts`
- Modify: `src/index.ts`
- Modify: `tests/management/server.test.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/ws.ts`

**Step 1: Write the failing tests**

Assert that an authenticated connection receives the latest `trace_snapshot`,
live events produce ordered `trace_delta` messages, reconnect replays a full
snapshot, and projection failures produce a trace warning without closing the
session.

**Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/management/server.test.ts
```

Expected: FAIL because ManagementServer only sends output and execution
timeline messages.

**Step 3: Write minimal implementation**

Inject the trace query/stream into ManagementServer, merge live and durable
facts by stable event ID, broadcast deltas, and send snapshots on connection.
Update the browser protocol types and client handlers.

**Step 4: Run tests and Web typecheck**

Run:

```bash
npx vitest run tests/management/server.test.ts
cd web && npx tsc --noEmit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/management/server.ts src/index.ts tests/management/server.test.ts web/src/api/types.ts web/src/api/ws.ts
git commit -m "feat(web): stream interaction traces"
```

### Task 8: Build The Detailed Right-Pane Trace UI

**Files:**
- Modify: `web/src/App.tsx`
- Create: `web/src/components/InteractionTracePanel.tsx`
- Modify: `web/src/components/ChatPane.tsx`
- Delete: `web/src/components/ExecutionTrace.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/web/interaction-trace.test.ts`

**Step 1: Write the failing test**

Use source-level component assertions consistent with existing Web tests to
verify the panel renders all phases, actor/status labels, expandable details,
exact routing binding, active streaming state, and responsive layout.

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/web/interaction-trace.test.ts
```

Expected: FAIL because `InteractionTracePanel` does not exist.

**Step 3: Write minimal implementation**

Replace the right-side timeline with the detailed trace panel, keep the existing
visual language, add intentional active-stage motion and auto-follow, and
remove the duplicate inline chat trace.

**Step 4: Run Web validation**

Run:

```bash
npx vitest run tests/web/interaction-trace.test.ts
cd web && npx tsc --noEmit && npm run build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add web/src/App.tsx web/src/components/InteractionTracePanel.tsx web/src/components/ChatPane.tsx web/src/components/ExecutionTrace.tsx web/src/styles.css tests/web/interaction-trace.test.ts
git commit -m "feat(web): show detailed interaction trace"
```

### Task 9: Integrate, Document, And Close

**Files:**
- Modify: `CONTEXT.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `docs/plans/2026-08-17-web-interaction-trace-and-planner-socket-reliability.md`
- Modify: `docs/plans/2026-08-17-web-interaction-trace-and-planner-socket-reliability-design.md`
- Modify: `docs/README.md`

**Step 1: Run focused suites**

```bash
npx vitest run tests/tui-bridge/planner-host-bridge.test.ts tests/planning/planner-process-supervisor.test.ts tests/planning/anyfusion-planning-agent.test.ts tests/session/interaction-trace-stream.test.ts tests/management/interaction-trace-projector.test.ts tests/management/server.test.ts tests/execution/execution-progress-and-workspace-services.test.ts tests/web/interaction-trace.test.ts
```

Expected: PASS.

**Step 2: Run repository validation**

```bash
npm run lint
npm run build
npm test
cd web && npx tsc --noEmit && npm run build
```

Expected: PASS. If the environment cannot run a suite, record the exact
constraint rather than retrying blindly.

**Step 3: Update documentation**

Record completion date, delivered behavior, validation, residual risks, and
closing commits. Update current architecture docs only for changed runtime and
navigation contracts.

**Step 4: Commit**

```bash
git add CONTEXT.md docs/current/technical-overview.md docs/current/technical-overview.zh-CN.md docs/plans/2026-08-17-web-interaction-trace-and-planner-socket-reliability.md docs/plans/2026-08-17-web-interaction-trace-and-planner-socket-reliability-design.md docs/README.md
git commit -m "docs: close web interaction trace delivery"
```
