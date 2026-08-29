# Multi-Conversation Task Parallelism Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow top-level Tasks from different Conversations in one AccountRuntime to execute concurrently while strictly serializing Tasks within each Conversation and preserving context, recovery and publication isolation.

**Architecture:** Keep one AccountRuntime, KernelWorkflow, ControlKernel and execution control plane. Add durable Conversation slots and schedule entries, an account-scoped pure scheduler, immutable Task/Conversation routing, and owner-scoped projections. Reuse existing attempt, resource, worktree, publication and Gateway seams.

**Tech Stack:** Node 22, TypeScript ESM, SQLite/better-sqlite3, Zod, Vitest, React/Web Settings, native Planner fork, Docker acceptance.

---

## Task 1: Freeze contracts and baseline

**Files:** `docs/adr/0037-multi-conversation-task-parallelism.md`, `CONTEXT.md`, `docs/current/technical-overview.md`, `docs/current/technical-overview.zh-CN.md`, `docs/adr/README.md`, `docs/plans/future-multi-task-scheduling-roadmap.md`

1. Replace current account-wide single-Task statements with ADR-0037's Conversation slot rule and link the active design/implementation plan.
2. Record schema baseline from code (`CURRENT_SCHEMA_VERSION = 34`) and make all migration references explicit.
3. Run `git diff --check` and focused documentation link/grep checks.
4. Commit as `docs: accept multi-conversation task parallelism contract`.

## Task 2: Runtime policy configuration

**Files:** `src/configuration/types.ts`, `src/configuration/schema.ts`, `src/configuration/projections.ts`, `src/configuration/application-config-projection.ts`, `src/configuration/production-runtime-bindings.ts`, `web/src/settings-model.ts`, `web/src/components/SettingsPanel.tsx`, configuration tests.

1. Write failing schema/default/projection tests for all five fields and the cross-field attempt-cap invariant.
2. Add optional revision fields with the ADR defaults, bounds and compatibility projection.
3. Expose effective values and usage guidance through the existing Settings model/API without adding environment-only controls.
4. Verify configuration activation and existing snapshots preserve revision pinning; run focused configuration and Web checks.
5. Commit as `feat: configure multi-conversation scheduling policy`.

## Task 3: Durable Conversation slot and queue

**Files:** `src/storage/migrations.ts`, Task/Conversation repository ports and SQLite adapters, `src/task/`, `src/session/`, storage tests.

1. Write failing migration and repository tests for owner fields, one slot per Conversation, queue bounds and conditional slot claims.
2. Migrate schema 34 to the next version transactionally; reconstruct legacy ownership only when unambiguous and fail closed otherwise.
3. Add owner-scoped Task queries, `conversation_task_slots` and `task_schedule_entries` repositories.
4. Verify queued admission creates no dispatch item and slot release requires the Phase 6 residue fence.
5. Commit as `feat: persist conversation task slots and queue entries`.

## Task 4: Pure scheduler and Kernel contract

**Files:** `src/kernel/`, `src/work-graph/`, Kernel types, `tests/kernel/`, scheduler tests.

1. Write failing deterministic policy tests for two-Conversation overlap, same-Conversation queueing, global/per-Task attempt caps, aging, fairness, resource conflicts and no preemption.
2. Add account scheduling event, scheduler snapshot and grouped dispatch decision types.
3. Implement pure candidate selection with durable sequence/timestamp facts supplied in the snapshot; Kernel reads no clock or repository.
4. Replace scalar `runningTaskId` policy inputs with Conversation-scoped projections while retaining local presentation adapters only where required.
5. Commit as `feat: schedule tasks across conversations in the kernel`.

## Task 5: Immutable AccountRuntime and execution routing

**Files:** `src/account/account-kernel-coordinator.ts`, `src/account/account-runtime.ts`, `src/account/account-startup-recovery-service.ts`, `src/account/account-conversation-execution-binder.ts`, `src/execution/kernel-execution-runtime.ts`, `src/execution/attempt-supervisor.ts`, `src/execution/task-cancellation-coordinator.ts`.

1. Add failing async interleaving tests proving A events cannot apply to B and A-only cancellation cannot affect B.
2. Replace mutable snapshot/runtime callback references with event/decision keyed builders and application bindings.
3. Key supervisor contexts and cleanup by attempt/task identity; support account kick and task-scoped drain.
4. Recover all occupied slots and retain slots through uncertain residue; schedule independent Tasks after isolated recovery blocks.
5. Commit as `feat: route parallel task execution by immutable identity`.

## Task 6: Context, publication and client projections

**Files:** `src/planning/`, `src/work-graph/context-ref-eligibility.ts`, `src/execution/`, `src/gateway/`, `src/session/`, `web/src/`, `src/tui-bridge/`, `src/integrations/`.

1. Add failing tests for cross-Conversation context-reference rejection and bounded Workspace summaries.
2. Make Planner MCP, evidence, permission, trace and result projections owner-scoped.
3. Replace singleton runtime projections with Conversation-local projections plus bounded Account/Workspace summaries.
4. Preserve shared-Workspace publication ordering and conflict repair; verify no last-writer-wins path.
5. Commit as `feat: isolate parallel conversation projections and context`.

## Task 7: Acceptance and closure

**Files:** `tests/integration/`, `tests/acceptance/`, `scripts/`, `docker/`, current docs.

1. Add delayed two-Conversation native/Docker scenarios covering overlap, queueing, isolation, cancellation and restart recovery.
2. Run focused tests after each seam, then `npm run lint`, `npm test` and required Docker SQLite/POSIX tests.
3. Update plan status with delivered behavior, validation and closing commit; update ADR/technical docs only for verified behavior.
4. Commit as `test: verify multi-conversation parallel task lifecycle`.
