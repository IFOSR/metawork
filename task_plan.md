# MetaWork 统一 Gateway 完整 Pi TUI 实施计划

依据: docs/plans/2026-09-19-unified-gateway-full-pi-tui-design.md
Baseline commit: 3723377

## 阶段

- [x] A: ADR-0041 单 TUI 收敛与只读 Gateway 查询
- [x] B: Gateway 契约缺口（2026-09-19）
  - [x] complete_command / get_task_view 命令、scope 规则、能力常量
  - [x] hello 能力声明（command_completion_v1 / task_view_v1）
  - [x] ClientGateway 只读分支：绕过持久 admission、有界回执缓存、幂等冲突、每连接限频
  - [x] read-only-query-handler：connection 流定向响应、targetConversationId、候选上限 50
  - [x] EventJournal.reserveSequence / lastSequence（高水位持久防复用）
  - [x] task-view.ts 安全 DTO；server-composition 共享投影 owner
  - [x] vendored 镜像与 GatewayClient API（buildEnvelope/submitEnvelope/新查询）
  - [x] web gateway-types 识别新事件 kind
- [x] C: Pi 组件解耦（2026-09-19）
  - [x] layout.ts（80x24/120x36/160x48 响应式 + 时长/静默）
  - [x] MetaWorkEditor（Enter/`\`+Enter/F1/F4/F5/F6/F7/F8/F9/Ctrl+C/Ctrl+D/Esc 语义）
  - [x] conversation-panel（多 Turn、结果 streaming/failed、历史缺失提示）
  - [x] task-dashboard-panel（选中 Turn 的 Task/Subtask/Attempt 投影）
  - [x] status-bar（头部/操作行）、permission-panel（仅焦点内 a/x）、help-panel
  - [x] root（正文并列与列宽钳制）
  - [x] conversation-selector 迁移到新目录并改用新模型（Git 可追溯）
- [x] D: 唯一客户端整合（2026-09-19）
  - [x] controller（提交固定 envelope、取消、权限、补全版本匹配、导航代际、断线恢复）
  - [x] completion-provider（pi-tui AutocompleteProvider ↔ Gateway 补全）
  - [x] preferences（仅 UI 偏好，MetaWork 配置目录）
  - [x] app.ts 唯一组件树 + 弹层/焦点；index.ts runMetaWorkTui 入口
  - [x] main.ts `--gateway-socket` 延迟导入新入口（旧 client mode 不再被引用）
  - [x] GatewayClient buildEnvelope/submitEnvelope
  - [x] 架构测试扩展（新 TUI 树依赖审计、入口延迟导入）
- [x] E: 删除简版/旧 InteractiveMode/Ink/client-ui.tsx/readline-client 与残留开关（2026-09-19）
- [x] F: native PTY 三尺寸验收 + smoke:clients/smoke:gateway 通过；Docker 因镜像仓库不可达未执行；真实 Planner/飞书依赖外部环境未执行

## 阶段 E/F 验证记录（2026-09-19）
- 主仓库删除 Ink（src/tui、client-ui.tsx、readline-client、ink 依赖、standby 开关）
- vendored 删除简版客户端与 InteractiveMode（31 组件 + 30 测试）；无 Gateway 交互调用明确失败
- 迁移测试：tests/commands/task-list、tests/session/resume-persisted-execution-context
- smoke:gateway 端到端通过且无遗留进程；smoke:clients 通过
- 真实 PTY 验收 80x24/120x36/160x48（权限面板、Turn 选择、补全、结果认证标签）
- 修复 product bug：WorkspaceRecord.canonicalPath 未被 reducer 识别
- 未执行：Docker（镜像仓库不可达）、真实 Planner/飞书（缺外部环境）

## 阶段 B/C/D 验证记录（2026-09-19）
- 主仓库：`tests/client tests/architecture tests/gateway tests/web tests/scripts` 461 项通过；
  唯一失败为基线既有 `tests/web/workspace-shell.test.ts`（HEAD 上同样失败）
- vendored 新增 TUI 测试 56 项 + gateway-client/selector/旧 client mode 共 83 项全部通过
- `npm run lint`、web `tsc --noEmit`、`npm --prefix planner/AnyFusion-Pi run build:offline` 通过
- smoke:clients 通过；smoke:gateway 仅基线 workspace-shell 失败
- 修复真实缺陷：权限面板未校验焦点即可响应 a/x；连接失败不再堆栈崩溃且不误报已连接

## 约束
- 不提交 github（全部变更保持工作区未提交状态）
