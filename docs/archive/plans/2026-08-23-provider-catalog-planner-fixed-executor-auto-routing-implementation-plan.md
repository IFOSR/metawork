# Provider Catalog And Planner/Executor Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将桌面配置工作台收敛为 Provider 模型目录、Planner 固定模型选择和 Codex/Pi Fixed/Auto 路由，并在空闲状态下支持 Provider/Model 删除联动。

**Architecture:** 保留现有 immutable configuration revision、AccountRuntime activation gate、Planner/Kernel/Runtime ownership 和 AutoModelResolver。用户配置只维护 Provider catalog 与 AgentClass model policy；内部 ModelProfile 继续作为编译后的运行时投影，但不再暴露独立 Model Facts UI。Planner 永远使用 fixed policy，Codex/Pi 在用户允许的候选集合内使用 fixed 或 auto。

**Tech Stack:** Node 22.19+, TypeScript ESM, SQLite/better-sqlite3, Vitest, React/TypeScript, Vite, Headless Chrome CDP.

**Status:** Implemented

**Plan date:** 2026-08-23

**Completion date:** 2026-08-23

---

## Scope Guard

本计划不包含：

- 新增 Executor。
- 删除 Executor。
- 自定义 Harness/Driver/Executor command。
- Executor connectivity probe。
- Executor 热插拔或 Skill-style package lifecycle。
- 移动端配置。
- 用户编辑 Model Facts、模型成本、质量、延迟、context 等 metadata。

历史 revision、运行中的 generation/attempt 和 concrete binding 必须继续保持不变。

## Task 1: Lock The Configuration Contract With Failing Tests

**Files:**

- Modify: `src/configuration/types.ts`
- Modify: `src/configuration/schema.ts`
- Modify: `tests/configuration/schema.test.ts`
- Modify: `tests/configuration/staged-legacy-configuration.test.ts`
- Create or modify: `tests/configuration/provider-catalog-routing-contract.test.ts`

**Step 1: Write the failing tests**

Cover:

- `planner.modelPolicy.mode === 'auto'` is rejected.
- Planner fixed model must reference an enabled Provider catalog model.
- Codex/Pi Auto policies require a non-empty `allowedModelRefs`.
- Auto `defaultModelRef` must be one of `allowedModelRefs`.
- Fixed/Auto references to deleted models are invalid at activation validation time.
- Provider catalog projections deduplicate the same Provider/model identity without
  rejecting existing internal model refs that share it.

**Step 2: Run the focused tests**

Run:

```bash
npm test -- tests/configuration/schema.test.ts tests/configuration/provider-catalog-routing-contract.test.ts
```

Expected: FAIL because the current schema still permits the old Planner/Model policy shape.

**Step 3: Implement the minimum contract changes**

- Make Planner policy validation fixed-only.
- Keep Executor policy as fixed/auto.
- Add or formalize Provider catalog model identity validation.
- Keep legacy persisted configuration migration-compatible without adding a second runtime path.

**Step 4: Run the focused tests again**

Expected: PASS.

**Step 5: Commit**

```bash
git add src/configuration/types.ts src/configuration/schema.ts tests/configuration/schema.test.ts tests/configuration/staged-legacy-configuration.test.ts tests/configuration/provider-catalog-routing-contract.test.ts
git commit -m "feat: constrain planner and provider catalog routing policies"
```

## Task 2: Make Provider Catalog The User-Facing Model Source

**Files:**

- Modify: `web/src/settings-model.ts`
- Modify: `web/src/components/SettingsPanel.tsx`
- Modify: `web/src/api/types.ts`
- Modify: `tests/web/settings-workbench.test.ts`

**Step 1: Write the failing model semantics tests**

Cover:

- Provider catalog entries produce the global candidate set.
- Adding a Provider model does not automatically bind Planner/Codex/Pi.
- Removing a Provider model removes it from candidate projections.
- Provider/model identity replacement clears stale model metadata in the internal draft.
- Planner draft only accepts one fixed model reference.

**Step 2: Run the focused tests**

```bash
npm test -- tests/web/settings-workbench.test.ts
```

Expected: FAIL for the new Provider-first semantics.

**Step 3: Implement the draft model**

- Keep Provider catalog and internal model projection separate.
- Remove user-facing Model Facts fields from the settings draft.
- Add pure helpers for:
  - global candidate collection,
  - Provider model removal,
  - dangling Fixed reference detection,
  - Auto candidate cleanup,
  - Planner fixed selection.
- Preserve enabled, reasoning and other existing fields when an unchanged model identity is activated.

**Step 4: Run the focused tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add web/src/settings-model.ts web/src/components/SettingsPanel.tsx web/src/api/types.ts tests/web/settings-workbench.test.ts
git commit -m "refactor: make provider catalog the model candidate source"
```

## Task 3: Update Provider UI And Delete Cascade

**Files:**

- Modify: `web/src/components/SettingsPanel.tsx`
- Modify: `web/src/styles.css`
- Modify: `tests/web/settings-workbench.test.ts`

**Step 1: Write failing UI behavior tests**

Cover:

- Provider cards show model directory and `加入模型`.
- Provider cards expose `删除 Provider`.
- Removing a Provider removes its models from the draft catalog.
- Removing a Provider removes those refs from every Executor Auto pool.
- Removing a Fixed model does not select a replacement.
- A Fixed AgentClass with a deleted model displays “没有可用模型”.
- The activation button remains disabled while the draft is invalid.

**Step 2: Run focused tests**

```bash
npm test -- tests/web/settings-workbench.test.ts
```

Expected: FAIL.

**Step 3: Implement Provider draft operations**

- Add `removeProvider(providerRef)`.
- Add `removeProviderModel(providerRef, modelId/modelRef)`.
- Cascade only through the local draft:
  - remove Provider,
  - remove associated internal models,
  - remove Auto refs,
  - clear invalid Fixed refs without replacement.
- Keep the Provider delete button disabled when runtime status is not activation-safe.
- Keep all durable mutation behind `POST /api/config/activate`.

**Step 4: Implement validation feedback**

- Distinguish `runtime_busy` from `invalid_configuration`.
- Render the affected AgentClass and the required repair action.
- Do not display modelRef or internal revision identifiers in the normal UI.

**Step 5: Run focused tests**

Expected: PASS.

**Step 6: Commit**

```bash
git add web/src/components/SettingsPanel.tsx web/src/styles.css tests/web/settings-workbench.test.ts
git commit -m "feat: cascade provider model removal through routing drafts"
```

## Task 4: Make Planner Fixed-Only In The UI And Activation Payload

**Files:**

- Modify: `web/src/components/AgentClassConfig.tsx`
- Modify: `web/src/components/SettingsPanel.tsx`
- Modify: `web/src/settings-model.ts`
- Modify: `tests/web/settings-workbench.test.ts`

**Step 1: Write failing Planner tests**

Cover:

- Planner card has no Auto select.
- Planner card exposes one manual model select.
- Planner activation payload always serializes fixed policy.
- Planner never receives Auto allowed-model fields.
- Deleted Planner model produces a blocking validation message.

**Step 2: Run the focused tests**

```bash
npm test -- tests/web/settings-workbench.test.ts
```

Expected: FAIL.

**Step 3: Implement Planner-specific rendering and serialization**

- Add a Planner branch in `AgentClassConfig`.
- Render only a fixed model select.
- Normalize legacy Planner auto drafts to a deterministic fixed selection only when a valid model exists; otherwise leave the draft invalid and require user selection.
- Serialize Planner as `{ mode: 'fixed', modelRef }`.

**Step 4: Run focused tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add web/src/components/AgentClassConfig.tsx web/src/components/SettingsPanel.tsx web/src/settings-model.ts tests/web/settings-workbench.test.ts
git commit -m "feat: make planner routing explicitly fixed"
```

## Task 5: Implement Codex/Pi Candidate Projection Rules

**Files:**

- Modify: `web/src/settings-model.ts`
- Modify: `web/src/components/AgentClassConfig.tsx`
- Modify: `src/routing/auto-model-resolver.ts`
- Modify: `src/kernel/control-kernel.ts`
- Modify: `tests/routing/auto-model-resolver.test.ts`
- Modify: `tests/kernel/control-kernel.test.ts`
- Create or modify: `tests/routing/configuration-candidate-projection.test.ts`

**Step 1: Write failing routing tests**

Cover:

- Codex candidate projection includes GPT-related models from multiple Providers.
- Codex does not require the Provider ref to be `code-cli`.
- Pi candidate projection includes all enabled Provider catalog models.
- Auto resolution is restricted to the user-selected allowed refs.
- Fixed resolution is never overridden by Auto.
- Unsupported/deleted candidates produce an explicit rejection reason.

**Step 2: Run focused tests**

```bash
npm test -- tests/routing/auto-model-resolver.test.ts tests/routing/configuration-candidate-projection.test.ts tests/kernel/control-kernel.test.ts
```

Expected: FAIL for cross-Provider Codex projection and Planner fixed-only assumptions.

**Step 3: Implement pure candidate projection**

- Add a system-owned candidate classifier for Codex GPT-family models.
- Keep the classifier independent of Provider naming.
- Keep Pi’s default projection as all enabled candidates.
- Use the same projection rules in Web explanation and Kernel authorization.
- Do not create a second semantic router in Web.

**Step 4: Run focused tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add web/src/settings-model.ts web/src/components/AgentClassConfig.tsx src/routing/auto-model-resolver.ts src/kernel/control-kernel.ts tests/routing/auto-model-resolver.test.ts tests/routing/configuration-candidate-projection.test.ts tests/kernel/control-kernel.test.ts
git commit -m "feat: project cross-provider executor routing candidates"
```

## Task 6: Enforce Runtime Busy And Invalid Draft Activation Rules

**Files:**

- Modify: `src/configuration/configuration-activation-gate.ts`
- Modify: `src/configuration/configuration-runtime-coordinator.ts`
- Modify: `src/configuration/configuration-service.ts`
- Modify: `src/management/server.ts`
- Modify: `web/src/components/SettingsPanel.tsx`
- Modify: `tests/configuration/configuration-activation-gate.test.ts`
- Modify: `tests/configuration/configuration-runtime-coordinator.test.ts`
- Modify: `tests/management/server.test.ts`

**Step 1: Write failing activation tests**

Cover:

- Idle runtime permits Provider/Model deletion in a draft.
- Idle runtime rejects activation of a draft with an invalid Fixed model.
- Busy runtime rejects Provider/Model deletion activation with `409 runtime_busy`.
- Busy runtime makes `activationAllowed` false.
- Revision conflict remains distinct from invalid configuration.

**Step 2: Run focused tests**

```bash
npm test -- tests/configuration/configuration-activation-gate.test.ts tests/configuration/configuration-runtime-coordinator.test.ts tests/management/server.test.ts
```

Expected: FAIL where current validation treats all revision changes or stale refs identically.

**Step 3: Implement backend validation**

- Recheck the gate while holding the activation mutex.
- Validate all Planner and Executor model refs against the candidate catalog.
- Return structured `invalid_configuration` issues for missing Fixed models.
- Preserve `runtime_busy` for active work.
- Keep durable activation atomic and revision-pinned.

**Step 4: Update Web activation state**

- Disable delete controls and Save/Activate during runtime busy.
- Keep Save/Activate disabled for invalid draft even when idle.
- Show repair instructions rather than generic failure text.

**Step 5: Run focused tests**

Expected: PASS.

**Step 6: Commit**

```bash
git add src/configuration/configuration-activation-gate.ts src/configuration/configuration-runtime-coordinator.ts src/configuration/configuration-service.ts src/management/server.ts web/src/components/SettingsPanel.tsx tests/configuration/configuration-activation-gate.test.ts tests/configuration/configuration-runtime-coordinator.test.ts tests/management/server.test.ts
git commit -m "fix: distinguish busy activation from invalid routing drafts"
```

## Task 7: Update Configuration Projections And Documentation

**Files:**

- Modify: `src/configuration/projections.ts`
- Modify: `src/configuration/agent-runtime-renderer.ts`
- Modify: `src/configuration/staged-legacy-configuration.ts`
- Modify: `CONTEXT.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/README.md`
- Modify: `docs/adr/0033-hot-configuration-activation-and-auto-model-routing.md`
- Modify: `docs/plans/2026-08-23-metawork-hot-activation-auto-routing-and-plan-visualization-design.md`

**Step 1: Write projection regression tests**

Cover:

- Planner projection exposes a fixed model policy.
- Internal ModelProfile projection remains available to Planner/Kernel/Runtime.
- Provider catalog and internal model projection cannot diverge after activation.
- Historical revision projection remains immutable.

**Step 2: Run focused projection tests**

```bash
npm test -- tests/configuration/projections.test.ts tests/configuration/production-runtime-bindings.test.ts tests/configuration/staged-legacy-configuration.test.ts
```

Expected: FAIL until the projection and seeded defaults are aligned.

**Step 3: Implement projection and migration updates**

- Compile Provider catalog into internal model projections.
- Normalize seeded Planner config to fixed-only.
- Preserve existing internal runtime binding contracts.
- Document that Model Facts are internal, not user-editable.
- Mark the earlier broad design as amended by the Provider-first design.

**Step 4: Run focused tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add src/configuration/projections.ts src/configuration/agent-runtime-renderer.ts src/configuration/staged-legacy-configuration.ts CONTEXT.md docs/current/technical-overview.md docs/README.md docs/adr/0033-hot-configuration-activation-and-auto-model-routing.md docs/plans/2026-08-23-metawork-hot-activation-auto-routing-and-plan-visualization-design.md
git commit -m "docs: record provider-first routing configuration contract"
```

## Task 8: Add Desktop Browser End-To-End Coverage

**Files:**

- Modify: `tests/e2e/settings-workbench-browser.test.ts`
- Modify: `web/src/components/SettingsPanel.tsx`
- Modify: `web/src/styles.css`

**Step 1: Extend the browser fixture**

Fixture data must include:

- Two Providers.
- Multiple models across Providers.
- Planner fixed policy.
- Codex and Pi policies.
- One disabled Provider for deletion coverage.

**Step 2: Add the E2E assertions**

Verify:

- No horizontal overflow at 1440px.
- Provider model catalog appears.
- Planner has no Auto control.
- Codex shows cross-Provider GPT candidates.
- Pi shows all candidates.
- Auto pool editing works.
- Provider deletion cascades from Auto pools.
- Fixed deletion shows “没有可用模型”.
- Save/Activate remains disabled for invalid draft.
- Valid repair activates and posts the expected payload.
- Busy activation state disables delete and Save/Activate controls.

**Step 3: Run the browser test**

```bash
npm run build --prefix web
RUN_BROWSER_E2E=1 npm test -- tests/e2e/settings-workbench-browser.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add tests/e2e/settings-workbench-browser.test.ts web/src/components/SettingsPanel.tsx web/src/styles.css
git commit -m "test: cover provider-first routing workbench flow"
```

## Task 9: Full Validation And Release Notes

**Files:**

- Modify: `docs/plans/2026-08-23-provider-catalog-planner-fixed-executor-auto-routing-design.md`
- Modify: `docs/plans/2026-08-23-provider-catalog-planner-fixed-executor-auto-routing-implementation-plan.md`

**Step 1: Run static validation**

```bash
npm run lint
npm run build
cd web && npm run build
git diff --check
```

Expected: all commands pass.

**Step 2: Run focused routing/configuration tests**

```bash
npm test -- tests/configuration tests/routing tests/web tests/e2e/hot-activation-auto-routing.test.ts
```

Expected: all focused tests pass.

**Step 3: Run desktop browser E2E**

```bash
RUN_BROWSER_E2E=1 npm test -- tests/e2e/settings-workbench-browser.test.ts
```

Expected: one browser test passes.

**Step 4: Run the full suite**

```bash
npm test
```

Expected: full suite passes, with only environment-conditional skips.

**Step 5: Update completion records**

Record:

- Delivered Provider-first behavior.
- Planner fixed-only behavior.
- Codex/Pi candidate projection.
- Provider/Model deletion semantics.
- Busy and invalid activation behavior.
- Test commands and final counts.
- Explicitly note that Executor hot-plug remains deferred.

**Step 6: Commit**

```bash
git add docs/plans/2026-08-23-provider-catalog-planner-fixed-executor-auto-routing-design.md docs/plans/2026-08-23-provider-catalog-planner-fixed-executor-auto-routing-implementation-plan.md
git commit -m "docs: finalize provider-first routing implementation plan"
```

## Completion Record

本计划已按 Provider-first 修正版完成。Provider 模型目录是全局候选源；
Planner 仅固定选择；Codex Auto 仅使用跨 Provider 的 GPT-family 候选；Pi
Auto 使用全部启用 Provider 候选；删除 Provider/Model 会清理 Auto 池，Fixed
引用删除模型时不自动替换且必须修复。busy runtime 禁止删除和激活，invalid
draft 返回 `invalid_configuration`。

完整验证已通过：323 个测试文件通过、5 个跳过；1458 个测试通过、16 个跳过；
桌面 Headless Chrome E2E 通过 1 个测试；lint、根构建、Web 构建和
`git diff --check` 均通过。未创建 Git commit，改动保留在共享工作树中供审查。

2026-08-24 follow-up 修复并验证：

- DeepSeek Provider 预置目录补充 `deepseek-v4-flash` 和
  `deepseek-v4-flash-vision-exp`，仍保留已有兼容模型。
- 修复热激活后的 Planner binding refresh 使用旧 active runtime revision
  导致的 `Configuration revision mismatch`；激活消费者现在使用同一激活快照
  生成的 Runtime view。
- Web 设置页遇到 `revision_conflict`，或兼容旧返回中的
  `activation_failed + revision mismatch` 时，会重新加载最新配置并提示用户
  检查后再次激活。
- 新增 revision 绑定回归测试和 DeepSeek 预置目录测试。

本次 follow-up 验证：323 个测试文件通过、5 个跳过；1460 个测试通过、16 个
跳过；设置工作台 Headless Chrome E2E 通过 1 个测试；lint、根构建、Web 构建
和 `git diff --check` 均通过。未创建 Git commit。

2026-08-24 activation/Planner replay follow-up：

- 热激活切换 active pointer 后，会先把新 configuration revision 登记到运行时
  SQLite 的 `configuration_revisions`，再刷新 Planner/Runtime consumers；登记
  失败会回滚 active pointer 和 candidate secret，避免新 Planner proposal 写入
  `kernel_events` 时触发外键失败。
- Planner proposal 的 `uncertain` 状态现在允许完全相同的 submission 使用原
  `eventId` 重新进入 Kernel 幂等提交；仓储会在同一事务内把
  `uncertain -> submitting`，防止并发重放重复进入。
- `submitting` 仍返回 `in_flight`，已接受/拒绝的 proposal 仍只返回持久化结果，
  不重复创建 Kernel event、decision、interaction 或用户输出。
- 真正处于 `uncertain` 的 Kernel application 不会被 proposal replay 盲目重试，
  继续遵守显式 recovery 协议，避免重复外部副作用。
- SQLite schema 升级到 v33，新增 Planner proposal 的
  `configuration_revision` pin；schema 30/31/32 均可事务式升级到 v33，历史
  已丢失 event 的旧 proposal 保留兼容性回退。
- 回滚到已有历史 revision 时复用其 immutable source metadata，避免把已有
  `native` revision 错误登记为 `rollback`。

最终验证：323 个测试文件通过、5 个跳过；1463 个测试通过、16 个跳过；
设置工作台 Headless Chrome E2E 通过 1 个测试；lint、根构建、Web 构建和
`git diff --check` 均通过。未创建 Git commit。

最终统计（2026-08-24 reliability closure 完成后）：323 个测试文件通过、
5 个跳过；1465 个测试通过、16 个跳过；设置工作台 Headless Chrome E2E
通过 1 个测试；lint、根构建、Web 构建和 `git diff --check` 均通过。未创建
Git commit。
