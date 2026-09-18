# Attachment Resource Execution Implementation Plan

> **Status:** Completed locally; awaiting explicit Git commit/GitHub confirmation
> **Started:** 2026-09-17
> **Working rule:** No Git commit or GitHub push until explicit user confirmation.
> **Completed:** 2026-09-17

> **For Codex:** REQUIRED SUB-SKILL: Use test-driven-development and execute this plan task-by-task.

**Goal:** Deliver opaque user attachments from Web/Feishu through Planner-selected Work Graph references into authorized attempt-local inputs, with paste support and a default Executor document reader for DOCX, PDF, XLSX, and PPTX.

**Architecture:** Planner receives bounded attachment metadata only and selects `{ kind: 'attachment', attachmentId }`. MetaWork stores original bytes with durable ownership/hash metadata, validates references at admission and attempt time, and materializes selected originals into `inputs/`. A separately bundled Executor CLI owns document parsing; the Server never imports its parser dependency.

**Tech Stack:** Node 22 TypeScript ESM, Vitest, Zod, React/Vite, file sidecar metadata, existing Kernel/Work Graph contracts, bundled `officeparser` Executor CLI.

---

### Task 1: Lock The Architecture Contract

**Files:**
- Modify: `docs/adr/0038-planner-metawork-executor-context-bridge.md`
- Modify: `CONTEXT.md`
- Modify: `docs/current/technical-overview.md`

**Steps:**
1. Amend ADR-0038 with current-Turn attachments, Planner-safe metadata, eligibility checks, and attempt-local materialization.
2. Record that Runtime does not parse attachment contents and that document parsing is Executor-owned.
3. Update current authority docs without claiming implementation completion until validation passes.

### Task 2: Make Attachment Storage General, Bounded, And Durable

**Files:**
- Modify: `tests/storage/file-attachment-store.test.ts`
- Modify: `src/gateway/attachment-store-port.ts`
- Modify: `src/storage/file-attachment-store.ts`
- Modify: `tests/management/server.test.ts`
- Modify: `src/management/server.ts`
- Modify: `web/src/api/session-types.ts`

**Steps:**
1. Write failing tests for DOCX/PDF/XLSX/PPTX and unknown binary upload, ownership metadata, maximum size enforcement, metadata-only lookup, and hash revalidation.
2. Run the focused tests and confirm current 415/type behavior fails them.
3. Replace the image/text kind with normalized `mediaClass`, durable Account/Conversation/Workspace ownership, availability, MIME, size, and SHA-256.
4. Add a bounded streaming upload limit and cleanup on overflow/failure.
5. Make the authenticated upload endpoint derive and verify Conversation/Workspace ownership from client state rather than trusting arbitrary query identities.
6. Re-run focused storage and server tests.

### Task 3: Replace Planner Content Injection With Safe Attachment Views

**Files:**
- Modify: `tests/management/web-gateway-session-runtime.test.ts`
- Modify: `tests/gateway/conversation-gateway-runtime.test.ts`
- Modify: `tests/planning/planning-context-builder.test.ts`
- Modify: `tests/planning/planner-input-profile.test.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/gateway/conversation-gateway-runtime.ts`
- Modify: `src/session/conversation-session.ts`
- Modify: `src/planning/planning-types.ts`
- Modify: `src/planning/planning-context-builder.ts`
- Modify: `src/planning/planner-input-profile.ts`
- Modify: `src/planning/planner-process-supervisor.ts`

**Steps:**
1. Write failing tests proving Planner input contains only attachment ID/name/MIME/size/availability.
2. Write regression tests proving no attachment bytes, excerpts, base64, or private paths enter Planner input.
3. Remove `enrichWithAttachments()` and Planner image resolution.
4. Resolve and validate all message attachment references into `PlannerAttachmentView[]`.
5. Serialize the bounded metadata into the Planner prompt while keeping Pi RPC file/image payloads empty.
6. Re-run the focused Gateway/Planning tests.

### Task 4: Add First-Class Attachment Context References

**Files:**
- Modify: `tests/planning/planning-agent-plan-schema.test.ts`
- Modify: `tests/planning/work-graph-structure-rules.test.ts`
- Modify: `tests/session/assistant-reference-eligibility.test.ts`
- Modify: `tests/kernel/control-kernel.test.ts`
- Modify: `src/work-graph/types.ts`
- Modify: `src/work-graph/validation.ts`
- Modify: `src/planning/planning-agent-plan-schema.ts`
- Modify: `src/work-graph/context-ref-eligibility.ts`
- Modify: `src/kernel/control-kernel.ts`
- Modify: `src/session/conversation-session.ts`
- Modify: `src/session/metaclaw-session.ts`

**Steps:**
1. Write failing schema, duplicate-key, eligibility, and Kernel clarification tests for attachment refs.
2. Add `{ kind: 'attachment'; attachmentId: string }` to the shared union and Zod schema.
3. Carry current-Turn attachment identities on the durable `plan_proposed` event.
4. Admit only refs in the event-bound eligible attachment set; keep replans from inventing new attachment IDs.
5. Add the user-facing Kernel kind label for attachments.
6. Re-run planning, Work Graph, session eligibility, and Kernel tests.

### Task 5: Materialize Attachments Into Executor Inputs

**Files:**
- Modify: `tests/execution/subtask-execution-context.test.ts`
- Modify: `tests/execution/subtask-attempt-runner.test.ts`
- Modify: `tests/executor/prompt-builder-context-layering.test.ts`
- Modify: `src/execution/subtask-execution-context.ts`
- Modify: `src/execution/subtask-attempt-runner.ts`
- Modify: `src/executor/prompt-builder.ts`
- Modify: `src/server/server-composition.ts`

**Steps:**
1. Write failing tests for ownership/status/hash rejection and deterministic materialization.
2. Inject the attachment store into the attempt/context seam.
3. Resolve selected attachments separately from text evidence and historical Artifacts.
4. Revalidate Account/Conversation/Workspace/status/hash before copying.
5. Materialize originals with collision-safe names into `inputs/`, preserving idempotency across retries.
6. Add safe selected-attachment metadata and relative paths to the Executor prompt.
7. Remove the image-only task-resource materialization special case where the unified path supersedes it.
8. Re-run focused execution and prompt tests.

### Task 6: Declare And Deliver Default Document Processing Capability

**Files:**
- Modify: `tests/routing/configuration-catalog.test.ts`
- Modify: `tests/routing/executor-capability-manual.test.ts`
- Modify: `tests/configuration/configuration-compiler.test.ts`
- Modify: `src/routing/types.ts`
- Modify: `src/routing/executor-capability-manual.ts`
- Modify: `src/installation/source-native-installer.ts`
- Modify: `src/configuration/legacy-configuration-reader.ts`
- Modify: `src/configuration/staged-legacy-configuration.ts`
- Modify: `src/configuration/smoke-configuration.ts`

**Steps:**
1. Write failing tests for a `document-processing` routing capability and default Codex qualification.
2. Register the capability with workspace-reconcilable recovery semantics.
3. Add stable labels/semantic patterns/manual projection.
4. Declare the default engineering Executor capable of document processing.
5. Re-run routing and configuration tests.

### Task 7: Build The Executor-Owned Document Reader

> **Reversed on 2026-09-18.** The MetaWork-owned reader CLI was removed by user decision: the routed Executor's base model and its own tools own document parsing. The steps below are the historical plan; see Post-Completion Revision at the end of this document.

**Files:**
- Create: `src/document-reader-cli.ts`
- Create: `src/executor/document-reader.ts`
- Create: `tests/executor/document-reader.test.ts`
- Modify: `tsup.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docker/Dockerfile.attempt-codex`
- Modify: `docker/Dockerfile.attempt-pi`
- Modify: `src/executor/local-cli-executor-adapter.ts`
- Modify: `src/executor/container-compatibility-adapter.ts`
- Modify: `src/executor/prompt-builder.ts`

**Steps:**
1. Add `officeparser` as a build-time dependency and keep all imports confined to the Executor CLI entrypoint.
2. Write failing real-format tests using small deterministic DOCX/PDF/XLSX/PPTX fixtures.
3. Implement a bounded CLI that reads one attempt-local file and emits normalized text or structured failure.
4. Bundle the CLI as a separate executable artifact.
5. Expose its command to native and container attempts through `METAWORK_DOCUMENT_READER`.
6. Copy only the bundled CLI into attempt images.
7. Add an architecture test proving Server/Planning/Storage code does not import the parser.
8. Run document reader, adapter, build, and container contract tests.

### Task 8: Unify Web Click, Drop, And Paste Upload

**Files:**
- Create: `tests/web/composer-attachments.test.ts`
- Modify: `web/src/components/Composer.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/api/session-types.ts`
- Modify: `web/src/styles.css`

**Steps:**
1. Write failing source-contract tests for advisory/no `accept` whitelist and `onPaste` image/file handling.
2. Remove the narrow picker whitelist.
3. Route click, drop, and clipboard files through the same callback.
4. Preserve ordinary text paste.
5. Update attachment media icons, status text, and actionable upload errors.
6. Run Web source-contract tests and the Vite build.

### Task 9: End-To-End Attachment Flow

**Files:**
- Create: `tests/e2e/attachment-planner-executor-flow.test.ts`
- Modify: `tests/e2e/web-image-planner-flow.test.ts`
- Modify: `tests/gateway/feishu-conversation-routing.test.ts`

**Steps:**
1. Write an end-to-end test that uploads a document, gives Planner metadata only, selects its attachment ref, authorizes it, and observes original bytes in attempt `inputs/`.
2. Update Feishu attachment persistence to include the bound Workspace and use the same opaque resource path.
3. Replace the old Planner-image E2E expectation with unified attachment behavior.
4. Run focused E2E and Gateway tests.

### Task 10: Validate And Close Documentation

**Files:**
- Modify: `docs/plans/2026-09-17-attachment-document-ingestion-and-paste-design.md`
- Modify: `docs/plans/2026-09-17-attachment-resource-execution-implementation-plan.md`
- Modify: `docs/README.md`

**Steps:**
1. Run `npm run lint`.
2. Run all focused attachment/planning/kernel/execution/Web tests.
3. Run `npm run build`.
4. Run the full test suite if the host supports SQLite; otherwise run the required Docker test path and record the limitation.
5. Record completion date, delivered behavior, validation evidence, and remaining operational risks.
6. Run `git diff --check` and review the final diff for accidental Runtime parser imports or private-path leakage.

---

## Completion Record

### Delivered

- General bounded attachment storage for images, text, documents, archives, and unknown binary files with Account/Conversation/Workspace ownership, SHA-256, availability, and metadata-only Planner projection.
- Unified Web click, drag/drop, and clipboard file upload path with ordinary text paste preserved.
- Planner-visible current-Turn attachment metadata and explicit `attachment` Work Graph references; Planner receives no attachment bytes, excerpts, hashes, or private paths.
- Kernel admission and attempt-time revalidation followed by idempotent materialization into attempt-local `inputs/`.
- Executor prompt projection with relative input paths and a `document-processing` routing capability.
- Planner skill/system-prompt guidance for opaque current-Turn attachments and exact attachment ContextRefs.

### Validation

- `npm run lint` passed.
- `npm run build` passed, including `build:web`, planner schema generation, and the separate reader bundle.
- `git diff --check` passed.
- Full host suite passed: 407 files, 2222 tests; 8 files and 20 tests skipped.
- Real DOCX/PDF/XLSX/PPTX reader fixtures passed. **Withdrawn on 2026-09-18**: the reader bundle was removed; see the revision record in the design document §15.
- Planner contract, Web image migration, Management upload, Planner MCP metadata, storage, routing, execution-context, and prompt tests passed.
- No document parser is bundled anywhere: `officeparser` was removed from the dependency tree on 2026-09-18, so there is no parser entrypoint to isolate.
### External Validation Limits

- Docker attempt image builds were attempted for both Codex and Pi but could not fetch the Docker Hub base-image token due to network timeout before build execution.
- Live Feishu tenant validation remains outside this local workspace because it requires external credentials and network access.

### Post-Completion Revision

- 2026-09-18: Task 7 (the MetaWork-owned `metawork-document-reader` CLI) was reversed by user decision. The routed Executor's base model and its own tools own document parsing; MetaWork ships no parser. The `document-processing` capability declaration and Task 6 remain. Code, Docker, prompt and documentation changes are listed in `2026-09-17-attachment-document-ingestion-and-paste-design.md` §15.

### Git State

- No Git commit was created.
- No GitHub push was performed.
- Closing commit: pending explicit user confirmation.
