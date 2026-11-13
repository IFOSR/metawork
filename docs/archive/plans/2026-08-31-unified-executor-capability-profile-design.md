# 统一 Executor 能力画像与路由投影设计

> **状态：** Implemented
> **设计日期：** 2026-08-31
> **完成日期：** 2026-09-01
> **范围：** Executor 能力说明书、模型能力归因、用户自然语言定义、Planner 智能路由、Routing Catalog 结构化投影、配置预览与热激活
> **不在范围：** Provider 配置、凭据与 SecretStore、动态健康、Permission Profile 语法、Harness 驱动实现、运行中 Task 的 revision 切换
> **前置方案：** [Planner Executor Capability Manual Design](2026-08-30-planner-executor-capability-manual-design.md)
> **受影响权威：** ADR-0015、ADR-0018、ADR-0028、ADR-0033；模块依赖继续遵守 ADR-0020

## 1. 决策摘要

当前实现同时生成两套并行结果：

```text
模型配置 + Executor 配置 + 用户定义
  -> Skill-style 能力说明书

模型配置 + Executor 结构化字段
  -> Routing Catalog
```

能力说明书用于 Planner 的语义偏好，Routing Catalog 决定 Executor 是否
具有硬性路由资格。两者可能表达不同结论，用户修改说明书也不一定改变
实际路由资格。这不符合“最终能力说明书就是 Planner 智能路由依据”的
产品目标。

本方案引入每个 Executor 独立的、revision-scoped 的统一能力画像：

```text
模型事实 + Executor 配置 + 用户自然语言定义
                      |
                      v
            ExecutorCapabilityProfile
                 最终能力画像
                      |
            +---------+----------+
            |                    |
            v                    v
 Skill-style 中文说明书   结构化路由能力投影
 Planner 语义理解         Planner / Validator 校验
                                 |
                                 v
                         Routing Catalog
```

Routing Catalog 不再是独立于说明书的另一套配置或真相。它是统一能力
画像的确定性、机器可读投影。说明书与 Catalog 必须来自同一个 profile、
同一个 source fingerprint 和同一个配置 revision。

用户不编辑 Routing Catalog、能力标签或底层 capability 数组。用户只需：

1. 为 Executor 选择模型；
2. 用自然语言描述定位、擅长、不擅长、模型贡献和路由要求；
3. 更新能力画像并查看能力增减、模型证据和最终说明书；
4. 保存并激活配置 revision。

只要所选模型、Harness 和 Executor 配置能够支撑某项已注册能力，更新后的
Executor 就在同一 revision 中真正获得该能力的 Planner 路由资格。Kernel
仍校验具体模型、权限、健康和绑定，但不维护另一套 Executor 语义定位。

## 2. 当前问题

### 2.1 说明书和实际资格可能不一致

当前 Planner 同时读取：

- `executorCapabilityManuals`：描述 Executor 的定位、擅长、不擅长和模型贡献；
- `routingCatalog`：列出 Planner 可以写入 Work Graph 的受控
  `RoutingCapability`。

Planner 可以从说明书判断某个 Executor 很适合图片生成，但如果 Catalog
没有 `image-generation`，Validator 仍会拒绝该绑定。反过来，Catalog 可以
允许某项能力，而用户已经在说明书中明确要求不要把这类任务路由给该
Executor。

### 2.2 用户编辑无法完整改变路由结果

当前用户自然语言只会改变说明书中的 mission、strength、limitation、
preferred task、avoid task、model contribution 和 delivery 文案。用户内容
会覆盖冲突的系统文案，但不会改变结构化路由资格。因此“用户定义优先”
只在文字层面成立，没有贯穿 Planner proposal 和 Validator。

### 2.3 模型变化和说明书变化没有形成一个激活事务

当前模型池可以触发说明书重生成和部分模型派生能力，但用户很难确认：

- 新增模型后增加了哪些实际路由能力；
- 移除模型后失去了哪些能力；
- 哪项能力由哪个模型提供；
- 用户声明是否已经成为有效路由策略；
- 当前看到的是草稿预览还是已激活 revision。

### 2.4 “Catalog”是内部实现概念，不应成为用户配置对象

用户真正关心的是 Executor 能做什么、适合做什么、由哪个模型提供能力，
以及保存后 Planner 是否会这样路由。让用户理解或维护 Catalog、标签和
capability ID 会把内部结构泄漏到产品交互中。

## 3. 目标与非目标

### 3.1 目标

- 每个 Executor 拥有独立的统一能力画像，不跨 Executor 共享。
- 最终中文能力说明书是 Planner 的权威语义路由依据。
- Routing Catalog 是同一能力画像的机器可读投影，不再独立维护。
- 用户自然语言定义优先于系统生成的定位、偏好和限制。
- 模型变化自动增加或移除由模型支撑的 Executor 能力。
- 用户可以通过自然语言确认已注册的模型能力，不需要编辑能力标签。
- 配置页面明确展示能力变化、支撑模型、未满足声明和激活状态。
- Profile、说明书、Catalog 和模型策略在同一 immutable revision 中原子激活。
- Kernel 继续校验具体绑定、权限、健康和运行条件。

### 3.2 非目标

- 不允许用户通过自然语言创建新的 capability ID 或 Permission 语法。
- 不把 Markdown 解析放入 Planner、Validator、Kernel 或 Runtime 热路径。
- 不让 Planner 自行修改配置或授予执行权限。
- 不改变 Provider、凭据、SecretStore 和 Provider 健康语义。
- 不让新 revision 修改运行中或历史 Work Graph 的既有绑定。
- 不引入第二个语义路由器。

## 4. 核心概念

### 4.1 模型能力事实

模型能力事实回答“这个模型在结构上能够提供什么”。来源按可信度记录：

```text
system-known
  代码维护的已知模型能力，例如 gpt-image-2 的图片生成和编辑

provider-declared
  Provider discovery 或受控 Provider metadata 返回的能力

user-confirmed
  用户在 Executor 自然语言定义中明确确认的已注册模型能力
```

`user-confirmed` 只允许确认系统已经注册的能力词汇，并且必须关联当前
Executor 已允许使用的具体模型。它不能：

- 创建未知 capability；
- 启用未配置或已禁用的模型；
- 绕过 Harness 兼容性；
- 扩大 Permission Profile；
- 绕过 Provider、模型或 Executor 的 enabled 状态。

系统已知或 Provider 已声明的模型事实优先作为证据。用户确认主要用于
自定义模型、兼容模型或系统目录尚未覆盖的模型。

### 4.2 执行支撑能力

执行支撑能力回答“当前 Executor 的模型、Harness 和受控 affordance 是否
足以执行某项能力”。它是确定性编译结果，不由 Planner 临时猜测。

例如：

```text
image-generation
  至少一个有效 allowed Model 具备 image-generation
  + 当前 Harness 支持该模型的图片产物执行协议

workspace-engineering
  Executor 具备 workspace-read-write
  + workspace-command-validation

current-web-research
  Executor 具备 public-web-search
  + public-web-fetch
  + source-citation
```

Routing Capability Registry 应统一保存这些 qualification rules，避免
“模型派生规则”和“affordance 要求”散落在不同模块。

### 4.3 用户路由策略

用户自然语言定义经过语义解析后形成该 Executor 私有的路由策略：

- 核心定位；
- 擅长和优先任务；
- 不擅长和避免任务；
- 模型贡献；
- 交付要求；
- 对已注册能力的明确启用、限制或禁用意图。

用户路由策略只属于目标 Executor。`pi-agent` 的策略不得进入 `codex` 的
profile 或说明书。

### 4.4 最终可路由能力

最终可路由能力由“执行支撑”和“用户路由策略”共同决定：

```text
Routable(E, C)
  = StructurallySupported(E, C)
  AND UserPolicy(E, C) != disabled
```

用户可以：

- 把已经有执行证据的能力设为 preferred；
- 保持 allowed，作为正常或 fallback 路由；
- 设为 avoid，降低 Planner 优先级但保留最后 fallback 资格；
- 明确设为 disabled，使其不进入最终可路由能力投影。

用户不能把没有任何执行证据的能力直接变成 routable。此时系统保存用户
意图，但必须在预览中显示“未满足”，不能生成一份声称已经可执行的说明书。

### 4.5 统一能力画像

建议新增 revision-scoped 结构：

```ts
interface ExecutorCapabilityProfile {
  schemaVersion: 1;
  agentClassRef: string;
  configurationRevision: string;
  sourceFingerprint: string;

  semanticProfile: {
    mission: string[];
    strengths: string[];
    limitations: string[];
    preferredTasks: string[];
    avoidTasks: string[];
    modelContributions: Array<{
      modelRef: string;
      text: string;
      capabilityId?: RoutingCapabilityId;
    }>;
    delivery: string[];
  };

  capabilities: Array<{
    capabilityId: RoutingCapabilityId;
    support: 'supported' | 'unsupported';
    routingDisposition: 'preferred' | 'allowed' | 'avoid' | 'disabled';
    evidence: Array<{
      kind:
        | 'model-system-known'
        | 'model-provider-declared'
        | 'model-user-confirmed'
        | 'executor-affordance'
        | 'harness-support';
      modelRef?: string;
      detail: string;
    }>;
    unresolvedReasons: string[];
  }>;

  manualMarkdown: string;
  tags: {
    bestFit: string[];
    avoid: string[];
  };
}
```

这是概念契约，具体字段可以在 ADR Review 中收敛。关键不变量是：

```text
manualMarkdown
tags
routableCapabilities
capability evidence

全部从同一个 ExecutorCapabilityProfile 派生
```

## 5. 权威关系

### 5.1 用户定义优先于系统生成语义

对于定位、偏好、限制、任务边界和模型分工：

```text
用户规范化语义
  > 系统生成的默认语义
  > 没有声明
```

系统不能在最终说明书中保留与用户定义冲突的旧文案。例如：

```text
系统默认：适合大型代码重构
用户定义：不要把代码重构路由给该 Executor

最终画像：
- 代码重构进入 avoid 或 disabled
- 最终说明书不再声称它适合代码重构
- 结构化投影同步反映该策略
```

### 5.2 执行事实不是可被文案覆盖的系统偏好

用户优先不等于忽略客观执行条件。模型是否存在、是否启用、是否属于
Executor 的 ModelPolicy、Harness 是否支持对应协议、Permission 是否允许，
属于执行事实，不是系统生成文案。

用户声明“`gpt-image-2` 给 `pi-agent` 带来图片生成能力”时：

- 如果 `gpt-image-2` 已在该 Executor 的有效模型池中，声明会被确认并进入
  最终可路由能力；
- 如果模型未绑定、已禁用或 Harness 不支持，声明保留为未满足意图，不能
  对 Planner 宣称已经具备执行资格。

### 5.3 Planner、Validator 与 Kernel 的边界

```text
Configuration
  编译统一能力画像，是静态能力与语义路由契约的 owner

Planner
  阅读最终说明书和同源结构化投影，理解任务并提出 Executor 绑定

Validator
  校验 Planner proposal 是否符合该 revision 的可路由能力投影

Kernel
  校验并解析具体 AgentClass / Model / Harness / Permission 绑定

Runtime
  只执行 Kernel 已授权的具体绑定并上报事实
```

Kernel 不读取 Markdown，也不重新定义 Executor 擅长什么。Kernel 的职责是
确认“这次实际执行是否有合法、健康、可用的具体绑定”，不是维护第二套
能力说明书。

## 6. 统一编译链路

每个 Executor 独立执行以下流程：

```text
1. 读取 Executor AgentClass
2. 解析 effective ModelPolicy
3. 规范化有效模型及其能力事实
4. 计算 Harness / affordance 支撑能力
5. 读取用户原始自然语言与已接受语义
6. 合并系统默认语义和用户语义
7. 计算每项 capability 的 support 与 routingDisposition
8. 生成 ExecutorCapabilityProfile
9. 从 profile 渲染中文 CAPABILITY.md
10. 从 profile 投影 Planner-safe Routing Catalog
11. 校验说明书、标签和 Catalog 的同源不变量

### 6.2 用户操作与编译入口

用户界面只提供一个 Executor 操作：

```text
更新能力画像
```

该操作同时完成用户自然语言的语义解释和最终能力画像生成。用户不需要
区分“智能提炼”和“更新能力画像”。

系统内部仍保留两个有明确职责的阶段，但它们属于同一次编译：

```text
Semantic Interpretation
  用户自然语言 -> Executor 私有结构化语义

Deterministic Compilation
  模型事实 + Executor 配置 + 结构化语义
    -> 中文说明书
    -> 能力标签
    -> Routing Catalog 投影
```

当用户文本发生变化，统一编译入口使用当前 Planner 模型绑定执行一次
结构化语义解释。当只有模型池、模型能力或 Executor 执行事实发生变化时，
系统复用已持久化的可信语义，只重新编译能力画像，不重复调用语言模型。

如果此前只保存了原文而没有结构化断言，后续再次更新能力画像时会重新尝试
语义解释。预览产生的可信语义回执会在保存激活时复用，避免“预览成功、保存
再次解析”造成重复调用和结果不一致。

保存激活是同一编译链路的最后兜底：如果用户没有先点击更新，激活流程会对
发生文本或能力事实变化的 Executor 自动执行统一编译。语言模型暂时不可用
时保留用户原文并完成系统能力编译，不阻塞配置激活；结构化断言仍必须通过
配置服务的回执校验。
```

### 6.1 编译公式

对 Executor `E` 和 Routing Capability `C`：

```text
EffectiveModels(E)
  = ModelPolicy(E) 中已启用、Provider 可用且与 Harness 兼容的模型

ModelEvidence(E, C)
  = EffectiveModels(E) 中至少一个模型满足 C 的模型能力要求

AffordanceEvidence(E, C)
  = E 包含 C 要求的全部受控 affordance

HarnessEvidence(E, C)
  = Harness driver 声明支持 C 对应的执行与产物协议

StructurallySupported(E, C)
  = RegistryQualification(C) 的全部必要证据成立

Routable(E, C)
  = StructurallySupported(E, C)
  AND UserDisposition(E, C) != disabled
```

对于 `avoid`：

```text
Eligible(E, C) = true
PlannerPreference(E, C) = low
```

这允许用户表达“尽量不要用，但没有其他 Executor 时可以接”，而不用把
能力事实伪装成不存在。

### 6.2 Catalog 投影

Routing Catalog 应从 profile 生成，而不是重新读取 AgentClass 和 Model：

```ts
interface ConfigurationCatalogAgentClass {
  id: string;
  routableCapabilities: RoutingCapabilityId[];
  capabilityPreferences: Array<{
    capabilityId: RoutingCapabilityId;
    disposition: 'preferred' | 'allowed' | 'avoid';
  }>;
  modelPolicy: ModelPolicy;
  profileFingerprint: string;
}
```

Validator 只接受：

```text
subtask.requiredCapabilities
  被所选 AgentClass.routableCapabilities 完整覆盖
```

Planner 使用 `capabilityPreferences`、最终说明书和任务语义排序多个合格
Executor。Catalog 不再复制一套 `primaryUseCases` / `avoidUseCases` 文案。

### 6.3 同源校验

配置编译必须满足：

```text
Catalog.profileFingerprint
  == CapabilityProfile.sourceFingerprint

Catalog.routableCapabilities
  == CapabilityProfile 中
     support=supported 且 disposition!=disabled 的 capability 集合

说明书中的“稳定执行能力”
  == CapabilityProfile 的 supported capability 解释

说明书中的“当前不可执行”
  == CapabilityProfile 的 unsupported / unresolved claims
```

任何不一致都必须使候选 revision 编译失败，不能在激活后交给 Planner 猜测。

## 7. `gpt-image-2` 示例

### 7.1 添加模型

用户把 `gpt-image-2` 加入 `pi-agent` 的 Auto 模型池，并定义：

```text
pi-agent 负责图片生成和图片编辑。
其中 gpt-image-2 提供这两项能力。
```

编译结果：

```text
有效模型证据：
- gpt-image-2 -> image-generation
- gpt-image-2 -> image-editing

最终能力画像：
- image-generation: supported + preferred
- image-editing: supported + preferred

Routing Catalog 投影：
- pi-agent -> image-generation
- pi-agent -> image-editing

最终说明书：
- pi-agent 优先承担图片生成和图片编辑
- 两项能力均由 gpt-image-2 提供
```

Planner 收到图片任务后，根据说明书优先选择 `pi-agent`，并在 Work Graph
中使用 `image-generation` 或 `image-editing`。Kernel 从该 revision 允许的
模型中解析 `gpt-image-2` 具体绑定。

### 7.2 移除模型

用户从 `pi-agent` 模型池移除 `gpt-image-2` 并更新能力画像：

```text
模型证据消失
  -> image-generation unsupported
  -> image-editing unsupported
  -> 两项能力从 routableCapabilities 移除
  -> Catalog 同步移除
```

如果用户原始文本仍写着“负责图片生成”，最终说明书不能继续声称已具备
该执行资格。它应明确展示：

```text
当前未满足：
- 用户希望承担图片生成，但当前模型池没有可执行该能力的模型
```

用户原始文本继续保存用于审计和后续重新绑定模型，但不制造错误资格。

### 7.3 自定义模型

如果系统目录尚未记录某个自定义模型的图片能力，用户可以自然语言确认：

```text
custom-image-v2 支持 image-generation，并由 pi-agent 用于图片生成。
```

语义编译器只能把它规范化为系统已注册的 `image-generation`，并记录
`model-user-confirmed` 证据。只有以下条件同时成立才进入 Catalog：

- `custom-image-v2` 已配置、启用并属于 `pi-agent` ModelPolicy；
- 当前 Harness 声明支持图片生成调用与产物协议；
- Provider 和 Executor 已启用；
- capability ID 已在代码控制的 Registry 中注册。

UI 应标注“用户确认，未由系统目录验证”，以区分系统已知证据。

## 8. 用户自然语言解析

### 8.1 不要求必须由 Planner 解析

Executor 配置解析不是普通 Planner 工作图规划。它应使用独立的
`ExecutorCapabilityInterpreter` 接口：

```ts
interface ExecutorCapabilityInterpreter {
  interpret(input: {
    agentClassRef: string;
    sourceText: string;
    currentProfile: ExecutorCapabilityProfile;
    effectiveModels: SafeModelCapabilityFact[];
  }): Promise<ExecutorUserSemanticProfile>;
}
```

实现可以使用当前 Planner 模型、其他配置模型或后续专用模型，但不应依赖
Planner RPC 必须提交某个 planning tool。配置解释只返回严格结构化语义，
不创建 Task、不提交 Work Graph、不接触 Kernel。

### 8.2 失败处理

模型池变化不依赖语义模型，因此即使自然语言解释服务暂时不可用，也必须
能够重新计算模型派生能力。

对于用户修改后的新自然语言：

- 原始文本立即保存在配置草稿中；
- 已激活 revision 和上一次已接受语义不被覆盖；
- 解释成功后生成新的 profile 预览；
- 超时或结构化输出失败时返回可重试诊断，不返回 HTTP 422 作为普通用户
  输入错误；
- 未成功编译的新语义不能静默成为激活路由真相；
- 用户可以继续编辑或重试，不丢失文本。

这避免“解析失败但页面看起来已经保存并生效”，也避免一次模型超时破坏
当前有效路由。

### 8.3 语义结果

建议语义结果显式区分：

```ts
interface ExecutorUserSemanticProfile {
  mission: string[];
  strengths: string[];
  limitations: string[];
  preferredTasks: string[];
  avoidTasks: string[];
  modelContributions: Array<{
    modelRef: string;
    text: string;
    confirmedModelCapabilities: ModelCapability[];
  }>;
  capabilityPolicies: Array<{
    capabilityId: RoutingCapabilityId;
    disposition: 'preferred' | 'allowed' | 'avoid' | 'disabled';
    reason: string;
  }>;
  delivery: string[];
}
```

用户不填写这个结构。它只是自然语言解释后的持久化、审计和重生成输入。

## 9. 配置页面与交互

### 9.1 页面原则

每个 Executor 的设置卡片只展示与用户决策有关的信息：

1. Executor 基本状态；
2. 当前模型选择；
3. 自然语言能力定义；
4. 最终能力画像预览；
5. 保存和激活状态。

不单独展示可编辑的模型能力表、Routing Catalog、capability ID 或能力标签。
标签由最终 profile 自动提炼，只读展示。

### 9.2 “更新能力画像”操作

建议将“更新能力说明书”改为“更新能力画像”，因为操作同时刷新：

- 模型能力证据；
- 最终可路由能力；
- 用户语义合并；
- 只读标签；
- 中文 Skill-style 说明书；
- Catalog 草稿投影。

按钮只编译当前未保存草稿，不激活配置。预览至少展示：

```text
新增可路由能力
- 图片生成，由 gpt-image-2 提供
- 图片编辑，由 gpt-image-2 提供

移除可路由能力
- 无

路由偏好变化
- pi-agent 现在优先承担图片任务

未满足声明
- 无
```

### 9.3 保存与激活

页面应明确区分：

```text
已编辑
  用户输入或模型池发生变化，尚未编译

已预览
  草稿 profile 编译成功，尚未激活

激活中
  正在执行 ConfigurationActivationGate 和 revision 切换

已生效
  active revision 已包含该 profile

需要修正
  存在未满足能力、无可用模型或语义解释失败
```

“保存并应用”原子提交：

- Executor ModelPolicy；
- 用户原始文本；
- 用户规范化语义；
- 统一能力画像；
- 中文说明书；
- Routing Catalog 投影；
- source fingerprint。

后端必须从输入重新编译并校验，不能信任前端提交的 profile、标签或 Catalog。

### 9.4 模型变化

模型选择变化后：

- 页面立即把当前预览标记为 stale；
- 用户点击“更新能力画像”得到确定性模型能力变化；
- 不要求用户重新输入相同的自然语言；
- 移除模型必须同步移除其能力归因和 Catalog 资格；
- 添加模型必须自动加入它能支撑的注册能力；
- 只有成功激活后才影响下一次 Planner turn 和新 Work Graph generation。

## 10. Revision 与运行时语义

统一能力画像是 immutable configuration revision 的组成部分：

```text
revision N
  -> Executor AgentClass
  -> ModelPolicy
  -> User source + accepted semantic profile
  -> ExecutorCapabilityProfile
  -> CAPABILITY.md
  -> Routing Catalog projection
```

激活 revision `N+1` 后：

- 下一次 Planner turn 读取 `N+1` 的说明书和 Catalog；
- 新 Work Graph generation 使用 `N+1`；
- 已存在的 Task、graph generation、attempt、fallback 和 recovery 保持原
  revision；
- rollback 重新激活旧 revision，并恢复其 profile、说明书和 Catalog。

Runtime 目录中的 `CAPABILITY.md` 是该 revision 的只读产物，不是独立配置
源，也不能被直接编辑后影响路由。

## 11. 模块所有权与依赖

本方案不改变 ADR-0020 的主轴：

```text
Planner proposes
  -> Kernel decides
  -> Runtime applies
```

建议所有权如下：

### Configuration

- 持有用户源文本和规范化语义；
- 解析 effective models；
- 调用纯 capability compiler；
- 校验、编译和激活 immutable revision；
- 不把 Provider secrets 输入能力画像。

### Routing

- 持有受控 Routing Capability Registry；
- 持有 qualification rules；
- 提供纯 `compileExecutorCapabilityProfile`；
- 从 profile 生成 Planner-safe Catalog；
- 从 profile 渲染 CAPABILITY.md。

### Planning

- 读取每个 Executor 独立的最终说明书；
- 读取同源结构化投影；
- 选择 Executor、required capabilities 和模型偏好；
- 不拥有 profile 编译或配置写入。

### Validator

- 校验 proposal 引用 active revision；
- 校验 AgentClass 覆盖 required capabilities；
- 校验 Planner 提议的模型在 ModelPolicy 内；
- 不解析 Markdown。

### Kernel / Runtime

- Kernel 解析具体授权绑定；
- Runtime 执行绑定和产物协议；
- 两者不重新解释用户说明书；
- Permission、health、capacity 和 recovery 规则保持现有权威。

允许依赖：

```text
Configuration -> Routing compiler
Planning      -> Routing projection types
Validator     -> Routing projection types
Kernel        -> compiled Kernel configuration facts
```

禁止：

- Routing compiler 调用 Planner；
- Kernel 或 Runtime 解析 Markdown；
- UI 直接写 Catalog；
- Planner 修改 Executor profile；
- 用户自然语言直接扩大 Permission Profile。

## 12. 数据迁移

### 12.1 现有 Executor

首次迁移为每个 enabled Executor 编译一个 profile：

```text
现有 AgentClass routingCapabilities
  -> 初始受控能力声明

现有 primaryUseCases / avoidUseCases
  -> 初始系统语义

现有 executorManual.sourceText / assertions
  -> 初始用户语义

现有 ModelPolicy 和 Model capabilities
  -> 能力证据
```

迁移后 Catalog 必须从 profile 生成。旧字段可以在一个 migration revision
中作为输入读取，但不能长期保留为第二写入源。

### 12.2 兼容边界

- 历史 revision 和历史 Work Graph 不重写；
- 历史 `CAPABILITY.md` 保持可审计；
- 当前 active revision 通过正常 activation 生成第一个统一 profile revision；
- 不新增运行时 dual-read 或 dual-write；
- 若需要 schema version bump，必须事务化迁移并同步 repository、Docker 和
  rollback 测试。

### 12.3 旧字段收敛

目标状态：

```text
AgentClass.routingCapabilities
  不再是用户或 UI 独立写入源

primaryUseCases / avoidUseCases
  迁入 profile 的系统默认或用户路由策略

executorManual.assertions
  演进为 ExecutorUserSemanticProfile

routingCatalog
  仅为 profile projection
```

是否物理删除旧字段由实施 ADR 和 migration plan 决定，但生产代码不得长期
同时从旧字段和新 profile 分别计算资格。

## 13. 错误与诊断

用户可见错误应回答“为什么没有获得资格”，而不是暴露内部 Catalog 术语。

推荐诊断：

```text
无法启用图片生成：
- pi-agent 当前没有支持图片生成的模型

图片编辑尚未生效：
- gpt-image-2 已选择，但当前 Harness 不支持图片编辑产物协议

能力定义尚未更新：
- 自然语言解析超时，原始内容已保存在草稿中，请重试更新能力画像

配置未激活：
- 当前仍在使用 revision abc，草稿 revision def 尚未应用
```

内部审计应保留：

- profile fingerprint；
- capability evidence；
- unresolved reasons；
- semantic interpreter 模式和安全摘要；
- configuration revision；
- activation result。

不得记录原始凭据、Provider secret、模型隐藏推理或未脱敏 prompt。

## 14. 方案比较

### 方案 A：保留说明书和 Catalog 双轨

优点是改动小。缺点是用户修改无法完整影响实际资格，两套真相继续漂移。
不采用。

### 方案 B：让 Planner 每次直接解析 Markdown 并自由路由

优点是表面灵活。缺点是不可复现、不可稳定校验，Validator 和 Kernel 无法
获得可靠结构化契约，也容易让不同 Planner turn 得出不同资格。不采用。

### 方案 C：统一能力画像，说明书与 Catalog 同源

同时保留自然语言灵活性、结构化校验、revision 审计和 Kernel 安全边界。
这是本方案的推荐路径。

## 15. 实施阶段

### Phase 0：ADR 修订

- 修订 ADR-0015：Planner 使用最终说明书作为权威语义路由依据；
- 修订 ADR-0018：Routing Catalog 定义为 compiled capability profile 的投影；
- 修订 ADR-0028：说明书不再只是 advisory，模型证据与路由语义进入统一
  profile，但授权绑定仍由 Kernel 决定；
- 修订 ADR-0033：profile、说明书和 Catalog 随配置 revision 原子热激活；
- 更新 `CONTEXT.md` 和 current technical overview。

### Phase 1：统一 Profile 和纯编译器

- 新增 profile、evidence、routing disposition 类型；
- 把模型要求、affordance 要求和 Harness 要求统一到 capability registry；
- 实现确定性 profile compiler；
- 实现说明书和 Catalog 同源投影；
- 增加 fingerprint 和一致性校验。

### Phase 2：配置持久化与迁移

- 演进用户语义持久化结构；
- 迁移现有 AgentClass、manual assertions 和 use-case hints；
- 配置 compile/preview/activate 全部生成 profile；
- 删除生产路径中的双重资格计算。

### Phase 3：Planner、Validator 与 Kernel 对接

- Planner 上下文返回 profile-derived manuals 和 projection；
- Planner Skill 移除“manual 不能改变 Routing Capability”的旧规则；
- Validator 使用 profile-derived routable capabilities；
- Kernel 继续使用同 revision 的模型要求解析具体绑定；
- 加入 fingerprint / revision mismatch fail-closed。

### Phase 4：配置 API 和 Web 交互

- 引入独立 `ExecutorCapabilityInterpreter`；
- “更新能力说明书”升级为“更新能力画像”；
- 增加能力增减、模型证据、未满足声明和 revision 状态预览；
- 标签只读并从 profile 提炼；
- 保存激活时由后端重新编译。

### Phase 5：运行时产物、回归和文档

- 从 profile 渲染 revision-pinned `CAPABILITY.md`；
- 覆盖 native 和 Docker 配置编译路径；
- 完成 Planner -> Validator -> Kernel -> Executor E2E；
- 更新 ADR、CONTEXT、技术文档和方案完成记录。

## 16. 验收标准

### Profile 与投影

1. 每个 enabled Executor 有且只有一个 revision-scoped profile。
2. 说明书、标签和 Catalog 带相同 profile fingerprint。
3. Catalog 中不存在 profile 未声明的 routable capability。
4. profile 中 supported 且未 disabled 的能力全部进入 Catalog。
5. 编译结果相同则 fingerprint 和输出稳定。

### 模型变化

6. 给 `pi-agent` 添加 `gpt-image-2` 后，预览和激活 revision 同时增加
   `image-generation` 与 `image-editing`。
7. 移除 `gpt-image-2` 后，两项能力、模型归因、只读标签和 Catalog 投影同时
   删除。
8. Auto 默认模型不支持图片时，Kernel 仍能从 allowed pool 选择具备图片
   能力的模型。
9. 没有有效支撑模型时，用户声明显示为未满足，不产生错误资格。

### 用户语义

10. 用户对定位、擅长、不擅长和模型分工的定义覆盖冲突系统文案。
11. 用户明确 disabled 的能力不进入 Catalog。
12. 用户标记 avoid 的能力仍可作为 fallback，但 Planner 不应优先选择。
13. 用户确认自定义模型的已注册能力时记录 `user-confirmed` 证据。
14. 用户不能创建未知 capability 或扩大 Permission Profile。

### 配置交互

15. 用户不需要也不能编辑内部能力标签或 Catalog。
16. 更新能力画像明确展示新增、移除、偏好变化和未满足声明。
17. 语义解释超时不返回误导性的 422，不丢失用户草稿，也不破坏 active
    revision。
18. 保存并应用后，下一次 Planner turn 读取新 revision；运行中 Task 不漂移。

### 路由执行

19. 图片生成请求由 Planner 路由给 profile 中具备
    `image-generation` 的 Executor。
20. Validator 接受该 Executor 的 binding，并拒绝没有该能力的 Executor。
21. Kernel 从该 Executor 的当前 allowed models 中解析图片模型具体绑定。
22. Executor 能生成符合 Completion Protocol 的图片产物。

### 安全与回归

23. Provider 配置和 secret handling 无变化。
24. Permission、health、capacity、recovery 和 authorized binding 规则无放宽。
25. Planner、Kernel 和 Runtime 均不解析 Markdown。
26. 历史 revision、历史 Work Graph 和历史结果保持可读。

## 17. 测试策略

实施计划必须按 owner seam 先写失败测试：

- Routing compiler 单元测试：模型证据、用户策略、unsupported、fingerprint；
- Configuration 测试：draft、preview、activation、rollback、migration；
- Projection 测试：manual / tags / Catalog 同源；
- Planner 测试：读取每个 Executor 独立说明书并按 disposition 排序；
- Validator 测试：只接受 profile-derived capability coverage；
- Kernel 测试：图片任务选择图片模型，普通默认模型只是偏好；
- Management API 测试：解析失败、stale preview、revision conflict；
- Web 测试：能力 diff、只读标签、未满足声明、保存状态；
- E2E：添加和移除 `gpt-image-2` 后真实路由结果同步变化；
- Docker / native smoke：revision artifact 和 Planner-to-Executor 图片产物。

核心回归命令至少包括：

```text
npm run lint
npm test
npm run build
npm run build:web
npm run build --prefix planner/AnyFusion-Pi/packages/coding-agent
npm run smoke:metawork
```

SQLite、POSIX path、runtime rendering 和 Docker attempt 相关测试继续按仓库
规范在 Docker 中执行。

## 18. 实施完成记录

本方案已按统一编译链路落地：

- 新增每个 Executor 独立的 `ExecutorCapabilityProfile` 纯编译器，统一生成
  source fingerprint、能力证据、support、routing disposition、可路由能力、
  中文 Skill-style 说明书和只读标签；
- Routing Catalog、Planner manual projection 和 Kernel configuration view
  全部从同一 profile 派生，Catalog 保留兼容字段名
  `routingCapabilities`，但其内容已经是 profile-derived qualification；
- `gpt-image-2` 的系统已知能力会为有效 Executor 模型池派生
  `image-generation` 和 `image-editing`，移除模型会同步移除证据和资格；
- 用户自然语言语义支持对已注册能力设置
  `preferred | allowed | avoid | disabled`，用户定义覆盖冲突的系统语义，但
  不能创建未知能力、未配置模型或 Permission 语法；
- Executor 能力解释使用独立配置 turn，Planner RPC 超时、模型失败或未提交
  proposal 时返回成功的 `source-preserved` 预览，不再把普通解释失败暴露为
  HTTP 422；系统保留用户原文并完成基于当前模型与 Executor 配置的基础画像，
  因此不会因语言模型暂时不可用而阻塞配置激活；结构化语义变化只有在取得
  服务端签发、绑定原文与 assertions 的 semantic receipt 后才会进入激活配置，
  客户端不能伪造或复用旧语义，后续点击同一“更新能力画像”操作可重试语义
  解析；清空已有定义则通过同一受信路径确定性生成回执，不调用 Planner 模型；
- 配置服务在接收 Planner 语义回执时，会把误挂在普通断言上的路由字段规范化
  为独立的 `capability-policy` 断言，避免单个模型的输出格式差异让整个 Executor
  画像降级为原文保留；
- 配置 revision 的内容哈希只计算可持久化的 canonical 配置字段，避免可选字段的
  `undefined` 值在内存与 YAML 重读之间产生哈希漂移；
- Codex/Pi Driver 通过同一 Harness Driver Catalog 声明
  `workspace-image-artifact-v1`，图片能力进入执行上下文和 Executor prompt，
  图片 Subtask 强制使用 `deliveryKind: edit`，Completion Protocol 使用有界读取
  校验 PNG/JPEG/WebP/GIF 文件签名，缺少、不可读或伪造图片产物时失败关闭；
- 系统生成的适合任务和模型 strengths 会按当前 supported/disposition 过滤，
  模型移除后中英文图片用例都会从说明书与只读标签中同步移除；
- 生产语义 Planner ingress 拒绝新的 `direct_reply`，slash 系统命令继续走
  Application-Shell，其余工作型请求必须生成 Work Graph 并交给 Executor；
- Web 设置页提供“更新能力画像”，展示当前可路由能力、相对上次画像的新增/
  移除/偏好变化、当前未满足、能力证据、中文说明书和只读标签；用户不能直接
  编辑 Catalog 或标签；
- ADR-0015、ADR-0018、ADR-0028、ADR-0033、`CONTEXT.md` 和中英文当前技术
  概览已同步更新为统一 profile 权威关系。

### 验证

2026-09-01 完成以下验证：

```text
npm run lint
  passed

npm test
  374 test files passed, 8 skipped
  1894 tests passed, 20 skipped

focused capability/manual/clear-path regression
  8 test files passed
  139 tests passed

npm run build
  passed, including nested Web production build

npm run build:web
  passed when run serially

npm run build --prefix planner/AnyFusion-Pi/packages/coding-agent
  passed

git diff --check
  passed

independent read-only review
  no remaining Critical or Important findings
```

原生 `npm run smoke:metawork -- --scenario planner-session` 在启动前按设计失败，
原因是本机没有 `~/.config/metawork/provider.env`。未执行 Docker smoke，因为
当前任务没有提供 `docker/*.env` Provider 凭据。代码和配置尚未在本工作会话中
创建 closing commit。

## 19. 风险与缓解

### 用户确认了错误模型能力

用户确认只允许使用代码已注册能力，并明确标注证据来源。Harness、模型池、
Provider、Permission 和具体绑定仍需校验。执行失败进入现有结构化失败和
健康路径，不能静默伪造成功。

### 语义解释不稳定

自然语言解释结果必须通过严格 schema 和当前 Executor / Model facts 校验。
激活保存规范化语义，后续模型变化使用确定性重编译，不在每次 Planner turn
重新解释用户文本。

### Profile 变成新的大对象

Planner 不需要接收全部内部 evidence。Planner-safe projection只包含最终
说明书、可路由能力、偏好和安全模型归因。详细证据保留在配置管理与审计
接口，并设置每 Executor 和总上下文大小上限。

### 迁移期间出现双重资格来源

迁移必须以一个 revision 原子切换。允许旧字段作为 migration input，但不
允许新生产路径同时读取旧 `routingCapabilities` 和新 profile 分别做资格
判断。

## 20. Review 决策点

本方案建议 Review 时确认以下三项：

1. 用户对能力使用 `preferred / allowed / avoid / disabled` 四级策略，其中
   `avoid` 保留 fallback 资格，`disabled` 才移除资格。
2. 自定义模型允许通过自然语言产生 `user-confirmed` 已注册模型能力证据，
   但不得创建 capability、Harness 或 Permission 新语义。
3. 新用户自然语言未成功解析时只保存草稿，不激活新的语义路由；模型池
   变化仍可独立、确定性地重新编译能力。

Review 通过后，应先提交 ADR 修订，再编写逐文件、TDD 化的实施计划。本
文档本身不授权直接修改 Kernel、Routing Catalog 或配置 schema。
