# AnyFusion README Productization Plan

**Status:** Complete

**Plan date:** 2026-07-18

**Completion date:** 2026-07-18

## Objective

Reframe the English and Chinese repository front pages as an enterprise product overview rather than a source-code guide. The README must lead with AnyFusion's durable task control plane, policy-governed orchestration, dependency-aware work graphs, and specialized-agent routing while remaining accurate about the current Developer Preview execution scope.

## Scope

1. Remove repository-tree, source-module, container-development, and detailed development-command sections from both READMEs.
2. Consolidate duplicated introductory and getting-started content.
3. Replace implementation-class architecture with a product-level control-plane diagram.
4. Present durable scheduling, governed planning, typed handoffs, evidence, memory, and delivery as coherent enterprise capabilities.
5. Explain that the architecture is designed for safe multi-agent concurrency while the current preview serializes subtask execution until partition and lease controls are complete.
6. Preserve the approved backing statement, four badges, public AnyFusion command, release status, and links to detailed technical documentation.

## Source material

- `docs/current/technical-overview.md`
- ADR-0011, ADR-0014, ADR-0015, ADR-0018, ADR-0020, and ADR-0021
- `docs/plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md`
- Current codebase architecture graph

## Validation

- English and Chinese section parity.
- Relative Markdown links resolve.
- Public-facing branding remains AnyFusion.
- No source-directory inventory or implementation-class diagram remains in the README.
- Current serial execution limitation is explicit and cannot be mistaken for shipped parallel dispatch.
- `git diff --check` passes.

## Completion record

Delivered:

- Rebuilt both README front pages around AnyFusion's durable task control plane,
  policy-governed planning, dependency-aware work graphs, specialized-agent
  routing, isolated execution, typed handoffs, evidence, memory, and delivery.
- Removed the repository tree, source-module inventory, implementation-class
  architecture, container-development section, detailed slash-command guide,
  technical-debt callout, and development-command table from the product page.
- Replaced the implementation diagram with a product-level control-plane flow.
- Consolidated installation and first-use guidance into one Quick Start.
- Added explicit release and execution-scope disclosure: the current preview
  serializes ready subtasks while safe asynchronous concurrency remains on the
  published partition/lease roadmap.
- Added a focused documentation index for technical and contributor detail.

Validation performed:

- English and Chinese section parity review — passed.
- Relative Markdown target audit — passed.
- Public MetaClaw/source-structure/implementation-class reference audit — passed.
- `npm run lint` — passed.
- `npm run build` — passed and generated the PlanningAgentPlan v4 schema.
- `git diff --check` — passed.

Implementation commits:

- `5b23838` (`docs: productize AnyFusion README`)
- `5cb9e46` (`docs: refine AnyFusion README hero`)
