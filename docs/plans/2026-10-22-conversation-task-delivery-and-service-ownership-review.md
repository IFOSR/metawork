# 会话-任务-交付模型：故障复盘与改造方案

- 日期：2026-10-22。
- 状态：待评审，未实施。本文只定义问题、判据与改造目标，不代表源码已经符合目标。
- 取证对象：本机两套安装（`~/.metawork`、`~/.metawork-guangda`）的日志与 SQLite 数据库副本，以及本地工作区源码（含尚未提交的受管服务与公开交付实现）。
- 架构边界：[ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md)、[ADR-0021](../adr/0021-work-graph-v4-subtask-execution-contract.md)、[ADR-0022](../adr/0022-unified-kernel-control-plane-and-decision-ledger.md)、[ADR-0025](../adr/0025-single-task-concurrency-and-git-publication.md)、[ADR-0035](../adr/0035-workspace-scoped-conversation-organization.md)。实施批准前，现行 ADR 与 [`CONTEXT.md`](../../CONTEXT.md) 仍是现行系统依据。
- 完成日期、验收证据、关闭提交：待实施完成后补录。

---

## 0. 结论摘要

**问题分两层。**

1. **平台级空转与失明（A）**：25ms 全表轮询、日志无堆栈、成功也打日志。与任务内容无关，任何安装、空闲状态都发生。
2. **结构性作用域错位（决定性）**：会话里每一轮都会**新建**四样东西——工单、交付目录、服务登记、经验卡。"每一轮是新的一次改动"是对的；"每一轮是一个新工程"是错的。用户理解的是"一个会话、一件事"，系统执行的是"一个会话、N 个互不相识的工程"。

**决定性的不是 A，而是第二层。** 只要这四样跟着每轮一起新建，任何"接着上一轮继续做"的需求都会反复撞到同一批拒绝：服务归属不符、任务已终态、交付哈希不符、目录无法寻址。同一条拒绝还会在最坏的入口留下不可收敛的残留，把整个会话永久堵死。

---

## 1. 取证方法与证据来源

| 证据类型 | 采集方式 | 说明 |
| --- | --- | --- |
| 运行日志 | `~/.metawork/logs/desktop-server.log`（20,267 行）、`~/.metawork-guangda/logs/server-9001.log`（1,013,753 行） | 逐行分类统计，见附录 A |
| 数据库 | 用 `better-sqlite3` 的 `backup()` 备份到临时目录后只读查询，未修改运行中的库 | 全部结论可复现 |
| CPU | `process.cpuUsage()` 计时 + `ps` 采样 | 见 A1 |
| 维护路径复现 | 用 esbuild 打包 `createAccountEventJournal` 等模块，对数据库副本跑维护循环 | 见 A2 |
| 交付目录 | 直接检查 `<workspace>/metaclaw-tasks/*` 与 `managed-services/*.log` | 见 A5、3.3 |

---

## 2. A：平台级缺陷

### A1. 25ms 永动扫表，无退避

**现象**：没有任何待办工作时，后台仍以 40 次/秒的频率查询数据库。

**代码位置**

- `src/server/account-event-journal.ts:42`：`intervalMs: 25`（硬编码）
- `src/gateway/event-journal-maintenance.ts:38-50`：每轮结束无条件重新 `setTimeout(25ms)`，不区分"这一轮有没有活"
- `src/storage/event-journal-segment-index-repo.ts:75`：每 tick 至少执行一次跨 6 张表的 `UNION` 查询（`gateway_journal_streams`、`conversation_history_streams`、`conversation_read_rebuilds`、`conversation_read_heads`、`conversation_read_history_dirty`、`conversation_metadata_projection`）

**实测**

| 观测项 | 数值 |
| --- | --- |
| 只跑维护循环、库内零待办，20s 内 CPU 时间 | 0.74s（单核 3.7%） |
| 运行中的 server 进程空闲 CPU | 14.5%（其余来自 100ms/250ms 的另外 4 个定时器） |
| guangda 实例空闲 CPU | 6.2%（约 373 分钟 / 3 天，与外部观测一致） |
| 日志放大效应 | guangda 实例累计 **1,008,612 行**同一维护错误 |

**影响**：任何安装、任何状态下持续消耗 4%–15% 单核；错误被 40Hz 放大成百万行日志，直接吃掉磁盘与排查能力。

**修复方向**：无待办时退避到 1s；`nextStream` 返回空时退避；错误按 `(conversationId, message)` 限速；理想形态改为事件驱动（append 时唤醒），而非全表轮询。

---

### A2. `Cannot read properties of null (reading 'length')` 反复触发

**现象**：Gateway 日志维护周期性报错，与任务活跃期强相关。

**证据**

- `~/.metawork/logs/desktop-server.log`：**4,057 行**完全相同的 `Gateway journal maintenance failed: Cannot read properties of null (reading 'length')`
- `docs/plans/2026-10-13-metawork-real-task-acceptance-report.md:139` 已把同一错误记录为"P1：只记录，不修复"，解释了"跨约两周反复出现"
- guangda 实例是**另一种**错误：`Gateway journal maintenance failed: no such table: notification_outbox`（1,008,612 行），属于数据库迁移漂移，应单独立项

**已核实与未核实**

| 结论 | 状态 |
| --- | --- |
| 错误真实、反复出现、时间跨度 ≥ 2 周 | ✅ 已核实 |
| 它**不阻断**流水线：`event-journal-maintenance.ts:52-62` 的 catch 按 stream 隔离，游标继续前进 | ✅ 已核实（库内数据已收敛：91/91 会话已导入，脏队列与重建队列为空） |
| 具体空接收方的代码位置 | ❌ 未定位。对数据库副本完整复跑维护循环 60s（约 2,400 tick，覆盖全部 222 个会话）未复现；worker 路径与 staging 重建路径也未复现。原因是副本已收敛，缺少当时的中间态 |
| 它导致任务失败 | ❌ 不成立。把它列为"决定性故障"属定性过重 |

**为什么定不了位**：见 A3——日志只输出 `message`，没有堆栈、没有 `conversationId`。

**修复方向**：`onError` 输出 `stack` 与 `conversationId`（一行改动即可让此 bug 下次在 5 分钟内定位）；补充"半完成状态"注入测试。

---

### A3. 日志缺堆栈与上下文，且被噪声淹没

**代码位置**

- `src/server/server-composition.ts:1505`：`console.error(\`Gateway journal maintenance failed: ${(error as Error).message}\`)`
- `src/server/server-composition.ts:433-443`：reconciler 每 60s 执行一次，**成功也打印**
- `src/execution/task-state-reconciler.ts:170-172`：`lines.push('task state is consistent; nothing to reconcile')`

**日志构成（本机 20,267 行）**

| 行类型 | 行数 | 占比 |
| --- | --- | --- |
| `[reconciler] task state is consistent; nothing to reconcile` | 15,662 | 77.3% |
| `Gateway journal maintenance failed: ...` | 4,057 | 20.0% |
| `[reconciler] retained conversation slot ... still owns kernel_application` | 239 | 1.2% |
| 其余（启动横幅、Web 请求失败等） | ~309 | 1.5% |

**影响**：**98.5% 的日志没有信息量**。而"为什么任务卡住"的唯一线索（那 239 行 retained slot）恰恰被埋在这里，人眼无法发现。同时 reconciler 在 `main()` 中无条件启动，连 `server status` 这类一次性命令也会触发一次。

**修复方向**：无操作时不打印；`retained slot` 只在状态变化时打印并带持续时长；维护错误带堆栈与 `conversationId`。

---

### A4. Executor 沙箱 HOME 隔离，工具链不可用

**代码位置**

- `src/executor/pi-cli-driver.ts:96-112`：每次 attempt 的 `HOME` 指向 `attempts/<bounded-id>/home`，只创建 `.pi/agent/sessions`
- `src/executor/runtime-home-materializer.ts:16-33`：`homeDirectories` 之外一律不存在
- `src/execution/docker-cli-attempt-execution-backend.ts:84`：容器路径 `HOME=/tmp`
- `src/executor/harness-driver.ts:149`：只透传 `PATH`，不透传 `RUSTUP_HOME`、`CARGO_HOME`、`GOPATH`、`~/.cache`

**影响**：`rustup` 找不到 toolchain、`cargo` 丢 registry 缓存、`go` 丢 module cache。凡"需要真实系统工具链"的执行器都踩，与任务内容无关。危险之处在于**结果不确定**：能否编译取决于用户 `PATH` 里是否有非 rustup 的编译器，同一任务重跑可能时过时不过。

**修复方向**：`RUSTUP_HOME`/`CARGO_HOME`/`GOPATH`/`npm_config_cache` 只读透传，或在 attempt home 内建立符号链接；允许 AgentClass 声明 `homeMounts`。

---

### A5. `.gitignore` 让构建产物永远进不了交付

**代码链路**

1. `src/execution/workspace-change-tracker.ts:33`：`git status --porcelain=v1 -z --untracked-files=all`（被忽略文件天然不出现）
2. `src/execution/managed-git-workspace.ts:267`：`git add -A`（同样跳过忽略文件）
3. `src/execution/workspace-publication-worker.ts:826-841`：交付清单 = 步骤 1 的 `delta.changed`
4. `src/delivery/user-artifact-publication-service.ts`：按清单复制到用户目录

**实证（同一服务模板，两天内结果相反）**

| 任务目录 | `.gitignore` | `target/` | 结果 |
| --- | --- | --- | --- |
| `启动-system-one-决策服务…d2c76bae`（10/21） | 无 | 存在（被交付） | ✅ `healthy`，`listening 127.0.0.1:8787` |
| `在-8789-端口启动带-provider-配置…e0a607b2`（10/22） | 有 `/target` | 不存在 | ❌ `run-service.sh: … target/release/systemone-decision: No such file or directory` |

**影响**：交付的是"`git status` 命中的子集"，不是工程树；任何忽略目录里的构建产物永远无法交付。

**修复方向**：交付清单除 `git status` 外增加"声明产物"通道（`fileOutputs`、启动规格引用的路径、`git status --ignored` 命中的声明路径）。

---

## 3. 结构性根因：每一轮"新建"了四样东西

### 3.1 现状

| 每轮新建的东西 | 存储 | 每轮的取值 |
| --- | --- | --- |
| 工单 | `tasks` | 新 `task_plan_event_proposal_<hash>` |
| 交付目录 | `tasks.public_task_directory` | `metaclaw-tasks/<标题>-<sha256(taskId)前16>` |
| 服务登记 | `managed_local_services`（主键 `service_id`，记录内 `specification.taskId`） | 登记在本轮任务名下 |
| 经验卡 | `task_memory_cards`（`task_id` 唯一） | 本轮一张 |

**只有第一项"每轮新建"是合理的**，后三项跟着换是错位。

### 3.2 会话里真正共享的只有最便宜的两样

| 上下文层 | 作用域 | 是否跨轮共享 |
| --- | --- | --- |
| 对话历史 | 会话（`contextRecaller.recallAsync({ sessionId })`） | ✅ |
| 长期偏好 | 全局（`memoryEngine` 中 `scope === 'global'`） | ✅ |
| 文件 / 工程目录 | Task | ❌ |
| 交付产物 | Task | ❌ |
| 服务与端口 | Task | ❌ |
| 经验沉淀 | Task（`task_id UNIQUE`） | ❌ |

**结论：共享了"故事"，没共享"现场"。**

### 3.3 唯一两条跨 Task 通道，且都失效

1. `publicProjectDirectory`（只在新任务创建时、Workspace 相对路径、创建后不可改）
   —— 146 次新建任务只用过 1 次；且一旦用户自己改过文件，下一轮发布直接 `发布冲突，文件已被修改`（`user-artifact-publication-service.ts:278`），因为基线是任务创建瞬间拍的哈希（`capturePublicProjectBaseline`）。
2. `binding:'reference'` + 精确 `taskId`（13 次）
   —— 不复制文件，只把操作指回那个任务的目录。但服务的 `serviceId` 一生只能登记一次（`managed-local-service.ts:166`），且 owner 任务一终态就永久拒绝（`control-kernel.ts:837`）。

**因此"本轮接着上一轮交付的东西继续做/启动"在今天是结构性死局**：引用新任务 → 归属不匹配；引用 owner → 任务已取消。唯一出路是换 `serviceId`（本机已出现 `systemone-decision` → `-8789` → `-v2` 三个），代价是撞端口、丢目录。

### 3.4 为什么当初会这样

`UserArtifactPublicationService` 的设计意图是"一次性交付物"：每任务一目录、逐文件哈希、用户改动即视为未发布。这套规矩对**存档件**是对的，被直接用来管**可长期改、可长期跑**的产物后产生了全部症状。

**任务类型不是分界。** 写代码、写报告、做 PPT、讨论方案，本质都是"生成文件、修改文件"；差异只在验收。用"报告 vs 工程"分两条逻辑没有意义。

### 3.5 被本次讨论否定的说法

| 说法 | 判定 |
| --- | --- |
| `189/189` 个 receipt 全部 pending、自 10/1 起无一翻转 | ❌ 无法复现。本机 195 张 receipt 中 150 `completed`、18 `executor_failed`、16 `uncertified_result`、11 `cancelled_or_stale`；publication 149 `integrated` + 2 `cancelled`；delivery 51/51 `succeeded`；任务 117 `done` |
| A2 是导致任务失败的"决定性故障" | ❌ 该错误被按 stream 隔离，不阻断流水线 |
| 换任何任务都会卡 | ⚠️ 只在同一会话成立。槽位是会话级；换新会话不受影响 |
| 报告类任务应继续用"一次性独立目录" | ❌ 报告同样多轮修改；目录策略不应按任务类型分叉 |

---

## 4. 目标模型

### 4.1 五条硬规则

1. **一个会话 = 一个目录。** 第一轮创建（或直接使用会话绑定的 Workspace 目录），此后所有轮次都在其中改动。没有例外，没有开关。
2. **每一轮 = 一张工单 + 一次文件改动（可以是 0 个文件）。** 0 文件表示这一轮的产出是一句回复。
3. **一份东西 = 目录里的一个子路径。** 会话里做多件事即多个子路径，不是多个目录。
4. **每一轮结束记一条版本**：改了哪些文件、内容哈希、验收结果、所属工单。回滚 = 将某条历史版本重新置为当前位置。
5. **目录内若存在启动声明，即可启动；登记的归属是会话，不是某一轮任务。** 唯一需要排他的资源是端口。

**这条模型里没有任何一条提到"代码/报告/PPT"。**

### 4.2 三条验收约束

1. 验收失败**不改变文件位置**（同一目录，下一个版本）。
2. 验收失败**不改变服务与经验的归属**（服务登记挂会话）。
3. 验收结果**只记在当轮版本记录上**，只决定"这一轮是否算完成"。

### 4.3 验收是唯一的差异，且必须可执行

现状的问题：`verification-and-delivery-service.ts:78/103/116` 用正则（`/测试|test/i`、`/报告路径|report path/i`、`/最终内容|final content/i`）**猜**这一轮属于哪类工作。同一件事换个措辞，验收结果就不同——这是隐式的类型分叉，比显式两套逻辑更难维护。

目标形态：每条验收 = 声明 + 可执行判据，系统逐条执行并记录。

```jsonc
acceptance: [
  { "key": "build_passes",  "check": { "kind": "command", "run": "cargo build --release", "expect": { "exitCode": 0 } } },
  { "key": "health_ok",     "check": { "kind": "http",    "url": "http://127.0.0.1:8789/api/health", "expect": { "status": 200 } } },
  { "key": "artifact",      "check": { "kind": "files",   "paths": ["bin/systemone-decision"], "expect": { "exists": true, "modifiedThisRound": true } } }
]
```

```jsonc
acceptance: [
  { "key": "chapters", "check": { "kind": "content", "path": "行业分析报告.md", "expect": { "headings": 5 } } },
  { "key": "sources",  "check": { "kind": "content", "path": "行业分析报告.md", "expect": { "citationsAtLeast": 8 } } }
]
```

`kind` 建议支持：`command`、`http`、`files`、`content`、`manual`。代码轮与报告轮走同一个执行器、同一张记录表，"逻辑不一样"体现为数据差异。`manual` 覆盖"讨论一轮方案、你确认一下"这类无客观判据的工作。

### 4.4 作用域改动表

| 现有实现 | 目标 | 性质 |
| --- | --- | --- |
| `tasks.public_task_directory`（每轮算新目录） | 会话级目录，会话出生时确定、终生不变 | 作用域：任务 → 会话 |
| `publicProjectDirectory` 开关 | 删除 | 功能删除 |
| `preflight()`：用户改过文件 → `发布冲突，文件已被修改` | 用户改动 = 用户版本，记录但不阻断 | 删除哈希锁 |
| `resolvePublishedDirectory()`：哈希不符 → null → "代码尚未发布" | 目录存在 + 启动声明在 → 可启动 | 删除哈希锁 |
| `managed_local_services.specification.taskId` | 绑会话；端口做互斥登记 | 作用域 |
| `task_memory_cards.task_id UNIQUE` | 绑会话 | 作用域 |
| `deliveryKind: 'edit' \| 'report'` | 降级为界面提示，不参与目录/发布/验收 | 降级 |
| `workspace_records.cleanup_after`（按任务清理） | 按会话归档/删除时清理 | 作用域 |
| `verification-and-delivery-service.ts` 关键词嗅探 | 按 `check.kind` 分派 | 替换为可执行判据 |

---

## 5. 改造分期

### P0 — 止血（不改表，1–2 天）

| 项 | 改动 | 验证 |
| --- | --- | --- |
| P0-1 | 维护循环退避：无待办 1s、有待办 25ms；`nextStream` 为空后退避；错误限速 | 空闲 CPU 从 3.7% 降到 <0.5%；日志不再增长 |
| P0-2 | `onError` 输出 `stack` + `conversationId`；reconciler 无操作时不打印；retained slot 仅状态变化时打印 | 日志行数下降 >95%，错误仍可定位 |
| P0-3 | `manageLocalService` 内的拒绝不再向外抛：拒绝作为 observation 走 `markApplied`（拒绝无副作用） | 构造一次归属拒绝，确认不产生 `uncertain` |
| P0-4 | `authorize_task_control` 脱离 `UNMANAGED_ACTIONS`，或补一条"纯拒绝类可收敛"规则 | 现存 3 条 `uncertain` 中有 2 条可自动收敛 |
| P0-5 | Kernel 拒绝文案带 `serviceId`、`ownerTaskId`、`ownerTaskStatus` | 用户能从界面看到真实原因 |

**风险**：P0-3/P0-4 触及 Kernel 收敛语义，需与 ADR-0022/0023 的"unresolved 必须到达用户"原则对齐；不能把真正不确定的副作用误标为 `applied`。

### P1 — 作用域迁移（加表，约 1 周）

| 项 | 改动 |
| --- | --- |
| P1-1 | 新增会话级目录事实（新表或会话元数据字段）：`conversationId → rootDirectory`，创建后不可变 |
| P1-2 | 交付改为写入会话目录；`tasks.public_task_directory` 退化为历史字段（读兼容，写不再生效） |
| P1-3 | 发布冲突规则改为"版本化"：用户改动记为作者=用户的新版本，不阻断 |
| P1-4 | `managed_local_services` 归属改为会话；端口做互斥登记；删除 `服务标识已绑定其他启动规格`（改为"以最新声明为准"或显式 restart 决策） |
| P1-5 | `task_memory_cards` 增加会话维度，跨轮累积 |

**风险**：P1-4 放宽了服务与任务的绑定，需要保证"哪个会话能启动哪个服务"的授权边界不退化（改为会话成员判定）。

### P2 — 验收插件位（约 1 周）

| 项 | 改动 |
| --- | --- |
| P2-1 | `acceptance` 增加 `check` 字段，定义 `command/http/files/content/manual` 五类判据与执行器 |
| P2-2 | 删除 `TestEvidenceVerifier`/`ArtifactVerifier` 的关键词嗅探，改为按 `check.kind` 分派 |
| P2-3 | 每轮版本记录附带逐项验收结果（现成 `acceptance` + `requiredEvidence` 结构可扩展） |

**待决**：`check.kind: 'command'` 等于允许计划指定要执行的检查命令，需与 ADR-0024（资源分区/沙箱/权限）对边界；可能要求命令来自受控白名单或与执行同权限档案。

### P3 — 文档与 ADR（与代码同步）

- 修订 ADR-0021（work graph 与交付边界）、ADR-0025（单任务并发与 Git 发布）、ADR-0035（会话级 Workspace 组织）；
- 更新 `CONTEXT.md`、`docs/current/technical-overview.md`；
- 若最终引入独立 Project 实体，则新增 ADR 并在其中记录本次复盘结论。

---

## 6. 数据迁移

### 6.1 现有 5 个重复目录的合并

本机 `harnessclash/metaclaw-tasks/` 下与 8789 服务相关的目录共 5 个：

```
在-8789-端口启动带-provider-配置的升级版服务-重新交付-e0a607b2
在-8789-端口启动带-provider-配置的升级版服务-bb16aed5
快速构建并启动-8789-端口的-provider-版服务-9c7ccb43
增加模型-provider-配置入口并启动真实决策服务-d8b37bd4
诊断-8789-决策请求-502-的根因-a3a29394
```

迁移规则（按会话归并为一个目录）：

1. 以**最近一次 `integrated` 发布**为当前版本，其内容作为会话目录的初始内容；
2. 其余目录按发布时间**降序**依次生成历史版本记录（只登记清单与哈希，不复制文件）；
3. 同名文件以发布时间最新者为准，旧版本保留哈希与来源任务；
4. 源目录**不删除**，改为在目录内放置 `MIGRATED.txt` 指向会话目录，验证通过后再由用户决定清理；
5. 任一文件在源目录中已缺失的（如忽略目录产物），记录为"未交付"而不是"内容为空"，避免把缺失静默当成一致。

### 6.2 服务登记迁移

`managed_local_services` 现有两条：`systemone-decision`（owner `f887a2f2`，`stopped`）、`systemone-decision-8789`（owner `f60cd19e`，`failed`）。迁移为会话归属，并保留原 `ownerTaskId` 作为历史字段。迁移后必须验证：

- 相关会话可以重新 start `systemone-decision-8789`（即使原任务已 cancelled）；
- 端口 8789 上仍有外部进程时，返回"端口被占用"而不是"归属不匹配"。

### 6.3 经验卡迁移

`task_memory_cards` 现为 `task_id UNIQUE`。迁移为会话维度时保留 `taskId` 作为来源；同一会话多张卡按 `updated_at` 降序合并，冲突项（同一 pitfall 不同结论）保留两条并标注来源任务。

---

## 7. 验收标准（怎么证明修好了）

| 编号 | 断言 | 检验方式 |
| --- | --- | --- |
| V1 | 空闲 10 分钟，日志零增长，CPU 增量 <0.5% 单核 | 采样对照 |
| V2 | 人为制造一次服务拒绝，`kernel_decision_applications` 中不出现新的 `uncertain`，会话槽位在下一轮被释放 | 构造式测试 |
| V3 | 同一会话连续三轮改同一个文件：只有一个目录，产生三条版本记录，第二轮不会因用户手改而 `发布冲突` | 端到端脚本 |
| V4 | 同一会话里"取消任务 → 再启动该任务交付的服务"成功（或明确报端口占用），不再报归属/终态拒绝 | 端到端脚本 |
| V5 | 代码类验收（`command`/`http`/`files`）与报告类验收（`content`）走同一执行器，结果逐项入库 | 端到端脚本 |
| V6 | 交付清单包含被 `.gitignore` 忽略但被声明的产物（如 `bin/`） | 端到端脚本 |
| V7 | 现有 145 张任务、195 张 receipt、151 条 publication 在迁移后仍可查询，历史版本可回滚 | 数据一致性校验 |

---

## 8. 待决事项

| 编号 | 待决问题 | 影响 |
| --- | --- | --- |
| D1 | 验收 `check.kind: 'command'` 的安全边界（是否白名单、是否与执行同权限档案） | P2 能否落地 |
| D2 | 用"会话即项目"还是显式 `projects` 表 | 决定 P1 是否新增实体与跨会话共享能力 |
| D3 | `deliveryKind` 保留为展示提示还是彻底移除 | 影响 UI 与配置兼容 |
| D4 | 槽位是否继续按会话独占（ADR-0011/0025），还是允许会话内并行 | 影响 P1 的并发语义 |
| D5 | 旧目录清理由系统执行还是交给用户 | 影响迁移脚本的破坏性 |

---

## 附录 A：证据清单

**本机 `~/.metawork`**

| 项 | 数值 |
| --- | --- |
| `tasks` | done 117 / cancelled 27 / created 1 |
| `executor_attempt_receipts` | 195：completed 150 / executor_failed 18 / uncertified_result 16 / cancelled_or_stale 11 |
| `workspace_publications` | integrated 149 / cancelled 2（无 pending） |
| `workspace_publication_deliveries` | succeeded 51 |
| `kernel_decision_applications` | applied 756 / uncertain 3 |
| 决策分布 | `authorize_task_plan/new` 146、`authorize_task_control/reference` 13、`authorize_task_plan/reference` 1 |
| 会话内任务数峰值 | `conv_dHWzo_CbPJh0` 9 张（同一 workspace） |
| 日志行类型 | consistent 15,662 / journal failed 4,057 / retained slot 239 / 其他 ~309 |

**guangda 实例**

| 项 | 数值 |
| --- | --- |
| `server-9001.log` 行数 | 1,013,753 |
| `no such table: notification_outbox` | 1,008,612 |
| `task state is consistent` | 5,105 |

## 附录 B：代码位置索引

| 主题 | 位置 |
| --- | --- |
| 维护轮询与退避 | `src/server/account-event-journal.ts:42`、`src/gateway/event-journal-maintenance.ts:38-62` |
| 全表 UNION 扫描 | `src/storage/event-journal-segment-index-repo.ts:75` |
| 维护错误日志 | `src/server/server-composition.ts:1505` |
| reconciler 周期与噪声 | `src/server/server-composition.ts:433-443`、`src/execution/task-state-reconciler.ts:170-172` |
| 残留判定 | `src/execution/task-residue-reader.ts:100-110` |
| 槽位保留与容量 | `src/execution/task-state-reconciler.ts:105-140`、`src/storage/conversation-task-scheduler-repo.ts:124-148,199-215` |
| 服务拒绝与抛出 | `src/kernel/control-kernel.ts:830-843`、`src/execution/kernel-execution-runtime.ts:762-780` |
| 未收敛的 application | `src/execution/kernel-application-recovery.ts:168-185`、`src/account/account-startup-recovery-service.ts:913-935` |
| 受管服务启动前置 | `src/execution/managed-local-service.ts:33-45,66-98,150-215,261-288` |
| 交付目录命名 | `src/task/public-task-directory.ts` |
| 发布哈希锁 | `src/delivery/user-artifact-publication-service.ts:251-279`、`src/server/server-composition.ts:1002-1027` |
| 交付清单来源 | `src/execution/workspace-change-tracker.ts:33`、`src/execution/workspace-publication-worker.ts:788-841` |
| 验收关键词嗅探 | `src/delivery/verification-and-delivery-service.ts:78,103,116` |
| Executor HOME 隔离 | `src/executor/pi-cli-driver.ts:96-112`、`src/executor/runtime-home-materializer.ts:16-33` |
| Executor 进程组回收 | `src/executor/local-cli-executor-adapter.ts:20-23,488,513-521` |
| Planner 路由规则 | `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-system-prompt.ts:39-40` |
| 生产授权闸门 | `src/kernel/production-authorization.ts:12-30` |
