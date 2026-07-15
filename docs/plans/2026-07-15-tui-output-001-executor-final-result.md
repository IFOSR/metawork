# TUI-OUTPUT-001：只展示 Executor 最终结果

- 状态：completed
- 计划日期：2026-07-15
- 完成日期：2026-07-15
- 实施提交：本提交（`fix: show only executor final results`）

## 完成记录

- 已交付：隐藏 executor 实时 stdout/stderr、工具过程与普通状态事件；每个 subtask 仅追加一次完整最终结果块。
- 已交付：Codex executor 使用 `--output-last-message`，不使用 `--ephemeral`，缺失或空最终消息失败关闭，并在成功、失败、spawn error、idle timeout 与 abort 后清理临时目录。
- 已交付：TUI 动态区域使用约 350ms 的循环省略号动画，终态清除；最终结果块整体按 Executor 蓝色样式渲染。
- 已交付：文件型与非文件型 completion 均不重复 executor 正文；飞书优先提取本轮全部新最终结果块，旧协议保留兼容。
- 验证：`npm run lint`、`npm run build`、Docker focused tests（114 tests）及 Docker 全量测试（754 passed，4 skipped）通过。
- 未执行：真实 SSH 交互式 TUI 人工检查；自动化 Ink TUI 回归已覆盖动画循环、最终结果颜色分类入口、长换行结果保留与终态清理。

## 目标

- 所有 executor 的实时 stdout/stderr、工具过程和状态事件不进入用户会话。
- Codex 通过 `--output-last-message` 精准获取最终回答。
- 每个 subtask 完成后只展示一次完整的蓝色 Executor 最终结果。
- 执行期间使用不进入历史记录的循环省略号动画。
- 失败时只显示精简、脱敏的原因和恢复提示。

## 实现方案

1. 深化 `CommandLineExecutorAdapter` 的内部运行 seam，统一管理启动参数、stdout 累积策略、最终结果读取和全终态清理。默认 executor 继续返回 `stdout.trim()`；Codex 使用 execution 级临时文件读取最终消息，executor 路径不使用 `--ephemeral`，且绝不回退展示原始 stdout。
2. 将 `ExecutionProgressTracker` 收敛为 Skill 事件持久化与 verifier evidence 收集器，移除用户输出 callback、展示去重状态和无意义的清理生命周期。
3. Coordinator 不再写入 Executor 启动与过程行；每个 subtask 成功后追加一个包含完整换行的最终结果条目。MetaClaw completion 只保留耗时、摘要、下一步和产物信息，不重复正文。
4. TUI 在动态区域显示 `执行中.`、`执行中..`、`执行中...` 循环动画，终态立即消失；新的 Executor 最终结果条目整体渲染为蓝色。
5. 飞书优先解析新的最终结果块并收集本轮所有 subtask 结果，旧的逐行启发式解析仅作为兼容 fallback。

## 验收与测试

- 先反转 `tests/tui/execution-progress.test.ts`，确认旧实现会泄露 progress，再修复至通过。
- 覆盖 Codex 最终文件优先、空/缺失文件失败关闭，以及成功、非零退出、spawn error、idle timeout、abort 的临时目录清理。
- 覆盖普通 progress 不进入会话、重复 Skill 事件仍被持久化并作为 evidence。
- 覆盖多 subtask 各展示一次最终结果，completion 不重复正文。
- 覆盖文件型和非文件型交付、飞书新结果块提取与旧格式兼容。
- 运行 `npm run lint`、`npm run build`、Docker focused tests 和完整 Docker suite，并通过 SSH TUI 手工检查动画、颜色、长文本与终态清理。

## 明确不在本轮处理

- TUI-OUTPUT-002、TUI-OUTPUT-003。
- `SessionSnapshot.output` 的整体结构化迁移。
- MetaClaw 自身白色决策过程的精简。
- 非 Codex executor 的专用最终消息协议。
- MetaClaw 统一 executor 日志表、日志文件或 `/executor logs` 命令。

## 已选默认与约束

- Codex 容器版本锁定为 `0.144.1`。
- Codex executor 依赖隔离 `CODEX_HOME` 的原生 session/log；其格式、保留期和清理由 Codex 负责。
- 其他 executor 只统一隐藏实时过程，最终结果仍使用各自当前 stdout 合同。
- 最终回答完整显示，不做静默截断。
