# ADR-0044: Settings Model Catalog, Internal SettingsAssistant and Planner Quality

- **Status:** Accepted
- **Date:** 2026-10-04
- **Scope:** Settings model/provider metadata, AgentClass responsibility, internal SettingsAssistant, and Planner decomposition quality
- **Amends:** ADR-0027, ADR-0028, ADR-0033

## Decision

MetaWork owns the settings workbench as an Application Shell surface. Provider
credentials remain in SecretStore and user configuration revisions contain only
credential references. OpenRouter is a public metadata source; it is never a
request Provider and does not require a user key. Prices are stored as CNY per
million tokens with the fixed conversion rate of 7, while original USD values,
source and fetch time remain auditable. A user price override is retained until
the user explicitly restores automatic pricing.

AgentClass responsibilities are optional routing descriptions. Planner and
Executor cards use the same model policy, edit and hot activation path. Planner
remains fixed-model by schema, but its model is selected in the shared
intelligent-agent section. SettingsAssistant is an internal Application Shell
service using the shared InternalLlmService transport. Its model/provider
configuration is read per request from `internal/llm.json`; SecretStore reads
an independent `internal/llm-credentials.json`, outside account credentials;
it cannot be changed by account revisions or client surfaces. Suggestions are
drafts requiring user confirmation. Responsibility rewrites require a successful
internal LLM response: validate the generated structured content and render it
without appending catalog prose or template duties. Missing credentials,
timeouts, HTTP failures and invalid/truncated responses report a controlled
error and preserve the source text. Deterministic capability compilation and
ordinary configuration editing remain available; they never masquerade as a
successful AI rewrite (2026-10-05 correction).

Planner decomposition guidance is advisory. Complexity warnings are emitted by
the Planner-side quality checker and never bypass Work Graph schema validation,
Kernel authorization, or durable execution rules.

## Migration and compatibility

Existing schema v2 revisions remain readable. The migration helper marks legacy
cost fields as user-supplied pricing and preserves Provider, Model and
AgentClass references. Responsibility is optional, so old revisions need no
synthetic text. A future schema v3 may make these fields explicit without
changing runtime identity or historical revision readability.

## Consequences

Settings can be edited and hot-activated without Planner availability. Public
metadata failures leave the last cache or an explicit incomplete state. The
quality checker can report under-decomposition without creating subtasks or
changing authorization decisions.

The same internal service summarizes selected OpenRouter public model records into
soft `routingNotes` used by the existing routing projections. It never grants
hard capabilities or executes routing decisions. Initial Provider credentials
are copied only with explicit authorization; there is no runtime Provider fallback.
See `docs/current/internal-llm-service.md` for configuration and bootstrap details.

Agent-facing capability explanations are a separate read-only use of the same
internal LLM (2026-10-05). Selected-model public evidence plus tool affordances
are translated into Agent work abilities and boundaries. This presentation does
not copy model catalog descriptions, edit responsibilities, or grant routing
capabilities/permissions. Model selection changes invalidate the explanation;
generation failures are explicit rather than falling back to catalog prose.


## 2026-10-05 correction: activation never invokes a semantic model

Remove ExecutorManualPlanner and its production compileAll activation hook.
It was still using the user-facing Planner to interpret settings duties, in
conflict with this decision. Configuration activation now performs only local
validation, deterministic projection/compilation, artifact/credential checks,
revision persistence and runtime cutover. Neither the Planner nor the internal
LLM generates text on save. Planner process rebinding during hot activation is
lifecycle management, not a semantic turn.

The existing manual analyze/compile API now uses ExecutorManualPreviewService:
it retains the submitted prose as responsibility and sourceText, renders the
revision-scoped manual locally and reports source-preserved. It accepts no new
client semantic assertions. Persisted assertions can be reused only with the
same source; edited source receives no inferred capability grants or receipts.
Preview resolves the requested revision exactly, never silently rebases.
Ordinary activation keeps the existing untrusted-assertion guard, authorized
binding checks, idle gate and compensating rollback unchanged.

AI rewriting, Agent capability explanation and model public-information
summarization remain explicit InternalLlmService operations. Missing or slow
internal LLM configuration can fail those AI actions, but cannot delay normal
settings saves by triggering automatic generation. There is no fallback to
Planner credentials or the Planner model.
