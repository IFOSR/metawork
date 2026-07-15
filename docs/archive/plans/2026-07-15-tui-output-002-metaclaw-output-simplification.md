# TUI-OUTPUT-002：简化 MetaClaw 规划与调度输出

- 状态：completed
- 计划日期：2026-07-15
- 完成日期：2026-07-15
- 实施提交：本计划的 closing commit

## 目标

- 从共享 session 输出源移除 PlanningAgent、PolicyKernel、Runtime、上下文构建和 Work Unit 的内部诊断文本。
- 永久保留蓝色阶段标题、实际 Executor 派发说明、Executor 最终结果和绿色任务汇报。
- clarification、reject 和运行失败仍提供精简、可行动且不泄露内部 reason 的用户提示。

## 实现约束

- `SessionSnapshot.output` 继续使用 `string[]`，本轮不引入结构化 presentation event。
- 普通对话只显示 `【MetaClaw｜理解用户请求】` 和最终回答。
- 任务执行保留三个上下文阶段标题；实际 Work Unit claim 后，每个真实 Executor 在同一任务中只显示一次派发准备块。
- 不处理“不确定记忆”“任务队列前五”面板，不处理 TUI-OUTPUT-003。
- 所有渠道消费同一精简投影，不在 TUI 或飞书增加字符串黑名单。
- 规划决策、task event、work-unit event 和 Skill evidence 的结构化审计保持不变。

## 测试与验证

- 按普通对话、任务执行、实际 Executor 路由、异常/澄清、跨渠道顺序执行纵向红—绿回归。
- 运行 `npm run lint`、`npm run build`、Docker focused tests 和 Docker 全量测试。
- 通过真实 SSH TUI 检查阶段颜色、输出顺序、多 subtask 与终态结果。

## 完成记录

- 普通对话只保留 `【MetaClaw｜理解用户请求】` 与最终回答，不再显示意图分类、执行策略或 PlanningAgent/PolicyKernel 过程。
- 任务执行保留三个 MetaClaw 上下文阶段标题；任务创建、召回数量、偏好注入详情、Runtime 路由、Planner dispatch 与 Work Unit 生命周期行已从共享 session 输出移除。
- Executor 派发块改为在 Work Unit 实际 claim 后生成，同一任务中每个真实 Executor 只宣告一次；候选回退时不会误报 planner 偏好的 Executor。
- clarification 与 reject 改为精简、可操作的用户提示；高风险确认不再泄露 `risk confirmation required`，原始 reason 仍保留在结构化审计中。
- TUI、脚本会话与飞书均消费同一精简投影；历史飞书格式解析仍保留兼容。

验证结果：

- `npm run lint`：通过。
- `npm run build`：通过。
- Docker focused regression：9 个文件、119 个测试通过；旧验收合同更新后 7 个文件、28 个测试通过。
- `docker build -f Dockerfile.test -t metaclaw-test .`：通过。
- `docker run --rm metaclaw-test`：172 个测试文件通过、2 个跳过；758 个测试通过、4 个跳过。
- 未重启当前用户的 `metaclaw-shell` 容器；真实 SSH TUI 的部署后实机复查留待新镜像切换时执行，本轮已由 Docker Ink/TUI、脚本和飞书回归覆盖输出顺序与边界。
