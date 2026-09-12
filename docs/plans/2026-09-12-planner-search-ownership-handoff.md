# Planner 检索职责归位：检索下沉执行器，Planner 只做理解与拆解

- 状态：**提案，待评审定稿**（未实施）
- 日期：2026-09-12
- 范围：vendored Planner（`planner/AnyFusion-Pi/packages/coding-agent`）提示词与工具白名单；MetaWork 侧超限兜底与错误文案
- 不在范围内：routing capability 注册表、Plan schema、Executor 实现、MCP、Web/TUI
- 触发事件：用户在 Web 里问"某份网络安全文件重点是什么 + 为什么引起争议",Planner 在 8 个处理轮次内未提交方案，整轮失败并显示 `Planner unavailable: Planner did not submit a proposal within 8 processing cycles; stop workspace inspection and decide from authoritative MCP facts.`

## 0. 摘要

| 项 | 内容 |
|---|---|
| 目标 | ① 消除"Planner 检索循环 → 整轮失败";② 职责归位：Planner 理解意图与拆解，检索归 Executor |
| 手段 | Planner 侧移除 `web_search`（并评估移除 `web_fetch`）+ 重写提示词/技能；MetaWork 侧把"决策耗尽"从硬失败改为兜底委派 |
| Executor 侧 | 无需改动（`pi-research` 已具备可用检索：curl + 代理 + Bing/百度 + 缓存 + 预算 + 优雅失败） |
| 预期结果 | 研究类请求稳定走 `plan_work_graph` → `pi-research`;不再出现 `Planner unavailable`;Planner 轮次与工具调用数显著下降 |

## 1. 背景

Planner 目前自带两个只读 Web 工具（`web_fetch`、`web_search`），并由系统提示词要求"先检索、再委派"。该设计要求 Planner 在委派前先自行确认需求的可研究性。实际运行中，这一要求在检索通道可用性差的网络环境下演变成**URL 猜测循环**,最终撞上有界决策保护（8 个处理轮次 / 12 次非提案工具调用）而**整轮失败**。

## 2. 实测证据

### 2.1 侦察检索是提示词明文要求的（非模型自作主张）

- `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-system-prompt.ts:31`
  > For Executor-owned research, use `web_fetch` for a supplied public URL or `web_search` when no source URL is supplied, **then** call get_planning_context, read the matching Executor manual, and submit one focused `plan_work_graph` ...
- `planner/AnyFusion-Pi/packages/coding-agent/src/metaclaw-planner/SKILL.md:27,29` 同义。

### 2.2 侦察结果不会进入 Plan

- 6 次 `submit_planning_proposal` 的 plan 内**均无 URL/摘要**（程序化检查 `plan` JSON 中不含 `http`）。
- Plan schema（`planning-agent-plan-v8`）的 subtask 字段仅：`id / title / goal / dependencies / contextRefs / requiredCapabilities / executorBindings / deliveryKind / acceptance / riskLevel`——**没有承载"侦察结果"的字段**；要传只能写入 `goal` 文本（实际未写）。

### 2.3 委派链路本来就是通的（实测）

同一环境下的"徐汇滨江附近有什么好吃的":

```
task   : 推荐徐汇滨江附近美食                     status = done
subtask: 调研徐汇滨江周边餐饮并给出推荐
  required_capabilities_json = ["current-web-research"]
  executor_bindings_json     = [{"agentClassRef":"pi-research","harnessRef":"pi-cli",
                                 "providerRef":"custom-provider-5",
                                 "modelRef":"custom-provider-5-5",
                                 "permissionProfileRef":"public-web-research", ...}]
  context_refs_json          = [{"kind":"current_user_input"}]
receipt: agent_class_name = pi-research, terminal_state = completed
```

即：Planner 只声明"需要 `current-web-research`",内核解析为 `pi-research` 并用 `deepseek-v4-pro` 完成；**子任务已携带 `contextRefs:[{kind:'current_user_input'}]`**（用户原话，含 URL）。

### 2.4 Executor 侧检索实现更强

| 维度 | Planner 侧（`anyfusion/planner-web-tools.ts`） | Executor 侧（`src/executor/pi-agent.ts` → `pi-attempt-tools`） |
|---|---|---|
| 网络 | undici 直连 + 解析后**钉 IP** | **curl 子进程** |
| 代理 | ❌ 与代理互斥 | ✅ 遵循 `HTTP(S)_PROXY`（工具描述与 `prompt-builder.ts:54` 明确） |
| 后端 | 仅 Bing 网页 HTML | **Bing HTML → 百度 HTML 兜底** |
| 缓存 | ❌ | ✅ 进程内 `searchCache` |
| 预算 | ❌（靠 supervisor 硬上限） | ✅ `MAX_SEARCH_CALLS_PER_ATTEMPT = 30`,超限**优雅返回**"基于已有信息继续" |
| 失败语义 | `throw` → 可能整轮失败 | 返回 `{success:false,error}` → 模型可收口 |

### 2.5 失败如何传导到用户

- `planner-process-supervisor.ts:38-39` 上限：`DEFAULT_MAX_PROCESSING_CYCLES = 8`、`DEFAULT_MAX_NON_PROPOSAL_TOOL_CALLS = 12`。
- `planner-process-supervisor.ts:523-527`（轮次超限）与 `552+`（非提案调用超限）调用 `fail()`,错误文案即"给模型的引导语"。
- `anyfusion-planning-agent.ts:73-76` 将失败包装为 `{ status: 'transport_uncertain', retryableByReplay: true, message: 'Planner unavailable: …' }`。
- `src/session/conversation-session.ts:566-568` 对 `transport_uncertain` **直接 `throw`** → 用户看到该错误，无法获得任何答复。

### 2.6 为什么模型会陷入 URL 猜测

- 本机 `www.google.com` 解析出 `2001::1` / `69.171.235.22`（含非公网地址）→ Planner 的 SSRF 防护**正确拒绝**，Google 不可用。
- 复跑 Planner 的 `web_search`（同查询）：`site:anthropic.com/news "…"` 返回 **Kimi 推广页**;通用查询返回百科/知乎/腾讯新闻与**错拼域名 `antohropic.com`**——搜索通道在中文网络环境下事实不可用。
- 于是模型退化为构造 URL（`anthropic.com/news/<slug>` 变体）→ 连续 404 → 撞上限。
- 该会话 Planner 模型为 `k3`（`custom-provider-4`，会话内 `03:07` 从 `gpt-5.6-sol` 切换），在检索无果时更倾向继续尝试。

### 2.7 时间与轮次成本（实测）

| Turn | 检索次数 | 首次/末次检索 | 提交 Plan |
|---|---|---|---|
| 徐汇滨江散步推荐 | 2 | +16s / +23s | +56s ✅ |
| 徐汇滨江好吃的 | 2 | +9s / +14s | +41s ✅ |
| 穿什么鞋散步 | 1 | +24s | +46s ✅ |
| Anthropic 报告 | **10** | +10s / +60s | ❌ 失败 |
| 继续 | **14** | +14s / +67s | ❌ 失败 |

每 Turn 工具调用（非提案）：散步 4、打招呼 1、好吃的 4、Anthropic 10、继续 14。

### 2.8 中途纠偏当前不可行

- `planner-host-bridge.ts:227-229`: `command_submit` 按会话 `enqueue`,**排队到本轮结束后执行**。
- Planner Host 协议命令仅 `hello / ping / shutdown / command_submit / proposal_submit / permission_resolve`,**无 abort/steer**。
- 结论：无法在轮次中途注入"立即收口"消息；只能靠提示词约束 + 失败后的兜底。

## 3. 术语（避免歧义）

| 概念 | 你环境中的实例 | 作用 |
|---|---|---|
| Executor / AgentClass | `codex-engineering`(harness `codex-cli`)、`pi-research`(harness `pi-cli`) | 实际执行角色：绑定 harness、权限档、模型策略 |
| RoutingCapability | `workspace-engineering`(codex)、`current-web-research`(pi) | 子任务"需要的能力"与执行器"声明的能力"的匹配键；内核据此选择执行器 |
| ExecutorAffordance | `public-web-search` / `public-web-fetch` / `source-citation`(pi) | 仅用于 Planner 拆解与路由判断的能力提示 |
| ModelCapability | `coding` / `tools` / `structured-output` / `planning` … | 路由能力经 `ROUTING_CAPABILITY_REGISTRY` 映射为模型能力要求（`current-web-research` 映射为空，不卡模型） |

## 4. 方案设计

### 4.1 Planner 侧：移除 Web 工具

- **`web_search`：移除**。依据：侦察结果不进 Plan（§2.2）、下游会自行检索（§2.4）、是唯一已知整轮失败源（§2.5/2.6）、每次 Turn 额外 5~24s（§2.7）。
- **`web_fetch`：建议一并移除**（决策点 2）。依据：读到的内容同样不进 Plan；Executor 的 fetch 更强且走代理；`contextRefs:[{kind:'current_user_input'}]` 已能把用户原话（含 URL）交给 Executor（§2.3）。若选择保留，必须同时满足：仅用户显式 URL、每 Turn ≤1 次且禁止顺链续读、摘要写入 subtask `goal`/`contextRefs`。

### 4.2 提示词与技能重写（本方案核心）

必须同步修改 `planner-system-prompt.ts`、`metaclaw-planner/SKILL.md`,否则移除工具后模型会按旧规则宣称"没有网络能力"或退回 `direct_reply`。

| 旧规则（删除） | 新规则（替换） |
|---|---|
| "Semantic RPC 有只读 `web_fetch`/`web_search`;不要声称没有网络能力，先尝试工具" | "Planner **在设计上没有** Web 工具；研究类请求由 Executor 完成。不得因缺少联网工具而声称会话/环境故障" |
| "需要当前公开信息或给了 URL → 先 `web_fetch`/`web_search`,再 `get_planning_context`、读执行器说明书、提交一个聚焦 `plan_work_graph`" | "需要当前公开信息或给了 URL → **直接**提交一个聚焦 `plan_work_graph`,路由到声明 `current-web-research` 的 AgentClass,并挂 `contextRefs:[{kind:'current_user_input'}]`,让 Executor 看到用户原话（含 URL）" |
| （无） | "**禁止构造或猜测 URL**" |
| "不得因为还没抓取来源就用 `direct_reply` 或澄清" | 保留（改为不依赖"抓取"措辞）："不得因为缺少来源就退回 `direct_reply`;只有意图/指代真正模糊时才用 `clarificationQuestion`" |
| （无） | "**在第 3 个处理轮次前必须提交一个方案**（可先粗粒度，后续可迭代）" |

### 4.3 超限语义：硬失败 → 三层兜底

1. **主（提示词）**：§4.2 的"第 3 轮前必须提交"使 8 轮上限几乎不可能触发。
2. **兜底（MetaWork）**：当 Planner 失败且原因为**决策耗尽**时，不再 `throw`,而是合成一个研究子任务并走既有校验路径：
   - `action: plan_work_graph`，单个 subtask
   - `goal` = 用户原话 + 约束（"若该请求不需要实时信息，请直接说明"）
   - `requiredCapabilities: ['current-web-research']`；`contextRefs: [{ kind: 'current_user_input' }]`
   - 落点：`src/session/conversation-session.ts` 的 `transport_uncertain` 分支（先判定原因，再调用既有 `submitValidatedPlannerProposal`）
   - **必须在回复中告知用户**："本轮 Planner 未能在限定步数内定稿，已按研究请求委派执行器"（可审计、可纠正）
3. **降级（无执行器）**：若没有 AgentClass 声明 `current-web-research`（如用户禁用了 `pi-research`）→ 明确提示"需要联网研究但当前没有可用的研究执行器",不硬失败、也不以模型内部知识作答。

协议级中途纠偏（§2.8）不做，记录为后续可选增强。

### 4.4 Executor 侧：确认无需改动

| 项 | 现状 | 结论 |
|---|---|---|
| `pi-research` 检索 | curl + 代理 + Bing/百度 + 缓存 + 30 次预算 + 优雅失败 | 直接承接 |
| 路由映射 | `current-web-research` → `pi-research` | 无需改 |
| codex 执行器 | 仅 `workspace-engineering`;生成配置 `web_search = "disabled"`（`agent-runtime-renderer.ts:189`） | 研究类不路由到它（符合预期） |
| 用户 URL 传递 | `contextRefs:[{kind:'current_user_input'}]`（Planner 已在用） | 无需改 schema |

### 4.5 错误文案

将 supervisor `fail()` 的文案从"给模型的引导语"改为面向用户且可操作：

> 现在：`Planner did not submit a proposal within 8 processing cycles; stop workspace inspection and decide from authoritative MCP facts.`
>
> 建议：`本轮 Planner 未能在限定步数内给出方案（已尝试 8 轮）。已按研究请求委派执行器；如需更精确的拆解，请补充目标或范围。`

（文案需同时满足 §4.3 兜底后的语义；若兜底未启用则退化为"请重试或缩小范围"。）

## 5. 文件级改动清单

| # | 文件 | 改动 | 类型 |
|---|---|---|---|
| 1 | `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-policy.ts` | `PLANNER_WEB_TOOL_NAMES` 移除 `web_search`(及 `web_fetch` 视决策 2) | 白名单 |
| 2 | `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-bootstrap.ts:61` | `customTools` 不再注入对应工具（或仅注入受限 `web_fetch`） | 注入 |
| 3 | `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/planner-system-prompt.ts:29-33` | §4.2 规则替换 | Prompt |
| 4 | `planner/AnyFusion-Pi/packages/coding-agent/src/metaclaw-planner/SKILL.md:27,29` | §4.2 同步 | Prompt |
| 5 | `planner/AnyFusion-Pi/packages/coding-agent/test/anyfusion-planner-web-tools.test.ts` | 随工具移除同步用例 | 测试 |
| 6 | `src/planning/planner-process-supervisor.ts` | ①错误文案 ②把"决策耗尽"暴露为可识别原因（结构化 code 或专用错误类型） | 代码 |
| 7 | `src/session/conversation-session.ts:566` | 决策耗尽 → 兜底委派；无执行器 → 明确提示 | 代码 |
| — | `ROUTING_CAPABILITY_REGISTRY` / Plan schema / Executor 实现 / MCP | 不改 | — |

## 6. 验证方案

### A. 原案例复现（必须）
同一句 "anthropic 最新的 AI 网络安全的一份文件引起了轩然大波…"：
- 轨迹中**无** `web_search`/`web_fetch` 猜测
- 直接产生 `plan_work_graph`（1 个 `current-web-research` 子任务 + `current_user_input`）
- 任务进入 `pi-research`,若触发兜底则在回复中明确告知
- 不再出现 `Planner unavailable`

### B. 分类回归

| 输入 | 期望 |
|---|---|
| "hi" | `direct_reply` / `no_action`（不变） |
| "徐汇滨江附近有什么好吃的" | `plan_work_graph` → `pi-research`,且**无侦察检索** |
| "在仓库里改 X 功能" | `plan_work_graph` → `codex-engineering`（不变） |
| "阅读并总结这个链接 `<URL>`" | `plan_work_graph` → `pi-research` + `current_user_input`;Executor 轨迹出现 `web_fetch` |
| 禁用 `pi-research` 后问研究类 | 明确的"无可用研究执行器"提示 |
| 构造成长链路触发超限 | 走兜底：委派 + 告知，不出现 `Planner unavailable` |

### C. 指标（改前/改后）
- Planner 轮次分布（P50/P95）、每 Turn 非提案工具调用数、`transport_uncertain` 占比、Turn 耗时

### D. 自动化
- policy 白名单与 prompt 文案断言
- 兜底路径单测：决策耗尽 → 生成研究子任务；无执行器 → 提示

## 7. 影响与风险

| 影响 | 说明 | 缓解 |
|---|---|---|
| Planner 不再联网 | 含"用户给 URL"场景 | 提示词强制直接委派 + `current_user_input`;分类回归覆盖 |
| 研究任务增多 | 更多落到 `pi-research`,可能排队 | 现有并发/队列策略（`maxConcurrentTasks`）;观察 P95 |
| vendored Planner 变更 | 需重新打包 release（planner tarball）才在安装版生效 | 沿用既有发版流程 |
| Prompt 重写风险 | 模型可能退回 `direct_reply`/滥用澄清 | 保留原防退化约束；分类回归验证 |
| 兼容性 | 旧会话/历史数据不受影响 | 无迁移 |

## 8. 分阶段与工作量（估）

| 阶段 | 内容 | 工作量 |
|---|---|---|
| P1 | 白名单 + prompt/SKILL 重写 + 错误文案 | 0.5 天（含 A/B 验证） |
| P2 | 超限兜底（supervisor 原因暴露 + session 合成研究子任务 + 无执行器提示） | 1 天 |
| P3（可选，独立） | Executor 侧检索升级为可配置 API provider | 1 天 |

## 9. 待定稿决策点

| # | 决策 | 推荐 |
|---|---|---|
| 1 | `web_search` 是否移除 | **移除** |
| 2 | `web_fetch` 是否移除 | **移除**（若保留，须满足 §4.1 三条件） |
| 3 | 超限兜底方式 | **P2 合成研究子任务 + 告知用户**（不做协议级中途纠偏） |
| 4 | 是否调整 8 轮 / 12 次上限 | **先不动** |
| 5 | 是否 P1+P2 一起发版 | **是**（P3 独立） |

## 10. 附录：不在本方案内的其他待办

1. 模型能力目录补 `glm-5.3`/`glm-5.3-flash`,复核 `k3` 的 `structured-output`
2. Web 空 Workspace 无入口新增（下拉支持填绝对路径 → `POST /api/workspaces/select`）
3. 登录凭据持久化（随机密码每次重启重生成、不落库）
4. 飞书接入迁移到本机（需 App ID/Secret 或扫码新建）
5. CI 增加 Web 类型检查（`build:web` 目前仅 vite，不做类型检查）
