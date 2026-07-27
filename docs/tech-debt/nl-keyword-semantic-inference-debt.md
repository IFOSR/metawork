# 自然语言关键字语义推断残留

> 状态：已盘点，待逐项评估与收紧  
> 创建日期：2026-07-15  
> 关联计划：`docs/archive/plans/2026-07-13-planner-semantic-tightening-and-dedicated-mcp-zh.md`  
> 关联 ADR：ADR-0015（Planner-Owned Semantics And Tool-Mediated Context）  
> 用途：记录 2026-07-13 Planner 语义收紧后，代码中仍依赖关键字/正则做自然语言语义推断的残留点。本文只登记债务，不在此直接改实现。  
> 边界：slash 命令、显式 ID、路径、URL、附件等确定性解析不视为债务。

## 总体判断

Planner / ControlKernel 前的生产主路径已经基本不再用自然语言关键字做意图路由。  
`RuleHintsProvider`、`filterDurableTasks`、优先级/风险/继续/恢复/清空范围等旧关键词助手，在 `src/planning/`、`src/kernel/`、`src/intent/` 中未再发现。

仍残留的关键字语义推断，主要集中在：

1. 记忆时间线召回的意图判定；
2. 偏好召回的场景/语气兼容判断；
3. 任务完成后的高置信偏好自动捕获；
4. 任务相关性打分中的连续性启发式；
5. Resume 上下文拼装中的交付/文件生成意图猜测。

这些逻辑多数不是 admission / routing，但仍在用硬编码中文词表猜测用户意思，与“自然语言语义判断统一进入 PlanningAgent”的方向不完全一致。

## 1. 已确认干净的范围

| 区域 | 结论 |
| --- | --- |
| `src/planning/` | 自然语言语义交给 Codex PlanningAgent；schema/validator 只校验结构化 Plan |
| `src/kernel/` | 只做确定性授权、风险确认拦截、非法 scope 拒绝 |
| `src/intent/` | 路径、URL、材料解析；不做意图猜测 |
| 命令路由 | `/` 前缀与命令树，不走 NL 关键字 |
| 脱敏与展示文案 | 如 `secret|token|key` 脱敏、blocked reason 文案映射，属于安全过滤或用户提示，不是路由决策 |
| 类型标签 `natural-language-resume` | 仅作恢复来源标记，不参与推断 |

## 2. 仍在用关键字做语义推断的位置

### 2.1 记忆时间线召回（高优先级）

| 位置 | 当前行为 | 问题 |
| --- | --- | --- |
| `src/memory/context-recaller.ts`：`isTimelineRecallRequest` | 用 `今天/昨天/早上/上午` + `做了什么/任务清单/列出来...` 判定是否时间线查询 | 对用户输入做意图分类，最接近旧 NL 路由 |
| `src/memory/context-recaller.ts`：`detectTimelineRange` | 用 `昨天`、`早上\|上午` 推断时间窗 | 把时间语义硬编码在代码里 |
| `src/memory/context-recaller.ts`：`extractKeywords` / `recallByKeywords` | 分词 + stopword + SQL `LIKE` | 本身是检索特征，可保留；但入口意图判定仍是债务 |

### 2.2 偏好召回场景兼容（中高优先级）

| 位置 | 当前行为 | 问题 |
| --- | --- | --- |
| `src/memory/memory-engine.ts`：`recall` | `communicationCue` / `projectCue` 用邮件、项目等词抬分 | 场景猜测影响偏好排序 |
| `src/memory/memory-engine.ts`：`isGlobalPreferenceSceneCompatible` | 决定全局偏好是否可注入当前输入 | 大块硬编码 NL 兼容规则 |
| `src/memory/memory-engine.ts`：`classifyPersonalityTonePreference` / `detectRequestedPersonalityTones` | 活泼/正式/犀利等语气词表分类 | 用关键字猜语气类型 |
| `src/memory/memory-engine.ts`：`isPersonalityToneSceneCompatible` / `isStructuredWorkScene` | 邮件、文案、PPT/周报等场景词表 | 用关键字猜场景是否匹配偏好 |
| `src/memory/memory-engine.ts`：`inferType` | `格式/风格/语气`、`流程/步骤` 推断偏好类型 | 轻量规则推断，可后置 |

### 2.3 后执行偏好自动捕获（高优先级，与计划精神有张力）

| 位置 | 当前行为 | 问题 |
| --- | --- | --- |
| `src/session/session-helpers.ts`：`extractHighConfidencePreferenceCandidates` | 匹配 `明确偏好`、`工作规则`、`以后/凡是...`、`我更喜欢/希望...` | 从文本抽“长期偏好”语义 |
| `src/session/session-helpers.ts`：`extractPatterns` | 匹配 `用X格式/语气`、`抄送X` | 重复模式观察入口依赖 NL 模式 |
| `src/session/session-helpers.ts`：`isHighRiskMemoryCandidate` | 外发/删除/生产环境等风险词门控 | 安全门本身可保留，但依赖同一套文本抽取 |
| `src/memory/memory-capture-service.ts`：`captureHighConfidencePreferences` / `captureCompletionPatterns` | 任务完成后自动抽偏好并可能静默写入 | 计划明确要去掉 Planner 前的高置信自动写入；当前在后执行路径仍保留类似行为 |
| `src/memory/memory-capture-service.ts`：`captureExplicitPreference` | 已定义但未见调用 | 死代码，可直接清理 |

说明：计划原文主要约束的是 Planner **前面** 的“记住……”快路径。当前实现不在路由前，而在任务完成后从 output 抽偏好；路径不同，但仍是关键字驱动的自动记忆写入。

### 2.4 任务相关性打分（中优先级）

| 位置 | 当前行为 | 问题 |
| --- | --- | --- |
| `src/task/task-relevance-ranker.ts`：`GENERIC_TERMS` | 停用词集合含 `继续/参考/历史` 等 | 合理检索噪声过滤，本身不是意图路由 |
| `src/task/task-relevance-ranker.ts`：`inferEntities` | `项目/周报/材料/方案` 等后缀实体启发式 | 轻量 NL 实体猜测 |
| `src/task/task-relevance-ranker.ts`：`applyContinuityFloors` | `复用\|沿用\|参考\|上次\|历史` 抬分 | 明确用用户措辞猜“要参考历史” |

### 2.5 Resume 上下文与交付意图（低到中优先级）

| 位置 | 当前行为 | 问题 |
| --- | --- | --- |
| `src/memory/resume-context-builder.ts`：`needsFeishuDocumentDelivery` | `飞书云文档/在线预览` 等词 | 影响交付/上下文拼装，不改路由 |
| `src/memory/resume-context-builder.ts`：`isFileGenerationRequest` | 生成/导出 html/md/文件等模式 | 影响 workspace 权限拼装 |

### 2.6 展示层文案映射（通常可保留）

| 位置 | 当前行为 | 结论 |
| --- | --- | --- |
| `src/session/session-presentation-service.ts` | 按 blocked reason 中的 `材料/权限/timeout` 选择提示文案 | 用户提示映射，不是决策路由 |
| `src/session/metaclaw-session.ts` 同类 reason 匹配 | 同上 | 一般不记为语义路由债务 |

## 3. 影响

- 用户换一种说法时，时间线召回、偏好注入、参考历史抬分、文件交付上下文可能静默失效或误触发。
- 偏好自动捕获可能把执行器输出中的“看起来像规则”的句子写入记忆，带来误记和风险门控绕过讨论成本。
- 债务分散在 memory / session / task 多个域，后续若继续把语义收口到 Planner，容易出现“路由已收口、侧路径仍各写一套词表”的双轨语义。
- 测试若只覆盖词表命中样例，会把这些启发式固化成行为契约，增加后续删除成本。

## 4. 建议处理优先级

| 优先级 | 项 | 建议动作 |
| --- | --- | --- |
| 高 | `context-recaller.isTimelineRecallRequest` / `detectTimelineRange` | 评估改为 Planner 查询驱动，或仅保留显式时间/任务查询入口 |
| 高 | 高置信偏好自动捕获链路 | 明确是否仍允许后执行自动写库；若不允许，改为候选 + 手动确认，或只认 `/memory` 等显式命令 |
| 中 | `memory-engine` 场景/语气词表 | 逐步改为 embedding/结构化偏好元数据，或显著收窄规则面 |
| 中 | `task-relevance-ranker.applyContinuityFloors` | 去掉措辞抬分，只保留实体/词重叠与产物信号 |
| 低 | Feishu/文件生成关键词 | 若 Plan/任务产物已能表达交付意图，再迁出 |
| 清理 | `captureExplicitPreference` 死代码 | 无行为争议，可直接删除并补回归 |

## 5. 非绑定修复方向

1. **最小清理**
   - 删除死代码 `captureExplicitPreference`；
   - 给剩余关键字入口补统一注释：标注“检索/安全/展示，不得用于 admission 或 action 选择”。

2. **中等收紧**
   - 停掉后执行高置信偏好静默写入，只保留候选观察与 `/memory confirm`；
   - 时间线召回不再用“做了什么/清单”等意图词，改为 Planner MCP 查询或显式命令。

3. **长期方向**
   - 自然语言语义只允许出现在 PlanningAgent 输出或明确工具结果中；
   - 代码侧只保留：slash/ID/路径/URL、结构化字段、检索分词、安全黑名单；
   - 偏好兼容、参考历史、交付意图等，优先变成 Plan 字段或任务/记忆结构化元数据，而不是再扩中文词表。

## 6. 未来验收标准

- 生产路径中，用户输入到 `PlanningAgentPlan.action` / task control / priority / risk 的决策，不再依赖中文/英文关键字词表。
- 记忆召回若仍保留检索分词，不得再单独用关键字判定“这是时间线查询/这是参考请求”等意图。
- 偏好写入只来自显式命令或经确认的候选；不存在静默高置信 NL 自动落库，或该行为被明确文档化为有意保留的例外。
- `task-relevance-ranker` 不再因 `参考/上次/历史` 等措辞单独抬分。
- 新增测试覆盖“同义改写不改变路由结果”和“关键字侧路径不越权做 action 选择”。
- 本文登记的死代码清理项完成后，从本清单勾除。

## 7. 明确不在本债务范围内

- slash 命令树与帮助文案；
- 路径、URL、附件、显式 task id 解析；
- 审计脱敏关键字；
- 纯展示层 reason → 用户提示映射；
- Planner Skill / 提示词中的自然语言说明（那是模型侧语义，不是代码关键字路由）。
