# MetaWork Workspace 级 Conversation 组织设计

> Status: Completed
> Design date: 2026-08-27
> Review completed: 2026-08-27
> Completion date: 2026-08-28
> Review owner: Product / Architecture
> Governing decisions: ADR-0020, ADR-0031, ADR-0034
> Required decision update: 新增 ADR-0035，修订 ADR-0031 与 ADR-0034 的
> Workspace/Conversation 组织和 `/workspace` 语义

## 1. 背景

当前 MetaWork 的持久组织结构以 Account 下的 Conversation 为中心：

```text
Account
├── Conversation A -> Workspace /repo-a
├── Conversation B -> Workspace /repo-a
└── Conversation C -> Workspace /repo-b
```

每个 Conversation 保存一份可变的 Workspace path。TUI、Web 和飞书通过统一
Gateway attach 到具体 Conversation，只有 attach 后才获得该 Conversation 的历史、
执行轨迹和实时事件。

这个模型保证了 Conversation 隔离和执行安全，但产品信息架构仍然是
Account-first：

- 用户以项目目录为工作入口，却先看到账号下的扁平 Conversation 列表；
- 同一 Workspace 下的历史 Conversation 和正在进行的 Conversation 没有稳定目录；
- 不同 Client 即使从同一个项目目录启动，也不能先获得一致的 Workspace 工作视图；
- Workspace path 同时承担身份、执行路径和 Conversation 可变 metadata，目录改名、
  软链接和 worktree 会让归类语义不稳定；
- Web、TUI 和飞书各自需要补足会话发现能力，容易形成不同的会话目录事实。

对代码项目型 Agent 产品，更符合用户心智的组织结构是：

```text
Account
└── Workspace
    ├── Conversation A
    ├── Conversation B
    └── Conversation C
```

Workspace 应成为一级产品容器和跨 Client 导航范围，Conversation 继续作为 Planner
历史、输入串行化、执行轨迹和实时事件的隔离单元。

## 2. 已批准目标

1. Account 下拥有稳定的 Workspace Catalog。
2. Workspace 使用不可变 `workspaceId` 作为身份，绝对路径不是主键。
3. 一个 Workspace 可以拥有多个 Conversation。
4. 一个 Conversation 归属于一个 Workspace；产生第一条普通用户 Query 后不得
   通过 `/workspace` 静默改变归属。
5. 同一 Account 的不同 Client 进入同一 Workspace 后，看到相同的 Conversation
   目录、历史摘要和正在进行状态。
6. Client 只有进入具体 Conversation 后，才回放完整历史并订阅详细实时事件。
7. 新 Conversation 创建在当前选中的 Workspace 下。
8. Web 保留当前 Conversation、Trajectory、Execution、Artifact、Settings 和
   Composer 的展示与交互；本次只改变 Workspace/Conversation 导航层和数据来源。
9. TUI、Web、飞书和未来 App 使用同一个 Server-owned Workspace Directory
   projection，不各自维护 Workspace 会话目录。
10. AccountRuntime 继续是 Runtime、Kernel、Task、Executor 和恢复的唯一所有者；
    Workspace 组织不创建第二套 Runtime 或调度边界。

## 3. 非目标

- 不把 Workspace 下所有 Conversation 合并成一个统一消息时间流。
- 不在 Workspace 首页自动下载每个 Conversation 的完整消息和完整执行轨迹。
- 不让 Client 根据本地路径直接写 Workspace 或 Conversation metadata。
- 不把 Workspace path 放进 Web URL、Gateway endpoint manifest、浏览器历史或
  可分享链接。
- 不把 `workspaceId` 解释为 Git repository identity、worktree identity 或
  Executor managed workspace identity。
- 不自动把不同 clone、不同 worktree 或不同 canonical path 合并成一个 Workspace。
- 不在本阶段实现跨 Account Workspace 分享、组织成员权限、云同步或多人协作。
- 不改变 ADR-0011 的 Account 内单活跃顶层 Task 约束。
- 不增加 Workspace 级调度器、Workspace 级 Kernel 或 Workspace 级数据库。
- 不提供隐式 Conversation 搬迁；显式迁移/复制历史是未来独立能力。
- 不删除或复用 `accounts/<id>/workspace-store/`。该目录是 Executor managed
  workspace 存储，不是本设计的用户 Workspace Catalog。

## 4. 核心产品模型

### 4.1 层级

目标层级为：

```text
ServerProcess
  -> RuntimeRegistry
    -> AccountRuntime
      -> WorkspaceDirectory
        -> Workspace
          -> ConversationRegistry references
            -> ConversationSession
              -> ClientConnection attachments
```

这个层级表达产品组织和查询关系，不改变 Runtime 所有权：

- AccountRuntime 仍拥有 Account 级 Kernel、Task、Execution 和恢复；
- WorkspaceDirectory 拥有 Workspace identity、路径绑定和 Conversation 摘要索引；
- ConversationSession 仍拥有单个 Conversation 的输入 mailbox、Planner turn、
  安全历史投影和详细事件；
- ClientConnection 拥有临时的当前 `activeWorkspaceId` 和可选
  `activeConversationId`；
- Gateway 负责认证、Account/Workspace/Conversation 解析和安全事件投影。

### 4.2 Workspace

Workspace 是 Account 内稳定的用户项目容器：

```text
Workspace:
  id: workspace_<opaque-id>
  accountId: local-default
  displayName: metawork
  canonicalPath: /Users/user/Program/metawork
  availability: available | unavailable
  createdAt: 2026-08-27T00:00:00.000Z
  updatedAt: 2026-08-27T00:00:00.000Z
  createdByPrincipal: local:local-installation
  archived: false
```

规则：

- `id` 创建后不可变；
- `canonicalPath` 是当前主机上的执行路径绑定，不是 Workspace identity；
- 同一 Account 中，同一 available canonical path 只能对应一个 active Workspace；
- `displayName` 初始取 path basename，之后允许独立修改而不改变 identity；
- 路径暂时不存在时 Workspace 变为 `unavailable`，历史 Conversation 不丢失；
- archive 只影响默认导航，不级联删除 Conversation、Task、Result 或 Artifact；
- 第一阶段一个 Workspace 只保存一个本机 canonical path，不设计多主机 path map。

### 4.3 Conversation

Conversation 是 Workspace 下的独立工作线程：

```text
Conversation:
  id: conv_...
  accountId: local-default
  workspaceBinding:
    workspaceId: workspace_...
    boundAt: 2026-08-27T00:00:00.000Z
    boundByPrincipal: web:local-web-user
  plannerSessionId: ...
  title: 用户第一条普通 Query
  createdAt: ...
  updatedAt: ...
  archived: false
```

规则：

- 新 Conversation 必须在一个已授权 Workspace 下创建；
- 为兼容迁移，旧 Conversation 可以暂时处于 `workspaceBinding: null`；
- 在第一条普通用户 Query 准入前，空 Conversation 可以重新绑定 Workspace；
- 第一条普通用户 Query 准入后，`workspaceId` 固定；
- Planner 历史、Conversation turns、trace 和输入 mailbox 不跨 Conversation 合并；
- Workspace archive 不改变 Conversation binding；
- Conversation archive 不影响同 Workspace 下其他 Conversation；
- Conversation 删除继续服从现有历史删除规则，不级联删除 Workspace。

### 4.4 Turn 和 Task

每个已准入 Turn 继续固定具体执行事实：

```text
TurnAdmission:
  accountId
  workspaceId
  workspacePath
  conversationId
  configurationRevision
```

`workspaceId` 用于产品组织和审计，`workspacePath` 是该 Turn 准入时经过
canonicalization 和 authorization 的具体路径。后续 Workspace 路径不可用或被重新
绑定时，不得改写历史 Turn/Task 的准入事实。

Task 仍由 AccountRuntime/Kernel 拥有，并记录 origin Conversation。Workspace
Conversation 目录中的“正在进行”状态由 Planner/Task/Execution durable facts 投影，
不得由 Client 根据本地 spinner 推断。

## 5. Workspace Identity 与路径解析

### 5.1 Client 启动目录

`metawork`、`metawork tui` 和 `metawork web` 继续捕获一次 `process.cwd()`，但
新语义为：

```text
Client startup cwd
  -> untrusted workspace path hint
  -> authenticated Workspace selection
  -> realpath and directory validation
  -> Principal/account authorization
  -> find Workspace by canonical path
  -> create Workspace when absent
  -> set ClientConnection.activeWorkspaceId
```

启动目录不直接创建 Conversation，也不覆盖历史 Conversation。

### 5.2 `/workspace <path>`

`/workspace <path>` 继续是所有 Client 统一的用户可见命令，但语义从
“修改当前 Conversation path”收敛为“选择 Client 当前 Workspace”：

- 对 TUI/Web：更新当前 ClientConnection 的 `activeWorkspaceId`；
- 对飞书：更新当前已授权 platform chat/thread binding 的 Workspace selection；
- 选择成功后返回 Workspace 摘要和该 Workspace 的 Conversation 目录；
- 当前 Conversation 有历史时不修改其 `workspaceId`；
- 当前 Conversation 为空时，Client 可以选择继续把它绑定到目标 Workspace，或
  放弃空 Conversation 后在目标 Workspace 新建；
- 正在执行的 Conversation 不因 Workspace selection 变化而停止、迁移或失去订阅；
- 进入其他 Workspace 后，用户仍可显式返回并 attach 原 Conversation。

为避免隐式数据搬迁，第一阶段不提供 `/workspace` 对已有历史 Conversation 的
reparent 行为。

### 5.3 直接 attach

显式 attach 保持最高优先级：

```text
metawork tui --conversation <id>
metawork web --conversation <id>
```

Server 授权并解析 Conversation 后：

1. 从 `workspaceBinding.workspaceId` 恢复 Workspace；
2. 把 Client 的 `activeWorkspaceId` 切换到该 Workspace；
3. attach Conversation；
4. 回放完整 Conversation snapshot/deltas；
5. 不应用当前 Client cwd hint。

这样从其他目录启动也不会覆盖历史归属。

## 6. Workspace Conversation Directory

### 6.1 目录投影

Server 为每个 Workspace 提供有界、可分页的 Conversation 摘要：

```text
WorkspaceConversationSummary:
  conversationId
  workspaceId
  title
  createdAt
  updatedAt
  archived
  lastTurnStatus: completed | failed | blocked | null
  activity:
    state: idle | planning | executing | waiting | blocked
    taskId: string | null
    updatedAt: string
  preview: bounded first/last user-visible text
```

目录不得包含：

- hidden reasoning、prompt、credential、raw stdout/stderr；
- 完整历史正文；
- 未授权的本机路径或内部 managed workspace 路径；
- Kernel/Executor 私有绑定细节。

默认排序：

1. `planning`、`executing`、`waiting`、`blocked`；
2. 其他 Conversation 按 `updatedAt` 降序；
3. 相同时间按 `conversationId` 稳定排序。

默认只返回 active Workspace 的未 archived Conversation。全局搜索和 archived
浏览必须是显式操作。

### 6.2 实时更新

进入 Workspace 的 Client 订阅 Workspace 级摘要事件：

```text
workspace_directory_snapshot
workspace_conversation_upserted
workspace_conversation_removed
workspace_activity_changed
workspace_availability_changed
```

这些事件只更新 Conversation 列表和状态，不承载完整 Turn/trace。Client attach
具体 Conversation 后，继续使用现有 `conversation_snapshot`、`trace_delta`、
`execution_delta`、result 和 terminal 事件。

因此同一 Workspace 的多个 Client 能同时看到：

- 新 Conversation 出现；
- 标题由第一条用户 Query 更新；
- Conversation 进入 planning/executing/waiting/blocked/idle；
- Conversation archive/delete；
- Workspace path availability 变化。

但它们不会因为进入 Workspace 就订阅所有 Conversation 的详细输出。

### 6.3 搜索、分页与保留

- Conversation 目录从第一版就使用 cursor pagination；
- 默认 page size 50，最大 100；
- 搜索默认限定当前 Workspace；
- “所有 Workspace”搜索是显式 Account 级查询；
- title 使用当前“第一条普通用户 Query”规则；
- preview 和目录状态必须有独立大小上限；
- 历史完整内容仍从具体 Conversation replay/read 获取。

### 6.4 Conversation 历史分页

Gateway 提供 Conversation-scoped、只读、有界的 history page：

```text
ConversationHistoryPage:
  conversationId
  turns: bounded user-visible turns
  previousCursor: string | null
  nextCursor: string | null
```

规则：

- 调用方必须已通过 Account、Workspace 和 Conversation attach authorization；
- `limit` 由 Client 提示，Server 负责默认值、最大值和最终裁剪；
- cursor 是 opaque Server cursor，Client 和 adapter 不解析、不合成；
- history page 只包含允许回放的用户可见 Turn，不包含 hidden reasoning、credential、
  raw protocol payload 或其他 Conversation 的内容；
- attach 初始摘要的最近 3 turns 与 `/history` 使用同一 replay projection；
- history pagination 不创建 Turn、不改变 activity，也不写 Planner transcript。

## 7. Client 行为

### 7.1 Web

Web 保留当前主工作区展示，只调整左侧导航：

```text
Workspace selector
Workspace status/path
New conversation
Search conversations in this Workspace
Conversation list with activity state
Settings
```

规则：

- `metawork web` 启动 hint 选择/创建 Workspace；
- sidebar 只显示 active Workspace 的 Conversation；
- 选择 Conversation 后，当前 Conversation/Trajectory/Execution/Artifact 展示
  完全复用现有行为；
- “新建会话”在 active Workspace 下创建；
- running 状态来自 Server Workspace Directory；
- Web 不再以 Web-local catalog 作为 Workspace/Conversation 目录权威；
- 当前 Web session rail 数据迁移到统一 ConversationStore/Directory projection；
- 清空历史默认只作用于 active Workspace，且保留当前/正在执行 Conversation；
- Settings 页交互和信息不得因本次改造退化。

### 7.2 TUI

普通 `metawork`/`metawork tui` 启动后进入 Workspace 范围：

- 用户可通过 `cd <workspace-path> && metawork` 从启动 cwd 选择/创建 Workspace；
- Header 展示 Workspace displayName 和可访问的完整 path；
- 启动时显示有界的 recent/running Conversation selector；
- selector 至少展示 title、activity state、current task 摘要和最近更新时间；
- `↑`/`↓` 选择 Conversation，`Enter` attach，`n` 在当前 Workspace 新建
  Conversation，`/` 搜索当前 Workspace，`r` 刷新目录；
- `/conversations` 打开当前 Workspace 的 Conversation selector；
- `/conversation <id>` 显式 attach 已授权 Conversation；
- `/workspace <path>` 选择其他 Workspace 并刷新目录；
- `--conversation <id>` 继续直接 attach，不先显示 selector；
- `metawork tui --conversation <id>` 必须恢复该 Conversation 的 Workspace，
  不应用启动 cwd；
- attach 后的 Planner TUI 对话、工具限制和 Gateway-only Runtime 规则不变。

TUI selector 是 Client presentation，不得读取文件存储、Task repository 或
ConversationStore，也不得把 Workspace directory、selector 操作或 Workspace
切换记录写入 Planner transcript。

### 7.3 飞书

飞书没有本地 cwd，因此：

- `/workspace <path>` 为当前 chat/thread binding 选择 Workspace；
- 选择成功后返回当前 Workspace、最近 Conversation 和运行状态；
- `/conversations` 查看当前 Workspace 的有界、可分页目录，卡片分页继续使用
  Server cursor，不在 adapter 内缓存完整目录；
- `/conversation <id>` attach 当前 Workspace 下的已授权 Conversation；
- attach 成功卡片至少返回 title、activity state、current task 和最近 3 个
  Conversation turns，避免在聊天中自动展开完整 transcript；
- `/history` 返回当前 Conversation 最近一页历史，`/history <limit>` 设置本次
  有界页大小，卡片“上一页/下一页”动作使用 Server cursor 分页；
- 普通消息在没有 active Conversation 时，于当前 Workspace 创建新 Conversation；
- 没有 Workspace selection 时返回 `workspace_required` 和明确命令；
- 飞书卡片只展示摘要，进入/继续具体 Conversation 后才接收其详细进度；
- attach 后只订阅该 Conversation 的 detailed replay 和 live events，不订阅同一
  Workspace 下其他 Conversation 的完整历史、trace 或 result chunks；
- 不允许仅凭猜测的 Conversation ID 跨 Account 或跨未授权 Workspace attach。

平台 chat/thread 到 Workspace/Conversation 的选择由 Server binding repository
持久化，Feishu adapter 不自行保存权威状态。历史页由 Gateway 从
Conversation-scoped replay projection 读取；飞书 adapter 只负责卡片呈现和 cursor
动作转发。

### 7.4 多 Client 一致性

同一 Account、同一 Workspace：

- 所有 Client 看到相同 Conversation 目录和 Server-derived activity；
- 多 Client 可以同时 attach 同一个 Conversation；
- attach 后共享 replay 和后续事件，但各自保留 UI 状态；
- 一个 Client 切换 Workspace 不改变其他 ClientConnection 的 active Workspace；
- 一个 Client archive/delete Conversation 后，其他 Client 收到目录 delta；
- Client 断线不停止 Conversation、Planner、Task 或 Executor。

## 8. 持久化与迁移

### 8.1 新目录

新增 Account 级产品 Workspace Catalog：

```text
accounts/<account-id>/
  workspace-catalog/
    catalog.json
    quarantine/
```

不得与以下目录混用：

```text
workspace-store/   # Executor managed workspaces and Git publication
```

### 8.2 Conversation 格式

Conversation format 从 v2 升级到 v3：

```text
v2:
  workspace:
    path
    selectedAt
    selectedByPrincipal

v3:
  workspaceBinding:
    workspaceId
    boundAt
    boundByPrincipal
```

v3 不双写 legacy `workspace.path`。对 Client 的 path/displayName projection 从
Workspace Catalog join 得到。

### 8.3 一次性迁移

AccountRuntime 启动前执行幂等迁移：

1. 读取 v1/v2 Conversation catalog 和 records；
2. 对非空 legacy path 使用已保存值进行归一化；路径可访问时重新 realpath；
3. 同一 canonical/last-known path 映射到一个 Workspace；
4. 路径不存在时创建 `availability: unavailable` 的 Workspace，保留历史分组；
5. 为 Conversation 写入 `workspaceBinding`；
6. 原子切换 Workspace Catalog 和 Conversation v3 文件；
7. 写 migration journal 后才删除临时文件；
8. 重跑迁移不得生成新的 Workspace ID 或重复 Conversation；
9. 失败时保留原 v2 权威数据并 fail closed，不进入双读双写运行态。

`workspace: null` 的旧 Conversation 保持 unassigned，直到用户在已选 Workspace 下
显式 attach/迁移或创建新 Conversation；不得猜测使用最近 Workspace。

## 9. 授权与安全

- Account authorization 先于 Workspace 查询和选择；
- Workspace path hint 永远是不受信任输入；
- Server 执行 realpath、directory check 和 Principal authorization；
- Client 提供的 `workspaceId` 只是引用，Server 必须验证它属于当前 Account；
- Workspace Directory 只返回 Principal 有权发现的 Workspace/Conversation；
- path 不进入 URL、Referer、endpoint manifest 或共享 token；
- Workspace 目录事件和 Conversation 事件继续通过现有 payload sanitization；
- attach 具体 Conversation 时同时验证 Account ownership 和 Workspace binding；
- Workspace selection 不赋予新的文件访问权限；
- archived/unavailable Workspace 不能接受新语义 Turn；
- 正在进行的 Conversation 不允许 archive/delete/rebind；
- 所有迁移和 path binding 变更都记录 Principal 和时间。

## 10. 并发与冲突

- ADR-0011 的单活跃顶层 Task 仍按 AccountRuntime 生效；
- 多 Conversation 可以并发进行只读 Planner turn，但 mutating proposal 继续由
  Account Kernel revalidate；
- Workspace Directory 不调度任务，只投影 durable facts；
- 同一 Workspace 的多个 Conversation 不获得并行写同一用户仓库的额外授权；
- 未来多 Task 路线图必须在 Workspace/Git publication 层处理冲突，本设计不提前
  放宽约束；
- Workspace Catalog 写入使用 Account 级串行 mutation/原子文件替换；
- Conversation 创建必须在同一操作中固定 `workspaceId`，避免 orphan Conversation。

## 11. 错误语义

新增稳定错误：

```text
workspace_not_found
workspace_unavailable
workspace_archived
workspace_unauthorized
workspace_binding_locked
conversation_not_in_workspace
workspace_catalog_migration_failed
```

保留并重新解释：

```text
workspace_required
workspace_path_invalid
workspace_busy
```

行为：

- Workspace 选择失败不创建 Conversation；
- Conversation attach 失败不回退到同标题或最近 Conversation；
- unavailable Workspace 保留历史目录，但禁止新 Turn；
- migration 失败阻止 AccountRuntime 接受用户命令；
- Client 收到结构化错误和可执行恢复提示，不显示内部路径或堆栈。

## 12. 方案比较

### 12.1 只按 canonical path 在 UI 分组

优点：

- 改动小；
- 可以快速让 Web sidebar 看起来按项目归类。

缺点：

- path 仍是身份；
- rename、symlink、worktree 和 unavailable path 语义不稳定；
- TUI/飞书仍可能各自实现目录；
- `/workspace` 会让有历史 Conversation 在分组间静默移动；
- 无法形成可靠迁移、审计和未来 App 契约。

结论：拒绝作为最终架构，可作为一次性迁移输入。

### 12.2 Workspace 作为一个共享大 Conversation

优点：

- 用户表面上只进入一个项目流。

缺点：

- Planner 历史和上下文无限增长；
- 不同任务、主题和权限混在一个 mailbox；
- 多 Client 输入和执行轨迹难以隔离；
- replay、搜索、归档和恢复成本持续增加；
- 会破坏 ADR-0031 的 Conversation 隔离。

结论：拒绝。

### 12.3 First-class Workspace + isolated Conversations

优点：

- 符合项目型 Agent 的用户心智；
- 保留 Conversation 隔离和可恢复性；
- 跨 TUI/Web/飞书形成同一目录事实；
- path 与 identity 解耦；
- 能展示 Workspace 下全部历史和正在进行状态；
- 为未来 App、搜索、归档和协作保留清晰扩展点。

缺点：

- 需要 Conversation v3 与 Workspace Catalog 迁移；
- Gateway 和 Client 需要新增 Workspace 级查询/事件；
- 当前 `/workspace` 语义发生兼容性切换；
- Web-local session catalog 需要收敛；
- TUI 和飞书需要新增 Conversation 发现/attach UX。

结论：批准采用。

## 13. 验收标准

1. 同一 Account 的 TUI 和 Web 从同一 path 进入后，解析到同一 `workspaceId`。
2. 两端看到相同的 Workspace Conversation 列表、标题和 activity state。
3. 一个 Client 新建 Conversation 后，另一个 Client 收到目录 upsert。
4. 一个 Client attach 正在进行的 Conversation 后，获得 snapshot、缺失 delta 和
   后续 live events。
5. 未 attach 的 Client 只收到摘要，不收到完整回答、trace 或 result chunks。
6. 同一 Workspace 下不同 Conversation 的 Planner history 和输入 mailbox 隔离。
7. `/workspace <path>` 不移动已有历史 Conversation。
8. `--conversation <id>` 恢复其 Workspace，不应用启动 cwd。
9. Conversation v2 迁移后，相同 legacy path 的记录归入同一稳定 Workspace。
10. unavailable legacy path 的历史仍可见，但新 Turn fail closed。
11. Web 当前 Conversation、Trajectory、Execution、Artifact、Settings 和 Composer
    回归测试保持通过。
12. TUI、Web 和飞书不直接读取 Workspace/Conversation persistence。
13. Workspace path 不出现在 URL、endpoint manifest 或未授权事件中。
14. Server 重启后 Workspace Catalog、Client attach 和 Conversation activity
    projection 可恢复。
15. TUI selector 支持键盘选择、新建、当前 Workspace 搜索和直接 attach，且目录
    状态不污染 Planner transcript。
16. 飞书 attach 摘要包含 title、activity、current task 和最近 3 turns；
    `/history [limit]` 与卡片 cursor 可以有界翻页且不泄露其他 Conversation。
17. 完整测试、native multi-client smoke 和真实浏览器验收通过。

## 14. 文档与决策要求

实施前必须：

1. 新增 ADR-0035，记录 Workspace-first organization、Conversation immutable
   binding、Workspace Directory 和 `/workspace` 新语义；
2. 修订 ADR-0031 的固定层级与 Conversation resolution；
3. 修订 ADR-0034 的 Client startup Workspace 选择；
4. 更新 `CONTEXT.md`、中英文 technical overview、operations 和 `AGENTS.md`；
5. 明确本设计取代
   `2026-08-27-client-default-workspace-design.md` 中
   “Workspace 的 Conversation 级可变所有权”部分，但保留安全 launch hint、
   Server-neutral 和 path-free Web bootstrap 规则。

## 15. 交付记录

MetaWork 已按本设计完成 Workspace-first Conversation 组织：

- Account-scoped Workspace Catalog 成为产品 Workspace identity 的唯一权威，
  `workspaceId` 与 canonical path 解耦；
- Conversation v3 只保存 immutable `workspaceBinding`，第一条普通用户 Query
  准入后不允许 `/workspace` 重新归类；
- TUI、Web 和飞书通过 Gateway v2 共享 Workspace Directory、Conversation 摘要、
  activity 和 bounded history，完整历史、trace、result chunks 仍只对已 attach
  Conversation 的 Client 返回；
- Client replay cursor 按 Workspace/Conversation stream 独立维护，切换
  Conversation 不会用其他 stream 的 sequence 请求回放；筛选、搜索和分页产生的
  Workspace directory snapshot 使用 connection-scoped projection stream，只返回
  请求该页面的 Client，不污染共享 Workspace journal；
- TUI 提供 Workspace home、Conversation selector、搜索、新建、刷新和 attach；
  Web 使用 Server-owned Workspace rail，同时保留 Conversation、Trajectory、
  Execution、Artifact、Settings 和 Composer；飞书提供 `/conversations`、
  `/conversation` 和 `/history`；
- Server 保持 Workspace-neutral 和常驻，TUI/Web 独立启动；Client 启动目录只作为
  Server 验证的 Workspace hint，Web bootstrap URL 不包含本地 path；
- root 与 vendored Planner 协议统一升级，native release 能从同一 release 的
  `planner/packages/coding-agent/dist/cli.js` 启动 TUI。

迁移通过一次性 v2-to-v3 migrator 完成：相同 legacy path 幂等归入同一 Workspace，
不可访问 path 保留为 unavailable Workspace，catalog、Conversation records 和
migration journal 以原子切换恢复；运行态不保留 legacy path 双读双写。

验证证据：

- `npm run lint`、`npm run build`、`npm run smoke:clients` 和
  `npm run smoke:gateway` 通过；
- 根仓库默认三 worker 全量测试完成：354 files passed、8 skipped、13 个既有
  Planner/Executor/TUI 长耗时用例因资源竞争超时或 timing assertion 失败；这些
  失败不在 Workspace/Gateway 改动路径。随后将受影响的 4 个文件改为单 worker
  顺序复核，62 tests passed、4 environment-skipped，包含此前全部失败用例；本次
  Workspace/Gateway focused tests、Browser E2E、Client smoke、native process
  smoke、lint 和 build 均通过。
- 显式 Browser E2E 通过：2 files、3 tests，覆盖 Workspace Conversation directory
  多浏览器摘要共享与 attach 隔离，以及 Provider/Model Settings 回归；
- `npm run smoke:gateway` 先通过 root 21 files/105 tests 和 vendored Planner
  3 files/21 tests，再安装真实隔离 native release：`server start` 未启动 Client，
  macOS PTY launcher 从 Workspace A 启动 TUI，三个真实 Gateway Client 验证
  Workspace identity 共享、Workspace B 隔离、未 attach detail isolation 和 attach
  replay，Web Client 独立连接同一 Server 并生成 path-free opaque bootstrap URL；
- 同一 native smoke 继续执行 `server status`、`server restart`、Workspace/
  Conversation durable recovery 和真实异步 `server stop`；随机 Web port、短 Unix
  socket root、实际 HTTP Web probe 和 immutable revision cleanup 保证验收不干扰
  用户 Server 且可重复；
- Account isolation、path secrecy、pagination/event bounds、migration recovery、
  Server restart recovery 和未 attach detail isolation 均由 focused/full smoke
  覆盖。

最终独立 review 关闭了四项实现风险：TUI 不再跨 stream 复用 replay cursor；
filtered/paginated Workspace 页面不再广播到共享 journal；Web Gateway mirror 只接受
protocol v2；Gateway smoke 从静态测试集合升级为真实安装和进程生命周期验收。随后
又关闭了 Unix socket `connectionId` 碰撞/旧 socket cleanup 竞态，以及随机 Web port
manifest 不可访问的问题。

交付提交为 `093691b`、`7688cfc`、`ba144db`、`78345fd`、`29bc66b`、
`2f0a30f`、`7d72d0b`、`d22d7c7`、`c5fbd79`、`1b5b39c`，以及最终实现提交
`35c697d`。

剩余非目标不变：不合并 Conversation 详细时间线，不把 Workspace 变成 Runtime/
Kernel ownership boundary，不自动合并 clone/worktree，不放宽 Account 单 Task
约束。线上真实飞书机器人和真实 Provider 任务执行仍属于部署环境验收；本次本机
验收使用隔离配置验证协议、生命周期、目录、回放和 UI，不使用生产凭据。
