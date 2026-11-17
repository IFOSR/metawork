# 接受结果后的交付与状态修复

- 日期：2026-11-17
- 状态：实现与专项验证完成，用户已授权提交 GitHub；未部署
- 完成日期：2026-11-17
- 事故：Conversation `conv_0O9GzLfosm61`，调查表任务于 13:43:41 接受后，总任务 queued、最后子任务 awaiting_decision。交付重复失败于临时输入与封存文件集合不一致。
- 首次阻塞根因补充：原提示词要求只有零变更编辑才提供 noChangeReason，解析器却无条件必填；这是系统提示与解析契约矛盾，不能把协议修补责任转给用户。
- Closing commit：本记录所在提交 `fix(execution): normalize completion metadata and reconcile accepted delivery`。

## 实施范围

1. Workspace 文件边界由共享纯函数定义，变更采集、持久观察读取与 Git 封存排除 Runtime 临时目录；业务文件仍须匹配封存内容。旧观察只做读取投影，不重写历史。
2. Storage 提供当前 generation 的精确接受后交付事实；Task Domain 从这些事实统一计算进行中及失败状态，Runtime 在交付失败时协调状态。失败不再无限静默重试；用户可重试同一已接受结果的交付。
3. TaskView、Web 节点文字与颜色、独立任务轨迹、持久化页面快照共享接受后交付事实与恢复入口。命令保持原有精确结果身份校验，不再启动 Executor；失败显示「交付受阻」，待交付显示「待交付」，不改写历史执行回执。
4. 根据用户反馈，完成回执解析自动把省略的 noChangeReason 归一化为 null；报告或已产生实际变更的编辑不再因此触发用户确认。提示词只在零变更编辑时要求解释。实际交付物、证据、Workspace delta 与安全检查继续生效，不默认接受不完整结果。

用户交互边界：用户确认用于解决结果/需求/选择的不确定性，不用于批准内部协议格式。确定性的格式省略由系统处理；无法确定的元数据仍走既有有界补正，不能凭空补出业务证据。本轮具体落实 noChangeReason 的确定性默认值，未将所有 completion_malformed 一概视为成功，也未重写已有历史回执。

所有运行期变更通过现有 TaskStateAuthority、结果身份和 outbox 边界；不增加语义路由，不绕过文件/安全检查，不修改用户真实数据库或已安装服务。

## 验证结果

- 最新核心专项 11 文件 / 146 测试通过：接受→交付失败→needs_action→显式重试→节点 done；重复接受幂等，原接受记录保留，无新增 Executor 回执；过期结果、generation、终态与后继结果不恢复旧按钮。包含提示词和新增的 9 个完成协议场景：报告文件/编辑文件/纯文本回答省略 noChangeReason 仍认证；零变更编辑仍缺说明，缺文件、缺证据、未知/截断 delta、非法字段值仍不认证。
- 实际 SQLite + Git 验证：历史临时输入不会导致误报；业务文件修改、缺失、伪造 hash 均拒绝；历史观察字节不变。
- 全部 Web 测试 61 文件 / 402 测试通过，包含待交付节点文字和颜色覆盖旧阻塞投影、失败恢复入口。
- npm run lint 与 npm run build 通过；git diff --check 通过。
- maintained-host 全量入口 npm test -- --bail=1 已尝试，但在既有 tests/session/span-routing-session-integration.test.ts 首个失败停止：测试夹具缺少 runtimePort.turnCancellations，导致 ConversationSession.cancelActiveTurn 读取 request 失败。该测试和实现均未在本修复中修改；不声明全量测试通过。
- 修改涉及的两个投影测试同步既有契约：ExecutionProjector 夹具由已移除的 decisionRepo 转为 dispatch 授权事实；WorkGraphPresentationProjector 的旧 Codex CLI 显示名称断言改为当前通用 Codex Harness 回退名称。未恢复退役路由或驱动。

## 事故只读复验与恢复边界

以只读方式读取原任务的 workspaceDelta 与封存标识，将校验所需事实复制到内存 SQLite，使用修复后的解析和真实 assertSealedDelta 检查原封存及当前工作区。原 3 个路径投影为 1 个业务路径 deliverables/企业知识库需求调查表.md，完整性校验通过。该结论说明现有报告通过了本次失败点的校验，可以用于后续重试交付；不等于已完成整条真实任务交付。

本次修复没有升级正在运行的安装实例，也未修改原 Task、outbox 或用户文件。用户验证并升级后，原 uncertain 交付会投影为待处理，可通过「重试交付」复用原接受决定和结果继续现有发布流程；后续交付仍执行原有完整性与结果身份检查。用户于 2026-11-17 明确授权将本轮代码提交到 GitHub，覆盖此前仅保留本地的限制；运行实例升级和真实任务交付不属于此次提交。
