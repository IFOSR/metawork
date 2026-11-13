# 设置、模型、智能体与 Planner 重设计方案

- **状态：已完成**
- **日期：2026-10-04**
- **范围：** Web 设置页、Configuration schema、OpenRouter 模型元数据、AgentClass 路由画像、Planner 模型选择与 Work Graph 拆解策略
- **不包含：** Executor Harness 的进程协议、Kernel 授权语义、运行中 Task 的历史绑定改写

### 2026-10-05 AI 操作反馈与版本对照

- 状态：实现、回归验证、真实调用与本机部署完成；完成日期 2026-10-05。
- “AI 改写”和“能力更新”在内容旁持续显示处理中、成功、内容无变化、失败，以及等待秒数和完成时间。明确当前展示的是更新前还是更新后内容；职责成功回填仅为草稿，需保存并激活。
- 职责提供本次改写前后对照，能力提供本次更新前说明。请求期间继续编辑职责或切换模型时保留最新输入，显示“本次建议未应用”；每个智能体独立记录请求状态。无变化按返回文本比较（忽略空白差异），不声称 AI 判定质量优秀，也不把失败当无变化。
- 失败保留现有内容，可重新点击重试；错误信息就近展示并移除 HTTP JSON 包装。浏览器为两个 AI 调用设置 150 秒兜底超时。反馈支持屏幕阅读器，等待秒数不逐秒播报；窄屏下时间与版本对照自动换行，尊重减少动画偏好。
- 验证：46 项相关测试、根项目和 Web 类型检查、生产构建及 `git diff --check` 通过。新增并运行 Chrome 回归，覆盖两种操作的等待、成功、无变化、失败、前后对照及请求中继续编辑不被覆盖（1 项通过，另外 4 项不相关浏览器用例未运行）。实际安装服务上两项真实 LLM 调用均出现成功状态；检查桌面和 390px 窄屏截图，无状态区域横向溢出。验证未保存职责草稿。
- 本机版本：`0.1.3-settings-ai-feedback-20261005-1791171651469`，服务已启动，升级前后 Provider 凭证保持一致。
- Closing commit：`15197ec`（随 v0.1.4 同步至 GitHub）。

### 2026-10-05 智能体能力说明纠错

- 状态：实现、真实调用、浏览器验收与本机部署完成；完成日期 2026-10-05。
- 删除智能体页面直接拼接的模型摘要、优势原文和英文公开介绍。由独立内部 LLM 根据所选模型公开事实和当前工具能力，生成以智能体为主体的中文总述、3–6 项具体工作能力和必要边界；Planner 聚焦意图理解、DAG 拆解与编排。
- “能力更新”现在重新整理智能体能力说明，模型公开信息仍在模型编辑中获取。展开时自动整理，资料或选择变化时重新生成；多候选的差异能力需说明条件，不把并集表述成始终同时可用。
- 说明只读，使用同一内部 LLM 服务，不写入职责、路由权限或模型资料。接口鉴权与输入输出校验、最多 64 项缓存、失败反馈、旧选择请求隔离均已实现。正文桌面两列、窄屏单列，移除模型产品介绍段落。
- 验证：97 项相关测试、根项目与 Web 类型检查、生产构建、`git diff --check` 通过。使用 GLM/Sonnet 真实资料完成真实生成；Chrome 桌面 1440px 与窄屏 390px 检查无能力区域横向溢出，实际 Executor/Planner 请求均通过；浏览器延迟响应测试确认旧选择结果不会覆盖新选择。浏览器验收未保存或激活测试中的模型选择。
- 本机版本：`0.1.3-agent-capability-description-20261005-1791170637423`，服务已启动；升级前后 Provider 凭证文件保持一致。
- Closing commit：`15197ec`（随 v0.1.4 同步至 GitHub）。

### 2026-10-05 Provider 凭证覆盖修复

- 根因：本机 Codex/Pi 凭证导入将 URL 匹配作为跨 Provider 的凭证来源，并把已保存的不同 Key 当作“过期”值覆盖；启动预热也存在同样的覆盖逻辑。截图中两个 Provider 的独立凭证槽已实际保存为同一个 Key，问题并非仅为掩码显示。
- 修复：已保存的 MetaWork Key 优先；自动导入只补缺失且来源明确的凭证，禁用 URL-only 跨 Provider 导入，冲突来源不猜测。前端仅按 URL + 完整凭证身份去重，不合并未知 Key；编辑中的新 Key 不复用旧指纹。
- 回归：覆盖同 URL 不同 Key、重复启动导入、预热、缺失 Key 不借用、多个本机来源冲突与编辑新 Key 后身份更新。
- 本机恢复检查：在现存 MetaWork 凭证和生成的模型/认证文件中未找到 `custom-model-4` 被覆盖前的独立 Key；不会猜测、清空或用其他凭证替代，需要用户在修复部署后重新填写。
- 状态：源码修复与本机部署完成，完成日期 2026-10-05；被覆盖的原 Key 待用户重新填写。
- 验证：5 个相关测试文件共 52 项通过，根项目与 Web 类型检查、生产构建及 `git diff --check` 通过。已安装 `0.1.3-provider-key-isolation-20261005-1791169924179`，Server ready；升级启动前后凭证文件逐字节一致，未再次改写已保存 Key。
- Closing commit：`15197ec`（随 v0.1.4 同步至 GitHub）。

**完成日期：2026-10-04。** Configuration schema 的职责与价格元数据、OpenRouter 公开目录及 7 倍汇率换算、持久化元数据缓存、Provider → Model 设置界面、已有模型编辑与价格手动覆盖、连接设置渐进展开、Planner/Executor 统一折叠卡片与一次热激活、内置 SettingsAssistant、DAG 质量告警和离线 fixture 均已交付。

**交付验证：** `npm run lint`、`npm run build`、`npm run build:web`、设置工作台与 OpenRouter/SettingsAssistant 专项测试通过；全量 Vitest（浏览器依赖的 E2E 按仓库既有条件跳过）及 schema migration、DAG quality 专项测试已通过。

## 1. 目标与结论

本方案把设置页从“填写一份模型连接和一堆模型事实”改成三个清晰的资源层次：

1. **Provider 连接**：API 地址、凭证和协议。一个 Provider 下可以有多个模型。
2. **Model 目录项**：模型 ID、公开能力、上下文和价格。能力与价格优先从 OpenRouter 公共目录补全，用户只补充目录缺失的字段。
3. **AgentClass 智能体**：职责、启用状态、模型策略和执行工具。职责是路由语义；模型能力是系统事实；用户不再填写模型优点和缺点。

Planner 作为 `kind: planner` 的普通 AgentClass 出现在智能体列表中，使用同一套展开/收起、模型选择和热激活流程。它的职责文案明确为“理解复杂用户意图、拆解任务、编排 DAG”，执行助手则描述具体交付能力。

设置页的辅助 LLM 从 Planner 链路中移出，成为 MetaWork Application Shell 内置的 `SettingsAssistant`。默认绑定 DeepSeek v4.1 Flash：运行时模型 ID 为 `deepseek-v4.1-flash`，在当前 Provider 模型目录中沿用用户可见名称 `deepseek-flash`。绑定信息放在 MetaWork 内部系统配置文件中，由研发/部署人员维护，方便更新模型、Provider 地址和兼容参数；它不是用户账户配置，也不在普通设置页暴露。SettingsAssistant 只服务于设置草稿的结构化建议、职责文本整理和能力画像编译；最终配置仍由 ConfigurationService 校验、编译、探测和激活。没有 Planner 时，设置页仍可使用 LLM 辅助。

所有设置修改统一进入现有 ConfigurationRuntimeCoordinator 的一次激活事务。保存成功后对下一次 Planner/Executor 解析热生效，运行中的 Task 继续使用其已绑定的 revision；不再为 Planner 单独提供“更新规划设置”按钮。

## 2. DeepSeek harness 可复用的逻辑

本仓库 vendored 的 AnyFusion-Pi coding-agent 已经实现了适合复用的模型目录逻辑：

- `packages/ai/src/providers/deepseek.ts` 将 Provider 定义为 `id`、显示名、默认 `baseUrl`、认证方式和模型集合。
- `deepseek.models.ts` 只声明模型运行必需事实，如 `id`、API、是否支持 reasoning、上下文、最大输出和价格。
- `packages/coding-agent/docs/models.md` 采用 Provider-first 的 `models.json`：Provider 提供 endpoint/API/key，Model 最少只需要 `id`，其他字段有默认值。
- 内置 Provider 与自定义模型按 `provider + modelId` 合并；同 ID 的自定义定义覆盖内置定义；`modelOverrides` 只覆盖单个内置模型。
- 模型目录在打开 `/model` 时重新加载，新增或修改模型不需要重启进程。
- API Key 属于 Provider 请求配置，模型选择不重复填写凭证。

MetaWork 复用这些边界和合并规则，但不直接照搬 Pi 的 `models.json`：MetaWork 的凭证必须继续由 SecretStore 管理，模型价格统一存人民币账单价，能力事实从 OpenRouter 目录和受控目录编译，配置写入必须经过 AccountRuntime 激活门。

## 3. 用户体验与信息架构

设置抽屉调整为四个同级区块：

| 区块 | 用户看到的内容 | 默认状态 |
| --- | --- | --- |
| 模型与连接 | Provider 卡片、已添加模型、可添加模型、编辑模型 | Provider 展开，连接设置和模型详情收起 |
| 智能体 | Planner 与所有 Executor 的摘要卡 | 全部收起 |
| 运行策略 | 并发任务等运行参数 | 展开 |
| 高级连接 | 仅保留确有必要的内部/外部连接状态 | 收起 |

Planner 不再放在高级设置。智能体区块顶部固定显示 Planner，之后显示执行助手。每张智能体卡片的收起摘要至少包含：显示名、类型徽标、职责首行、当前模型和启用状态。点击卡片标题或展开箭头即可编辑该卡片；刷新后默认全部收起。

展开后的智能体设置分为：

- **基本信息**：名称、职责（可为空或填写简短描述）。Executor 的职责示例为“负责当前公共网络资料检索和来源核验”；用户可点击“AI 改写”整理职责文本。
- **模型策略**：固定模型或自动模型池、默认模型、回退顺序和成本/质量/延迟目标。
- **系统事实**：模型能力、Harness、权限和安装状态，只读展示。
- **编辑智能体**：保留现有入口，用于名称、职责和受控运行参数；不再显示“模型优点/缺点”输入框。

Executor 只保留一个用户定义的“职责”字段；模型能力由目录事实自动注入并以只读方式展示，避免职责与能力说明重复。Planner 的职责固定为“理解用户意图、拆解任务为 DAG 图、选择执行智能体并完成编排规划”，不要求用户填写。

## 4. 模型与 Provider 设计

### 4.1 新增与编辑流程

主入口统一使用“新增模型”。弹窗创建 Provider，随后在 Provider 卡片内管理模型：

1. 选择内置 Provider（DeepSeek、OpenRouter、Kimi 等）或自定义 OpenAI-compatible Provider。
2. 填写 Provider 名称、API URL 和 API Key；内置 Provider 自动预填 URL，Key 只在首次输入时显示。
3. 点击“获取模型目录”。服务端调用 Provider `/models`（若支持），并同时从 OpenRouter 公共目录匹配模型元数据。
4. 可添加模型列表中的模型点击“新增模型”即加入并启用；未知模型可以手工输入 Model ID。
5. 已添加模型行提供唯一的启用开关、明确的“编辑”入口和“移除”操作；编辑区可以改 Model ID、兼容参数和价格补充值。

已有模型连接必须可编辑。编辑依据稳定的 `providerRef + modelId` 身份，不重新生成 model ref；如果只改显示名或价格，不影响 AgentClass 引用和历史 revision。

删除 Provider 前，系统展示受影响的 AgentClass。固定引用不会被静默替换；草稿必须重新选择模型才能激活。自动模型池中的引用可自动移除，并在摘要中提示。

Provider 的唯一身份由规范化后的 Base URL 与 API Key 的单向指纹联合决定。相同地址、相同凭证的重复 Provider 在设置工作台加载时合并到一个 Provider，并把其模型归并到同一连接下；相同地址但凭证不同的 Provider 保持独立，避免不同账户或租户的 API Key 互相覆盖。API Key 只用于服务端生成不可逆指纹，客户端不接收明文。

### 4.2 能力事实

模型能力字段不再作为新增模型的必填表单。能力来源按优先级合并：

1. OpenRouter `architecture.input_modalities`、模型描述和结构化字段；
2. MetaWork 受控模型能力目录（人工审核的补充和纠错）；
3. Provider `/models` 响应中的安全元数据。

界面只读显示能力来源徽标，例如“OpenRouter 自动发现”“MetaWork 目录”“待获取”。模型能力不作为新增模型的表单输入，用户不需要填写模型优缺点。

### 4.3 OpenRouter 价格同步

服务端增加 `OpenRouterModelCatalog`，免登录请求 `GET https://openrouter.ai/api/v1/models`，读取公开目录字段。OpenRouter 模型目录查询不要求用户填写或授权 OpenRouter API Key；如果部署环境出现网络策略或未来接口限制，使用最近一次成功缓存，并把目录状态显示为“暂时不可用”，不能把失败误报为模型不存在。

读取字段包括：

- `id`、`name`、`description`；
- `context_length`、`architecture.input_modalities`；
- `pricing.prompt`、`pricing.completion`（美元/Token）。

价格换算固定为：

```text
CNY / 1M tokens = USD / token × 1,000,000 × 7
```

输入和输出价格分别保存。若未来需要缓存读写价，新增可选字段，不改变现有账单公式。每个 Model 保存价格来源、原始美元值、换算汇率 `7`、抓取时间和目录版本；运行时账单只使用已经编译的 CNY 值。

同步策略：

- 打开设置页先读最近一次缓存；缓存超过 24 小时时后台刷新。
- 显式点击“刷新 OpenRouter 目录”时立即刷新，带请求超时、大小上限和 ETag/Last-Modified。
- 网络失败时使用未过期缓存；没有缓存时显示“价格未获取”。
- OpenRouter 找不到模型或价格字段为空时，模型仍可作为草稿保存；启用前提示用户补充输入/输出 CNY 价格。
- 自动获取的价格可以直接在模型编辑区手动修改。用户修改后记录为 `source: user`，保留最近一次 OpenRouter 原始价格作为参考，并默认不被后续目录刷新覆盖；用户可点击“恢复自动价格”重新采用最新目录值。
- `validateEnabledModelPrices` 改为检查“有效价格来源”：OpenRouter 换算价、受控目录价或用户补充价三者之一即可。

模型匹配先尝试完整 `provider/modelId`，再尝试去 Provider 前缀后的 canonical ID、展示名称和 token 相似度。完整 ID、canonical ID 或展示名称属于高置信度时自动采用；仅有相似度候选时在模型编辑区列出候选、匹配分数和“选择此模型”，用户确认后才写入能力与价格。映射保存于 `pricing.catalogModelId`，实际请求仍发往用户配置的 Provider，OpenRouter 只作为元数据来源。

### 4.4 建议的数据模型

保持内部稳定引用，增加可迁移字段：

```ts
interface ModelPricingMetadata {
  source: 'openrouter' | 'catalog' | 'user';
  usdInputPerToken?: number;
  usdOutputPerToken?: number;
  exchangeRate: 7;
  fetchedAt?: string;
  catalogModelId?: string;
  overrideReason?: string;
}

interface ModelProfile {
  providerRef: string;
  modelId: string;
  // capabilities 仍是编译后的事实，不再要求添加时手填
  capabilities: ModelCapability[];
  costInputPerMillion?: number;  // CNY
  costOutputPerMillion?: number; // CNY
  pricing?: ModelPricingMetadata;
  ...
}
```

`costInputPerMillion` 和 `costOutputPerMillion` 暂时保留，避免账单、历史 revision 和投影同时改名；新字段只记录来源和原始值。配置 schema 升级到下一版本时提供 v2 → v3 迁移：旧价格标记为 `user`，旧能力保留为用户/历史事实，Provider/Model/AgentClass 引用不变。

## 5. AgentClass 与智能路由

### 5.1 职责字段

AgentClass 增加 `responsibility`，允许为空，不设置最少字数限制；启用的 Executor 可以先保存简短职责、关键词甚至空白草稿，并可点击“AI 改写”整理文本。Planner 使用系统固定职责，不提供用户编辑入口。`primaryUseCases` 和 `avoidUseCases` 保留用于旧 revision 读取，但设置页不再让用户直接编辑这两组模型优缺点字段。

职责补全的输入只包括设置上下文：AgentClass 类型、用户原始描述、当前任务/设置意图、所选模型的公开能力、Provider/模型目录事实和已有受控 Routing Capability。系统 LLM 不读取秘密、工作区、Task 原文或隐藏模型推理。若没有用户意图可参考，则生成简洁的职责草案并标记为“待确认”，不能自动扩大路由能力或权限。

职责编译为两种投影：

- Planner-safe Routing Catalog：显示名、类型、职责摘要、受控 Routing Capability、模型池和模型事实。
- Kernel-safe profile：保留结构化路由能力、模型策略、授权所需的绑定事实，以及不含凭证的公开模型适配事实，供最终软排序复核。

用户职责文本不能新增未知 Routing Capability、放宽权限或绕过模型白名单。内置 `SettingsAssistant` 可以把用户自然语言整理成职责摘要和建议标签，但必须保留原文，并由用户确认后写入草稿。

职责改写必须由内置 LLM 理解用户意图后生成：核心职责、主要任务、预期交付物、质量要求和工作边界。适用任务体现在具体任务条目中，不另设重复范围段落。模型的公开描述、亮点、推理/上下文事实仅作为生成背景，转化为与用户职责有关的工作方式；不直接复制英文介绍、能力标签或单列“模型适配提示”，不扩大业务范围。LLM 返回结构化 JSON 内容，程序只校验并统一排版，不拼接职责正文。重复改写时重新组织全文，不嵌套旧标题。LLM 不可用、超时、截断或输出无效时明确报错并保留原文，禁止用确定性模板冒充 AI 改写成功；普通编辑、保存和能力编译仍可继续。

路由采用“硬过滤 + 软排序”两层语义。`routingCapabilities` 和模型能力标签只回答模型是否满足任务的必要条件，并用于资格过滤；Provider/模型可用性、Harness 兼容性、上下文窗口、结构化输出等运行约束也属于硬条件。通过硬过滤后，确定性 resolver 和 Span 决策模型再共同参考 Agent 职责、模型详细描述、`routingNotes`、OpenRouter `publicFacts`、质量/推理/延迟等级及价格目标，判断哪个候选更有可能把任务做好。价格与延迟只能作为目标偏好，不能绕过能力和质量要求；详细事实不足时必须明确降级为“能力满足但质量适配信息不足”，不能伪造模型差异。

### 5.2 Planner 展示和模型选择

Planner 是智能体列表中的第一张卡，显示“规划智能体”徽标及固定说明：理解复杂意图、识别依赖、拆解 DAG、选择执行助手和编排验收。它沿用 AgentClass 的模型策略字段，用户可以选择固定模型或允许的模型池；不再通过单独高级设置进入。

Planner 的模型选择变化与其他智能体一起保存、探测和激活。Planner 运行时仍按每次新 RPC turn 解析具体模型，历史 Planner turn 绑定原 revision。

## 6. 内置 SettingsAssistant

新增 Application Shell 服务：

```ts
interface SettingsAssistant {
  suggestAgentResponsibility(input: {
    agentClassRef: string;
    sourceText: string;
    modelFacts: ReadonlyArray<SafeModelFact>;
  }): Promise<ResponsibilitySuggestion>;
  compileCapabilityProfile(input: SafeConfigurationDraft): Promise<CapabilityCompilation>;
}
```

默认实现使用 DeepSeek v4.1 Flash：运行时模型 ID 为 `deepseek-v4.1-flash`，当前 Provider 的用户可见名称为 `deepseek-flash`。其 Provider、模型、API 地址、兼容参数和凭证引用放在 MetaWork 内部系统配置文件中，由研发/部署人员维护；API Key 仍通过 MetaWork 原生 SecretStore/凭证加载能力注入运行时。内部配置文件可以更新模型版本而不改变用户配置 schema，更新后由启动加载或受控热刷新生效。用户不能在普通模型目录、账户配置或设置 UI 中修改、删除或替换这组内置连接，也不能把它当成普通 Provider 暴露给 Planner 或 Executor。该 Provider、Model、Key 不出现在用户配置、模型选择器、Planner projection 或客户端响应中。

OpenRouter 的公开模型目录不需要登录或用户 Key。SettingsAssistant 的内部系统配置和 DeepSeek Key 与 OpenRouter 的公开目录访问是两条独立链路：前者是 MetaWork 研发/部署可维护的内置运行能力，后者是无凭证的公开元数据读取，不能共用凭证配置或失败状态。

内部系统配置至少包含以下字段，并且必须与用户账户配置分离：

```ts
interface InternalSettingsAssistantConfig {
  provider: 'deepseek';
  modelId: 'deepseek-v4.1-flash' | string;
  displayName: 'deepseek-flash' | string;
  baseUrl: string;
  apiKeyRef: string;
  enabled: boolean;
  timeoutMs: number;
}
```

`modelId` 和 `displayName` 的默认值分别是 `deepseek-v4.1-flash` 和 `deepseek-flash`，但保留可配置性，便于研发切换到兼容模型。配置加载器只接受内部系统配置文件中的受控字段，禁止通过 Web、TUI、Feishu、普通 CLI 或用户提交的 configuration revision 覆盖它。配置变更需要记录版本和校验结果；失败时继续使用上一份已验证配置，若没有可用配置则提示 AI 改写不可用；普通能力编译不受影响。

职责建议接口允许把模型事实和用户意图传入系统 LLM：

```ts
interface ResponsibilitySuggestion {
  sourceText: string;
  suggestedText: string;
  selectedModelRefs: string[];
  evidence: string[];
  requiresConfirmation: boolean;
}
```

`suggestedText` 只是草稿。用户不点击确认时，保存流程保留原始职责文本；LLM 超时、Key 缺失或返回非法结构时，确定性配置流程继续执行。

边界：

- 它只能读当前草稿中已允许的模型/智能体事实；不能读工作区、Task、数据库原始记录或秘密。
- 它生成建议和能力画像，不直接写文件、不激活 revision、不决定 Executor 绑定。
- 请求有固定超时、大小上限、脱敏和失败回退；失败时保留用户原文。
- 运行中 Task 不需要重新调用它；激活事务在服务端重新编译并校验最终 profile。

## 7. Planner DAG 拆解改进

当前 Planner Skill 明确要求“只在 Routing Capability handoff 处分拆”，这会把很多复杂请求压成一个节点。保留 Work Graph v7 和 Kernel 授权边界，调整 Planner 策略和校验质量门：

### 7.1 拆解触发条件

Planner 先判断任务复杂度。满足以下任一条件时，应优先生成两个或更多 Subtask：

- 存在两个以上独立交付物或领域；
- 需要“研究 → 实现/报告”“分析 → 执行”“实现 → 验证”等明确交接；
- 存在可并行的独立分支；
- 需要独立验收、测试、来源核验或风险复核；
- 不同阶段需要不同 Routing Capability 或不同 AgentClass；
- 用户明确要求拆解、分工、并行或多智能体协同。

简单问答、单文件小改动和单一来源查询仍允许一个节点。拆解上限建议为 8 个节点；每个节点必须有可观察的目标、验收标准和候选 AgentClass。

### 7.2 图质量规则

新增 Planner-side 非权威质量检查，结果进入安全 Trace，不绕过 Work Graph/Kernel validator：

- 复杂度触发时，单节点图产生 warning；
- 有两个独立交付物却没有并行分支产生 warning；
- 后继节点没有引用前置验收产物产生 warning；
- 所有节点串成单链且不存在真实依赖产生 warning；
- 节点数量超过 8、依赖成环、无入口节点或验收缺失直接拒绝。

Planner Skill 增加三类示例：研究与实现并行、研究完成后实现、实现后独立验证。系统提示要求“只为真实依赖拆分，不为增加节点而拆分”。

### 7.3 运行和验收

每次 Work Graph 在 Web/TUI 中展示节点、依赖、并行组和最终绑定。增加离线评测集，覆盖单任务、串行 DAG、并行 DAG、跨能力交接和需要验证的任务；指标包括：多节点召回率、虚假拆分率、依赖正确率、一次通过率和总成本。Planner 模型可由用户选择，但所有提案仍必须经过现有 v8 schema、Work Graph v7 和 Kernel 授权。

## 8. 统一热生效与并发边界

采用一次草稿、一次激活：

1. Web 读取 active revision，创建本地草稿。
2. 模型、Provider、AgentClass、Planner、运行策略修改都写入同一 candidate。
3. Server 在现有严格 idle gate 下校验、补全、编译、探测并激活。
4. 激活成功后一次性刷新 Planner、Kernel、Runtime 视图并广播配置事件。

不再有 Planner 专用激活 API 和独立按钮。配置正在激活或账户存在可继续的 Task/Attempt 时，仍返回 `runtime_busy`；这是当前热生效语义的安全边界。运行中的 Task、Attempt、Work Graph 和账单继续使用其 pinned revision，新请求使用新 revision。

凭证写入、OpenRouter 元数据缓存和配置 revision 必须分别保持事务边界：缓存失败不能回滚配置，配置激活失败不能留下新凭证。多窗口使用 optimistic revision check；冲突时重新加载 active draft。

## 9. 分阶段实施

### Phase 0：ADR 与迁移契约

- 新增本方案对应 ADR，明确 SettingsAssistant 所有权、OpenRouter 元数据来源和 Planner DAG 质量门。
- 定义 schema v3、v2 → v3 迁移、旧 `primaryUseCases/avoidUseCases` 兼容读取。
- 增加内部 SettingsAssistant 系统配置文件、默认 DeepSeek v4.1 Flash（`deepseek-v4.1-flash` / `deepseek-flash`）和凭证注入契约；该文件由研发/部署人员维护，不进入用户配置 schema。

### Phase 1：目录后端

- 实现 OpenRouterModelCatalog、缓存、限时请求、字段解析、USD→CNY 转换和模型匹配。
- 扩展 completion API 返回价格来源、抓取时间、能力来源和缺失字段。
- 更新 enabled-model price validation 和账单投影测试。

### Phase 2：模型设置 UI

- 重做“新增模型”对话框和 Provider → Model 两层界面。
- 为已有模型增加清晰的编辑入口、启用开关、稳定 ref、价格来源徽标和缺失价格补充。
- 移除“加入候选”“调整能力”等重复主流程；能力只读展示并由公开目录自动总结。

### Phase 3：智能体与内置 LLM

- AgentClass 增加职责字段和折叠卡片，Planner 与 Executor 使用同一列表。
- 合并 Planner 与常规设置保存流程，移除 Planner 专用更新按钮。
- 将能力画像编译和职责建议从 Planner 改为 SettingsAssistant；职责建议超时或失败时保留原文，能力编译仍走确定性流程。

### Phase 4：DAG 策略

- 更新 Planner Skill、系统提示和拆解示例。
- 增加非权威图质量检查、Trace 警告和评测集。
- 对 Work Graph 展示补充并行组、交接产物和验证节点信息。

### Phase 5：迁移与验收

- 旧配置自动迁移并保留历史 revision 可读性。
- Native Web、TUI、Docker smoke 覆盖添加/编辑模型、价格缺失补充、智能体折叠、Planner 选模、无 Planner 时设置 LLM、热激活和复杂 DAG。
- 观察一段时间后再决定是否删除旧能力编辑 API；旧 API 初期只做兼容映射，不新增第二套语义路由器。

## 10. 主要验证项

- Provider 与 Model 的 `providerRef + modelId` 身份稳定，编辑不会丢失 AgentClass 引用。
- OpenRouter 价格按 7 汇率换算，原价、人民币价、来源和时间可审计。
- OpenRouter 不可用时使用缓存或明确进入“待补充”，不会静默写入 0 元价格。
- 未启用模型的缺失能力/价格不会阻塞保存；启用 AgentClass 可达模型缺失时激活失败并指出具体路径。
- Planner 没有安装、没有配置或 RPC 不可用时，设置页仍能加载、编辑、保存，SettingsAssistant 失败也能确定性编译。
- 所有配置统一一次热激活；运行中 Task 的历史模型和价格投影不被新 revision 改写。
- DAG 质量检查不能越过 Planner 提案、Work Graph 校验或 Kernel 授权，不能凭 warning 自动创建 Subtask。

## 11. 已确认并落地的决策

1. DeepSeek v4.1 Flash 使用默认运行时 ID `deepseek-v4.1-flash`、Provider 目录显示名 `deepseek-flash`；内置 LLM 通过研发/部署维护的 MetaWork 内部系统配置文件切换，API Key 按 MetaWork 原生配置文件和 SecretStore 注入。
2. OpenRouter 公开模型目录免登录读取；网络不可用时使用持久缓存或明确显示不可用。
3. 价格缓存有效期为 24 小时；自动价格允许用户覆盖，覆盖后默认不被同步刷新，提供“恢复自动价格”。
4. Executor 职责不设最少字数，允许由用户意图和所选模型触发 SettingsAssistant 扩展并由用户确认。
5. DAG 质量 warning 仅进入 Trace 和界面提示，不阻止合法提案，也不自动创建 Subtask。

### 2026-10-05 职责改写纠错记录

- 当时状态：源码修复完成；尚未部署，真实内置模型生成验证待配置。此部署状态已由下方独立服务交付记录更新。
- 删除把 OpenRouter 英文介绍、标签和套话拼接成职责的失败回退。仅合格的 LLM 生成内容可进入职责草稿，重复标题在排版前归一化。
- 默认生成超时由 8 秒调整为 30 秒，输出预算由 720 调整为 2048 tokens；模型和凭证继续由研发内部配置管理。
- 验证：`npm run lint`、`npm run build` 通过；`tests/configuration/settings-assistant.test.ts` 18 项与 `tests/web/settings-workbench.test.ts` 22 项通过。生成测试使用模拟响应，只验证调用、校验、排版和失败行为，不代表真实模型生成质量验收。
- 本机默认安装目录中缺少 `internal/llm.json` 和默认内部凭证，未进行真实模型调用；没有自动借用账户 Provider 的 Key。
- Closing commit：`15197ec`（随 v0.1.4 同步至 GitHub）。

### 2026-10-05 独立内部 LLM 服务交付

- 状态：本次独立服务配置、接入、真实验证与本机部署完成；完成日期 2026-10-05。
- 按用户授权一次性复制当前 DeepSeek Provider 的连接与 API Key。实际 API 模型 ID 为 `deepseek-flash`，以已配置且真实请求通过的 ID 为准；上文设计时假定的 `deepseek-v4.1-flash` 不代表本机实际请求 ID，也未据此推断服务端实际模型版本。
- 内部连接文件为 `<installRoot>/internal/llm.json`，凭证独立保存到 `internal/llm-credentials.json`，两者权限均为 `0600`。不修改账户 Provider，不建立运行时借用关系；研发可直接更新配置与凭证，下次请求生效。详见 [内部 LLM 研发说明](../current/internal-llm-service.md)。
- 明确更新第 6 节加载规则：按请求严格读取独立配置，文件缺失则禁用辅助服务、文件无效则明确报错；不静默回退到旧连接或账户 Provider。当前配置为 60 秒超时、4096 tokens、`thinking: disabled`。
- `InternalLlmService` 同时服务职责改写与 OpenRouter 模型画像提炼。职责由真实 LLM 根据用户意图与所选模型背景重写；仅对匹配或确认的 OpenRouter 模型提炼摘要、优势、局限和具体任务标签，保存到同一份 `routingNotes` 并进入现有决策输入。硬能力与权限仍保持既有确定性边界。
- 验证：`npm run lint`、Web `tsc --noEmit`、`npm run build`、vendored Planner `npm run build:offline` 通过；Configuration、Routing、Management API、Settings Workbench 与 Provider Secret 测试共 49 个文件、469 项通过；`git diff --check` 通过。
- 真实验证：用户原文“擅长代码撰写、项目测试”生成中文任务职责，不复制英文广告、无重复核心职责标题；`gpt-6-sol` 匹配 `openai/gpt-6-sol` 并生成公开资料支撑的中文模型画像和任务标签。原生升级后，又通过已登录的生产设置 API 完成这两项真实调用；验证未保存职责草稿或激活模型配置。
- 本机安装版本：`0.1.3-internal-llm-20261005-1791167981084`，Server 已启动且 ready。首次安装器因并存历史目录拒绝自动根目录迁移；显式指定现有 MetaWork 根目录后升级成功。
- Closing commit：`15197ec`（随 v0.1.4 同步至 GitHub）。


## 2026-10-05：自然语言能力优先的路由修订

用户已同意用具体能力描述完成语义匹配，泛化标签不再承担质量比较职责。
本修订取代本文早期“将公开能力充分转化为路由标签”的目标；公开资料和中文
能力说明直接作为决策证据。保留协议、输入/产出、权限等客观执行条件。
详细实施与验证记录见 [自然语言能力优先的任务路由](2026-10-05-description-first-routing.md)。


## 2026-10-05：保存链路 Planner 依赖遗漏修正

此前完成记录未覆盖保存时 ExecutorManualPlanner.compileAll 的旧依赖，导致
编辑职责后仍串行调用 Planner。此次移除该链路，设置 AI 操作只使用内置 LLM，
保存不触发生成。实施与实测见 [修正记录](2026-10-05-settings-activation-without-planner.md)。
