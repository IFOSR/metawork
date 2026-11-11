# 会话 Worktree 被 Workspace 入口校验误拒绝

- 日期：2026-10-30
- 状态：代码修复已部署；真实模型恢复等待用户重新登录
- 对应方案：[会话 Worktree 技术设计](2026-10-29-workspace-internal-git-session-worktree-technical-design.md)
- 完成日期：2026-10-30（代码修复与部署）
- 提交：未提交

## 现场与根因

北京天气 PPT、昆明天气 PPT 的首个检索 Subtask 在 2026-10-30
20:04（北京时间）启动准备阶段失败；同一天 17:12 的财报任务也有相同错误，早于
19:55 的会话状态简化版本重启。`dispatch_items.error_summary` 记录：

> 不能使用此目录作为 Workspace：…/.metawork/accounts/local-default/workspace-git/…/sessions/… 与 MetaWork 运行目录 …/.metawork 重叠。

`runDispatchItem` 先把 `request.workspacePath` 换为绑定的 `executionRoot`，
接着把它交给 `WorkspaceDirectoryService.preflightPath`。后者用于检查用户选择的
目录，禁止运行目录及其父子目录，是正确的入口约束；内部会话 Worktree 本来就放在
运行目录中，因此这里用了错误的校验对象。Executor 尚未执行，Kernel 将失败映射为
`configuration requires explicit recovery`；依赖检索结果的 PPT Subtask 无法继续。
界面只有 `Execution needs attention` 的标题，不能据此辨认原始原因。

## 修复

有 Conversation Git 绑定时，对 `binding.userRoot` 执行用户 Workspace 预检，保留
`binding.executionRoot` 作为 AttemptRunner 的执行源。AttemptRunner 原有的
binding fingerprint、Worktree registry、incarnation、Git common-dir 和受管分支
校验继续在执行前生效。不允许凭任意内部路径绕过入口校验，也不修改用户选中的目录。

未绑定 Conversation Git 的请求仍按原规则规范化并检查其 Workspace 路径。
失败任务通过现有恢复命令重试，不直接修改数据库状态、失败记录或 Git 绑定。

## 验证

- 回归覆盖普通用户目录、合法绑定内部执行目录、未登记内部路径、绑定中非法用户目录四种入口；验证正确路径确实传入 AttemptRunner，并保留 Executor 失败回执。
- Kernel 执行恢复测试 22 项通过；其余六组 AttemptRunner、执行上下文、Workspace Git、FIFO 合并和 Workspace Directory 测试共 75 项通过。
- `npm run lint`、`npm run build` 通过。
- 已部署 `0.1.20-build-5470ac9b-worktree-fix-1793362428340`，原端口 8788；安装后服务端全部构建文件与源码构建逐一校验一致，页面及 WebSocket hello 可用。
- 重启后 `/api/official-auth/status` 为 `logged_out`。当前官方账号登录仅保存在 Server 内存，真实执行恢复仍需用户重新登录。没有绕过授权、直接改数据库状态，也没有声称天气任务已经完成。登录后可在原会话继续，或用现有 `/task resume <taskId>` 恢复。

## 第二个现场错误：Executor 后端误选容器适配器

入口校验修复后，新的失败从准备阶段推进到了 Executor 启动阶段。最新失败 Attempt
的 `dispatch_items.error_summary` 为：

> ContainerCompatibilityAdapter requires a container execution backend

Conversation Git Worktree 的实际 Attempt 后端是宿主机路径模式（`pathMode:
'native'`；当前实现的后端类型为 `native`），而 `src/account/account-execution-services.ts`
此前只把 `kind: 'in_place'` 识别为本机 CLI。于是同一个宿主机后端被错误传给保留的
`ContainerCompatibilityAdapter`，它在启动时按契约拒绝非容器后端。这个错误与
Workspace 路径校验无关，也不是用户 Workspace 或 Worktree 注册损坏。

修复后的适配器选择以 `pathMode: 'native'` 为主条件，同时兼容历史
`in_place`、`native` 和 `worktree` 类型；只有容器路径模式才继续使用容器兼容适配器。
新增 AccountExecutionServices 回归断言，验证 Worktree 后端的 Pi Executor probe
确实可用，从而不会再走容器适配器。

## 第二次验证与部署

- `tests/account/account-execution-services.test.ts`、容器适配器和本机 CLI 适配器测试：27 项通过。
- `npm run lint` 通过。
- `npm run build` 通过。
- 已停止旧 Server，重新安装并启动最新源码版本：
  `0.1.20-build-5470ac9b-1793365047521`，端口仍为 `8788`。
- 已确认安装目录 `app/current/dist` 包含新的 native backend 路由逻辑，Server 状态为运行中。
- 旧失败 Attempt 保留原始失败事实，没有手工改成成功；要验证真实 Provider 执行，需在登录后重新提交或通过现有恢复入口继续任务。
