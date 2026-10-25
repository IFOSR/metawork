# Planner 主导的 Workspace 执行模式与临时 Worktree 设计

- 日期：2026-10-25。
- 状态：已确认并实施（2026-10-25，ADR-0050）。
- 依据：DeepSeek Harness 对齐的工作区执行与变更记录方案，以及当前 MetaWork 的 Planner、Kernel、Workspace、Attempt 和 ResourceLease 实现。
- 实施记录：[技术实施方案](2026-10-25-planner-owned-workspace-mode-implementation-plan.md)；架构决定：[ADR-0050](../adr/0050-planner-owned-workspace-execution-mode.md)。

## 1. 决策摘要

MetaWork 只保留两种写入执行模式：`in_place` 和 `worktree`。

`in_place` 是普通 Workspace 会话的主路径：Executor 在目标资源所属的授权 Workspace 内直接工作，结果落在该 Workspace 的目标路径中。

`worktree` 是有明确隔离价值的执行后端：Executor 在内部临时执行目录中完成工作，目标 Workspace 在执行期间保持不变。只有经过 Kernel 授权的发布、接受或交付动作，结果才进入目标 Workspace。

旧的“Worktree 执行后自动复制到 `publicTaskDirectory`”不再作为产品路径保留。Worktree 仍然可以发布结果，但发布必须应用经过授权的变更集或声明文件，不能复制整个执行目录。

## 2. 单一语义判断者

Planner 是 Workspace 执行模式的唯一语义判断者。它根据用户请求和当前 Conversation 上下文识别：

- 目标 Workspace 和目标相对路径；
- 用户是否要修改已有文件或创建新文件；
- 是否要求保留原文件；
- 是否明确要求隔离、候选结果或人工接受；
- 操作的风险和副作用边界；
- 应使用 `in_place`、`worktree`，还是需要追问。

系统不再让 Planner 和另一个决策模型分别判断模式。模式决策链固定为：

```text
用户请求
  -> Planner 提出结构化 Workspace 意图和模式建议
  -> Kernel 做确定性的权限、路径、租约和风险校验
  -> Runtime 执行 Kernel 固定的模式
```

Kernel 不是第二个语义模型。它不重新理解自然语言，只负责拒绝不满足约束的提案、要求确认、固定不可变 binding，并授权 Runtime 产生副作用。

未来如果引入独立 Decision Model，它只能替代 Planner 的模式判断职责，不能与 Planner 并列产生互相竞争的最终模式，也不能绕过 Kernel。

## 3. Workspace 词汇

需要严格区分以下三个概念：

| 概念 | 含义 | 用户可见性 |
| --- | --- | --- |
| 用户 Workspace | 用户拥有的真实项目目录和稳定 Workspace 身份 | 可见，可绑定 Conversation |
| Workspace Catalog 记录 | `workspaceId`、规范路径、Account 所属关系和权限事实 | 可查询 |
| Worktree 执行目录 | 某个 Generation/Task 的内部隔离执行根目录 | 默认不可见 |

Worktree 模式不创建新的用户 Workspace，也不向 Workspace Catalog 注册一个新的用户 Workspace。它只创建或复用一个内部临时执行目录。Git 项目使用 managed Git worktree；其他受支持的执行后端使用等价的受控隔离目录。

用户在 Web 或 TUI 中看到的是目标 Workspace、执行模式、候选变更和发布状态，不需要看到内部绝对路径。

## 4. Planner 契约

Planner schema 应增加统一的 Workspace 意图对象：

```ts
interface WorkspaceIntent {
  targetWorkspaceId: string | null;
  targetPaths: string[];
  operation:
    | 'modify_existing'
    | 'continue_existing_edit'
    | 'create_in_target'
    | 'run_in_target'
    | 'read_only'
    | 'isolated_experiment'
    | 'high_risk_change'
    | 'ambiguous';
  originalFilePolicy: 'may_replace' | 'must_preserve' | 'unknown';
  isolationPolicy: 'requested' | 'not_requested' | 'required' | 'unknown';
  proposedMode: 'in_place' | 'worktree' | null;
  confidence: number;
  reason: string;
}
```

Planner 仍然可以使用现有的 `action: 'clarification'` 和 `clarificationQuestion`。不应为 Workspace 模式再引入第二套追问机制。

Planner 不得输出任意绝对路径作为授权依据。目标 Workspace 必须通过 Workspace 身份或当前 Conversation 的受信绑定解析，目标文件只能是 Workspace 内的相对路径。Work Graph 声明的 `fileOutputs` 必须落在 `workspaceIntent.targetPaths` 覆盖范围内，声明输出不能扩大 Planner 已授权的目标路径。

写入型 `workspaceIntent` 必须至少声明一个目标文件或目录。目标范围会在 Attempt 启动前解析为实际执行根下的绝对路径并传给 Executor；不能把整个执行根目录冒充 Planner 的目标范围。只有 `read_only` 报告型 Work Graph 可以不声明目标路径，并且它仍使用内部隔离目录执行，不能获得用户 Workspace 的写权限。

## 5. 模式选择规则

模式判断遵循以下优先级：

1. 用户明确要求；
2. Planner 对 Workspace 意图的结构化判断；
3. Kernel 的确定性安全约束；
4. 高级设置中的 fallback，仅用于低风险且语义明确但未给出模式的请求；
5. Planner 失败或结果不可信时的安全兜底。

典型规则如下：

| 用户意图 | 结果 |
| --- | --- |
| 直接修改目标项目中的配置或代码 | `in_place` |
| 继续完善已有项目 | `in_place` |
| 在目标 Workspace 中新建文件 | `in_place` |
| 不要修改原文件，先生成候选版本 | `worktree` |
| 先在隔离环境中试验 | `worktree` |
| 批量或高风险修改，完成后再审核 | `worktree` |
| 仅阅读、分析或回答问题 | 不创建写入型 Task |
| “把 3 页 PPT 扩展成 5 页”且未说明是否覆盖原文件 | 追问 |

“保留原文件”本身不强制要求 Worktree。如果用户要求在目标 Workspace 中另存为新文件，可以使用 `in_place`。Worktree 表示执行隔离，而不是“生成副本”的同义词。

以下情况必须追问，不能静默使用 fallback：覆盖还是另存、是否允许删除、是否需要候选结果、是否需要人工接受、目标 Workspace 不明确，以及高风险操作缺少授权。

追问期间不创建 Task、Attempt 或 Worktree，不取得写租约，也不执行发布。用户回答后重新规划。

## 6. 高级设置

高级设置提供：

```ts
workspaceExecution: {
  fallbackMode: 'in_place' | 'worktree';
}
```

界面文案为：

> Planner 无法判断时的默认 Workspace 执行模式

推荐默认值为 `in_place`，以符合普通多轮 Workspace 编辑的 Harness 式主路径。该设置不能覆盖 Planner 的明确判断，也不能绕过 Kernel 的安全校验。

Planner 不可用、输出非法或语义存在副作用歧义时，系统应追问或使用安全的 `worktree` 兜底，不能因为用户选择了 `in_place` fallback 就盲目修改文件。

模式设置必须进入配置 revision。运行中的 Task、Generation 和 Attempt 不能根据当前环境变量重新解释模式。现有 `METAWORK_WORKSPACE_EXECUTION_DEFAULT` 和 `METAWORK_WORKSPACE_IN_PLACE_ENABLED` 只作为迁移期间的兼容输入，完成迁移后不再是生产执行依据。

## 7. In-place 生命周期

```text
解析目标 Workspace
  -> Kernel 固定 Workspace binding
  -> 获取 Workspace ResourceLease
  -> Executor 在目标 Workspace 执行
  -> 记录 WorkspaceChangeRecord 和 live Artifact 引用
  -> 完成认证与结果持久化
  -> 释放租约
```

In-place 不创建 Worktree，不创建任务目录，也不复制文件作为交付结果。用户文件已经发生的修改可以在 Attempt 失败或取消后保留；未知外部副作用进入 Kernel 的 uncertainty/recovery 路径，不能盲目重放非幂等命令。

## 8. Worktree 生命周期

```text
解析目标 Workspace W
  -> 创建或复用内部执行目录 E
  -> Executor 只在 E 中执行
  -> 生成变更记录、候选 Artifact 和发布计划
  -> Kernel 授权发布或等待用户接受
  -> 获取 W 的写租约
  -> 应用授权变更集或声明文件到 W
  -> 记录发布结果
  -> Task/Generation 终结后清理 E
```

E 是 Generation 级别的内部执行状态。多轮继续编辑同一个候选结果时复用 E，不在每一轮重新创建。发布成功、用户拒绝、Task 放弃或 Kernel 确认不再恢复后才清理 E。

进程崩溃或副作用不确定时必须暂时保留 E，等待恢复或用户决策。稳定的 Artifact、变更摘要和审计事实写入 CAS/数据库；E 本身不作为长期用户文件保存。

Worktree 执行期间只能持有隔离执行目录的写租约。发布阶段才申请目标 Workspace 的写租约，因而不会与 In-place 写入形成双写。

## 9. 发布语义

Worktree 的发布是独立的 Kernel 授权动作，分为：

- `none`：只保留候选结果，不进入用户 Workspace；
- `await_acceptance`：等待用户查看并接受；
- `auto_publish`：用户或 Planner 已明确授权，Kernel 仍需验证后执行。

发布只应用经过授权的变更集、补丁或声明文件。不得复制整个内部 Worktree，也不得使用 `publicTaskDirectory` 作为新的用户成果目录。

## 10. 持久化与不可变事实

Task/Generation binding 至少固定：

```text
workspaceId
canonicalWorkspacePath
executionMode
authorizedWorkingDirectory
bindingFingerprint
resourceLeaseId
```

Retry、恢复和同一 Conversation 的后续轮次继承既有模式。只有用户明确切换目标或创建新 Task，才重新进行模式判断。

历史 publication 记录可以保留用于审计，但旧的自动复制执行路径、旧 worker 恢复路径和 `legacy` 运行分支必须删除或停用。

## 11. 核心验收标准

- 普通目标 Workspace 编辑直接使用 `in_place`；
- 新建目标 Workspace 文件不因“新文件”自动切换到 Worktree；
- 明确要求隔离、候选版本或人工接受时使用 `worktree`；
- 模式存在副作用歧义时追问；
- Worktree 执行期间目标 Workspace 没有写入；
- Worktree 发布前不创建用户可见任务目录；
- 发布只应用授权变更，不复制整个执行目录；
- Worktree 多轮继续编辑复用同一个内部执行目录；
- Task Retry 和恢复保持原模式；
- Workspace 冲突由 ResourceLease 串行化；
- 内部执行目录在终结后清理，未决副作用期间保留；
- Planner 失效时不会静默覆盖用户文件。
