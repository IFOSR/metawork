# 附件资源贯穿 Planner、MetaWork 与 Executor 的设计

> **Status:** Implemented（核心链路与本地验证已完成；Docker 镜像构建受 Docker Hub 网络超时影响）。2026-09-18 修订：撤销 MetaWork 提供的文档解析器、上调附件预算、修复 bridge 提交路径丢失当前 Turn 附件资格并收敛 plan_proposed 构造点（见 §15 修订记录）。
> **Closing commits:** `c85383f feat(attachments): deliver opaque user attachments into Executor inputs`、`chore(release): 1.2.0-preview.5`（同一提交内记录本设计的交付与验证）
> **Date:** 2026-09-17
> **范围:** Web 附件上传、粘贴截图、Planner 附件编排、Kernel 授权、Executor 输入物化与文件处理能力
> **相关:** ADR-0015（Planner 语义所有权）、ADR-0020（模块职责与依赖方向）、ADR-0038（Planner、MetaWork 与 Executor Context Bridge）

---

## 1. 问题

### 1.1 用户当前遇到的现象

1. 点击回形针后，系统文件选择器中的 `.docx` 等文件被置灰，无法选择。
2. 拖入 `.docx` 后，服务端返回 `HTTP 415 Unsupported attachment type`。
3. Web 输入框不能通过 `Ctrl/Cmd+V` 粘贴剪贴板截图。
4. 当前附件处理把“上传文件”“Planner 理解文件”“Executor 使用文件”混成了一条文本增强链路，无法稳定覆盖办公文档和沙箱执行。

### 1.2 当前代码事实

| 现状 | 位置 | 问题 |
| --- | --- | --- |
| 文件选择器使用固定 `accept` 白名单 | `web/src/components/Composer.tsx` | 未列出的文件在系统选择器中被静默置灰 |
| 服务端只接受图片和文本 | `src/storage/file-attachment-store.ts` | `.docx/.pdf/.xlsx/.pptx` 等文件被 415 拒绝 |
| 文本附件被截取后拼进用户输入 | `src/management/web-gateway-session-runtime.ts:195` | Planner 收到的是摘要和服务端绝对路径，不是一等资源引用 |
| 图片通过 Planner RPC 的 `images` 通道传入 | `src/planning/planning-types.ts:68` | 只覆盖图片，并把 Planner 绑定为附件内容消费者 |
| Pi RPC 和 OpenAI 适配器只实现图片内容 | `planner/AnyFusion-Pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:19`、`planner/AnyFusion-Pi/packages/ai/src/api/openai-responses-shared.ts:144` | “Planner 模型可能支持文件”不等于当前协议已支持任意文件 |
| `ContextRef` 没有当前消息附件类型 | `src/work-graph/types.ts:18` | Planner 无法把用户上传的原始附件作为明确输入指派给 Subtask |
| attempt 已有 `inputs/` 目录 | `src/execution/subtask-attempt-runner.ts:489` | 已存在合适的 Executor 输入物化位置 |
| Artifact 已有验证和物化 seam | `src/execution/subtask-execution-context.ts:276` | 当前消息附件可复用同一责任模型，但不能冒充历史 Artifact |

### 1.3 根本问题

当前链路默认认为：

```text
附件上传
-> MetaWork 抽取一段文本
-> 把文本和绝对路径拼进 Planner 输入
-> Executor 尝试沿路径读取文件
```

这个模型有四个问题：

1. **职责错误**：MetaWork Runtime 被迫理解 DOCX、PDF、XLSX、PPTX 等内容。
2. **Planner 负担错误**：Planner 的职责是理解用户意图并编排工作，不应成为通用文件解析器。
3. **执行不可靠**：服务端绝对路径不是授权输入契约，Docker 或隔离 attempt 未必可访问。
4. **能力表述不真实**：允许上传一种格式，不代表被路由到的 Executor 能处理这种格式。

---

## 2. 已确认的责任边界

本设计采用以下单向链路：

```text
Planner understands intent and plans
MetaWork stores, validates, and materializes attachments
Executor reads, parses, and processes original files
```

中文表述为：

```text
Planner 理解用户意图并选择附件
MetaWork 保存附件、验证引用并物化授权输入
Executor 读取原件并完成实际处理
```

### 2.1 Planner

Planner 负责：

- 理解用户对附件的使用意图。
- 根据附件安全元数据和 Executor 能力目录拆分任务。
- 在 Subtask 的 `contextRefs` 中显式选择需要的附件。
- 把不同附件分配给具备相应处理能力的 Executor。

Planner 不负责：

- 解析图片、DOCX、PDF、XLSX、PPTX 或其他文件内容。
- 接收 Runtime 预抽取的全文或摘要。
- 接收附件存储绝对路径。
- 判断文件是否真实存在、是否越权或内容哈希是否变化。
- 因附件格式增加 Office 解析库。

### 2.2 MetaWork

MetaWork 负责：

- 接收有界上传并保存原始字节。
- 持久化附件身份、所有权、会话归属、Workspace 归属、大小、MIME、哈希和可用状态。
- 向 Planner 投影不含文件内容和私有路径的安全元数据。
- 在 Plan admission 和执行前验证附件引用。
- 把已授权原件复制到 attempt-local `inputs/`。
- 给 Executor 暴露稳定的相对路径和安全元数据。

MetaWork 不负责：

- 为通用附件抽取正文。
- 为 Planner 生成 `.extracted.txt`。
- 根据正文做语义路由。
- 在 Runtime 中依赖 `officeparser`、`mammoth`、`exceljs`、`pdftotext` 等内容解析器。

### 2.3 Executor

Executor 负责：

- 在 attempt 的 `inputs/` 中读取被授权的原始文件。
- 根据 Provider/Harness 能力选择模型原生文件输入、Skills、CLI、系统工具或解析库。
- 处理格式差异、表格、幻灯片、文档结构、扫描件和必要的降级策略。
- 在无法处理文件时返回规范化、可诊断的失败，而不是假装完成。

Executor 用哪个基座模型、哪种原生的工具或 Skills 完成解析，是它自己的实现细节。MetaWork 不提供任何解析器，也不把解析能力写进 MetaWork 的依赖或统一解析策略：被路由到的 Executor 的基座模型本身就能处理文档解析，再用一个能力更弱的固定解析库没有意义。

---

## 3. 方案比较与结论

### 3.1 方案 A：MetaWork Runtime 统一解析文件

原方案在上传时使用 Office/PDF 解析库，生成 `.extracted.txt`，再把摘要交给 Planner。

**结论：拒绝。**

原因：

- 把内容处理职责错误地放进 Runtime。
- Server 需要持续维护格式、解析质量、库体积和漏洞面。
- 解析结果会丢失版式、公式、图表、批注、嵌入对象等信息。
- Planner 获得正文并不是完成编排所必需的。
- Executor 最终仍可能需要读取原件，形成重复处理。

### 3.2 方案 B：所有附件直接交给 Planner 模型解析

Planner 模型可能是多模态模型，也可能由 Provider 提供原生文件输入能力。

**结论：不作为默认架构。**

这条路径技术上可作为未来特定 Planner/Provider 的优化，但不能成为系统契约，原因是：

- 当前 Pi RPC 和 Provider 适配器只实现图片输入，没有通用文件协议。
- 不同 Provider 对文件类型、大小、上传方式和生命周期的支持不同。
- Planner 即使能读文件，也不代表应该在规划阶段消耗完整文件内容。
- 文件处理结果最终服务于执行任务，直接交给 Executor 能减少重复读取和上下文占用。
- Planner 若依赖文件内容才能路由，会重新承担执行侧职责。

因此，本设计不是否定模型原生文件能力，而是不把它设为 Planner 的必要依赖。

### 3.3 方案 C：附件作为不透明资源，由 Executor 处理

**结论：采用。**

附件对 Planner 是带安全元数据的资源引用；对 Kernel 是待验证的授权对象；对 Executor 是 attempt-local 原始输入。

这个方案与 Planner 不直接执行 Web 搜索的责任模型一致：

- Planner 理解“需要查什么”或“需要对文件做什么”。
- Planner 选择合适的 AgentClass/Executor 并生成工作图。
- Executor 使用实际工具完成检索或文件处理。

---

## 4. 目标架构

### 4.1 端到端流程

```text
用户点击、拖放或粘贴文件
  -> Web 统一上传入口
  -> MetaWork 保存原件和安全元数据
  -> 用户提交消息时携带 attachmentId
  -> Planner 只看到用户意图和附件元数据
  -> Planner 在 Subtask 中选择 attachment ContextRef
  -> MetaWork 构建 eligible attachment set
  -> Kernel admission 验证引用和 Executor 资格
  -> Runtime 再验证并复制原件到 attempt inputs/
  -> Executor 读取原件并完成内容处理
  -> 结果按现有 Completion Protocol 和 Artifact 发布
```

### 4.2 附件与 Artifact 的区别

两者都可以被物化到 Executor 的 `inputs/`，但语义不同：

| 类型 | 来源 | 生命周期 | ContextRef |
| --- | --- | --- | --- |
| Attachment | 当前用户消息上传 | Account/Conversation/Workspace 作用域内的用户输入资源 | `{ kind: 'attachment', attachmentId }` |
| Artifact | 已完成 Task 发布的历史结果 | 由 Artifact publication 管理 | `{ kind: 'artifact', artifactId }` |

不得把当前上传附件伪装成已发布 Artifact，也不得复用 `task_resource` 的自由字符串 locator。

### 4.3 附件内部记录与 Planner-safe 投影

```ts
interface StoredAttachmentMetadata {
  attachmentId: string;
  accountId: string;
  conversationId: string;
  workspaceId: string;
  name: string;
  mime: string;
  mediaClass:
    | 'image'
    | 'text'
    | 'document'
    | 'archive'
    | 'binary'
    | 'unknown';
  size: number;
  sha256: string;
  status: 'available' | 'unavailable';
  createdAt: string;
}
```

Account、Conversation、Workspace、哈希和存储状态验证属于 MetaWork 内部授权事实。Planner 只接收完成编排所需的有界投影：

```ts
interface PlannerAttachmentView {
  attachmentId: string;
  name: string;
  mime: string;
  size: number;
  availability: 'available' | 'unavailable';
}
```

Planner-safe 投影必须排除：

- Account、Conversation 和 Workspace 的内部身份。
- 内容哈希。
- 服务器绝对路径。
- 原始字节和 base64 内容。
- 预抽取正文或摘要。
- 存储实现细节。
- Account 私有目录结构。

---

## 5. 上传与存储契约

### 5.1 上传支持不等于处理支持

系统必须分别表达两种能力：

1. **Upload acceptance**：MetaWork 能否安全、有界地保存原始字节。
2. **Execution eligibility**：是否存在能处理该文件的 Executor。

未知扩展名或 `application/octet-stream` 可以被上传并标记为 `unknown`，但 Planner 只能把它路由给声明支持该媒体类型或具备通用二进制检查能力的 Executor。

如果没有 eligible Executor，系统应在规划/admission 阶段给出明确提示，而不是：

- 在上传阶段假装“格式不支持”；
- 把文件交给不具备能力的 Executor；
- 由 Runtime 尝试兜底解析。

### 5.2 服务端校验

上传仍需执行与内容理解无关的基础校验：

- 单文件大小上限。
- 单消息附件数量上限。
- Account/Conversation/Workspace 绑定。
- 文件名规范化和路径穿越防护。
- 流式写入与哈希计算。
- 原子落盘和元数据提交。
- 普通文件、非符号链接检查。
- 存储配额和失败清理。
- MIME sniffing 仅用于安全分类和路由事实，不用于提取正文。

具体大小与配额数值在实施计划中结合现有 Gateway 限制确定，不在本设计中把解析器限制误写成产品格式限制。当前生效数值见 §15 修订记录。

### 5.3 类型策略

- 服务端不再以“图片或文本”作为唯一允许清单。
- Web 文件选择器不应使用窄 `accept` 白名单阻止用户选择文件。
- `accept` 可以保留为建议性提示，但不能成为产品支持范围的唯一来源。
- 扩展名、声明 MIME 和 sniffed MIME 不一致时记录规范化分类；高风险或明显伪造内容按安全策略拒绝。
- 加密、损坏或内容不可解析的文件可以成功上传；是否可处理由 Executor 决定。

---

## 6. Planner 与 Work Graph 契约

### 6.1 Planner 输入

用户提交消息时，Planner 获得：

- 原始用户文本。
- 本消息附件的安全元数据列表。
- Routing Catalog 中与文件处理有关的 Executor 能力事实。

Planner 不获得附件内容。它可以根据名称、MIME、媒体类别和用户意图形成工作图。例如：

```text
用户：比较这两个版本的合同并列出风险
附件：contract-v1.docx、contract-v2.docx

Planner：
  -> 生成一个文档比较 Subtask
  -> contextRefs 选择两个 attachmentId
  -> 路由到支持 DOCX 处理的 Executor
```

### 6.2 一等 Attachment ContextRef

P0 必须扩展 `ContextRef`：

```ts
export type ContextRef =
  | { kind: 'current_user_input' }
  | { kind: 'interaction'; interactionId: string; side: 'user' | 'assistant' }
  | { kind: 'attachment'; attachmentId: string }
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'task_resource'; locator: string }
  | { kind: 'task_evidence'; evidenceId: string }
  | { kind: 'preference'; preferenceId: string };
```

这不是 P1 优化，而是避免绝对路径和文本摘要旁路的核心契约。

### 6.3 Planner 选择规则

- Planner 只引用当前 eligible attachment set 中的 `attachmentId`。
- 一个附件只有在某个 Subtask 实际需要时才进入该 Subtask 的 `contextRefs`。
- Planner 不得构造路径、猜测 ID 或用文件名代替稳定身份。
- Planner 可以把不同附件分配给不同 Subtask。
- Planner 可以在用户只上传文件但未说明目标时发起澄清，而不是先解析文件寻找任务。

---

## 7. Kernel 验证与 Runtime 物化

### 7.1 Eligible attachment set

在 Plan admission 前，MetaWork 为当前 Turn 构建有界 eligible set，至少验证：

- Attachment 存在。
- Account 与当前 Task 一致。
- Conversation 与当前 Turn 一致。
- Workspace 与当前 Task 一致。
- Attachment 属于本次用户提交或被明确允许的当前上下文。
- 状态为 `available`。
- 源文件是普通文件且不是符号链接。
- 持久化哈希非空，当前源文件哈希与记录一致。

Kernel 只接受 eligible set 中的 attachment 引用。

### 7.2 Executor 能力资格

Routing Catalog/Executor profile 必须能够表达文件输入处理能力。实现可以按稳定媒体类别与格式集合建模，例如：

```text
file-input
document-docx
document-pdf
spreadsheet-xlsx
presentation-pptx
image-input
```

最终 capability 命名由实施计划结合现有 Routing Capability 体系确定，但必须满足：

- Planner 能看见安全、稳定的能力事实。
- MetaWork 能在 admission 时验证绑定的 Executor 符合要求。
- Runtime 不通过文件扩展名临时改派 Executor。
- “可上传”不能自动推导为“任意 Executor 可处理”。

### 7.3 attempt-local 物化

Runtime 在每次 attempt 启动前重复身份、状态、文件类型和哈希验证，并把附件复制到：

```text
<attempt-workspace>/inputs/
```

Executor 只看到：

- 稳定、冲突安全的相对文件名。
- 相对输入路径。
- 文件名、MIME、大小、哈希等安全元数据。
- Subtask 目标和被选择的 ContextRef。

Executor 不看到 Attachment Store 的绝对路径。

重试、fallback、continuation 和容器执行必须通过同一物化 seam 获得等价输入，不依赖宿主路径偶然可读。

---

## 8. Executor 文件处理策略

### 8.1 支持方式

Executor 可根据自身实现选择：

- Provider 原生文件输入。
- 模型原生多模态/文档能力。
- 已安装 Skill。
- CLI 或系统工具。
- Executor 自带的 Node/Python 解析库。
- 格式转换或 OCR 工具。

MetaWork 不规定所有 Executor 使用同一种解析器。

### 8.2 P0 的真实完成标准

P0 不能只完成“文件可以上传”。至少一个默认可用 Executor 必须在原生和受支持的 Docker/沙箱路径中，通过真实验收证明能处理：

- `.docx`
- `.pdf`
- `.xlsx`
- `.pptx`

验收至少覆盖：

- 中文正文。
- 表格或工作表数据。
- 幻灯片文本和基本结构。
- 文件损坏或不支持时的明确失败。
- attempt 只能通过 `inputs/` 相对路径访问原件。

如果某个默认 Executor 依赖 Skill、CLI 或库，安装、版本锁定、探针和镜像一致性必须属于该 Executor 的交付范围。

### 8.3 图片统一

图片最终也应走同一个 attachment resource contract：

```text
上传图片
-> attachment ContextRef
-> Runtime 物化到 inputs/
-> 具备 image-input 能力的 Executor 处理
```

Planner 无需先通过 `images` 通道查看图片才能决定 Executor。当前 Planner 图片通道可以在迁移期间保留，但目标状态是删除这种格式特例，避免图片和文档形成两套权限与物化链路。

---

## 9. Web 交互设计

### 9.1 三个入口共用一个上传流程

以下入口必须统一调用同一上传函数和状态管理：

- 点击回形针选择文件。
- 拖放文件。
- 粘贴剪贴板截图或文件。

### 9.2 粘贴截图

`Composer` 增加 `onPaste`：

1. 读取 `clipboardData.items`。
2. 提取 `image/*` 项并转换为 `File`。
3. 生成可识别的默认文件名。
4. 复用普通附件上传流程。
5. 只有存在文件项时才拦截对应默认行为；纯文本粘贴保持不变。

### 9.3 用户可见状态

每个附件至少展示：

- 上传中。
- 已上传。
- 上传失败及可操作原因。
- 文件名和大小。
- 删除/取消。

不展示“抽取中”“已抽取 N 字”等状态，因为 Runtime 不再抽取内容。

当没有 eligible Executor 时，应明确区分：

```text
文件已上传，但当前没有可处理此格式的 Executor。
```

这比把上传失败和处理能力不足混成一个 415 更准确。

---

## 10. 契约与权威文档变更

### 10.1 必须修订 ADR-0038

ADR-0038 当前覆盖历史 Artifact 和图片 Executor 输入。本设计需要修订它，加入：

- 当前 Turn Attachment ContextRef。
- Attachment eligible set。
- Account/Conversation/Workspace/status/hash 验证。
- attempt-local 原件物化。
- Planner-safe 附件元数据。
- 图片与通用文件的统一目标模型。

修订后的方向仍保持 ADR-0038 的核心原则：

```text
Planner understands and selects
MetaWork provides facts and verifies
Executor executes
```

### 10.2 需要更新的契约面

| 契约 | 变更 |
| --- | --- |
| Attachment Store | 保存通用有界文件、身份归属、媒体分类、哈希和状态 |
| Gateway command | 用户消息携带 attachment IDs，不携带私有路径或正文 |
| Planning context/RPC | 提供安全附件元数据，不提供文件字节 |
| Work Graph schema | 新增 `{ kind: 'attachment', attachmentId }` |
| Planning validation | 只允许引用当前 eligible set |
| Kernel snapshot/admission | 验证附件资格和 Executor 文件能力 |
| Execution context | 解析 selected attachments 并生成安全输入清单 |
| Attempt runner | 在 `inputs/` 物化附件原件 |
| Executor profile | 声明实际文件处理能力 |
| Web | 放宽选择器、统一三入口、增加粘贴截图 |

### 10.3 必须删除的旧路径

- `enrichWithAttachments()` 中的文本摘录注入。
- `current_user_input` 中的附件绝对路径。
- “图片内容必须先给 Planner”的默认假设。
- Runtime 侧 `.extracted.txt` 设计。
- P0 引入 Server 级 `officeparser` 的计划。
- 把 attachment ContextRef 延后到 P1 的计划。

---

## 11. 测试与验收

### 11.1 上传与存储

- 点击、拖放、粘贴走同一上传入口。
- `.docx/.pdf/.xlsx/.pptx` 不再被前端选择器静默置灰。
- 通用文件按大小、数量、配额和安全规则保存。
- 文件名路径穿越、符号链接、写入中断和哈希不一致失败关闭。
- MIME/扩展名不一致时产生确定的媒体分类或拒绝结果。

### 11.2 Planner 与 Work Graph

- Planner 输入只含附件安全元数据。
- Planner prompt/RPC 中不出现附件绝对路径、base64 或预抽取正文。
- `attachment` ContextRef schema、序列化、验证和审计覆盖完整。
- Planner 不能引用其他 Turn、Conversation、Workspace 或 Account 的附件。
- 未使用的附件不会自动注入所有 Subtask。

### 11.3 Kernel 与 Runtime

- 错误 Account/Conversation/Workspace/status/hash 的引用全部拒绝。
- Executor 不具备文件能力时 admission 失败并给出稳定原因。
- 原生和 Docker attempt 都只能从 `inputs/` 读取附件。
- retry/fallback/continuation 的输入身份和哈希保持一致。
- 文件消失或哈希变化时执行前再次失败关闭。

### 11.4 Executor 能力

- 默认 Executor 对 DOCX、PDF、XLSX、PPTX 做真实内容处理验收。
- 中文、表格、幻灯片结构和多文件任务可处理。
- 损坏、加密、扫描件或不支持格式返回规范化失败。
- Executor 使用的解析依赖不进入 MetaWork Runtime 依赖树。

### 11.5 回归

- 现有文本消息、Task、Artifact Context Bridge 和 Completion Protocol 不回归。
- 历史 Artifact 仍使用 `{ kind: 'artifact' }`。
- 纯文本粘贴不被截图粘贴逻辑拦截。
- 附件上传成功不被错误表述为已具备处理能力。

---

## 12. 分期

### P0：附件成为 Executor 输入资源

- 通用、有界附件上传和元数据持久化。
- Web 点击、拖放、粘贴三入口统一。
- Planner-safe 附件元数据投影。
- `attachment` ContextRef 和 schema/validation。
- Kernel eligible set 与 Executor 资格验证。
- attempt-local `inputs/` 原件物化。
- 删除摘要和绝对路径注入。
- 至少一个默认 Executor 真实支持 DOCX、PDF、XLSX、PPTX。
- 修订 ADR-0038、`CONTEXT.md` 和 current technical overview。

### P1：扩展文件能力

- 更多格式和媒体类别。
- OCR、扫描件和复杂版式能力。
- 大文件分块、Provider file lifecycle 和缓存优化。
- 图片 Planner 直传通道迁移到统一 attachment path。
- Executor 能力探针、可观测性和用户可见诊断增强。

---

## 13. 明确不做

- 不在 MetaWork Runtime 中建设通用 Office/PDF 内容解析层。
- 不为 Planner 生成或注入 `.extracted.txt`。
- 不把附件全文或摘要默认拼入 `current_user_input`。
- 不把服务端绝对路径暴露给 Planner 或 Executor。
- 不假设“模型是多模态”就等于所有 Provider/Harness 支持所有文件格式。
- 不把上传成功等同于处理能力已经存在。
- 不允许 Planner、Web 或 Executor 绕过 Kernel 授权直接读取 Attachment Store。

---

## 14. 实施结果与验证结论

已确定并实现：

1. Attachment 以文件 sidecar 元数据保存，单文件上限为 100 MiB，单条消息的附件合计上限为 500 MiB，数量上限为 32 个，绑定 Account、Conversation 和 Workspace。
2. Planner 只接收安全元数据，`attachment` 作为一等 Work Graph `ContextRef`。
3. MetaWork 在 attempt-local `inputs/` 中完成原件物化，并在执行前重验所有权、状态、大小和 SHA-256。
4. Web 点击、拖放和剪贴板文件粘贴共用上传入口；普通文本粘贴保持原行为。
5. 默认工程 Executor 声明 `document-processing`；文档内容由该 Executor 的基座模型与其自有工具处理，MetaWork 不提供、也不发布任何文档解析器。

本地验证已完成：

1. `npm run lint`、`npm run build`、`npm run build:web` 和 `git diff --check` 通过。
2. 附件上传、Planner 安全元数据投影、Kernel 资格校验、attempt-local 物化由 host 测试覆盖（2026-09-18 修订后不再包含解析器 fixture 验证，见 §15）。
3. 全量主机测试通过：407 个测试文件通过、8 个跳过；2222 个测试通过、20 个跳过。
4. Planner schema contract、Web 图片迁移、Management 上传、Planner MCP 附件元数据和执行上下文测试通过。
5. 主 bundle 不包含任何文档解析器：`officeparser` 已从依赖中移除，仓库内不存在解析器入口。

仍存在的操作验证限制：

1. 两个 attempt Docker 镜像构建在拉取 `node:22.19.0-bookworm-slim` 时因 Docker Hub token 网络超时未能开始构建；需要在可访问 Docker Hub 的环境中重跑。
2. 本地测试覆盖了 Feishu Workspace 绑定和附件路由契约；真实 Feishu 租户端到端验证仍依赖外部租户凭据和网络。

这些验证不得改变责任边界：Planner 编排、MetaWork 验证和物化、Executor 处理内容。

---

## 15. 修订记录

### 2026-09-18：撤销 MetaWork 提供的文档解析器

原实施把“文档处理”落成了一个 MetaWork 自带的 `metawork-document-reader` CLI（内部打包 `officeparser`），并把它注入 attempt 环境（`METAWORK_DOCUMENT_READER`）和 Executor prompt。该实现被撤销，理由：

- 被路由到的 Executor 的基座模型本身具备文件解析能力，且在 attempt 中可以使用自己的工具、Skills 或代码完成解析。
- 在 Executor 里再加载一个固定的第三方解析库（`officeparser`）属于能力更弱的替代品，反而把格式覆盖、解析质量、依赖体积（含 `pdfjs-dist`、`tesseract.js`）和漏洞面变成 MetaWork 的长期负担。
- 它与本设计 §2.3 的边界表述不一致：Executor 用哪种手段解析必须是 Executor 自己的实现细节，而不是 MetaWork 发布的一个统一工具。

撤销内容：

1. 删除 `src/executor/document-reader.ts`、`src/document-reader-cli.ts`、`tsup.document-reader.config.ts` 及其测试。
2. 从 `package.json` 移除 `metawork-document-reader` bin、`build:document-reader` 脚本和 `officeparser` 依赖；`package-lock.json` 不再包含 `officeparser`。
3. 两个 attempt 镜像不再 `COPY dist/document-reader-cli.cjs`，也不再创建 `/usr/local/bin/metawork-document-reader`。
4. native 与 container Executor 适配器不再注入 `METAWORK_DOCUMENT_READER`。
5. Executor prompt 的 `Document processing` 段落改为 `Attachment processing`：附件是物化在 `inputs/` 下的原件，MetaWork 不提供解析器，由 Executor 用自己的模型与工具处理；无法处理时返回规范化失败，而不是猜测内容。

保留内容（未变）：

- `document-processing` Routing Capability 及其默认声明。它是 Planner/Kernel 的路由词汇：Planner 需要它来选择具备文件处理能力的 Executor，Kernel 需要它来拒绝不具备该能力的 Executor。撤销的只是由 MetaWork 提供的**解析实现**，不是能力声明。
- MetaWork 的责任边界：保存原件、验证引用、物化到 attempt-local `inputs/`，不解析内容。

### 2026-09-18：上调附件大小上限并新增单消息预算

原上限（单文件 25 MiB）过小，用户上传一份带内嵌图片的 WPS 菜谱工作簿（79 MB）会在上传阶段被 400 拒绝。新契约：

| 规则 | 数值 | 常量 |
| --- | --- | --- |
| 单个附件 | 100 MiB | `MAX_ATTACHMENT_BYTES`（`src/gateway/attachment-store-port.ts`，由 `FileAttachmentStore` 强制） |
| 单条消息附件合计 | 500 MiB | `MAX_ATTACHMENT_TOTAL_BYTES_PER_MESSAGE` |
| 单条消息附件数量 | 32 | `MAX_ATTACHMENTS_PER_MESSAGE` |

实现要点：

1. `MAX_ATTACHMENT_BYTES` 从 `src/storage/file-attachment-store.ts` 移到 store port 模块，成为唯一来源；存储层重新导出，网关层不再引用存储实现。
2. 新增 `src/gateway/attachment-budget.ts`：消息级预算的唯一定义与纯函数 `evaluateAttachmentBudget` / `evaluateAttachmentCount`。
3. Web 消息提交在 `WebGatewaySessionRuntime.submit` 里先校验预算再进入 Planner/Kernel；违反时抛 `WebGatewayAdmissionError`，错误码为 `attachment_too_large` / `attachment_total_too_large` / `attachment_count_exceeded`，消息不会成为一次 Turn。
4. Web 前端新增 `web/src/attachment-limits.ts`（与 Server 同规则的镜像），`handleFilesSelected` 在上传前预检，并在收到 `attachment_*` 错误码时恢复草稿与待发附件，不再丢失消息。
5. 数量上限从“仅前端”变为 Server 也强制。

未变：MetaWork 不解析内容；Executor 对 `inputs/` 下原件如何处理由 Executor 及其基座模型决定。已知空缺：附件按 Conversation 持久保存，存储侧没有总量配额（本次只加了单消息预算）。

### 2026-09-18：修复 Bridge 提交路径丢失当前 Turn 附件资格

现象：用户在 Web 上传两个附件并发送后，Kernel 返回“计划引用了当前任务不可用的上下文（attachment）。请重新说明需求……”。

根因：原生 Planner 通过 host bridge 提交方案，走 `ConversationSession.submitPlannerProposal`。该方法原先调用 `buildPlanningContext(userInput)`，**没有传 attachments**，于是 `plan_proposed.attachmentIds` 为空，`buildEligibleContextRefKeys` 无法把 `{ kind: 'attachment' }` 加入 eligible set，Kernel 按设计 fail closed 拒绝。Planner 侧其实正常：它已通过 MCP `get_planning_context` 拿到附件元数据（`METAWORK_PLANNER_ATTACHMENTS_JSON`）并正确引用。该缺陷影响所有经 bridge 提交的附件方案（Web、飞书、native Planner 均走这条提交路径）。

修复：

1. `ConversationSession` 在 Planner 运行期间保存当前 Turn 的附件视图（`activePlannerTurnAttachments`），运行结束（`finally`）时清空；`submitPlannerProposal` 用它重建与 Planner 看到的一致的 context，使 `attachmentIds` 与该 Turn 的 eligible set 一致。
2. `ControlKernel` 的 kindHint 补充 `attachment → 附件`，用户不再看到英文原词（原属计划 Task 4 第 5 步，漏交付）。

回归测试：`tests/session/conversation-session.test.ts` 新增 bridge 提交路径用例（去掉修复后必失败：`attachmentIds` 为 `[]`）；`tests/kernel/control-kernel.test.ts` 新增附件引用的中文标签与 eligible 准入用例。

已知残留：eligible set 的进程内副本在 Server 中途重启后会丢失（若持久化未做）。彻底修复需把该 Turn 的附件 id 持久化。

### 2026-09-18：收敛 plan_proposed 构造点，replan 继承原 Turn 附件，持久化 Turn 附件事实（schema 38）

针对上一节暴露的结构问题（同一份 Turn 事实被多个入口各自重建），完成三件事：

**1. 单一构造点。** `ConversationSession.buildPlanProposedEvent` 成为构造 `plan_proposed` 事件的唯一位置，`attachmentIds` 是必填字段。原先三个构造点（初提案、自动 replan、冲突/合并 replan）全部改为调用它，新入口不可能再静默丢掉附件集。

**2. Turn 事实单一来源。** `ConversationSession` 在 Planner 运行开始时记录本 Turn 的输入事实（`beginPlannerTurn`），运行结束时清除（`endPlannerTurn`）；`submitValidatedPlannerProposal` 不再接收调用方的 `context`，而是从这份 Turn 事实推导 `attachmentIds` 与 configuration revision。因此进程内回调（门 A）与 host bridge（门 B）两条提交通道走同一实现、同一事实，不可能再分叉。门 A 的接口钩子保留（它已不是第二条实现），因为测试档依赖它，且删接口会强制重写大量行为测试而不增加正确性。

**3. replan 继承原 Turn 附件。** 自动 replan 与冲突/合并 replan 不再造空集，而是从 Kernel 账本中该 Task **最早那条 `plan_proposed` 事件**的 `attachmentIds` 取回（`resolveTaskTurnAttachmentIds`），落实设计文档“replan 不得发明新附件 id”。

**4. 持久化（schema 37→38）。** 新增 `planner_turn_inputs`（conversation_id 主键 + user_input_hash + attachment_views_json）与 `PlannerTurnInputRepo`：Turn 开始时写入，结束时清除，bridge 提交找不到进程内事实时回退到该行（校验请求文本 hash）。这样 Server 在 Planner 运行中途重启、方案由 bridge 重放时仍能通过准入，而不是回退为澄清。

验证：`tests/session/conversation-session.test.ts` 新增“bridge 提交来自重启后的进程”与“replan 可引用原 Turn 附件”两条用例（去掉对应修复均失败）；`tests/storage/planner-turn-input-repo.test.ts` 覆盖读写/覆盖/清理/坏数据；`tests/storage/migrations.test.ts` 新增 37→38 升级与基线断言。

未变：MetaWork 不解析附件内容；`MetaclawSession`（standby Ink TUI）保留自己的旧构造代码，但它不支持附件，按 AGENTS.md 不对其做迁移投入。

### 2026-09-18：Planner/Executor 失败原文透传（取消“通称替换”）

现象：一次 Executor attempt 因 provider `403 用户额度不足` 失败，但用户界面只看到“已阻塞 · 36 步”+ 模型最后一句旁白；轨迹里的失败摘要是 Codex 的启动提示 `Reading additional input from stdin...`，分类落到 `unknown_executor_failure`，Kernel 因此 `block_work`（"unknown requires explicit recovery"）。真因（额度）既不在用户可见文案里，也不在轨迹里。

根因（三层叠加）：

1. 捕获：`normalizeHarnessResult` 在非 0 退出时只取 stderr；真实原因在 stdout 的 `turn.failed` / `error` 事件里，被丢弃。
2. 摘要：`formatExecutorError` 把原文替换成中文通称，且全为噪音时兜底会把噪音行当摘要返回。
3. 分类：额度类文本没有任何规则命中，落到 `unknown` → Kernel fail-closed 阻塞，且无可换 binding 路径。

修复（按“错误必须原文透传”的原则）：

1. `KernelFailure` 增加透传字段：`label`（可选中文headline）、`detail`（原始尾巴，有界 4000）、`origin`（planner/executor/harness/provider/kernel）、`stage`、`actor`（agentClass/harness/provider/model/attempt/subtask）、`provider.httpStatus`/`requestId`、`step`（失败前最后一步）；新增失败种类 `provider_quota`。
2. `normalizeExecutorFailure` 的 `summary` 改为**上游原文**（首个有意义行，否则原文首行）；中文通称只作为 `label`，从不覆盖原文。
3. 新增 `provider_quota` 判定（额度/余额/欠费/402，**不含**裸 403）：Kernel 把它归入“不重试但可换 binding”的集合（`control-kernel.ts`），`executor-status-projection.ts` 将其计为类永久故障，因此欠费的 provider 不会被继续使用；没有可换 binding 时自动 replan 一次，再不行才 park。
4. Codex driver 新增 `structuredStreamFailure`：非 0 退出时优先取 `turn.failed`，其次最后一条 `error` 事件，stderr 降级为 `errorDetail`。
5. `local-cli-executor-adapter` 在失败时附带 `origin/stage/actor/step`，其中 `step` 来自最后一条进度行。
6. 可见性：`executor_result_observed` 轨迹事件新增 `failureSummary`/`failureLabel`/`failureStep`/`failureProvider`/`failureDetail`；`blockTask` 的 description 在策略原因后附上失败码与原文；Web 会话条目在 blocked/failed 时渲染失败摘要、失败码、步骤与 provider 状态（`ConversationTurn.tsx` + `styles.css`）。

验证：`tests/executor/codex-cli-driver.test.ts` 复现本次事故（去掉 driver 修复即失败）、`tests/executor/error-utils.test.ts` 新增透传/分类用例、`tests/kernel/control-kernel.test.ts` 新增“quota → 换 binding / 单 binding → 一次 replan（不再是 unknown 阻塞）”、`tests/web/conversation-turn-failure.test.ts` 断言界面出现原文+失败码+步骤。回归：executor/kernel/tui/web 75 文件 381 通过；management/gateway/acceptance 55 文件 384 通过；`npm run lint`、web `tsc`、`vite build` 通过。

### 2026-09-18：托管路径缩短（F4）与配额失败不再标记类故障

现象（承接上一节）：Executor 工作目录达 402 字符，`planning-with-files` 的技能脚本把整条 CWD 压成单段目录名时溢出 macOS `NAME_MAX`(255)。

根因：同一个 64 位 plan-event 哈希在三级目录名里各出现一次（`task_...`(89) / `generation_task_...`(95) / `task_..._r1_<slug>`(120)），且 account 根下 `workspace-store/workspace-store` 重复了一段；attempt 目录段也长达 188。

修复：

1. 新增 `src/utils/bounded-path-segment.ts` 的 `boundedPathSegment(identity, {prefix, readable, from, digest})`：确定性、纯函数、≤64 字符（可读前缀/后缀 + 8 位摘要）。持久 id 在数据库、Kernel 账本与所有 handle/URI 中保持完整不变，只有磁盘目录名被压短；任何进程都能重算出同一目录，无需映射表或迁移。
2. 应用于：`workspace-store.ts` 的 task/generation/subtask 段（创建与 `assertManagedWorkspace` 校验两处同源）、`runtime-home-materializer.ts` 的 attempt 段、`managed-git-workspace.ts` 的仓库目录段（Git ref/branch 名保持完整可读，因为它们是发布契约且组件本身未超限）。
3. `account-workspace-services.ts` 去掉重复的 `workspace-store` 段（account 级 `<account>/workspace-store/` 契约不变，ADR-0031/0034/0035 不受影响）。
4. 实测效果：同一 task 的工作区绝对路径从 402 → 约 150 字符，每段 ≤64；attempt HOME 从 188 → 约 80。
5. 配额失败（`provider_quota`）**不再**计入永久类故障：充值后该类立刻可用，路由继续按能力优先；单次失败只在当前 Subtask 内跳过已试过的 binding（Kernel 仍会换 binding 或自动 replan 一次），不影响后续任务。

新增/更新测试：`tests/execution/workspace-path-length.test.ts`（纯函数 + 真实长 id 的段落/总长断言）、`runtime-home-materializer.test.ts`、`scripted-session.test.ts`（新目录形状）、`control-kernel.test.ts`（quota 后类仍 available、再次成功保持 healthy）。契约记录：`CONTEXT.md` 新增 managed path-naming invariant；`CHANGELOG.md` Unreleased。

### 2026-09-18：Planner 模型切换与会话语义调和；replan 禁止盲目复用失败候选

现象：把 Planner 换成本地部署模型后，执行任务报 `Planner unavailable: Planner model binding mismatch: expected custom-model-5/Ornith-…gguf, received deepseek/deepseek-flash`。

根因：每个 Conversation 的 Pi 会话是持久的（`--session <conversation>.jsonl`），会话自身保存了上次选择的模型；切换模型只改了 revision 级 runtime home 的 `settings.json`（本机 `planner/runtime/revision-d1adc52b…/settings.json` 已是新模型），而 `planner/sessions/conv_OS3gQjfaDuxK.jsonl` 里仍是 `provider=deepseek, model=deepseek-flash`。MetaWork 启动 Pi 时不传 `--model`，Pi 恢复会话模型并通过 `get_state` 上报，于是与配置期望不一致 → fail closed。

修复：`planner-process-supervisor` 在 `get_state` 检查发现不一致时，先发一次 RPC `set_model`（Pi 的 `rpc-mode.ts` 已支持，按 provider+modelId 在 registry 中校验）调和会话模型，随后再取一次 `get_state` 复核；只有调和失败才 fail closed，并在错误里同时给出期望值、实际值与 set_model 的失败原因。语义连续性（同一 Pi 会话）因此得以保留，不需要轮换会话。

同时补上一条 replan 语义指令：自动 replan 的请求已经携带本代失败候选（`agentClassName/failure/code/summary`），现明确要求 Planner 不得在未说明"这次为何会不同"的情况下把剩余工作重新绑定到刚失败的 Executor 候选。

状态：F1–F4 落地，模型切换调和与 replan 指令落地；F5（技能侧）按用户决定不做；未发 release。
