# 可见账单与历史任务账单简化设计

- **状态：** 已实施完成（待提交）
- **日期：** 2026-09-22
- **范围：** Web 账单入口、当前 Turn 账单展示、历史账单与历史 Task 关联、计量失败诊断
- **关联：** ADR-0042、ADR-0041、`docs/current/query-billing-operations.md`

## 1. 目标

用户必须在一次操作内回答以下问题：

1. 这次请求有没有账单？
2. 如果有，金额是多少？
3. 如果没有，为什么没有？
4. 历史任务和历史请求的账单在哪里？

账单不是执行轨迹的附属调试信息。它是一个独立的用户可见结果，同时保留可展开的诊断事实。执行完成但 usage 缺失时，不再隐藏账单区域，也不把未知成本显示为零。

## 2. 用户模型

用户只看到三种账单结果状态：

| 用户状态 | 含义 | 页面主文案 |
| --- | --- | --- |
| `已计费` | 已经生成可展示金额 | `本次费用：X MetaCoin` |
| `待确认` | 请求完成，但计量或账单仍缺少事实 | `费用暂时无法确认` |
| `无费用` | 已确认本次没有可计费资源 | `本次无费用` |

`collecting`、`pending_reconciliation`、`finalized`、`not_exported`、`pending`、`received`、`confirmed`、`unknown`、`rejected` 等内部状态只保留在 Server 和诊断详情中，不直接作为用户状态堆叠展示。

第三方消费提交不是本期用户主流程的一部分。页面不再展示“待核对金额”“进行中金额”“已确认第三方扣款”等账户级汇总，也不把第三方回执状态放在每个 Turn 的主卡上。需要时在诊断详情中显示一行“外部消费：未启用/已确认/异常”。

## 3. 页面信息架构

### 3.1 当前 Turn

每个非系统 Turn 在最终回答后固定显示一张账单卡，无论是否有金额：

```text
本次账单                         已计费
费用                             12.40 MetaCoin
关联任务                         鸡蛋期货近期上涨原因调研
查看账单详情                     >
```

缺少 usage 时显示：

```text
本次账单                         待确认
费用                             暂无法计算
原因                             Provider 未返回可验证的用量数据
查看诊断详情                     >
```

用户点击“查看账单详情”后才展开 Query ID、Turn ID、Task ID、Provider、Model、usage 观测数、缺失类别、稳定诊断码和最后刷新时间。原始 Prompt、API Key、原始 stdout/stderr 和隐藏推理不得进入页面。

### 3.2 顶部账单入口

Workspace 顶部新增一个明确的 `账单` 标签，与 `对话`、`轨迹` 同级。账单页只展示：

- 历史账单记录列表；
- 每条记录的时间、用户请求摘要、状态、金额、关联 Task；
- 筛选：全部、已计费、待确认、无费用；
- 点击记录进入账单详情。

不展示账户金额汇总卡，不制造第二套“余额/消费中心”概念。

### 3.3 历史 Task 关联

账单列表中显示 `Task` 摘要。账单详情显示同一 Task 下的历史 Query：

```text
Task：鸡蛋期货近期上涨原因调研
关联请求：3

09:10  初始请求       已计费       12.40 MetaCoin
09:25  自动重试       待确认       费用暂无法确认
09:40  用户继续       无费用       0 MetaCoin
```

历史 Task 没有 Query 事实时，显示“历史任务未建立计量记录”；不猜测金额，不追溯补算。

## 4. Server 与 Gateway

现有 `BillQueryService` 已经提供单 Query、Turn、Task 和账户列表查询。升级保持 ADR-0041 的只读分支：

- `list_query_bills` 支持 Web 账单页分页；
- `get_query_bill_for_turn` 支持当前 Turn 详情；
- `get_task_usage_summary` 只用于 Task 详情的关联 Query 展示，不再投影账户金额汇总卡；
- 新增只读账单诊断 projection，或在现有 `QueryBillProjection` 中增加稳定 `diagnosticCode`、`diagnosticMessage`、`observedUsageCount` 和 `missingCategories`；
- 所有查询都按 Account、Conversation、Task 授权；
- 只读查询不创建 Turn、不进入 Planner mailbox、不改变账单状态。

历史 Web 会话在 `enrichTurn` 时必须按 Turn 重新查询账单，并把账单状态投影为三态用户状态。历史账单不依赖当前 Web 进程是否仍保留内存 Turn。

## 5. 计量缺失的明确诊断

以下诊断码用于 Server、日志、测试和页面“诊断详情”，页面主文案使用中文解释：

| 诊断码 | 用户解释 |
| --- | --- |
| `no_usage_observed` | Provider 未返回可验证的用量数据 |
| `provider_usage_unavailable` | 当前 Provider 不提供用量数据 |
| `usage_parser_no_match` | 收到了 Provider 输出，但没有匹配到 usage 格式 |
| `query_not_finalized` | 请求仍在等待计量收束 |
| `missing_price_book` | 当前请求缺少有效价格规则 |
| `missing_billing_projection` | 账单事实存在，但页面投影暂时不可用 |
| `historical_unavailable` | 历史任务没有足够事实，无法安全补算 |
| `external_consumption_disabled` | 本地账单已生成，但外部消费提交未启用 |

诊断必须区分“没有账单事实”和“有账单事实但前端没有显示”，避免前端静默空白。

## 6. 真实 Provider 验收

测试分成两层：

1. **协议/适配器测试**：人工构造 Pi `message_end.usage` 和 Codex `turn.completed.usage`，验证解析与归因。
2. **真实链路验收**：一次真实 Web 请求必须在数据库中同时看到 Query、usage observation、bill projection 或明确的 pending diagnostic，并在 Web 当前 Turn 或账单页看到同一结果。

真实链路验收失败时，页面必须展示诊断码，不能只显示执行成功。

## 7. 历史兼容

- 有完整 usage 和 bill：显示 `已计费`。
- 有 Query 但没有 usage：显示 `待确认` 和 `historical_unavailable` 或 `no_usage_observed`。
- 只有 Task 没有 Query：显示“历史任务未建立计量记录”。
- 已终结账单金额不可用当前价格重算。
- 晚到的 usage 只能更新未终结账单或生成明确调整记录，不能静默改变已终结账单。

## 8. 验收标准

- 新 Turn 完成后必定出现账单卡；没有账单金额时显示原因。
- 页面有明确的“账单”入口和历史账单列表。
- 历史账单可关联到 Conversation、Turn、Task。
- 当前 Turn、账单页、Task 详情使用同一 Server projection，不由客户端计算金额。
- 用户状态最多三种：已计费、待确认、无费用。
- 诊断详情能说明 Query 是否创建、usage 是否收到、账单是否终结、投影是否失败。
- 现有账单、Gateway、Web Session、Pi/Codex usage 测试保持通过，并增加真实链路验收。

## 9. 发布后用户流程

```bash
npm run lint
npm run build
npm run smoke:query-billing
metawork server stop
npm run setup:native
metawork server start
metawork server status
```

重新打开 `metawork web` 后，用户可以在当前 Turn 的“本次账单”卡查看本次结果，在顶部“账单”标签查看历史记录。若 usage 缺失，页面直接显示“待确认”和诊断原因，不需要用户检查数据库或猜测构建是否生效。

## 10. 完成记录

- **实施状态：** 完成（2026-09-22）。
- **交付行为：**
  - `src/billing/bill-query-service.ts`：新增三态用户状态（`billed`/`unconfirmed`/`no_charge`）、
    八个稳定诊断码及中文解释、`TurnBillUserView` 单 Turn 视图、`listQueryBillsForTask`
    Task 关联列表；`QueryBillProjection` 扩展 `diagnosticCode`、`diagnosticMessage`、
    `observedUsageCount`、`missingCategories`、`turnId`、`conversationId`、`createdAt`。
  - `src/management/web-gateway-session-runtime.ts`：接入 billing 依赖；`enrichTurn` 历史
    读取时按 Turn 重新投影并替换陈旧账单；非系统 Turn 恒有三态账单视图（无事实 →
    `historical_unavailable`，活跃 → `query_not_finalized`，投影失败 →
    `missing_billing_projection`）；最终刷新 tick 无论是否有金额都发布账单卡；新增
    `listBillingRecords` / `getTaskBillingDetail` 联合投影（请求摘要 + Task 标题）。
  - `src/management/server.ts`：新增只读端点 `GET /api/billing/records`（分页 + 三态筛选）
    与 `GET /api/billing/tasks/:taskId`；未认证 fail closed。
  - `src/server/billing-composition.ts` / `server-composition.ts`：向查询服务传入计量/价格/
    导出开关事实源；Web 运行时接入统一 `billingServices.queries` 投影。
  - Web 端：顶部新增「账单」标签（`WorkspaceHeader`）；`BillingView` 历史列表 +
    全部/已计费/待确认/无费用筛选 + 账单详情与同 Task 关联请求（无事实时显示
    「历史任务未建立计量记录」）；`TurnBillCard` 三态账单卡固定展示于每个非系统 Turn，
    可展开 Query/Turn/Task ID、Provider/Model、usage 观测数、缺失类别、诊断码；移除
    Turn 上的账户金额汇总卡；原始 Prompt、API Key、stdout/stderr 与隐藏推理不进入页面。
- **验证：** `npm run lint`、`npm run build`（含 Web 构建）、`npm run smoke:query-billing`
  （6 文件 94 passed）；账单/计量/Web/管理/Gateway 只读分支回归 60 文件 457 passed；
  新增 `tests/billing/bill-user-projection.test.ts`（13）、运行时账单卡/账单页测试（5）、
  HTTP 路由测试（1）、真实链路验收 `tests/acceptance/query-billing-lifecycle.test.ts`
  新增 3 例（事实齐备三端一致、usage 缺失全路径待确认诊断、晚到 usage 不可改已终结账单）。
- **完成日期：** 2026-09-22。
- **收尾提交：** 工作区同时含有此前进行中的账单基础与 TUI 清理改动，未代为打包提交；
  建议用户确认后以 `feat(billing): visible bill card, billing page and stable diagnostics`
  提交本设计与相关文件。
