# Archived Architecture Decision Records

This directory preserves superseded proposals and decisions whose remaining valid content has been absorbed into current ADRs. These files explain historical context only and must not guide new implementation.

Use [the current ADR index](../../adr/README.md) to find implementation authority. In particular:

- ADR-0001 through ADR-0010 describe the removed `ExecutionPolicy`, `CapabilityClass`, Semantic Router and related routing rewrite proposals.
- ADR-0012's durable runtime facts are now governed by ADR-0020, ADR-0021 and ADR-0023.
- ADR-0013's durable vocabulary is governed by ADR-0020/0021/0023; Planner-owned dispatch is superseded.
- ADR-0014's Planner/Kernel/Runtime chain is absorbed by ADR-0015, ADR-0020 and ADR-0022.
- ADR-0016's static catalog rules are incorporated into ADR-0018; its historical graph rules were superseded by ADR-0021 and ADR-0023.
- ADR-0019's v3 graph and migration decisions are historical; current graph, workflow and ownership authority is ADR-0021, ADR-0023 and ADR-0020.

Archived ADR numbers remain stable historical identifiers even though their filesystem location changed.
