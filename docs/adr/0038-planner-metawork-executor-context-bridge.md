# ADR-0038: Planner, MetaWork And Executor Context Bridge

- **Status:** Accepted
- **Date:** 2026-09-02
- **Scope:** Conversation continuity, Planner MCP facts, historical Artifact references, Kernel eligibility, Runtime materialization and image Executor inputs
- **Amends:** ADR-0015, ADR-0021, ADR-0023, ADR-0032, ADR-0033, ADR-0035, ADR-0037
- **Preserves:** ADR-0020, ADR-0022, ADR-0024, ADR-0031, ADR-0034, ADR-0036
- **Related design:** `docs/plans/2026-09-02-planner-metawork-executor-context-bridge-design.md`
- **Governed by:** ADR-0020

## Context

Users continue work through natural language: “edit this image”, “use the
report just produced” or “turn that result into a summary”. The Planner
already has the strongest semantic continuity mechanism through its persisted
Pi session, but historical Executor results previously had no formal,
authorized input reference for a new Task. `task_resource` also conflated
current-turn resources with historical published files.

Adding a second semantic router or making Runtime guess a file by name would
duplicate Planner responsibility and could select the wrong object. The system
needs one contract that preserves semantic ownership while making the selected
historical object verifiable and executable.

## Decision

MetaWork adopts one directional context chain:

```text
Planner understands and selects
MetaWork provides facts and verifies
Executor executes
```

The persisted Pi session is the semantic continuity owner. MetaWork reuses the
existing `get_current_session_context` Planner MCP query as a bounded,
read-only Context Bridge. The Bridge projects current-Conversation
interactions, Tasks, Executor results and Artifact metadata. It does not rank
objects, resolve “this” or “that”, perform keyword/vector search, or replace
Planner reasoning.

The Work Graph `ContextRef` union includes:

```ts
{ kind: 'artifact'; artifactId: string }
```

This reference means a published historical image, document, HTML, TXT, code
or other file selected by Planner. `task_resource` remains limited to current
Task resources. A user does not need to provide a turn number, Artifact ID or
private path.

Before admission, MetaWork builds the eligible reference set and deterministically
checks:

- Artifact existence and account ownership.
- Source Task Conversation and Workspace ownership.
- Published/available status.
- Absolute private source path, regular-file and non-symlink safety.
- Non-empty content hash and current source hash equality.

The Kernel accepts only references in that verified set. Runtime repeats the
source identity and hash checks before copying the selected file into the
attempt-local `inputs/` directory. It exposes only a safe relative input name
and metadata to the Executor. Image adapters read that directory for editing;
they never read Artifact Store paths or Conversation history. Current Task
image resources and historical Artifact inputs share the same stable input
naming scheme.

Artifact publication remains the only source of historical Artifact records.
Only a completed, hash-verified publication inserts a `published` record.
Unavailable or superseded records remain visible as bounded facts but cannot
be admitted. Re-publication verifies existing content and can reactivate the
same durable Artifact identity. Schema v37 updates the `task_artifacts`
constraint to allow `image` preview kinds and migrates v36 databases by table
rebuild without changing Artifact identity.

## Consequences

- Planner semantic understanding remains single-owner and no second LLM router is introduced.
- Context Bridge failures, missing objects, cross-Conversation references, source disappearance and hash changes fail closed.
- Historical image editing works without re-uploading the image or exposing internal paths.
- Executor prompts contain only selected materialized input metadata, not Artifact Store paths or full Conversation transcripts.
- Context Bridge source verification performs bounded file reads on selected published records; it does not turn MetaWork into a semantic retrieval layer.
- Existing Web preview/download projections remain unchanged and do not become an authorization shortcut.

## Validation

Focused tests cover:

- Planning schema and Work Graph `artifact` references.
- Same-Conversation versus cross-Conversation and account eligibility.
- Unavailable and hash-mismatched Artifact behavior.
- Planner Context Bridge facts and private-path redaction.
- Historical Artifact materialization, idempotent copying and mixed image inputs.
- Image input loading and API Runner behavior.
- SQLite v36→v37 migration and fresh schema constraints.
- End-to-end bridge from Planner-selected reference through Runtime materialization.
