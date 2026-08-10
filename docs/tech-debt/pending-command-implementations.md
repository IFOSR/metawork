# 待实现命令与未来能力

> 状态：活跃  
> 创建日期：2026-07-13  
> 约束：本文件只登记缺口，不代表已经承诺最终命令路径。

## 1. 已进入命令树的可见占位

当前没有可见占位命令。原有登记已按以下方式处理：

- `/executor show <executorName>` 已实现为 AgentClass 静态配置、runtime binding 和活跃 WorkUnit 查询，不执行健康探测。
- `/task history <taskId>` 已实现为指定任务最近 20 条持久化交互与任务事件查询；旧的无参数全局历史入口已删除。
- `/executor feedback <taskId>` 已实现为指定任务的 Planner、ControlKernel、WorkUnit 和 Executor 事实查询；旧的无参数最近事件入口已删除。
- `/executor route <taskDescription...>` 已从命令树删除，不保留 alias、占位或迁移映射。

Command 的职责限定为执行确定操作，或查询已经存在的确定事实。针对假设任务描述进行模糊规划或路由预演不属于 Command 职责，应由正式 PlanningAgent 流程或未来独立交互形态承担。

## 2. 尚未进入命令树的未来能力

以下能力仍需独立设计，不在第一阶段新增功能范围内，也暂不确定最终命令路径：

- 显式创建新任务，以及已有运行任务时的排队策略。
- 队列查看、人工排序、优先级和截止时间控制。
- 指定 Executor 的正式派发与任务交接。
- 受只读权限约束的 Executor 直接咨询；不提供绕过 PlanningAgent、ControlKernel、Task Persistence 和 Execution Runtime 的裸聊天通道。
- 调度决策解释、任务事件、产物、重试、归档和焦点切换。
- 危险批量操作的影响预览与确认协议。

相关候选项继续在 [任务指挥、命令系统与 TUI 用户体验优化清单](./task-command-and-tui-ux-backlog.md) 中跟踪。
