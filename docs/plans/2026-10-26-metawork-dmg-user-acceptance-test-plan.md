# MetaWork 0.1.19 DMG 用户验收测试方案

Status: Ready for local UAT  
Plan date: 2026-10-26  
Build: `main` / `6cf72e33eacf63beced54bebfcafc3fdaccd1dc1`  
Artifact: `apps/desktop/release/MetaWork-darwin-arm64.dmg`

## 测试目标

从用户视角验证当前 macOS DMG 的安装、启动、Provider 配置、Workspace
原地执行、六态 Task、Memory、恢复和 Desktop/Web 一致性。测试以当前代码和
接受的 ADR 为准，不把旧的 `/memory`、`/learning` 指令或隐式 Worktree 行为
当作当前产品契约。

## 安装和基础检查

1. 双击 DMG，把 `MetaWork.app` 拖到 Applications。
2. 首次打开若被 macOS 拦截，在“系统设置 → 隐私与安全性”允许打开。
3. 确认应用窗口标题、Dock 名称和 Web 页面均为 MetaWork。
4. 配置一个可用 Provider 和模型，发送一轮普通对话。
5. 退出并重新打开，确认账号、配置、会话和 Workspace 仍然存在。
6. 在设置页观察“保存并激活”的结果。所有修改先是草稿，只有激活成功后
   才成为新的配置 revision；激活失败时必须按错误提示处理，不能把页面上的
   草稿状态当作已保存。

## Workspace 和 Harness 对齐测试

先准备临时目录并在客户端绑定：

```bash
mkdir -p /tmp/metawork-uat
```

```text
/workspace /tmp/metawork-uat
```

| 编号 | 用户案例 | 通过标准 |
| --- | --- | --- |
| W1 | 新建 `hello.md` 并写入内容 | 文件直接出现在原 Workspace，没有候选目录或隐式 Worktree |
| W2 | 修改已有文件 | 原文件直接变化，before/after 记录可查看 |
| W3 | “分析项目，不修改文件” | 不产生 Workspace 写入 |
| W4 | 要求写入 Workspace 外部绝对路径 | 被拒绝，不能越过路径 containment |
| W5 | 第一轮创建文件，第二轮继续修改 | 多轮会话复用同一个 Workspace |
| W6 | 两个 Conversation 同时修改同一文件 | 一个持有资源执行，另一个等待；释放后继续，不静默覆盖 |
| W7 | 明确要求隔离目录 | 不自动创建隐式 Worktree，应提示选择另一个 Workspace 或明确目录 |

## 六态 Task 测试

### 成功

```text
在当前 Workspace 创建 result.txt，内容为 task succeeded。
```

确认 Task 从等待/执行进入成功，`/task show <taskId>` 能看到结果、交付和
执行记录，重启后结论不变。

### 确定失败和 retry

先占用一个端口：

```bash
python3 -m http.server 18765
```

然后要求启动同一端口的服务。确认 Task 为 `failed`，原因明确。释放端口后
执行：

```text
/task retry <failedTaskId>
```

原 Task 保持失败，新 Task 执行未完成的交付或服务要求并成功。

### `needs_action`、接受结果和重新执行

提交一个需要外部凭据或用户授权的任务，例如把生成物发布到需要登录的
GitHub Release。缺少凭据时应进入 `needs_action`，并显示需要补充的材料。

```text
/task resume <taskId> <材料路径...>
/task accept-result <taskId>
/task retry-result <taskId>
```

`accept-result` 只接受已有结果并完成发布/交付检查，不重新调用 Executor；
`retry-result` 保留原 Attempt 并创建新的执行 Attempt。

### 取消和终态

让一个任务持续运行，然后执行：

```text
/task cancel <taskId>
```

确认任务进入 `cancelled`，重启或后台恢复不会自动重跑。对 `succeeded`、
`failed`、`cancelled` 任务执行 resume 不会原地复活；需要重做时必须 retry
或创建新任务。

### 服务健康门

分别测试一个能正常响应的 HTTP 服务和一个端口冲突/启动即退出的服务。
使用以下命令查看结果：

```text
/service status <serviceId>
/service logs <serviceId>
```

只有健康检查通过才算服务要求完成；启动失败、健康检查失败必须显示明确
原因。

## Memory 测试

Memory 通过设置页的“记忆”开关和抽取模型配置管理。当前产品不再使用
`/memory`、`/learning` 或 profile preference 指令。

### 开启和跨会话召回

1. 设置页打开“记忆”。
2. 选择已配置且支持 `structured-output` 的抽取模型。
3. 保存并激活，确认无需重启即可显示 enabled。
4. 会话 A 输入：`以后请使用中文，并优先用 Markdown 表格输出。`
5. 新建会话 B，要求整理一份销售周报。

确认新会话能够按该偏好输出，Memory 管理页能看到对应资产。

### 禁用和关闭

- 禁用单条记忆后，新会话不能继续使用该记忆。
- 完全关闭 Memory 后，不启动 sidecar、不发送 Memory 请求、不产生新资产。
- Memory 关闭或不可用时，普通对话和普通任务仍可运行。

### sidecar 和 evidence

- sidecar 停止或地址错误时，Memory 应显示 unavailable/degraded，任务不能因
  Memory 故障而失败。
- Planner 引用记忆后，在任务详情/执行轨迹中确认它以结构化
  `long_term_memory` evidence 传递，而不是直接拼入普通 prompt。
- 不要在偏好测试中放入真实 API Key、密码或生产数据。

## Desktop/Web 一致性

同时打开 Desktop 和 Web，连接同一个本地 Server：

1. Desktop 创建任务。
2. Web 查看 `/task list`、`/task show <taskId>`。
3. Web 取消或 retry，回到 Desktop 查看状态。
4. 刷新和重启两个客户端。

两个客户端必须以 Server 的持久化状态为准，Task 结论、Workspace 文件和
Memory 管理状态不能出现分歧。

## 建议执行优先级

### P0

启动、Provider、Workspace 原地写入、成功 Task、失败 retry、Memory 开关、
普通对话。

### P1

`needs_action`、accept/retry-result、取消、服务健康门、路径越界、并发
Workspace、重启恢复。

### P2

sidecar 不可用降级、结构化 Memory evidence、Desktop/Web 并行、旧指令被拒绝。

## 当前已知问题和回归检查

### Provider 显示和凭据回填

`/api/config` 是已激活配置的权威来源；`/api/config/completion` 还会返回
公开 Provider preset。因此页面里出现一个没有模型的 `deepseek`，可能只是
“可添加的公开 preset”，不一定是激活配置中的第二条 Provider。回归时同时检查
这两个接口，确认 UI 能区分“已配置连接”和“可添加 preset”。

当前启动流程仍会对 `code-cli`、`kimi`、`deepseek` 这三个固定 ref 尝试从本机
Agent 导入凭据。修正时应让导入只服务于已配置或明确启用的连接，避免启动过程
制造孤立的凭据记录。删除 Provider 的凭据清理必须在“保存并激活”成功后执行，
并且只清理没有被其他模型或 Provider 引用的 secret。

### 激活落盘

删除 Provider 只修改草稿；必须点击“保存并激活”，并确认成功 revision。若激活
失败、revision 冲突、存在运行中任务或模型校验失败，应保留当前激活 revision，
清楚显示失败原因，不让 UI 看起来像已经删除成功。

### TDAI Memory sidecar 发布问题

当前发布链路的 release manifest 只有 `metawork` 和 `planner` 两个 artifact，
`resolveMemorySidecarCommand()` 也只查环境变量目录和
`<installRoot>/memory/tdai/src/gateway/server.ts`。因此 DMG/安装目录没有
Memory sidecar 时，Memory 开关只能进入不可用状态。

修正发布链路时应按以下顺序落地：

1. 固定 TDAI upstream commit 和依赖版本，并把 LICENSE/NOTICE 一起纳入发布物。
2. 优先在 CI/打包阶段按 commit 拉取并校验源码和 hash，避免把数百个依赖直接
   放进主仓库；只有离线构建和供应链要求明确时再 vendor 到仓库。
3. 预编译 sidecar 为 `dist/gateway/server.js`，同时让 resolver 支持生产
   `dist` 入口；开发环境继续支持 `src` + `tsx`。
4. release manifest 增加 `memory` artifact、revision、大小、SHA-256 和兼容性
   校验；安装器、原生 macOS 安装、Desktop 打包和更新器全部解包到
   `<releaseRoot>/memory/tdai`。
5. CI 在打包后实际启动 sidecar，断言 `/health` 返回
   `stores.ftsAvailable === true`。引擎缺失和 FTS5 不可用必须在 UI 中显示为
   两种不同状态。
6. 保持 ADR-0049 的关闭语义：Memory 关闭时不启动进程、不发送请求、不产生模型
   成本；sidecar 故障不能让普通任务失败。

## 测试记录

测试人：  
测试日期：  
DMG SHA-256：  
Provider/模型：  
Memory sidecar 版本/commit：  
失败案例和日志位置：
