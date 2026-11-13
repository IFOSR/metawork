# Visible Billing Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复可见账单实现中的金额单位、账单入口、授权、兜底展示和历史账单可诊断问题。

**Architecture:** 保持账单金额和状态由 Server 投影提供，Web 只渲染 Server 已格式化的 MetaCoin 字符串。账单页作为 Workspace 级视图独立于当前 Conversation；Task 账单详情在标题投影前执行账户授权；缺少账单服务或详情接口失败时显示明确诊断。

**Tech Stack:** Node 22、TypeScript ESM、Vitest、React、Vite。

---

### Task 1: 修复金额投影与账单页面单位

**Files:**
- Modify: `src/billing/bill-query-service.ts`
- Modify: `src/management/web-session-types.ts`
- Modify: `web/src/api/session-types.ts`
- Modify: `web/src/components/BillingView.tsx`
- Modify: `web/src/components/QueryBill.tsx`
- Modify: `web/src/components/TurnBillCard.tsx`
- Test: `tests/billing/bill-user-projection.test.ts`

**Steps:**
1. 先增加断言，要求 Query projection 暴露十进制 MetaCoin 金额，账单列表/详情使用该字段。
2. 运行账单测试，确认当前 raw microCoin 输出导致失败。
3. 在 Server projection 中增加格式化金额字段，明细行同步格式化。
4. Web 只读取格式化字段，不在客户端重复计算。
5. 运行账单测试与 TypeScript 构建。

### Task 2: 修复账单入口与当前 Turn 卡兜底

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `web/src/components/TurnBillCard.tsx`
- Test: `tests/web/workspace-shell.test.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`

**Steps:**
1. 增加无选中 Conversation 时仍能渲染账单页的测试。
2. 增加 billing service 缺失时仍返回 `missing_billing_projection` 的测试。
3. 调整 App 渲染优先级，让账单页不依赖 `selectedId`。
4. 增加 Server 兜底账单视图。
5. 运行对应测试。

### Task 3: 增加 Task 账户授权与历史任务入口

**Files:**
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/server/server-composition.ts`
- Modify: `web/src/components/BillingView.tsx`
- Test: `tests/management/web-gateway-session-runtime.test.ts`
- Test: `tests/management/server.test.ts`

**Steps:**
1. 增加跨账户 Task 账单详情不能返回标题的失败测试。
2. 让 Task 时间线投影接收 accountId，生产实现校验 Task 所属账户。
3. 增加账单页 Task 详情请求的加载和错误状态。
4. 确保没有 Query 事实的 Task 详情仍能显示明确提示。
5. 运行管理运行时和 HTTP 测试。

### Task 4: 修复分页筛选与回归验证

**Files:**
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/billing/bill-query-service.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`

**Steps:**
1. 增加过滤后第一页不能错误为空的测试。
2. 在查询层按状态筛选后再进行游标分页，或继续读取页面直到填满。
3. 运行账单、管理、Web 测试。
4. 运行 `npm run lint`、`npm run build`、`npm run smoke:query-billing`。

## Completion

## Follow-Up: Missing Model Prices And Identity

- **Date:** 2026-09-22
- **Status:** Completed.
- **Evidence:** Read-only inspection of the installed account found no price
  versions and 12 usage observations with null Agent/Provider/model identity
  and `payer=unknown`.
- **Scope:** Complete Provider/model-scoped price loading and Settings price
  entry; keep real model IDs from adapters, never substitute internal model
  refs; distinguish missing prices and unknown payer from active collection.
- **Validation:** Focused regression tests, 309 billing/metering/executor/
  management/Web tests, `npm run lint`, `npm run build`, and
  `npm run smoke:query-billing` (97 tests) passed. The installed release was
  verified through authenticated `/api/billing/records`; historical bills were
  not edited.
- **Safety:** No inferred prices, payer changes, historical repricing or external
  consumption export.

## Original Completion

- **Completed:** 2026-09-22
- **Delivered:** Server-side MetaCoin decimal projections; Workspace-level billing access without a selected Conversation; explicit missing-projection fallback; Task account authorization; Provider/Model detail projection; account-scoped historical Task listing; visible task-detail/list errors; status filtering before cursor pagination.
- **Validation:** `npm run lint`, `npm run build`, targeted billing/management/Web tests (113 passed), and `npm run smoke:query-billing` (97 passed).
- **Commit:** Not created; the worktree contains unrelated pre-existing TUI/Gateway changes.
