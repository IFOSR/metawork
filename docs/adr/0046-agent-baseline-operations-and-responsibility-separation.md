# ADR-0046: Agent Baseline Operations And Responsibility Separation

- **Status**: Accepted; implemented locally 2026-10-06, real Docker acceptance open
- **Date**: 2026-10-06
- **Amends**: ADR-0024 Permission Profile defaults, ADR-0028 §§5–6, ADR-0033 bounded settings activation
- **Governed by**: ADR-0020
- **Plan**: [Agent baseline permissions design](../plans/2026-10-06-agent-baseline-permissions-design.md)

## Context

The current Executor editor asks users to choose research or engineering as an
operation scope. Both existing profiles allow workspace writes; public network
rules are only provided by the research profile. Executor creation also derives
business routing hints from that choice. This conflates permissions, available
tools and intended responsibilities, and obscures legitimate combined work such
as public research followed by local analysis or engineering with public docs.
The owner accepted removing this choice and making ordinary operations available
by default, with responsibilities determining work allocation.

## Decision

Ordinary Pi/Codex Executors use a system-owned `standard-agent` profile. It
combines ordinary task file/document/command operations with normalized public
HTTP(S) permission rules. Availability still depends on installed tools, models,
connections, resource ownership and execution backend. User responsibility text
never creates tools, hard capabilities, grants or approval facts.

Remove the ordinary editor's profile selector and editable profile field.
Configuration prepares the profile reference; all edits remain drafts until the
single page-level configuration activation transaction. Remove system-generated
research/engineering specialization derived solely from old profile choice;
preserve user-authored responsibilities and explicit limitations. Existing
routing owners compare duties with actual model/tool evidence; no new semantic
router or keyword-based permission inference is permitted.

Planner remains read-only and proposal-only. Client and Desktop authority does
not expand. Kernel remains the sole grant/deny/escalate owner, Runtime applies
its decisions, and Resource owns pure rules and identity. Sensitive operations
use existing concrete authorization seams. Unsupported effects remain unsupported;
this decision does not introduce a universal privilege or publication adapter.
Native worktree remains a trusted process boundary, without a claim of universal
fine-grained mediation. Docker retains constrained mounts and public egress,
without host escape or general private-network access.

Historical profile identifiers and immutable revisions retain their original
meaning. A new Server release installs the new grammar. Existing ordinary
profiles are migrated only by exact code-owned definition/constraint matching,
including aliases, through the next combined settings activation. Merely opening
settings or upgrading software must not widen active configuration. New installs
seed the baseline directly; restricted/custom profiles keep their restrictions.
Already pinned generations and attempts continue using their original revision.

The hot-update exception covers only the exact installed baseline definition and
bounded eligible reference conversion. It does not make arbitrary profile
grammar or backend/tool changes hot. Revision checks, strict idle admission,
credential staging and activation compensation remain under ADR-0033. There is
no separate permission activation endpoint or offline writer.

## Consequences and validation

Users configure purpose and actual execution tools without classifying ordinary
agents into mutually exclusive research/engineering presets. This removes a
product choice while preserving versioned internal authorization facts.

Delivery requires profile/normalization tests, bounded migration and rollback,
unchanged historical recovery, responsibility-without-authority tests, and
native plus Docker examples combining public research, local analysis and
engineering. UI/Electron acceptance must verify draft-only editing and the sole
activation action. Local implementation now provides these contracts, with
`standard-agent-read-8` preserving the historical standard engineering resource
parameter. Native backend, unit/browser and live Electron acceptance passed;
real Docker execution remains open because this host has no Docker runtime.
The linked plan records exact evidence, limitations and closing-commit status.
