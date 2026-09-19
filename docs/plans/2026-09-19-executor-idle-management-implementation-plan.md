# 执行助手空闲态管理 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> 其他执行代理使用环境中可用的 `executing-plans` 技能；本文件不是执行授权。

**Goal:** 仅复用现有 Pi / Codex CLI，在账户完全空闲时提供执行助手增删改启停并热生效，忙时所有写入入口拒绝。

**Architecture:** 复用 ConfigurationService、ConfigurationRuntimeCoordinator 和 AccountRuntime 的配置激活流程。账户统一提供未结束工作事实并将配置事务与新工作接收互斥；助手定义保持单一配置权威，界面、CLI、规划目录和执行绑定使用同一生效结果。不新增运行中换配置或旧任务跨配置继续执行的机制。

**Tech Stack:** 当前仓库 Node.js / TypeScript ESM、Zod、Vitest、React/Vite Web、既有文件配置与 SQLite 运行事实；不新增运行依赖。

---

- 计划日期：2026-09-19
- 状态：待实施；严格空闲边界待确认
- 配套设计：[执行助手空闲态管理设计](2026-09-19-executor-idle-management-design.md)
- 基线参考提交：`3d87c2e`；实施时重新检查工作树与最新代码
- 当前交付：仅设计与实施文档，不含业务代码变更
- 实施完成日期、实际测试结果、收尾提交：待填写

## 1. 开始前的范围约束

1. 确认设计第 4 节：`created/ready/running/parked/blocked` 等可继续的任务都阻止配置修改，而不仅检查执行进程。
2. 不新增工具类型，只复用现有真实类型为 `pi-cli` / `codex-cli` 的工具配置；不按其配置键名推断类型。
3. 同时保护模型服务、模型与共享凭据写入，防止间接修改 Executor 的执行条件。
4. 不删除 revision 字段、历史版本或审计，不改 Work Graph / Completion Protocol 版本。
5. 不新增 Executor 数据库表、持久草稿、后台更新队列或第二写入权威。
6. 不编辑 standby Ink TUI，不重命名 AnyFusion/MetaClaw 兼容标识。
7. 每项先写失败测试、确认失败原因，再实现最小改动、跑绿并审查；建议独立 Conventional Commit。
8. 本计划中的新文件、类型、路由和测试名称是拟议实现，不声称当前已存在。

### 实施依赖

```text
任务 0：确认边界与架构记录
  -> 任务 1：严格空闲与互斥
  -> 任务 2：受控助手候选配置
  -> 任务 3：真实工具兼容性
  -> 任务 4：同工具多助手与刷新
  -> 任务 5：原子热激活和旁路保护
  -> 任务 6：Management API 与 CLI
  -> 任务 7：Web 管理闭环
  -> 任务 8：端到端验收与文档收尾
```

任务 1、5 的后端限制完成前，不开放用户可点击的写操作。
不要用多个代理同时修改 AccountRuntime、Server composition 或配置事务。

## 2. 任务 0：确认边界并记录架构变更

**修改文件：**

- `docs/adr/0033-hot-configuration-activation-and-auto-model-routing.md`
- `docs/adr/0028-agentclass-model-and-harness-routing-contract.md`
- `CONTEXT.md`
- `docs/current/technical-overview.md`
- 本设计与计划的状态字段

**步骤：**

1. 确认严格空闲定义，明确当前“暂停/阻塞任务不影响激活”条款会被修改。
2. ADR-0033 增补配置写入与工作接收互斥、五种助手操作、凭据写入和 CLI 同门禁规则。
3. ADR-0028 增补 Pi/Codex 固定工具范围、真实 `driverId` 判定、配置字段权限、Planner 保护。
4. 明确一个账户的所有会话共享门禁；不开启第二调度策略，不把管理锁塞进纯 Kernel。
5. 更新当前文档时区分“已接受目标”和“尚未完成实现”，交付后再填写已生效行为。
6. 若严格空闲边界不获确认，暂停后续实现并修订恢复方案，不带着矛盾继续开发。

**验证：** 人工交叉检查与 ADR-0020/0027/0031/0037 的职责和版本固定约束不冲突。

**建议提交：** `docs: define idle-only executor management contract`

## 3. 任务 1：严格空闲检查与工作接收互斥

**修改文件：**

- `src/configuration/configuration-activation-gate.ts`
- `src/account/account-runtime.ts`
- `src/account/account-runtime-ports.ts`
- `src/account/account-kernel-coordinator.ts`
- `src/gateway/client-gateway.ts`
- `src/gateway/conversation-gateway-runtime.ts`
- `src/server/server-composition.ts`

**测试文件：**

- `tests/configuration/configuration-activation-gate.test.ts`
- `tests/account/account-runtime.test.ts`
- `tests/account/account-kernel-coordinator.test.ts`
- 新建 `tests/gateway/configuration-admission-interlock.test.ts`

**步骤：**

1. 为 planning、排队请求、五类未结束任务、执行、publication、取消清理、启动/周期恢复分别添加拒绝写入测试。
2. 添加“只有客户端连接/历史查询时允许写入”测试，禁止直接复用把连接数当忙碌的 `isBusy()`。
3. 使用受控 Promise 测试两个方向的竞争：配置先拿锁时不能开始工作；工作先被接收时不能启动配置事务。
4. 运行测试确认现有实现失败；当前 `beginWork()` 只增加计数，现有门禁并没有对称阻止它进入。
5. 扩展现有活动事实，加入有界的未结束任务摘要与待处理业务请求计数；由 AccountRuntime 通过已有 port 收集持久事实。
6. 在已认证的新业务命令进入持久接收/会话队列之前，建立账户级工作 reservation；从接收、排队到 Planner 完成/任务持久化连续占用，不留下“尚未 beginWork”的空窗。
7. reservation 在拒绝、重复请求、成功、失败及断线重放时准确释放或恢复；启动恢复完成前禁止配置写入，不新建一个替代 Gateway inbox。
8. 配置事务占用同一个互斥入口，整个 validate/说明处理/probe/activate/内存刷新/补偿期间拒绝新业务工作。
9. 查询、登录、设置读取、任务取消不当作新业务工作阻塞；取消后的资源未清理完成仍阻止配置修改。
10. 定时恢复和 Kernel 事件 drainer 不在配置事务期间启动副作用；保持 Kernel 策略所有权，仅在应用入口延迟/拒绝进入。
11. 用明确事务上下文处理同一保存流程中的嵌套调用，不能让普通请求通过 `allowNested` 绕过互斥。
12. 跑绿并检查异常路径的 reservation、计数、定时器均无泄漏。

**建议事实契约：**

```ts
interface UnfinishedWorkSummary {
  count: number;
  items: Array<{
    taskId: string;
    status: string;
    conversationId: string;
  }>;
}
```

摘要有固定条数上限；`count` 包含全部记录。确切活动类型沿用 owner 的现有值类型，
不能复制另一套 Task 状态枚举。API 返回安全摘要，不泄漏原始日志和路径。

**运行：**

```bash
npm test -- tests/configuration/configuration-activation-gate.test.ts tests/account/account-runtime.test.ts tests/account/account-kernel-coordinator.test.ts tests/gateway/configuration-admission-interlock.test.ts
```

**通过条件：** 所有非空闲状态拒绝写入；任意并发顺序不出现规划/执行与配置切换重叠。

**建议提交：** `fix: serialize executor configuration changes with work admission`

## 4. 任务 2：定义受控助手候选配置

**新建文件：**

- `src/configuration/executor-configuration.ts`
- `tests/configuration/executor-configuration.test.ts`

**修改文件：**

- `src/configuration/configuration-service.ts`
- `src/configuration/schema.ts`
- `src/configuration/types.ts`
- `src/configuration/executor-manual-planner.ts`
- `src/configuration/configuration-completion-service.ts`

**步骤：**

1. 定义只包含用户字段的输入 Schema，拒绝额外字段和任意命令、路径、Driver、能力注入。
2. 添加 create/update/enable/disable/remove、未知 ID、目标为 Planner、修改执行工具、删除最后一个助手的测试。
3. 添加“同名显示名称可存在但内部 ID 不冲突”“删除重建产生新 ID”“表单不能覆盖其他助手/模型/Planner”的测试。
4. 实现纯候选构造器，通过 ConfigurationService facade 暴露，不自行写磁盘或接触运行时 Repository。
5. 从当前配置及真实 Driver 类型选择可复用工具入口；同类型多个入口时使用服务端明确模板映射，有歧义就报错，不按名字猜。
6. 创建助手时生成 `agentClassRef`、`generatedRuntimeRef`，从受控模板生成 affordances 与能力声明；字段规则不从用户职责文字中自由发明。
7. 本版工具类型创建后固定，已有权限方案引用可编辑，权限规则定义不可编辑。
8. 允许零助手/零启用助手，但保留一个合法 Planner，禁止通过助手接口改 Planner。
9. 支持停用助手的新增与编辑；引用和模型必须结构有效，但不要求未启用工具通过可执行性探测。
10. 接入现有能力说明分析回执；新助手必须可在候选配置中预览，回执仍绑定候选输入，过期回执不能复用。

**拟议输入契约：**

```ts
type ExecutorEditableFields = {
  displayName: string;
  modelPolicy: ModelPolicy;
  permissionProfileRef: string;
  manualSourceText: string;
  enabled: boolean;
};

type ExecutorConfigurationChange =
  | { operation: 'create'; tool: 'pi' | 'codex'; fields: ExecutorEditableFields }
  | { operation: 'update'; agentClassRef: string; fields: ExecutorEditableFields }
  | { operation: 'enable' | 'disable' | 'remove'; agentClassRef: string };
```

`ModelPolicy` 引用现有 Configuration 类型。输入不包含 `kind`、`harnessRef`、
自由 `routingCapabilities`、Skills、MCP 或 plugins。
候选返回当前 `baseRevisionId`、新助手 ID、候选配置及安全差异，不保存持久草稿。

**运行：**

```bash
npm test -- tests/configuration/executor-configuration.test.ts tests/configuration/schema.test.ts tests/configuration/executor-manual-planner.test.ts tests/configuration/configuration-completion-service.test.ts
```

**通过条件：** 五种操作产生合法且最小的候选变更，不能混入本版不开放的控制字段。

**建议提交：** `feat: prepare bounded Pi and Codex executor configuration changes`

## 5. 任务 3：用真实工具类型判断兼容性

**修改文件：**

- `src/configuration/projections.ts`
- `src/configuration/types.ts`
- `src/routing/configuration-candidate-projection.ts`
- `src/configuration/harness-driver-catalog.ts`
- `web/src/settings-model.ts`
- `web/src/components/SettingsPanel.tsx`

**测试文件：**

- `tests/routing/configuration-candidate-projection.test.ts`
- `tests/configuration/projections.test.ts`
- `tests/configuration/provider-catalog-routing-contract.test.ts`
- `tests/web/settings-workbench.test.ts`

**步骤：**

1. 创建使用自定义 Harness 键名、真实 Driver 为 Codex 的测试，确认仍执行现有 Codex Auto 规则。
2. 创建名字含 codex、真实 Driver 为 Pi 的反例，确认不被错误套用 Codex 规则。
3. 覆盖改显示名称、多个同工具助手、未知 Driver、Fixed/Auto 区别。
4. 在现有 Kernel-safe 配置投影中加入受控真实 Driver 标识或等价兼容性事实；纯 Kernel 不导入执行器实现。
5. 移除 `agentClassRef === ...`、`harnessRef.includes('codex')` 等类型猜测。
6. 服务端输出候选模型与拒绝理由；前端使用服务端结果，不保留另一套基于 Harness 名字的判定。
7. 原有 Fixed/Auto 业务政策不扩大；未知 Driver/不支持的协议失败关闭。

**运行：**

```bash
npm test -- tests/routing/configuration-candidate-projection.test.ts tests/configuration/projections.test.ts tests/configuration/provider-catalog-routing-contract.test.ts tests/web/settings-workbench.test.ts
```

**通过条件：** 相同真实工具与配置产生相同兼容性结果，与任何显示名或配置键名无关。

**建议提交：** `fix: resolve executor model compatibility from actual harness drivers`

## 6. 任务 4：助手名单刷新与同工具多助手执行

**修改文件：**

- `src/executor/agent-class-service.ts`
- `src/account/account-task-services.ts`
- `src/account/account-runtime-composition.ts`
- `src/account/account-runtime.ts`
- `src/execution/kernel-execution-runtime.ts`
- `src/execution/subtask-attempt-runner.ts`
- `src/configuration/agent-runtime-renderer.ts`
- `src/configuration/production-configuration-probe.ts`
- `src/executor/pi-cli-driver.ts`
- `src/executor/codex-cli-driver.ts`
- `src/server/server-composition.ts`

**测试文件：**

- `tests/executor/agent-class-service.test.ts`
- `tests/configuration/agent-runtime-renderer.test.ts`
- `tests/configuration/production-configuration-probe.test.ts`
- `tests/account/account-execution-services.test.ts`
- `tests/executor/pi-cli-driver.test.ts`
- `tests/executor/codex-cli-driver.test.ts`

**步骤：**

1. 复现启动时停用、激活后启用但 Service 仍返回 false 的问题。
2. 注入配置查询 port 代替构造时固定的 `agentClasses` 对象；实时目录读 active，已有带 revision 的执行检查保持精确匹配，不新增 active 兜底。
3. 添加同一 Server 下新增、改名、停用、启用、删除后目录和执行检查一致的测试。
4. 添加两个 Pi 助手和两个 Codex 助手使用不同模型的运行输入测试。
5. 验证 Driver 从当前授权中取得具体模型与权限，私有 home/工作目录独立；不使用某个内置助手的默认值来代替授权。
6. 修正 renderer 对 `pi-agent` / `codex-cli` 助手键的必要依赖，保持现有目录协议，只渲染工具公共事实或明确的授权输入。
7. 增加删除全部内置助手、仅保留自定义助手后仍可构造运行环境的测试；重启不重新种回已删除配置。
8. 生产探测只要求候选配置实际启用的助手所需工具可用；无启用 Codex 助手时不因机器未安装 Codex 阻止保存。
9. 共享同一 Driver 的探测可以去重，但模型和权限校验不能因去重被略过。
10. 不直接把助手动态健康写为 healthy；遵循既有 Kernel 状态事实路径。

**运行：**

```bash
npm test -- tests/executor/agent-class-service.test.ts tests/configuration/agent-runtime-renderer.test.ts tests/configuration/production-configuration-probe.test.ts tests/account/account-execution-services.test.ts tests/executor/pi-cli-driver.test.ts tests/executor/codex-cli-driver.test.ts
```

**通过条件：** 列表和实际执行一致；同工具多助手互不串模型；无内置名字也可执行。

**建议提交：** `fix: refresh executor catalogs and isolate same-tool assistant bindings`

## 7. 任务 5：受控热激活、失败补偿与写入旁路

**修改文件：**

- `src/configuration/configuration-diff.ts`
- `src/configuration/configuration-runtime-coordinator.ts`
- `src/configuration/configuration-service.ts`
- `src/configuration/production-runtime-bindings.ts`
- `src/server/server-composition.ts`
- `src/configuration/local-agent-credentials.ts`，仅调整运行时导入调用边界所必需的部分

**测试文件：**

- `tests/configuration/configuration-diff-classification.test.ts`
- `tests/configuration/configuration-runtime-coordinator.test.ts`
- `tests/configuration/production-runtime-bindings.test.ts`
- `tests/configuration/configuration-service.test.ts`
- `tests/management/server.test.ts`
- `tests/architecture/configuration-authority-cutover.test.ts`

**步骤：**

1. 为合法执行助手增删、既有权限引用变更添加 hot 测试；为 Planner 增删、工具变更、权限语法、任意命令添加拒绝测试。
2. 分类器检查变更前后完整结构，不仅靠路径正则；新增助手的整体对象不能借此夹带非法字段。
3. activate 先取得任务 1 的配置互斥，再运行说明编译、验证、探测、写入、激活和内存刷新。
4. 检查现有 `compileAll` 在 coordinator 外运行的位置，移入同一个配置事务上下文；不在持锁事务内部再计为普通业务工作。
5. active pointer、Planner 绑定、执行助手名单、运行绑定和就绪投影全部完成后才返回成功。
6. 对每个可能失败的 await 注入异常：编译、探测、revision 注册、指针切换、Planner refresh、执行视图刷新、事件通知。
7. 验证补偿后 active/running 版本、凭据和名单一致；补偿无法确认时保持账户阻塞，禁止新工作，不释放成“正常空闲”。
8. 完整配置 API、rollback、独立 Key 替换均复用门禁；Key 读取不再隐式导入凭据。
9. 对模型/Provider 的其他写入应用同样规则；只读目录查询保留，但任何会落盘的预热/导入移动到受保护阶段。
10. 保留历史版本和绑定 hash 检查；不新增跨历史 revision 恢复逻辑，不删除已知缺口的诊断。
11. 双窗口同 baseRevisionId 保存，一个成功、另一个冲突；网络超时后的重复保存不能重复新增助手。

**运行：**

```bash
npm test -- tests/configuration/configuration-diff-classification.test.ts tests/configuration/configuration-runtime-coordinator.test.ts tests/configuration/production-runtime-bindings.test.ts tests/configuration/configuration-service.test.ts tests/management/server.test.ts tests/architecture/configuration-authority-cutover.test.ts
```

**通过条件：** 成功响应就是完全热生效；任何失败不会产生可继续接收工作的半更新状态。

**建议提交：** `feat: atomically activate idle executor lifecycle changes`

## 8. 任务 6：Management API 与 CLI 共用 Server

**新建文件：**

- `src/client/configuration-admin-client.ts`
- `tests/client/configuration-admin-client.test.ts`

**修改文件：**

- `src/management/server.ts`
- `src/commands/configuration-admin.ts`
- `src/cli/admin-args.ts`
- `src/server/server-composition.ts`
- `web/src/api/types.ts`
- `web/src/api/http.ts`

**测试文件：**

- `tests/management/server.test.ts`
- `tests/commands/configuration-admin.test.ts`
- `tests/cli/admin-args.test.ts`
- 新建 `tests/integration/executor-configuration-entrypoints.integration.test.ts`

**步骤：**

1. 增加已认证的 GET executor 列表和 POST prepare 接口，激活复用 `/api/config/activate`；不新增业务请求通道。
2. 保持既有 cookie、Bearer、Origin 和请求大小保护；其他账户或未认证请求不能访问配置。
3. prepare 和说明分析按设计检查门禁；API 不相信调用方提交的 tool/permission 以外的底层值。
4. CLI 实现 `executor add/edit/enable/disable/remove/test`，list 使用同一 Server 投影。
5. add/edit 输入采用显式 `--file` UTF-8 JSON，文件只含受控用户字段；不执行文件内命令，不在参数中传 Key。
6. CLI 通过已验证 endpoint 的 loopback Web origin 请求现有 Management API，显式提供现有管理 token；建议用 `METAWORK_MANAGEMENT_TOKEN` 环境变量，禁止日志回显。
7. 替换 production admin 分支的直接创建 ConfigurationService/切换文件路径，所有用户配置写入经 Server；无法连接或认证时不回退离线写。
8. 将配置 rollback、Provider/Model mutation 和独立凭据修改的既有 CLI 入口同时接入门禁，不能只修 executor 子命令。
9. 明确命令退出码：成功为零；忙碌、冲突、校验失败、认证失败均非零且给中文原因。
10. test 只做受保护的工具可用性与配置检查，不以诊断接口绕过 Kernel 执行业务任务；模型真实业务执行在最终 smoke 中验证。

**拟议 CLI：**

```text
metawork executor list
metawork executor add --file ./research-assistant.json
metawork executor edit <assistant-id> --file ./research-assistant.json
metawork executor enable <assistant-id>
metawork executor disable <assistant-id>
metawork executor remove <assistant-id>
metawork executor test <assistant-id>
```

这是新增命令语法，需修改当前只接收一个 ID 的 parser，不声称现有 CLI 已支持。
旧 `anyfusion`/`metaclaw` binary 别名仍走同一受保护的实现，不形成旁路。

**运行：**

```bash
npm test -- tests/client/configuration-admin-client.test.ts tests/management/server.test.ts tests/commands/configuration-admin.test.ts tests/cli/admin-args.test.ts tests/integration/executor-configuration-entrypoints.integration.test.ts
```

**通过条件：** Web、CLI、直接 API 对同一操作给出一致结果；Server 忙碌时没有直接文件写入。

**建议提交：** `feat: route executor administration through the live server`

## 9. 任务 7：Web 助手管理闭环

**新建文件：**

- `web/src/components/ExecutorEditorDialog.tsx`

**修改文件：**

- `web/src/components/SettingsPanel.tsx`
- `web/src/components/AgentClassConfig.tsx`
- `web/src/components/AgentReadinessBanner.tsx`
- `web/src/settings-model.ts`
- `web/src/api/http.ts`
- `web/src/api/types.ts`
- `src/server/server-composition.ts`，仅新工作就绪投影
- `src/management/agent-installation-readiness-service.ts`，仅安装事实与助手状态展示分离

**测试文件：**

- `tests/web/settings-workbench.test.ts`
- `tests/web/executor-health.test.ts`
- `tests/management/agent-installation-readiness-service.test.ts`
- `tests/e2e/settings-workbench-browser.test.ts`
- 新建 `tests/e2e/executor-idle-management-browser.test.ts`

**步骤：**

1. 沿用现有设置页视觉和命名，不重做整体 UI，不把 Driver/Harness/revision 暴露成普通用户必填项。
2. 新增助手弹窗提供名称、Pi/Codex、模型策略、说明、已有权限、启用状态；模型选项使用后端兼容性事实。
3. 原有助手卡片加入编辑、启用/停用、删除；执行工具只读，删除需明确确认。
4. 保存前 prepare，再按既有能力说明回执流程预览/确认，最后 activate；创建助手不能依赖 `originalAgentClasses[ref]` 已有全部字段。
5. 账户忙碌时全部写控件禁用并显示安全阻塞原因；运行状态事件到达时立即更新，不只在打开页面时检查。
6. 后端拒绝后保留本地输入但不乐观更新列表；冲突要求刷新，不自动覆盖别人修改。
7. 显示名可修改；卡片 key、编辑目标、请求关联始终用稳定 ID。
8. 区分“已停用”“工具未安装”“最近执行失败”，同一个 Pi 安装状态可以供多名助手使用。
9. 零助手/零启用助手时显示设置引导，新工作入口在服务端拒绝且可解释；历史、登录和设置继续可用。
10. 验证桌面和窄屏的弹窗、错误说明、长名称、删除确认均可操作。

**运行：**

```bash
npm test -- tests/web/settings-workbench.test.ts tests/web/executor-health.test.ts tests/management/agent-installation-readiness-service.test.ts
npm run build --prefix web
npm test -- tests/e2e/settings-workbench-browser.test.ts tests/e2e/executor-idle-management-browser.test.ts
```

浏览器测试环境按仓库既有 suite 组织；若缺少浏览器/服务依赖，记录未执行原因，
不能用字符串断言替代页面交互验收。

**通过条件：** 用户不懂内部术语也能完成五种操作；界面结果与下一次执行事实一致。

**建议提交：** `feat(web): manage Pi and Codex assistants while idle`

## 10. 任务 8：生产边界验收与收尾

**新建文件：**

- `tests/integration/executor-idle-management.integration.test.ts`

**修改文件：**

- `tests/e2e/hot-activation-auto-routing.test.ts`
- `tests/architecture/configuration-authority-cutover.test.ts`
- `tests/configuration/configuration-module-boundary.test.ts`
- `tests/executor/executor-module-boundary.test.ts`
- `docs/current/technical-overview.md`
- `CONTEXT.md`
- `docs/README.md`
- 本设计和实施计划的状态、验收、完成与提交记录

**步骤：**

1. 使用隔离的 Account/config/credentials/workspace 测试根目录，禁止覆盖操作者真实配置。
2. 集成测试启动真实 Server 装配路径，执行工具使用受控 fixture，验证的是实际配置消费者而非只 mock `onActivated`。
3. 记录 PID，空闲新增同工具两个助手，配置不同模型，检查下一次规划目录和实际 launch binding；PID 始终不变。
4. 规划中、排队中、执行中、publication 中、取消清理中，从另一客户端尝试五种操作与直接 Key 写入，全部拒绝。
5. 测试暂停/阻塞任务在无进程时仍阻止修改，取消并清理后允许；完成澄清但无任务不阻止。
6. 测试保存与新请求、定时恢复、断线 replay 的竞争，验证无任务读取半切换配置。
7. 测试删除内置助手、只用自定义助手、重启后不复活；恢复同一 active revision 的普通未结束工作保持既有行为。
8. 注入残留跨历史 revision 任务，验证拒绝配置写入并展示诊断，不强行改绑定或假报恢复成功。
9. 测试零助手时新业务请求明确拒绝；配置失败与补偿失败的行为符合任务 5。
10. 检查模块依赖，不允许 UI/CLI 直接操作 Repository，不允许 Configuration 导入 Kernel 策略或 Executor 实现。
11. 运行 lint、focused suites、Web build、native smoke；涉及持久事实/执行边界同时运行 Docker 回归。
12. 汇总已执行和未执行的门禁，更新文档后再报告功能交付；文档记录建议提交的实际 hash，不编造“通过”或完成日期。

**完整验收矩阵：**

| 场景 | 预期 |
| --- | --- |
| Planning 尚无 Task 记录 | 拒绝所有配置写入 |
| 新工作已接收尚未开始 Planner | 拒绝，不存在队列空窗 |
| 任一会话执行/等待/清理 | 账户范围拒绝，不只当前会话 |
| 全空闲新增/编辑/启用/停用/删除 | 保存成功，下一次工作立即生效 |
| 两个窗口同时保存 | 一个成功，一个 revision conflict |
| 两个同工具助手选不同模型 | launch 的模型与各自授权一致 |
| Codex 自定义键名 / Pi 名字含 codex | 兼容性依据真实工具，不受名字影响 |
| Codex 未安装且无启用 Codex 助手 | 不阻止 Pi 助手的合法更新 |
| 删除最后一名助手 | 设置仍可用，新业务明确拒绝 |
| 修改共享 Key 或触发自动凭据导入 | 不能绕过忙碌门禁 |
| CLI 连接失败、未认证、旧别名调用 | 不回退直接写配置 |
| 模型/说明/探测/刷新失败 | 原配置保持一致，或进入明确阻塞状态 |
| 取消任务刚返回但进程未退出 | 继续拒绝，直至清理确认 |
| 历史任务查看与产物读取 | 不因删除助手而丢失 |

**运行：**

```bash
npm run lint
npm test -- tests/configuration tests/routing tests/account tests/executor tests/commands/configuration-admin.test.ts tests/integration/executor-idle-management.integration.test.ts tests/integration/executor-configuration-entrypoints.integration.test.ts
npm run build --prefix web
npm test -- tests/e2e/hot-activation-auto-routing.test.ts tests/e2e/executor-idle-management-browser.test.ts
npm run smoke:gateway
npm run smoke:metawork
npm run smoke:metawork -- --scenario artifact
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

native smoke 必须确认其配置根与账户是可用于验收的隔离环境；真实模型调用可能产生费用。
Docker/网络/模型不可用时记录 blocked 的具体验收项，不把未执行写成通过。
若实施意外需要持久化 schema 变化，先更新 ADR、migration、repositories 与 Docker 测试，
不得把 schema 变化隐藏在本来承诺“无新增助手表”的任务里。

**建议提交：** `test: verify idle executor management across runtime boundaries`

## 11. 交付检查表

- [ ] 严格空闲定义得到确认，并更新 ADR-0033。
- [ ] 五种助手写操作在整个账户忙碌时均拒绝。
- [ ] 排队、恢复、取消收尾和已接收请求没有门禁空窗。
- [ ] 新工作与配置事务有对称互斥，而不只是 UI 禁用。
- [ ] 用户只选择 Pi/Codex 和已有权限，没有新工具/插件范围膨胀。
- [ ] Web、CLI、完整激活、回滚、共享凭据写入共用 Server 保护。
- [ ] 新增与启用后，规划目录、执行检查和真实模型绑定立即一致。
- [ ] 名称不参与判断 Pi/Codex 类型。
- [ ] 同工具多助手隔离，删除内置名字不破坏其他助手。
- [ ] 不新增旧任务跨配置继续执行机制，也不破坏历史审计与安全检查。
- [ ] 失败补偿及故障阻塞有行为测试。
- [ ] 真实 native、浏览器和 Docker 验收结果如实记录。
- [ ] 填写完成日期、交付行为、验收记录及收尾提交后再关闭计划。
