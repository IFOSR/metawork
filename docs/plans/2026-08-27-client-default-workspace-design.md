# MetaWork Client 默认 Workspace 与可见性设计

> Status: Approved / Ready for implementation
> Design date: 2026-08-27
> Review completed: 2026-08-27
> Review owner: Product / Architecture
> Governing decisions: ADR-0020, ADR-0031, ADR-0034
> Required decision update: 修订 ADR-0034 的新 Conversation Workspace 初始化规则

## 1. 背景

独立 Server/Client 架构已经落地。Server Runtime 常驻且不绑定用户 Workspace；
TUI、Web 和飞书通过统一 Gateway 使用 Conversation 级持久 Workspace。

当前实现要求每个新 Conversation 在执行任务前手动输入：

```text
/workspace /absolute/path
```

这保证了 Workspace 权威明确，但给本地 Client 带来不必要的重复操作：

- 用户通常已经在目标项目目录中执行 `metawork` 或 `metawork web`；
- 新 Conversation 仍要求再次复制同一个绝对路径；
- follow/attach 历史 Session 时，用户容易误以为需要重新设置 Workspace；
- TUI 已展示 Workspace，但 Web 尚未把当前 Workspace 作为稳定的 Conversation
  信息呈现；
- 多 Client 连接同一个 Conversation 时，Workspace 变化必须由 Server 统一广播，
  不能依赖某个 Client 的本地状态。

## 2. 已批准目标

1. 新 Conversation 默认使用启动 Client 命令时的当前目录。
2. follow、attach 或激活已有 Conversation 时，复用其持久 Workspace，不重新设置。
3. 当前 Workspace 必须在所有 Client 中可见。
4. `metawork web` 的执行目录是该 Web Client 创建新 Conversation 时的默认
   Workspace。
5. `/workspace <path>` 继续作为所有 Client 的显式覆盖命令。
6. Server 继续保持 Workspace-neutral，不读取自己的启动目录作为用户 Workspace。

## 3. 非目标

- 不把 Server 启动目录设为默认 Workspace。
- 不增加 Server 全局、Account 全局或“最近一次使用”的 Workspace。
- 不允许 Client 直接写 Conversation metadata。
- 不绕过现有 `realpath`、目录检查、Principal 授权、busy fence 和持久化路径。
- 不改变 Workspace 的 Conversation 级所有权。
- 不改变已准入 Turn 固定其 Workspace reference 的规则。
- 不重做 Web Client 的交互结构、信息架构或视觉风格。
- 不把绝对 Workspace 路径放进 URL query、浏览器历史或可分享链接。
- 不恢复 Script Client，也不新增独立的 Workspace selector API。

## 4. 核心语义

### 4.1 Workspace 解析优先级

每次 Client 创建或附着 Conversation 时按以下顺序解析：

1. **已有 Conversation 的持久 Workspace**
2. **当前 Client 的启动目录提示**
3. **没有可用 Workspace，保持 `workspace: null` 并返回明确提示**

因此：

- attach/follow 已有 Conversation 时，持久 Workspace 永远优先；
- Client 启动目录只用于初始化新 Conversation；
- Client 启动目录不得覆盖、修复或替换已有 Workspace；
- 默认设置失败时不得启动 Planner，也不得静默改用其他目录。

### 4.2 Client 提示不是 Workspace 权威

`process.cwd()` 只生成一个不受信任的 `workspaceHint`。它不直接成为执行目录，
也不直接写入 Conversation。

Server 必须沿用 `/workspace <path>` 的现有语义完成：

```text
Client startup cwd
  -> untrusted workspace hint
  -> authenticated Client command context
  -> Conversation Workspace service
  -> realpath and directory validation
  -> Principal/account authorization
  -> active Turn/Task fence
  -> atomic Conversation persistence
  -> workspace_changed event
```

这次变更只自动触发现有 Workspace mutation，不创建第二套初始化或授权路径。

## 5. TUI 行为

### 5.1 新 Conversation

`metawork` 和 `metawork tui` 在启动时捕获一次 `process.cwd()`。Launcher 把该绝对
路径作为 `workspaceHint` 传给 vendored TUI Client。

TUI 创建新 Conversation 后，在接受第一条语义输入前，通过 Gateway 自动提交等价
于以下命令的 Workspace mutation：

```text
/workspace <client-startup-cwd>
```

Server 成功后持久化 Workspace 并发布 `workspace_changed`。只有收到 Server
确认后，TUI 才把该路径显示为当前 Workspace。

### 5.2 已有 Conversation

执行以下命令时：

```text
metawork tui --conversation <id>
```

TUI 先 attach/replay。只要 replay 或 Conversation snapshot 中存在持久
Workspace，就直接复用并展示，不提交自动 `/workspace`。

即使当前终端目录与历史 Workspace 不同，也不得覆盖历史值。用户只有显式提交
`/workspace <path>` 才能请求切换。

### 5.3 展示

TUI Header 持续展示 Server 确认的当前 Workspace：

```text
MetaWork · connected · workspace: /absolute/path
```

窄屏可以显示 basename，但必须提供完整路径的可访问展示方式；不得只显示 Client
本地 hint。Workspace 未设置时显示可执行提示：

```text
未设置 · 输入 /workspace /absolute/path
```

## 6. Web 行为

### 6.1 `metawork web` 启动上下文

`metawork web` 在命令启动时捕获一次 `process.cwd()`。Web launcher 通过受保护的
本机 Server control/Gateway 通道注册一个短时、一次性的 Web launch context：

```text
workspaceHint
conversationId (optional)
issuedAt
expiresAt
oneTimeToken
```

Server 返回随机 bootstrap token。Browser URL 只携带该随机 token 的 fragment；
绝对 Workspace 路径不进入 query、fragment、浏览器历史、Referer 或日志。Web
Client 立即把 token POST 到同源 bootstrap endpoint，Server 交换 HttpOnly
session cookie，并把 launch context 绑定到该 Web session，然后清除 fragment。

launch context 必须：

- 只允许通过 mode-restricted 本机通道创建；
- 有短 TTL；
- 只能交换一次；
- 只绑定一个 Web session；
- 不写入 endpoint manifest；
- 不作为 Workspace 授权结论。

### 6.2 新 Web Conversation

该 Web session 创建新 Conversation 时，Server 使用绑定的 `workspaceHint`
自动执行现有 Workspace mutation。成功后通过现有 Web HTTP/WebSocket projection
返回 Workspace。

一个 Web Client 在本次打开期间创建的后续新 Conversation，继续使用
`metawork web` 启动时捕获的同一个默认目录，直到重新执行 `metawork web` 建立
新的 launch context。

### 6.3 已有 Web Conversation

以下情况只恢复持久 Workspace，不应用 launch hint：

- `metawork web --conversation <id>`；
- Web 激活历史 Conversation；
- Browser 刷新后恢复当前 Conversation；
- WebSocket 断线重连和 replay。

已有 Conversation 的 Workspace 即使与 `metawork web` 的执行目录不同，也不得
被覆盖。

### 6.4 展示兼容

Web Client 当前的 Conversation、Trajectory、Execution、Artifact、Settings 和
Composer 交互保持不变。只在现有 Workspace Header/Conversation chrome 中增加
当前 Workspace 展示。

Server 返回给 Web 的数据必须继续是当前 Web 展示需求的字段与行为超集，并新增：

```text
workspace:
  path
  selectedAt
```

Workspace 信息必须出现在初始化 HTTP snapshot、WebSocket replay 和
`workspace_changed` live update 中。不得为了统一 Client 而删减现有 Web
projection。

## 7. Feishu 行为

飞书没有 Client 启动目录，因此不产生 `workspaceHint`：

- 已绑定 Conversation 存在 Workspace 时继续复用；
- 新绑定 Conversation 没有 Workspace 时，语义消息返回
  `workspace_required` 和 `/workspace /absolute/path` 提示；
- 用户通过飞书提交 `/workspace <path>` 后，Server 完成同一套校验和持久化；
- 设置成功或 attach 恢复时，飞书发送一次简洁的 Workspace 确认消息；
- 后续 `workspace_changed` 由 Server 事件驱动更新，不由飞书 adapter 自行保存。

## 8. 多 Client 一致性

Workspace 是 Server 持久事实，不是 Client preference：

- 一个 Client 显式切换 Workspace 后，Server 发布 `workspace_changed`；
- 所有 attach 到该 Conversation 的 TUI、Web 和飞书 projection 都更新；
- replay 必须重建与 live delivery 相同的 Workspace 状态；
- Client 断线期间的变更在重连 replay 后可见；
- 不允许以 Client 本地缓存覆盖较新的 Server sequence。

## 9. 错误处理

自动默认与显式 `/workspace` 使用相同错误码：

- `workspace_path_invalid`
- `workspace_unauthorized`
- `workspace_busy`
- `conversation_not_found`

自动默认失败时：

1. Conversation 保持 `workspace: null`；
2. 不启动 Planner；
3. TUI/Web 显示失败原因；
4. 提示用户执行 `/workspace /absolute/path`；
5. 不静默回退到 Server cwd、home、上一个 Conversation 或其他 Client 的目录。

对已有 Conversation，launch hint 不参与验证，因此不会因当前启动目录不可用而
阻止 attach。

## 10. 安全与隐私

- Workspace 路径是敏感的本地环境信息，只在受认证的 Client/Server 通道传输。
- URL 中只允许短时随机 bootstrap token，不允许 Workspace path。
- bootstrap token 与 launch context 均不得写入日志、endpoint manifest 或持久
  Conversation history。
- HttpOnly Web session 只关联 launch context；真正 Workspace 仍由 Conversation
  metadata 持久化。
- Client 不能伪造 Principal、Account 或 Workspace 授权结果。
- Workspace display 使用 Server 返回的 canonical path，不使用未确认 hint。

## 11. 被拒绝方案

### 11.1 把 Workspace 放进 URL

拒绝。绝对路径会进入浏览器历史、日志、截图、分享链接或 Referer，造成不必要的
本机信息泄漏。

### 11.2 Server 保存全局“最后使用的 Workspace”

拒绝。一个 Server 同时服务多个 Conversation 和 Client，全局值会产生竞态并错误
覆盖其他 Conversation。

### 11.3 Client 直接写 Workspace metadata

拒绝。它绕过 Server 的 canonicalization、authorization、busy fence、持久化和
事件顺序。

### 11.4 每次 attach 都重新应用 Client cwd

拒绝。follow 历史 Session 的核心要求是恢复原 Workspace；重新应用 cwd 会破坏
Conversation 连续性并可能在错误仓库执行。

## 12. ADR-0034 修订要求

当前 ADR-0034 明确规定：

- 新 Conversation 从 `workspace: null` 开始；
- process `cwd` 不是 Workspace authority；
- `/workspace /absolute/path` 是唯一初始化路径。

实施时必须修订 ADR-0034，使其同时表达：

- Server process `cwd` 仍不是 Workspace authority；
- Client startup `cwd` 是新 Conversation 的不受信任初始化提示；
- 默认初始化仍通过同一 `/workspace` mutation 语义完成；
- attach/follow 时持久 Workspace 优先；
- 无可用 hint 或校验失败时仍保持 `workspace: null`；
- `/workspace <path>` 仍是用户显式覆盖的唯一命令。

同时更新：

- `docs/adr/README.md`
- `CONTEXT.md`
- `docs/current/technical-overview.md`
- `docs/current/technical-overview.zh-CN.md`
- `docs/current/account-runtime-and-gateway-operations.md`

## 13. 验收标准

### TUI

- 在 `/repo-a` 执行 `metawork`，新 Conversation 自动显示 `/repo-a`。
- 第一条语义消息无需手动 `/workspace` 即可进入 Planner。
- 在 `/repo-b` attach 上述 Conversation，仍显示和使用 `/repo-a`。
- 显式 `/workspace /repo-b` 后，所有已连接 Client 更新为 `/repo-b`。

### Web

- 在 `/repo-a` 执行 `metawork web`，新 Web Conversation 自动使用 `/repo-a`。
- Workspace path 不出现在 URL 或 endpoint manifest。
- 新建第二个 Web Conversation 时仍默认 `/repo-a`。
- follow 历史 Conversation 时复用其 Workspace。
- 当前 Workspace 在 Web Conversation UI 中始终可见。
- Conversation、Trajectory、Execution、Artifact、Settings 和 Composer 的既有
  行为无回归。

### Feishu

- 历史绑定恢复并确认持久 Workspace。
- 新绑定没有 Workspace 时给出明确 `/workspace` 提示。
- 设置成功后收到 Workspace 确认。

### 安全与恢复

- 无权限、无效路径和 busy 状态均 fail closed。
- replay 与 live event 构造相同 Workspace 状态。
- Server restart 后 Workspace 仍由 Conversation metadata 恢复。
- 多 Client 并发连接不会产生 Server 全局 Workspace。

## 14. 交付记录

> Implementation status: Not started
>
> Delivered behavior: 待实施完成后填写。
>
> Validation: 待实施完成后填写聚焦测试、全量测试和真实 TUI/Web/Feishu
> acceptance 结果。
>
> Closing commit: 待实施完成后填写。
