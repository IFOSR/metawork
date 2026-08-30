# Planner Direct Web Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use test-driven-development and execute this plan task-by-task.

**Status:** Completed

**Plan date:** 2026-08-30

**Completion date:** 2026-08-30

**Design:** [Planner Direct Web Access Design](2026-08-30-planner-direct-web-access-design.md)

**Goal:** Let the semantic Planner answer real-time public-information questions
directly while routing every request that needs side effects or schedulable work
to the existing Kernel-authorized Executor path.

**Architecture:** Add bounded read-only `web_fetch` and `web_search` custom tools
inside the vendored AnyFusion-Pi Planner bootstrap. Keep action selection in the
Planner semantic policy, proposal validation in MetaWork Planning, authorization
in Kernel, and side effects in Executors.

**Tech Stack:** Node 22.19+, TypeScript ESM, TypeBox, Undici, Vitest.

---

## 1. Tool Surface RED/GREEN

**Files:**

- Modify: `planner/AnyFusion-Pi/packages/coding-agent/test/anyfusion-planner-policy.test.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/test/anyfusion-planner-bootstrap.test.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/test/anyfusion-planner-web-tools.test.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-web-tools.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-policy.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-bootstrap.ts`

1. Add failing tests that require semantic RPC to expose exactly
   `web_fetch`, `web_search`, the proposal tool, and the seven MetaWork MCP
   tools while continuing to exclude repository and mutation tools.
2. Run the focused Pi tests and confirm failure because the Web tools do not
   exist.
3. Add tool tests for bounded public fetch/search behavior and private-target
   rejection using injected fetch and DNS operations.
4. Implement the minimal Web tools and register them as Planner custom tools.
5. Run the focused tests and confirm GREEN.

## 1A. Network Boundary Hardening RED/GREEN

**Files:**

- Modify: `planner/AnyFusion-Pi/packages/coding-agent/test/anyfusion-planner-web-tools.test.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-web-tools.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/test/anyfusion-planner-semantic-session.test.ts`

1. Add failing tests for validated-address pinning, explicit dispatcher use,
   slow DNS, slow response bodies, and public-to-private redirects.
2. Confirm the existing implementation fails because DNS validation is
   detached from the real connection and its timer ends at response headers.
3. Use a per-hop Undici Agent with a lookup function restricted to the
   validated public addresses, bypassing the global proxy dispatcher.
4. Apply one AbortSignal deadline across DNS, connection setup, redirects, and
   bounded body reads; close or destroy every dispatcher on exit.
5. Construct a real semantic AgentSession and assert its final active tool set.
6. Run the focused tests and Planner build and confirm GREEN.

## 2. Routing Contract RED/GREEN

**Files:**

- Modify: `planner/AnyFusion-Pi/packages/coding-agent/test/anyfusion-planner-system-prompt.test.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-system-prompt.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/metaclaw-planner/SKILL.md`

1. Add failing prompt tests for the direct-reply Web rule and the mandatory
   Executor route for shell, file/Git/storage mutation, authenticated external
   actions, unavailable local inspection, durable work, and artifacts.
2. Run the focused prompt tests and confirm RED.
3. Update the fixed Planner instructions without adding keyword routing.
4. Run the focused prompt tests and confirm GREEN.

## 3. Authority And Validation

**Files:**

- Modify: `docs/adr/0015-planner-owned-semantics-and-tool-mediated-context.md`
- Modify: `CONTEXT.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `docs/README.md`

1. Record the read-only Planner Web tools and semantic action boundary.
2. Run the focused Pi policy/bootstrap/tool/prompt tests.
3. Run MetaWork Planner tests, `npm run lint`, and `npm run build`.
4. Run the vendored Planner build.
5. Record completion date, validation evidence, and closing commit after the
   change is committed.

## Completion Record

### Delivered Behavior

- Semantic Planner RPC exposes bounded read-only `web_fetch` and `web_search`
  alongside the proposal and seven authoritative MetaWork MCP tools.
- `direct_reply` is limited to complete current-turn answers from dialogue and
  available read-only tools. Shell, unavailable Workspace inspection,
  file/Git/storage mutation, authenticated actions, side effects, durable
  progress, monitoring, artifacts, and handoffs route through
  `plan_work_graph` to a Kernel-authorized Executor.
- Public Web requests pin validated addresses to the actual per-hop Undici
  connection, bypass the global proxy dispatcher, reject private/special IPv4
  and IPv6 targets, and apply one deadline across DNS through body consumption.

### Validation

- AnyFusion-Pi focused Planner tests: 28 passed.
- AnyFusion-Pi coding-agent build passed.
- MetaWork focused Planning/Kernel tests: 83 passed locally; independent review
  also ran the broader Planning set with 104 passing tests.
- `npm run lint`, `npm run build`, and `git diff --check` passed.
- Real `web_fetch` returned HTTP 200 from the target GitHub repository.
- Real `web_search` followed the public Bing redirect, returned 10 results, and
  included the target GitHub repository.
- Independent re-review reported no blocking correctness or security findings.

### Closing Commit

`baca776` (`feat(planner): add bounded direct web access`).
