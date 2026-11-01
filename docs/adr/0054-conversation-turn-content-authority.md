# ADR-0054: Conversation Turn Content Authority

- Status: Accepted — implementation authorized by the user on 2026-11-01.
- Date: 2026-11-01
- Design: [Conversation Turn single source](../plans/2026-11-01-conversation-turn-single-source-design.md)
- Amends: ADR-0031, ADR-0043 and ADR-0049 for conversation content only.

## Decision

The Application Shell owns the `ConversationTurnStore` port; Storage implements
it in the account SQLite database. Immutable UTF-8 bodies, Turn identities and
answer revisions are one transactional authority. Gateway persists the input
before invoking Planner, and final replies use the same store. A transactional
outbox bridges SQLite to the existing idempotent event journal. Projectors cannot
write Turn content. Task/Attempt lifecycle remains with its existing owners.

History and presentation rows retain metadata and references. The user input is
the original accepted text, not Kernel requestText or a derived Task prompt.
Planner JSONL remains a non-authoritative runtime transcript. Derived execution
instructions must retain Turn provenance. Memory reads full authoritative bodies
and sanitizes only at its external boundary; missing content never falls back to
a preview. Memory delivery is idempotent and must not truncate long messages.

Archive retains content. Deletion fences new writes and deposition, cleans local
copies, and remains pending until external L0 cleanup is acknowledged. Migration
classifies conflicts without guessing original text or changing Task facts.

## Implementation boundaries

Gateway, Session and Memory consume ports, not SQLite repositories. Composition
roots wire adapters. Read-model rebuild/GC may never remove authoritative bodies.
SQLite history is metadata during cutover; legacy unresolved content is retained
as migration evidence, never promoted on the strength of a preview alone.


## 2026-11-02 implementation

Schema 64 implements the Store and version receipts; projector version 2 orders
Turns by Store sequence. Proven legacy copies retain a seven-day rollback window
from cutover, followed by hash verification and retirement. Unresolved provenance
never becomes authoritative or enters L0. Deletion closes idle Planner sessions,
erases quarantine copies and fences erased workflow records from recovery.
Implementation-specific acceptance and outstanding repository-wide regression
failures are recorded in the design document, not treated as passing checks.
