# Planner Executor Capability Manual Design

> **Status:** Implemented; routing-authority sections superseded by the
> [Unified Executor Capability Profile Design](2026-08-31-unified-executor-capability-profile-design.md)
> **Design date:** 2026-08-30
> **Implementation date:** 2026-08-31
> **Review owner:** Product / Architecture
> **Scope:** Semantic Planner action boundary, Executor routing guidance, model-derived Executor manuals, and configuration revision behavior
> **Related authority:** ADR-0015, ADR-0018, ADR-0020, ADR-0027, ADR-0028

This document records the first delivery of per-Executor manuals and the
Planner direct-reply boundary. Its statements that the manual is advisory and
that Routing Catalog is an independent eligibility authority are historical.
The 2026-08-31 unified profile design is authoritative for current manual,
capability evidence, disposition, Catalog projection, and model-change
semantics.

## 1. Decision Summary

MetaWork should make two related changes:

1. A semantic Planner turn must not complete a user task through
   `direct_reply`. Any request that expects work, a deliverable, an analysis
   result, a workspace change, a research result, or another durable outcome
   must become a focused `plan_work_graph` and be completed through the
   Kernel-authorized Executor path.
2. Every Executor AgentClass should have its own independent generated
   Markdown capability manual. There is no global Executor manual shared by
   all Executor AgentClasses. Each manual is derived from its own AgentClass
   definition and the exact models currently allowed by its `ModelPolicy`. It
   is projected to the Planner as bounded routing guidance and rendered into
   that Executor's revision-pinned runtime directory. Users can describe
   corrections and organization preferences in natural language. The source
   text is authoritative and directly persistable; a bounded model-assisted
   semantic layer may additionally extract structured assertions that the
   system folds into that Executor's final manual.

The manual is **guidance, not authority**:

```text
Model profile + AgentClass definition
  -> generated Executor capability manual
  -> Planner-safe routing projection
  -> Planner proposes a focused Executor graph
  -> Kernel validates capability coverage and exact bindings
  -> Runtime launches the authorized Executor
```

Provider definitions, Provider discovery, credentials, secret handling, and
Provider health semantics remain unchanged.

## 2. Problem

### 2.1 Planner can currently finish work itself

The active PlanningAgentPlan v8 contract includes `direct_reply`. The Planner
can put a complete answer in `response.directReply`, after which Runtime
delivers that text without starting an Executor.

That is useful for lightweight conversation, but it creates an ambiguous
product boundary:

- the Planner can appear to perform a task without a durable Task;
- the Planner can answer work-like requests without an Executor result;
- Executor selection is skipped for tasks that should benefit from a stronger
  or more specialized model;
- the user cannot consistently tell whether a result came from planning or
  execution.

The desired product boundary is stricter: the Planner plans and routes; the
Executor produces the task result. Slash-prefixed system commands remain
Application-Shell commands and are not semantic Planner work.

### 2.2 Current Executor routing hints are too shallow

`AgentClassDefinition` currently has concise fields such as
`routingCapabilities`, `primaryUseCases`, `avoidUseCases`,
`plannerAffordances`, `skills`, and `mcpServers`. These are useful catalog
facts, but they do not explain a complete routing profile:

- what the Executor is best at;
- which model or model set supplies those strengths;
- which tasks should be split or handed off;
- what the Executor can deliver;
- what it should avoid even if its Harness technically exposes a tool;
- how an `auto` model policy changes the reliable versus model-specific
  strengths.

The Planner currently receives a compact Routing Catalog projection. It needs a
bounded, human-readable capability contract without receiving credentials,
runtime commands, raw logs, or permission internals.

## 3. Product and Architecture Invariants

### 3.1 Planner is a planner, not a task-completion agent

For semantic user input:

| Situation | Planner result |
| --- | --- |
| User requests work, analysis, research, a report, an artifact, monitoring, or a workspace change | `plan_work_graph` with one or more focused Executor subtasks |
| One required user decision is missing | `clarification`; no task is created yet |
| User explicitly controls a known Task in natural language | Existing `task_control` path, subject to the current Kernel contract |
| Permission approval concerns the exact pending request | Existing `authorization_resolution` path |
| No response or state transition is appropriate | `no_action` |
| Slash-prefixed system command | Handled by the command surface outside semantic Planner planning |

`direct_reply` is removed from the semantic Planner production contract. It
must not be used as a fallback when an Executor is unavailable, when a model
cannot be selected, or when the Planner believes it can answer faster.

`clarification` is not a direct answer. It is a bounded planning pause used
only when one missing user decision prevents a safe or unambiguous Executor
plan. Once the user supplies that decision, the next semantic turn must route
the work.

Natural-language Task control remains a separate control-plane concern rather
than Executor work. It does not grant the Planner direct execution authority
and continues to be validated by the existing Task/Kernel contract. If the
product intends to require slash syntax for all Task control, that should be a
separate command-surface decision rather than being hidden in this change.

### 3.2 Executor results are the completion source

For a request that asks for an answer but requires task execution, the Planner
uses a `report` Subtask. The Executor returns the report through the existing
Completion Protocol and delivery path. The Planner may later explain or
summarize that result only when the user asks in a new turn; it does not
complete the original task with a private direct answer.

Examples:

| User request | Required route |
| --- | --- |
| “分析这份代码并给出风险报告” | Executor `report` Subtask |
| “调研当前方案并输出带来源报告” | Research-capable Executor `report` Subtask |
| “修改代码并运行验证” | Workspace-capable Executor `edit` Subtask |
| “把这个目录整理成文档” | Workspace-capable Executor `edit` Subtask |
| “继续执行刚才暂停的 Task” | Existing explicit Task-control path |
| `/task status` | Slash command path, no semantic Planner turn |

### 3.3 Capability manual is advisory

The manual may improve Planner selection but cannot:

- authorize an AgentClass that lacks the required Routing Capability;
- widen a Permission Profile;
- authorize a model outside the AgentClass `ModelPolicy`;
- make an unhealthy, disabled, or unavailable Executor eligible;
- replace Kernel validation, Runtime binding, or Completion Protocol;
- expose Provider credentials, secret references, raw commands, raw logs, or
  private runtime paths.

Planner instructions must explicitly state that the manual is a routing hint
and that the live proposal schema plus authoritative MCP facts remain binding.

## 4. Capability Manual Contract

### 4.1 One independent manual per Executor AgentClass

The primary manual identity is the Executor AgentClass, not the Harness, not
the Provider, and not the Account-wide Executor collection:

```text
Executor AgentClass A
  + Harness behavior
  + fixed Model, or all models allowed by auto ModelPolicy
  + controlled routing capabilities
  + existing use-case and affordance hints
  + user custom guidance
  -> capability manual A

Executor AgentClass B
  + Harness behavior
  + fixed Model, or all models allowed by auto ModelPolicy
  + controlled routing capabilities
  + existing use-case and affordance hints
  + user custom guidance
  -> capability manual B
```

This gives the Planner one routable unit matching the existing
`preferredAgentClassList` and `executorBindings` contract.

Manual A and Manual B are independently generated, edited, fingerprinted,
versioned, projected, and rendered. User guidance attached to Executor A must
never appear in Executor B's manual. A Model change regenerates only the
manuals of the Executor AgentClasses whose effective model set or model facts
changed.

For an `auto` ModelPolicy, the manual describes:

- capabilities reliable across all currently enabled allowed models;
- model-specific strengths that are not guaranteed across the whole set;
- the configured default and fallback order;
- tradeoffs such as quality, cost, latency, context, reasoning, and vision;
- tasks that should prefer a specific model when the Planner is allowed to
  propose one.

The Planner may use model-specific differences as a preference signal, but the
Kernel still resolves the exact authorized model according to the pinned
revision and policy.

### 4.2 Generated Markdown shape

The generated section should use a stable, bounded format similar to a Skill:

```markdown
---
name: metawork-executor-codex-cli
kind: executor-capability-manual
schemaVersion: 1
agentClassRef: codex-cli
configurationRevision: revision-...
sourceFingerprint: sha256:...
---

# Executor: codex-cli

## Mission
Short description of the coherent work this Executor should own.

## Reliable Capabilities
- Workspace engineering
- Workspace command validation
- ...

## Model Profile
| Model | Policy role | Strengths | Tradeoffs |
| --- | --- | --- | --- |
| ... | fixed/default/fallback | ... | ... |

## Best Fit
- ...

## Avoid or Hand Off
- ...

## Delivery
- `edit`: use when the Subtask changes the workspace.
- `report`: use when the Subtask produces a read-only result.

## Routing Notes
- Keep the Subtask focused.
- Do not claim unsupported permissions or external side effects.

```

The exact prose is generated deterministically from structured configuration
facts. The generator must not call a model during configuration activation.
This keeps activation reproducible, offline-compatible, auditable, and safe
from a second hidden routing loop.

### 4.3 System-generated and user-edited content

The user does not fill a fixed capability form or maintain Markdown merge
markers. The user may write natural-language guidance such as:

```text
这个 Executor 更适合大型 TypeScript 重构和测试修复，不适合视觉设计。
其中 gpt-5.6-sol 负责复杂推理和代码修改，k3 更适合长上下文阅读。
对于发布任务，要求最终报告列出影响的 package。
```

The optional semantic analyzer interprets this input against the selected
Executor and the current revision-scoped Model Profiles. It may extract
user-owned capability statements and model contributions, then submit them
through the existing configuration application path. The persisted
configuration retains the original text and, when extraction succeeds, its
normalized semantic representation:

```ts
interface ExecutorManualUserProfile {
  sourceText: string;
  assertions: ExecutorManualAssertion[];
}

interface ExecutorManualAssertion {
  topic: 'mission'
    | 'strength'
    | 'limitation'
    | 'preferred-task'
    | 'avoid-task'
    | 'model-contribution'
    | 'delivery';
  text: string;
  modelRef?: string;
  modelCapability?: ModelCapability;
}
```

The assertion shape is an internal persistence contract, not a user-facing
form. It lets the system preserve flexible natural-language guidance while
giving the generator stable facts to use after a Model change.

The edit flow is:

```text
User natural-language guidance
  -> deterministic source validation
  -> optional model-assisted semantic interpretation
  -> ExecutorManualUserProfile proposal or source-preserved profile
  -> ConfigurationService draft/validate/compile/activate
  -> persisted user source text + normalized assertions
```

Model-assisted interpretation is best effort and never an activation
precondition. The configuration turn receives the selected Executor's current
manual and Model facts directly, exposes only
`submit_executor_manual_proposal`, starts no Planner MCP extension, and uses a
30-second timeout. Timeout, model unavailability, missing tool submission, or
invalid semantic assertions returns a `source-preserved` preview with the
original text and an empty assertion list. Deterministic schema and
sensitive-content validation remain fail-closed.

When a later configuration revision changes the Model set, the configuration
system does not invoke the model again; it regenerates the system profile and
re-applies persisted assertions. If no assertions were extracted, the
authoritative source text remains bounded routing context in the regenerated
manual.

### 4.4 Effective manual merge

For one Executor AgentClass and one configuration revision. The same algorithm
runs independently for every Executor; there is no cross-Executor merge:

```text
S = GenerateSystemProfile(agentClass, currentModels, routingCatalog)
U = persisted ExecutorManualUserProfile.assertions
M = Merge(S, U)
```

The merge is semantic rather than positional:

1. Generate the system profile from the current Executor definition and
   effective Models.
2. When optional semantic extraction succeeds, decompose user text into
   capability assertions resolved to the selected Executor and, when stated
   and known, to a specific Model and Model capability. Otherwise retain the
   original source text without inferred assertions.
3. Match user assertions to generated claims by semantic topic and target:
   mission, strength, limitation, preferred task, avoided task, model
   contribution, or delivery.
4. When a user assertion conflicts with a generated claim for the same topic
   and target, remove or rewrite the generated claim and retain the user's
   statement in the final manual.
5. When no generated claim conflicts, add the user statement to the relevant
   part of the final manual.
6. Render one coherent Skill-style Markdown document. The final document does
   not expose separate “system” and “user” sections and does not contain
   contradictory copies of the same routing guidance.

The precedence rule is:

```text
user semantic assertion for the same topic/target
  > system-generated routing guidance
  > default absence of guidance
```

For example:

```text
System:  best for coding and repository changes
User:    avoid coding; use this Executor for document analysis
Final:   best for document analysis; avoid coding
```

The original user text and normalized assertions remain provenance data for
configuration audit. They are not appended blindly to Planner context.
Changing Models regenerates the system profile and re-applies the persisted
user assertions, so user guidance survives while current Model contributions
are refreshed.

This semantic merge does not change structured execution authority. A user can
override the routing recommendation that appears in the manual, but cannot
create a Routing Capability, Permission Profile, ModelPolicy allowance,
Executor health state, or authorized binding through text. Those facts remain
separate and authoritative for Kernel validation.

User input and normalized assertions must be bounded UTF-8 data and pass the
existing configuration secret/sensitive-content checks. They must not contain
credential material or private runtime data.

## 5. Model-Derived Generation Rules

### 5.1 Source facts

The generator consumes only revision-pinned configuration and controlled
catalog facts:

- AgentClass ID and enabled state;
- Harness display behavior that is safe for Planner projection;
- `routingCapabilities`;
- `plannerAffordances`;
- existing `primaryUseCases` and `avoidUseCases`;
- referenced `skills`, `mcpServers`, and `plugins` as safe identifiers only;
- exact effective model references from `ModelPolicy`;
- each Model Profile's `capabilities`, `reasoning`, context, cost, latency, and
  quality metadata;
- optional model routing notes described in section 5.3.

It must not consume Provider secrets, base URLs, API keys, command lines,
runtime homes, raw probe output, or mutable health state.

### 5.2 Fixed versus auto model policies

For a fixed model:

```text
reliable capabilities = the fixed Model Profile capabilities
model-specific strengths = the fixed model's strengths
policy role = fixed
```

For an auto policy:

```text
reliable capabilities = intersection(all enabled allowed model capabilities)
available strengths = union(all enabled allowed model strengths)
model-specific strengths = strengths annotated with the model that supplies them
policy role = default/fallback according to ModelPolicy
```

The manual must distinguish “every allowed model supports this” from “one
allowed model supports this”. It must never advertise the union as a
guaranteed Executor capability.

Disabled Models and Models whose Provider is disabled are excluded from the
active model table. If no allowed Model remains usable, the manual is still
rendered with an explicit “no currently usable model” diagnostic; it does not
invent a fallback model and does not turn the AgentClass healthy.

### 5.3 Optional model routing notes

The current `ModelProfile` capability enum is intentionally small. To produce
useful human-readable guidance without relying on model-name heuristics, the
Model Profile should gain optional non-secret routing metadata:

```ts
interface ModelRoutingNotes {
  summary?: string;
  strengths?: string[];
  limitations?: string[];
  preferredTaskTypes?: string[];
  avoidTaskTypes?: string[];
}
```

These notes are model facts, not Provider configuration. They are validated,
bounded, included in the generated manual, and exposed to Planner only through
the same safe projection. The existing code-owned
`MODEL_CAPABILITY_CATALOG` remains a source for known structural capabilities;
it is not replaced by arbitrary model-name inference.

If this metadata is omitted, the generator falls back to deterministic
descriptions of the structural capabilities and model quality/cost/latency
tiers. The resulting manual remains valid but less specific.

## 6. Planner Projection

### 6.1 Add manuals to the existing planning context

The manual should be attached to the existing revision-scoped
`PlannerConfigurationView`, alongside `routingCatalog`, rather than exposed
through a new semantic router or an unrestricted file read:

```ts
interface PlannerExecutorCapabilityManual {
  agentClassRef: string;
  configurationRevision: string;
  markdown: string;
  sourceFingerprint: string;
  tags: {
    bestFit: string[];
    avoid: string[];
  };
}

type PlannerConfigurationView = Readonly<{
  // existing fields
  executorCapabilityManuals: PlannerExecutorCapabilityManual[];
}>;
```

`get_planning_context` should return these bounded manuals with the existing
Routing Catalog. The fixed Planner Skill should instruct the Planner to:

- read the manual before selecting an Executor for new work;
- prefer one focused Subtask when one Executor can own the deliverable;
- split only when a capability handoff is actually required;
- use model-specific notes as preference signals, not authorization;
- use live Executor status separately when health or availability matters.

The same final manual also exposes derived read-only `bestFit` and `avoid`
tags for the Settings surface. Tags are generated from the effective
Best Fit/Avoid or Hand Off content after semantic user guidance is merged;
Settings does not allow users to add, remove, or edit them.

The Planner must not inspect generated runtime files or configuration source
files to recover these facts. The MCP projection is the authoritative
Planner-facing context.

### 6.2 Size and redaction limits

Manuals must have bounded per-Executor and total Planner-context sizes. The
projection should truncate only user guidance with an explicit marker, never
truncate the generated capability contract in a way that changes meaning.
Oversized custom guidance should be rejected during configuration validation
instead of silently becoming the Planner's routing source.

Provider refs may remain internal identifiers where the current Planner
projection already permits them. Provider URLs, secrets, environment variable
names, runtime commands, and filesystem paths must not enter the manual.

## 7. Configuration and Revision Semantics

### 7.1 Configuration authority remains unchanged

Users edit Executor custom guidance through the existing
`ConfigurationService` draft/validate/compile/activate flow. Settings,
Gateway administration, or future CLI surfaces must call that facade. They
must not edit files under an immutable generated revision or write SQLite
configuration rows directly.

Provider configuration is not moved, duplicated, or redesigned.

### 7.2 Regeneration triggers

The generated manual is rebuilt whenever a new configuration revision is
compiled and any of the following changes:

- an Executor AgentClass's routing capabilities, affordances, use-case hints,
  skills, MCP/plugin references, enablement, or ModelPolicy;
- a referenced Model Profile's capabilities, reasoning, routing notes,
  context, quality, cost, latency, or enablement;
- a referenced model's Provider enablement changes;
- the manual generator version changes.

A Provider base URL, credential reference, or secret value change does not
change the manual unless it changes the effective Provider/Model availability
projection. Provider secrets never become manual content.

### 7.3 Revision pinning

Generated manuals are revision artifacts:

```text
configuration revision N
  -> generated/executors/codex-cli/CAPABILITY.md
  -> generated/executors/pi-agent/CAPABILITY.md
  -> one PlannerConfigurationView entry per Executor
  -> new Work Graph generations only
```

Existing Tasks, graph generations, retries, fallback attempts, recovery, and
historical Planner turns continue to use the manual and routing facts from
their pinned configuration revision. Activating a new revision does not mutate
an existing manual in place.

The generated artifact should include a source fingerprint derived from the
normalized AgentClass, effective Model Profiles, generator version, and
customization content. This supports diagnostics and proves whether a rendered
manual matches the active revision.

## 8. Implemented Module Changes

### Planning

- Reject semantic production use of `direct_reply` at both session proposal
  ingress paths. Historical schema, ledger, Kernel action, and replay support
  remain intact behind the compatibility boundary.
- Update the fixed Planner Skill and AnyFusion Planner system prompt to route
  semantic work through Executor Work Graphs and to read per-Executor manuals.
- Add bounded manual records to `PlannerConfigurationView` and
  `get_planning_context`.
- Keep `clarification`, explicit control, authorization resolution, and
  `no_action` semantics separate from Executor work.

### Routing Catalog

- Add a pure capability-manual generator with fixed-model attribution, Auto
  common/model-specific capability rendering, deterministic source fingerprints,
  and semantic user-assertion precedence.
- Generate a separate manual for every Executor AgentClass; no shared manual
  is created.
- Keep controlled Routing Capabilities and manual prose as separate fields.

### Configuration

- Add bounded natural-language user guidance to Executor AgentClass
  configuration and persist its authoritative source text plus optional
  model-normalized semantic assertions.
- Add a ConfigurationService draft seam for applying a model-normalized
  `ExecutorManualUserProfile`; validate model references and reject
  credential-like content before compilation.
- Add optional Model routing notes.
- Generate each Executor's system baseline and deterministically merge that
  Executor's user assertions as part of revision compilation and Planner
  projection.
- Preserve Provider schema and secret flow unchanged.

### Runtime rendering

- Render one `CAPABILITY.md` under each revision-pinned Executor runtime
  directory through both the active runtime renderer and native compiler.
- Include the manual in the Planner-safe projection artifact.
- Do not copy the manual into a private runtime home as an authority for
  permissions or execution.

### Application Shell and Settings

- Add a user-facing per-Executor natural-language guidance editor.
- Save the original guidance through the existing configuration activation
  flow without requiring semantic normalization. The frontend does not parse
  keywords. `ConfigurationService.applyExecutorManualProposal` is the
  authoritative application seam for optional normalized assertions.
- Add a separate configuration-purpose Planner turn and
  `submit_executor_manual_proposal` tool. The turn writes only to an ephemeral
  draft, returns the normalized assertions and merged manual preview, and is
  discarded until the user confirms activation. It receives direct manual and
  Model context, starts no MCP extension, and degrades to a source-preserved
  preview on semantic failure.
- Add Web `GET /api/config/executors/:ref/capability-manual` and
  `POST /api/config/executors/:ref/capability-manual/analyze` endpoints. The
  Settings surface marks raw text edits stale, allows direct activation, and
  offers optional intelligent extraction plus a final merged Markdown preview.
- Return derived read-only `bestFit` and `avoid` tags with each manual for
  Settings; these tags are never edited independently.
- Explain that user guidance wins over generated routing prose but does not
  grant structured capabilities or execution permissions.
- Keep optional per-Model routing notes as system/model facts rather than a
  separate Settings section; discovered or persisted model facts contribute to
  each affected Executor's generated manual, while user corrections are
  expressed through that Executor's natural-language guidance.
- Keep slash command responses on the existing command path.

### Kernel and Execution

- No new semantic router.
- No new Kernel decision type solely for manuals.
- No Runtime fallback based on manual prose.
- Existing Work Graph capability validation and authorized binding validation
  remain unchanged; direct-reply completion remains readable for legacy
  records but is rejected at production semantic ingress.

## 9. Migration and Compatibility

### 9.1 Existing AgentClass configuration

Existing `primaryUseCases` and `avoidUseCases` remain readable and are used as
seed inputs to the generated manual. Existing routing behavior is not
silently reinterpreted. User natural-language guidance is interpreted by the
Planner semantic layer and merged into the corresponding generated claims;
conflicting generated prose is replaced by the user's statement.

The implementation should avoid a dual prompt representation: the Planner
should receive the manual as the richer explanation and the existing catalog
fields as structured validation facts, not two independently worded copies of
the same policy.

### 9.2 Existing direct replies

Historical `direct_reply` Planner proposals and ledger records remain readable
for audit and replay. New semantic proposals must not produce
`direct_reply`.

The migration must not rewrite immutable historical decisions or fabricate
Executor Tasks for old direct replies. Existing slash command behavior is
unchanged.

### 9.3 Configuration schema version

Recommended approach: add the new optional Model routing notes and Executor
customization fields as a backward-compatible configuration schema revision,
then use the existing configuration validation and activation flow to emit
the first revision containing generated manuals.

If the repository's configuration policy requires a schema-version increment
for all new fields, bump the configuration schema explicitly and add a
transactional migration before activation. Do not add a permissive reader
that accepts multiple unvalidated manual shapes.

## 10. Validation And Implementation Record

The implementation plan should follow TDD and cover these seams before broad
integration tests:

1. Planner rejects or cannot produce new semantic `direct_reply` proposals;
   slash commands still return through the command path.
2. Work-like natural-language requests produce focused `plan_work_graph`
   proposals with Executor bindings and never claim completion in Planner
   text.
3. A fixed Model produces a deterministic manual containing its structural and
   optional routing strengths.
4. An auto ModelPolicy manual distinguishes common capabilities from
   model-specific capabilities and preserves default/fallback order.
5. Changing the allowed Model set changes the generated source fingerprint and
   manual content in the next revision.
6. User guidance survives model changes while generated content is replaced.
7. Oversized or sensitive user guidance is rejected.
8. The configuration seam accepts model-assisted semantic decomposition as
   normalized assertions tied to the intended Executor and optional Model, and
   returns a source-preserved result when the model path is unavailable.
9. A user assertion replaces contradictory generated guidance for the same
   topic and target, while unrelated generated guidance remains.
10. Planner context includes only bounded safe manuals and no Provider secrets,
   commands, runtime paths, or raw diagnostics.
11. Revision-pinned Planner views and generated artifacts do not change when a
   later configuration revision is activated.
12. Existing Kernel capability validation, exact model-policy validation,
    health filtering, attempt binding, slash commands, and historical replay
    remain green.

Implemented validation gates:

- `npm test -- --run tests/routing/executor-capability-manual.test.ts tests/configuration/projections.test.ts tests/configuration/configuration-compiler.test.ts tests/configuration/agent-runtime-renderer.test.ts tests/configuration/configuration-service.test.ts tests/planning/planner-mcp-server.test.ts`
- `npm test -- --run tests/session/planning-kernel-path.test.ts`
- `npm run lint`
- `npm run build`
- `npm run build:web`
- `npm run build --prefix planner/AnyFusion-Pi/packages/coding-agent`
- Current focused regression set: 5 files, 91 tests passed, including the
  Planner configuration turn, per-Executor manual projection, Settings
  semantics, and configuration Schema boundary checks.
- `tests/gateway/conversation-gateway-runtime.test.ts`: 28 tests passed when
  rerun independently.

One long host-suite run was started before the final Schema boundary change
and completed with 371 test files passed, 8 skipped, and 3 failures. Two
failures were the newly added Schema tests loaded by that already-running
process; the Gateway origin-delivery failure passed when its file was rerun
independently. The repository's Docker SQLite/POSIX validation remains an
environment-dependent follow-up when the Docker test image is available.

## 11. Risks and Tradeoffs

### Risk: report-only tasks increase latency and cost

Routing every work-like request through an Executor adds a durable Task,
attempt, and completion cycle. This is the intentional product tradeoff:
task completion becomes auditable, model-specialized, and consistent. The
Planner may still ask clarification before creating work.

### Risk: generated prose overstates model ability

Structural capability facts and manual prose can diverge. Mitigations are:
common-versus-model-specific generation, explicit advisory wording, bounded
model routing notes, and unchanged Kernel/Permission/Completion validation.

### Risk: user guidance misleads Planner

User edits are useful for organization-specific routing knowledge but are not
trusted authorization. User overrides are authoritative over generated manual
prose for routing preference, while the separate structured Routing Catalog,
ModelPolicy, live health facts, Permission Profile, and Kernel validation
remain authoritative for actual eligibility and execution. The Planner Skill
must state both precedence layers explicitly.

### Risk: too many manuals increase Planner context

Manuals must be bounded, sorted deterministically, and loaded only through
`get_planning_context`. The implementation should prefer concise structured
tables over long narrative prose and reject oversized custom sections.

### Tradeoff: generated baseline versus semantic user guidance

Generated-only content is reproducible but not organization-specific.
Appending raw user text preserves local knowledge but leaves contradictions in
the Planner context. A rigid section form is predictable but burdens users.
The proposed semantic interpretation model lets users write naturally, merges
their intent into one coherent final manual, and retains an auditable
system/user provenance split.

## 12. Review Questions

Before implementation, confirm these product decisions:

1. Should semantic `task_control` remain available in natural language, or
   should all Task control require slash commands?
2. Is `clarification` acceptable as the only non-Executor semantic response,
   or should every semantic turn create a Task even when one user decision is
   missing?
3. Should user edits be entered as natural-language guidance, with an optional
   advanced Markdown view for the final generated manual? The recommended
   answer is natural-language guidance plus a read-only merged Markdown
   preview.
4. Should model routing notes be operator-authored configuration fields, or
   should the first version rely only on the existing structural capability
   enum and tier metadata?
5. What maximum size should apply per custom manual and to the aggregate
   Planner projection?
6. Should report-only Executor Tasks be visible and durable in exactly the
   same way as workspace-editing Tasks? The recommended answer is yes.

## 13. Implementation Notes

The implementation preserves schema version 2 because all new fields are
optional and are validated by the existing configuration schema. Provider
configuration and secret handling were not moved or duplicated.

The Settings flow treats intelligent extraction as optional. Changing
natural-language Executor guidance marks the preview stale but does not block
activation; saving without a current semantic preview persists the source text
with empty assertions. Changing model pool/capability/routing facts marks an
existing Markdown preview as system-stale and lets activation regenerate it
without forcing the user to repeat the same guidance. Configuration Schema
validation still rejects Planner-owned manuals, out-of-policy model references,
unsupported model capability attribution, and credential-like manual text.
Model capability facts are no longer exposed as a separate Settings section;
they remain system/model inputs and are presented through each Executor's
generated capability manual and routing explanation.
Settings also exposes `更新能力说明书`, which deterministically previews the
manual from the current unsaved Executor/model draft without probing,
activating, or persisting it. Deselecting a model and using this action removes
that model's generated contributions and derived read-only tags immediately.
Generated headings, known capability labels, delivery descriptions, tags, and
known use cases are rendered in Chinese; user guidance is semantically folded
into the same Chinese-oriented manual rather than appended as a separate raw
section.

`gpt-image-2` contributes structural `image-generation`, `image-editing`, and
`vision` Model capabilities. The first two derive controlled Executor Routing
Capabilities and mandatory model requirements. For Auto policy, the default
model is only a preference: Planner validation permits Kernel resolution across
the allowed pool, while an explicitly proposed or fixed ordinary model remains
invalid for image work. Kernel filters ordinary models and binds the
image-capable model before execution.

The configuration-purpose model turn is intentionally isolated from ordinary
planning: it receives direct revision-scoped context, exposes only
`submit_executor_manual_proposal`, does not load the Planner MCP extension, uses
low reasoning with a 30-second timeout, and returns HTTP 200 with
`analysisMode: source-preserved` when semantic enhancement is unavailable.
Candidate draft facts may carry a temporary revision, but the Planner process
continues to use the active revision's authorized model binding, credentials,
and runtime home. The draft revision is prompt context only and is never
materialized as an executable Planner binding.
Settings preserves existing normalized assertions when the source text is
unchanged, even if manual preview loading fails. It clears assertions only
when the user changes the source text without a matching new semantic preview.

Server startup re-renders the active revision's revision-scoped runtime
artifacts, including one `CAPABILITY.md` for every Executor AgentClass. This
backfills manuals for revisions created before the feature was introduced.

Post-fix validation on 2026-08-31:

- Capability-manual, routing, configuration, management, Settings, Planner
  validation, Kernel, and session focused suite: 202 tests passed across 15
  files.
- Final regressions after live verification: 51 tests passed across
  `planner-process-supervisor`, `executor-manual-planner`, and
  `executor-capability-manual`. The configuration-turn regression proves that
  draft facts use the active authorized Planner binding, while kernel turns
  still reject revision mismatch.
- Focused AnyFusion-Pi tests: 15 passed across bootstrap, semantic session, and
  system prompt behavior.
- Full MetaWork suite: 372 files and 1,849 tests passed with 20 skipped. Its
  only failure was the intentionally changed PlanningAgentPlan v8 schema digest
  after adding the two controlled image Routing Capabilities; the manifest was
  updated and the Task 8 cross-repository acceptance test then passed
  independently.
- `npm run lint`, MetaWork/Web production builds, and the
  `planner/AnyFusion-Pi` offline build passed after the final fixes.
- Native release `1.2.0-preview.0-build-208657c-1788178933640` is active. An
  old active revision storing `gpt-image-2` as `['vision']` generated Chinese
  manuals with image generation/editing capability attribution.
- The real unsaved-draft preview endpoint returned HTTP 200 and removed image
  descriptions and tags immediately after `gpt-image-2` was deselected,
  without activation.
- The real analyze endpoint returned HTTP 200 with
  `analysisMode: semantic` in 20.65 seconds, no warning, and three Chinese
  assertions covering preferred work, model contribution, and image-task
  preference. No Planner MCP query was needed.

No closing commit was created; changes remain in the working tree for review.
