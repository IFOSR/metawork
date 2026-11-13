# Pi 图片执行方案切换设计

> **状态：** Implemented
> **设计日期：** 2026-09-01
> **完成日期：** 2026-09-01
> **范围：** 将 `pi-agent` 的图片生成与编辑从 vendored AnyFusion-Pi 内部实现切换为 MetaWork 自有图片执行器
> **保持不变：** Provider 配置、SecretStore、统一 Executor 能力画像、Planner 路由、Kernel 授权、模型选择、Completion Protocol、用户可见的 Executor 数量
> **相关权威：** ADR-0020、ADR-0024、ADR-0028、统一 Executor 能力画像设计

## 1. 决策摘要

停止继续扩展 vendored AnyFusion-Pi 的图片模式，改为：

```text
同一个 pi-agent AgentClass
  + 同一个 pi-cli Harness 配置
  + 同一份 Skill-style 能力说明书
  + Kernel 授权的具体 Model binding
                    |
                    v
        PiCompositeExecutorAdapter
                    |
        +-----------+-----------+
        |                       |
        v                       v
普通文本、研究、工具任务     图片生成或图片编辑任务
标准 Pi CLI                MetaWork Image API Runner
```

用户、Planner 和 Kernel 仍然只看到一个 `pi-agent`。图片 Runner 是
`pi-cli` Executor 实现内部的执行引擎，不新增用户可配置的图片 Executor，
不新增第二份能力说明书，也不要求 AgentClass 支持多个 `harnessRef`。

Planner 继续根据 `pi-agent` 的最终能力画像选择 Executor。Kernel 继续根据
Subtask 的 `requiredCapabilities` 从该 Executor 的有效模型池中选择
`gpt-image-2`。只有执行阶段会根据已授权能力选择具体内部执行引擎。

## 2. 切换原因

方案一已经证明图片 API 和图片产物协议可行，但真实 CLI 验证暴露了结构性
问题：

- vendored Pi 是 Planner 定制 fork，CLI 入口会拒绝 Executor 传入的
  `--provider` 和 `--model`；
- Planner 的只读工具策略、Planner bootstrap 和 Executor 运行策略共用同一
  CLI 入口，继续拆分会扩大 fork 改造范围；
- 图片 API 不需要 Pi 的会话、ReAct、工具和 Planner proposal 机制；
- 将图片执行放进 Pi 会增加后续升级和 rebase 冲突；
- 方案一把完整 Executor 上下文作为图片 prompt 发送，混入了内部协议、
  路由和完成标记，不适合作为图片生成指令。

图片调用属于 Executor Adapter 的外部执行能力，应该由 MetaWork 的
Executor 层拥有，而不是由 Planner 定制 Pi 拥有。

## 3. 产品与架构边界

### 3.1 用户可见边界

配置页面保持：

```text
Executor: pi-agent

模型：
- 普通文本/研究模型
- gpt-image-2

能力说明书：
- 研究、分析等能力由普通模型提供
- 图片生成和图片编辑由 gpt-image-2 提供
```

不新增：

- `pi-image` Executor；
- 图片专用 AgentClass；
- 用户可编辑的图片 Harness；
- 第二份能力标签或 Routing Catalog；
- Provider 图片协议配置项。

### 3.2 Planner 和 Kernel 边界

链路保持：

```text
最终 Executor 能力画像
  -> Planner 语义匹配 pi-agent
  -> Work Graph requiredCapabilities=image-generation/image-editing
  -> Validator 校验 profile-derived qualification
  -> Kernel 从 pi-agent allowed models 选择图片模型
  -> 生成 revision-pinned AuthorizedExecutorBinding
  -> Runtime 创建 pi-agent Executor Adapter
```

执行器不得自行换模型。Image Runner 必须使用 Kernel 已授权 binding 中的：

- `providerRef`；
- `modelRef` 和实际 `modelId`；
- `configurationRevision`；
- `bindingFingerprint`；
- Permission Profile；
- attempt/workspace/input 路径。

### 3.3 Harness 边界

配置层继续使用：

```text
agentClass.harnessRef -> pi-cli Harness
```

代码维护的 `pi-cli` driver catalog 继续声明
`workspace-image-artifact-v1`，因为生产注册的 `pi-cli` Executor 实现整体
具备该协议。标准 Pi CLI 本身不再被描述为具有图片模式；图片协议由其内部的
MetaWork Image Runner 实现。

## 4. 目标组件

### 4.1 `PiCompositeExecutorAdapter`

新增一个只用于 `pi-cli` AgentClass 的组合 Adapter：

```ts
class PiCompositeExecutorAdapter implements ExecutorAdapter {
  constructor(
    private readonly piAdapter: ExecutorAdapter,
    private readonly imageAdapter: ExecutorAdapter,
  ) {}
}
```

执行选择规则必须是确定性的：

```text
requiredCapabilities 包含 image-editing
  -> imageAdapter(editing)

否则包含 image-generation
  -> imageAdapter(generation)

否则
  -> piAdapter
```

禁止根据 prompt 关键词、模型名称或说明书 Markdown 临时判断执行路径。

如果同时声明 `image-generation` 和 `image-editing`，按配置/计划验证错误
失败，不由 Adapter 猜测。图片任务的授权模型缺少对应模型能力时也失败关闭，
不能回退到普通 Pi。

`abort()` 同时通知两个内部 Adapter；只有持有该 attempt 的 Adapter 实际执行
终止。普通 response-only correction 仍由 Pi Adapter 提供。Image Runner
必须直接生成规范完成结果，不依赖模型补写 Completion Protocol。

### 4.2 `ImageApiExecutorAdapter`

图片 Adapter 复用现有 `ExecutorAdapter` 输入，不读取配置仓库，也不选择
模型。它负责：

- 从 `ExecutorInput` 构建干净的图片请求；
- 读取已授权输入图片；
- 调用 MetaWork Image API Runner；
- 输出安全进度；
- 规范化 Provider 错误；
- 返回带 Completion Protocol v4 marker 的结果；
- 支持 abort 和 attempt 超时。

它不负责：

- Planner 路由；
- Kernel 授权；
- Provider fallback；
- Task 状态；
- workspace delta 计算；
- 图片产物认证和发布。

### 4.3 `ImageApiCliDriver` 与 Runner

图片 API 通过 MetaWork 自有、一次性 Node CLI Runner 执行：

```text
src/executor/image-api-runner.ts
src/executor/image-api-cli-driver.ts
```

推荐继续复用 `LocalCliExecutorAdapter` 和
`ContainerCompatibilityAdapter` 的进程、超时、日志、worktree/container
生命周期，而不是在 `PiCompositeExecutorAdapter` 中复制这些逻辑。

Runner 输入来自已受控环境和参数：

```text
OPENAI_BASE_URL
OPENAI_API_KEY
OPENAI_MODEL
METACLAW_IMAGE_OPERATION
METACLAW_INPUTS_PATH
METACLAW_ATTEMPT_ID
METACLAW_SUBTASK_ID
工作目录
有界图片 prompt
```

Runner 不加载 Pi HOME、Pi settings、Skills、MCP、Planner bootstrap 或会话。

Runner 使用独立的 MetaWork JSONL 协议输出进度和终态，不伪装成 Pi event。
Driver 将该协议转换为稳定 `ExecutorResult`。

### 4.4 图片请求构建

新增专用 `buildImageRequest()`，不得复用
`buildExecutorContextPrompt()` 的完整文本。

图片 prompt 只包含：

- 当前 Subtask 的 operative goal；
- 与画面相关的 acceptance 描述；
- Planner 选择的必要文本证据；
- 直接上游 handoff 中明确用于本图片的文本要求；
- 生成或编辑操作类型。

必须排除：

- Completion Protocol marker；
- Task/Kernel/路由术语；
- binding、revision、内部路径和 token；
- 其他 Subtask；
- Permission 和恢复内部信息；
- 原始 Provider 配置。

图片编辑输入只从 `executionBinding.inputsPath` 和明确的 artifact handoff
读取。首版支持 PNG、JPEG、WebP、GIF，并设置数量、单文件大小和总大小上限。
缺少输入图片的 editing 任务直接失败。

### 4.5 OpenAI-compatible 图片传输

首个 transport 使用现有 Provider 的 `baseUrl` 和凭据：

```text
POST {baseUrl}/images/generations
POST {baseUrl}/images/edits
```

生成请求使用 JSON；编辑请求使用 multipart。请求明确要求 base64 图片返回。
响应首版接受：

- `data[].b64_json`；
- 经安全策略允许的有界图片 URL 响应。

URL 下载必须限制 HTTP(S)、重定向次数、响应大小、MIME 和图片签名，禁止访问
本机、私网和控制网络地址。若 `code-cli + gpt-image-2` 的真实协议不同，
差异应在 MetaWork 的代码维护 compatibility adapter 中实现，不向 Provider
配置页面增加新字段。

Provider 返回的错误、超时、无图片、非法 base64、超限响应和图片签名错误
都转为规范化 Executor failure，不生成伪完成结果。

## 5. 方案一改动分类

### 5.1 保留

以下内容与执行实现无关，继续作为方案二基础：

- `gpt-image-2` 的 `image-generation`、`image-editing` 模型能力事实；
- 每个 Executor 独立的统一能力画像和中文说明书；
- profile-derived Routing Catalog 和只读标签；
- 用户自然语言能力策略与模型贡献；
- Auto Model Resolver 对强制模型能力的过滤；
- Kernel 对图片 Subtask 的具体图片模型绑定；
- Planner/Validator 对图片 Routing Capability 的校验；
- `workspace-image-artifact-v1` 执行协议；
- 图片任务必须使用 edit delivery；
- Completion Protocol 对 PNG/JPEG/WebP/GIF 文件签名的校验；
- 图片 artifact 的预览、发布和交付；
- Local/Container Adapter 对 required capabilities、inputs path 和 execution
  target 的传递能力；
- Planner 禁止新 `direct_reply`、所有工作交给 Executor 的边界。

### 5.2 迁移

方案一中的通用图片逻辑迁回 MetaWork：

| 当前位置 | 目标位置 |
| --- | --- |
| Pi `openai-images.ts` | MetaWork `image-api-client.ts` |
| Pi `image-mode.ts` 输入加载 | MetaWork `image-input-loader.ts` |
| Pi 图片输出落盘 | MetaWork Image Runner |
| Pi Provider 错误转换 | MetaWork Image API Driver |
| Pi image mode tests | MetaWork Executor/Runner tests |

迁移时不直接复制实现，应补齐安全上限、干净 prompt、输出路径冲突和真实 CLI
链路测试。

### 5.3 删除或回退

以下方案一专属改动需要精确回退，不影响同文件中的其他 Planner/能力画像改动：

- 删除 Pi `--mode image`；
- 删除 Pi `openai-images` API 注册和类型扩展；
- 删除 Pi `runImageMode`；
- 删除 Pi 图片模式和图片 API 测试；
- 恢复 vendored Pi 的 Planner 参数安全边界，不为 Executor 放宽
  `--provider`/`--model`；
- 移除 `PiCliDriver` 对图片任务启动 `--mode image` 的逻辑；
- 移除为了图片模式而强制 Executor 使用 bundled Planner Pi 的路径；
- native 安装探针恢复为普通 Pi Executor 需要可用的标准 `pi` 命令；
- Docker Runtime/attempt 镜像恢复安装标准 Pi Executor；
- Planner 继续单独使用 vendored AnyFusion-Pi 构建，不受上述回退影响。

### 5.4 新增

预计新增：

```text
src/executor/pi-composite-executor-adapter.ts
src/executor/image-api-executor-adapter.ts
src/executor/image-api-cli-driver.ts
src/executor/image-api-runner.ts
src/executor/image-api-client.ts
src/executor/image-request-builder.ts
src/executor/image-input-loader.ts
```

实际实施时可合并过小模块，但必须保持 HTTP transport、请求构建、文件验证和
Adapter 编排可独立测试。

## 6. Native 与 Docker 路径

### 6.1 Native/worktree

```text
Planner
  -> vendored AnyFusion-Pi，独立进程和 HOME

pi-agent 普通任务
  -> 用户/安装器提供的标准 pi CLI，attempt 独立 HOME

pi-agent 图片任务
  -> 当前 MetaWork release 的 image-api-runner
  -> attempt worktree 写入图片
```

升级本机 Pi 只影响普通 Pi Executor，不会覆盖 MetaWork Image Runner。
升级 MetaWork 时 Image Runner 与 Runtime 同 revision 更新。

### 6.2 Docker compatibility

`docker/Dockerfile.attempt-pi` 包含：

- 标准 Pi CLI；
- MetaWork Image Runner；
- capability/evidence 工具；
- 不包含为了图片功能修改的 vendored Planner Pi。

普通任务在容器中运行标准 Pi，图片任务在同一受控 attempt image 中运行
Image Runner。两者继续使用既有只读 source/input mounts、可写 workspace、
资源限制和网络策略。

如果容器图片请求通过 attempt model gateway，gateway 需要把图片 multipart
请求上限提高到明确的有界值，并保留 attempt token、固定 upstream 和
credentials 不进入容器的安全属性。不能直接把 Provider secret 注入不受控
容器。

## 7. Provider 和安全边界

Provider 配置结构保持不变：

```text
protocol
baseUrl
apiKeyRef
region
enabled
```

Image Runner 只能使用 `RuntimePrivateConfigurationBinding` 解析出的授权环境。
不得接受 prompt、模型输出或用户输入提供的 base URL、API key、model ID。

必须增加以下限制：

- 请求总超时和无进展超时；
- prompt 字节上限；
- 输入图片数量、单文件和总字节上限；
- Provider JSON 和图片响应上限；
- base64 解码后上限；
- 输出文件名只由 Runtime/Runner 生成；
- 输出必须位于 attempt workspace；
- 图片 MIME 与签名一致；
- 日志和错误脱敏；
- abort 使用 `AbortController` 或终止 Runner 进程；
- 不记录 API key、原始 multipart 或图片 base64。

输出建议使用 attempt-scoped 路径，避免覆盖：

```text
artifacts/images/<subtask-id>/<attempt-id>-01.png
```

路径段必须由受控 ID 清洗生成。

## 8. 错误处理

用户可见错误应区分：

```text
图片模型未授权
  -> configuration/model binding failure

图片编辑缺少输入
  -> material/input failure

Provider 图片端点不支持
  -> provider compatibility failure

Provider 超时或网络失败
  -> retryable network failure

Provider 未返回图片
  -> provider contract failure

返回内容不是有效图片
  -> completion/artifact failure
```

Adapter 只产生规范化事实。是否 retry、fallback、block 或 replan 仍由 Kernel
决定。图片执行失败不得自动调用普通 Pi 伪造图片结果。

## 9. 切换实施顺序

### 阶段 1：冻结并建立回归基线

- 记录当前方案一相关 diff；
- 保留已通过的能力画像、Resolver、Kernel 和 Completion 测试；
- 增加真实 Pi CLI 被 Planner 参数策略拒绝的回归用例，证明切换原因；
- 不先删除方案一，避免迁移期间没有可比较实现。

### 阶段 2：先实现 MetaWork Image Runner

- 为生成、编辑、输入验证、HTTP 错误、超时、abort、输出路径和完成协议写
  失败测试；
- 实现 Image API client、request builder 和 Runner；
- 使用本地 mock HTTP 服务执行真实子进程生成/编辑测试；
- 验证不会把内部 Executor 上下文发送为图片 prompt。

### 阶段 3：接入复合 Adapter

- 新增 `PiCompositeExecutorAdapter`；
- 普通任务继续进入标准 Pi Adapter；
- 图片任务进入 Image Adapter；
- Adapter factory 使用已授权模型和同一 revision 构造两个内部执行路径；
- probe 同时验证标准 Pi 和 MetaWork Runner 的本地可用性；
- 不修改 AgentClass、Harness 配置或 Planner projection。

### 阶段 4：完成 native 和 Docker 打包

- native release 暴露 MetaWork Image Runner 路径；
- Docker attempt image 安装标准 Pi 并复制 Runner；
- host/container 使用同一请求和结果协议；
- 如果容器使用 model gateway，补齐 multipart 和响应字节上限；
- 分别执行 generation/editing smoke。

### 阶段 5：移除方案一

- 删除 Pi 图片 API 和 image mode；
- 精确回退 Pi CLI 参数/mode 类型改动；
- 恢复 Planner fork 的单一 Planner 职责；
- 去除 bundled Planner Pi 作为 Executor 的特殊路径；
- 重新构建 vendored Pi，确保 Planner 测试不依赖图片代码。

### 阶段 6：真实 Provider 兼容验证

- 使用 active revision 的 `code-cli + gpt-image-2` 做一次受控 generation
  smoke；
- 在用户提供输入图片或专用 fixture 后做一次 editing smoke；
- 验证真实响应格式、MIME、文件落盘、Completion、artifact preview；
- 如果端点协议不同，只调整 MetaWork compatibility adapter；
- 不把兼容差异重新放回 Pi。

真实调用可能产生 Provider 费用，实施时应在发起付费 smoke 前明确提示。

### 阶段 7：文档和完成记录

- 更新 ADR-0028，明确 `pi-cli` 是复合 Executor 实现；
- 更新 `CONTEXT.md` 和中英文技术概览；
- 修订统一能力画像方案的完成记录，删除“Pi 原生图片模式”表述；
- 记录验证、已知 Provider 兼容范围和关闭 commit。

## 10. 测试与验收

### 10.1 单元与组件测试

- Image request 不包含内部 Completion/Kernel 文本；
- generation 请求端点、header 和 JSON 正确；
- editing multipart 包含有效输入图片；
- 缺少编辑输入失败；
- 超限、非法图片、非法 base64 和空响应失败；
- Provider 401/404/422/429/5xx 分类正确；
- timeout 和 abort 终止请求；
- 输出路径不可逃逸 workspace；
- Composite Adapter 对普通/生成/编辑任务选择正确；
- 普通 Pi 路径不再出现 `--mode image`；
- Planner CLI 继续拒绝客户端覆盖 Provider/Model。

### 10.2 路由与执行测试

- 添加 `gpt-image-2` 后 profile/Catalog 获得两项图片能力；
- 移除模型后两项能力同步消失；
- Kernel 为图片任务选择 `gpt-image-2`；
- 普通任务不选择仅图片模型；
- 图片任务使用同一 `pi-agent` AgentClass；
- 未授权图片模型时 Image Runner 不启动；
- 图片生成和编辑均产生有效 workspace delta；
- Completion Protocol 拒绝伪图片；
- artifact preview 能读取最终图片。

### 10.3 构建和 smoke

至少执行：

```text
npm run lint
npm test
npm run build
npm run build:offline --prefix planner/AnyFusion-Pi
docker build -f docker/Dockerfile.runtime ...
docker build -f docker/Dockerfile.attempt-pi ...
npm run smoke:metawork
```

新增：

```text
native mock-provider image generation smoke
native mock-provider image editing smoke
Docker mock-provider image generation smoke
Docker mock-provider image editing smoke
受控真实 code-cli generation smoke
受控真实 code-cli editing smoke
```

## 11. 验收标准

1. 用户仍只配置和看到一个 `pi-agent` Executor。
2. `pi-agent` 的一份能力说明书同时描述普通能力和图片能力。
3. Planner 根据最终能力画像把图片任务路由给 `pi-agent`。
4. Kernel 只从该 Executor 的 allowed model pool 中选择图片模型。
5. 图片任务不启动 vendored AnyFusion-Pi，也不使用 Pi image mode。
6. 普通任务继续使用标准 Pi CLI。
7. 升级标准 Pi 不会覆盖或删除 MetaWork 图片执行能力。
8. 升级 vendored Planner Pi 不需要重新合并图片 API 代码。
9. Native 和 Docker 均支持图片生成与编辑。
10. 图片结果必须是 Completion Protocol 验证通过的真实图片 artifact。
11. 移除 `gpt-image-2` 后说明书、标签、Catalog 和实际执行资格同步消失。
12. Provider 配置、SecretStore、Permission、health 和 Kernel recovery 语义不变。
13. 方案一的 Pi 图片代码全部删除，不保留双执行路径或隐藏 fallback。

## 12. 风险与控制

### Provider 端点兼容

这是主要外部风险。通过 MetaWork compatibility adapter 和真实 Provider
smoke 收敛，不通过修改 Pi 或增加用户配置项规避。

### Container multipart 大小

现有 attempt model gateway 默认请求上限较小。图片编辑需要提高为明确的有界
值，并增加响应上限，不能改成无限制代理。

### 普通任务误选图片模型

Auto Model Resolver 必须确保仅图片模型不会成为普通任务默认候选。图片执行
路径仍以 Subtask `requiredCapabilities` 为唯一开关。

### 迁移期间双路径

开发阶段可以短暂保留方案一用于对照，但最终合并前必须删除 Pi image mode，
并用测试证明生产只存在 MetaWork Image Runner 一条图片执行路径。

## 13. 推荐结论

采用本方案：

```text
一个 pi-agent
一份统一能力画像
一个配置层 pi-cli Harness
两个内部执行引擎
  - 标准 Pi CLI
  - MetaWork Image API Runner
```

它保留了用户期望的综合 Executor 体验，同时把图片执行放回 MetaWork
Executor Adapter 所属边界，避免 Planner fork 继续承担无关能力，也显著降低
Pi 升级、rebase 和 Docker 打包风险。

## 14 实施记录

已完成：

- `pi-agent` 通过 `PiCompositeExecutorAdapter` 在普通任务和图片任务之间确定性分流；
- 普通任务使用标准 `pi --mode json`，图片任务使用 MetaWork Image API Runner；
- native/worktree 和 Docker compatibility 两条执行路径都复用生成/编辑、输入校验、图片签名校验和 Completion Protocol；
- Docker 图片请求通过 attempt-scoped model gateway，Provider 凭据不进入容器；
- 移除 vendored Planner 的图片模式类型/测试残留、Pi 图片执行 fallback 和生产探针的 bundled Planner Executor fallback；
- 账户级 Executor 工厂、Image Adapter、Container Adapter、Runner 和生产探针均有回归覆盖。

验证：

- MetaWork 图片与账户执行器聚焦测试：通过；
- `npm run lint`：通过；
- MetaWork `npm run build`：通过；
- vendored AnyFusion-Pi `npm run build:offline`：通过；
- `npm run lint`、MetaWork 全量测试和 `git diff --check`：通过；
- Docker `docker/Dockerfile.attempt-pi`：Dockerfile 解析正常，但 Docker Hub 拉取 `node:22.19.0-bookworm-slim` 时返回 `EOF`，需在 registry 网络可用时复验；
- 真实 Provider generation/editing smoke：未执行，避免未经确认产生 Provider 费用。

已知边界：

- 图片生成和编辑仍要求当前授权 binding 的 Model 具备对应模型能力；
- 标准 Pi CLI 本身不提供 MetaWork 图片模式，升级本机 Pi 不会覆盖 MetaWork Image Runner；
- Docker 仅是显式 compatibility backend，macOS native/worktree 不依赖 Docker。
