# Executor 工具调用级停滞自治与定向中断方案

- Status：Implemented（原子级自治 + 定向中断 + 熔断报失败）；2026-11-02 完成。
- Plan date：2026-11-02。
- Completion date：2026-11-02。
- 触发事故：2026-11-02 会话 `conv_XmMMcT-z8xAE` 的子任务「国内大厂 agents 产品布局、渠道生态与公开定价事实」
  （`..._r1_china-agent-landscape`）在 09:03 后无任何实际进展，持续挂起至 09:46 以上，界面只能显示
  「持续无活动，正在检查执行状态 / 执行状态待确认：暂无可验证的工作状态」，用户无从得知卡住的是哪个进程，
  也不会自愈。
- 关联 ADR：[ADR-0053](../../docs/adr/0053-planner-graph-coordinator-and-executor-authority.md)、
  [ADR-0052](../../docs/adr/0052-executor-owned-tool-capabilities-and-kernel-boundary.md)、
  [ADR-0024](../../docs/adr/0024-resource-partition-sandbox-and-runtime-elevation.md)、
  [ADR-0028](../../docs/adr/0028-transparent-execution-and-optional-service-specification.md)、
  [ADR-0015](../../docs/adr/0015-planner-owned-semantics-and-tool-mediated-context.md)。
- 方向一致性：ADR-0053 已明确「Executor/Harness 拥有工具注册与工具调用级 retry/repair」，
  且「新代码不得新增 Kernel 拥有的 permission / tool-selection / Harness retry / fallback / repair 策略」。
  本方案属于 Executor 既有职责的补齐，不与 ADR-0053 冲突。
- 前序方案：[PDF 处理与执行卡住修复方案](2026-10-06-pdf-processing-and-executor-stall-repair.md)（已实施，但其 §5 只落地
  「观测」，未落地「归因 + 定向中断 + 收敛」）。

## 1. 已验证的事故事实

1. 子任务 `_r1_china-agent-landscape` 的 attempt 从 09:01:48 起运行，`executor_attempt_runtime.updated_at`
   每约 10 秒仍在刷新，但 `progress_json.history` 停在第 20 条、最后一条 `occurredAt=2026-11-02T01:03:41Z`，
   且该 attempt 至今没有 `executor_attempt_receipts` 记录。
2. Executor 进程存活：pid 77689 `pi`，父进程为 MetaWork server pid 2592，cwd 为该 attempt 的会话工作区。
3. 挂起点是 Executor 通过 bash 工具发起的一次网页抓取：
   `python3 links.py "https://cloud.tencent.com/document/product/1759" "计费" | head -30`，
   其中 `links.py` 用 `subprocess.run` 拉起 `Google Chrome --headless=new --dump-dom <url>`。
4. 该进程树自 09:03 起无输出、无退出：`bash(80137) → python3(80139) → Chrome(80149)`，Chrome 挂死 52 分钟以上，
   同一条命令里的第二个 URL（火山引擎）因管道串行尚未开始执行。
5. 界面文案来源：`src/executor/local-cli-executor-adapter.ts:766` 与
   `web/src/components/LiveExecutionPanel.tsx:398`，是看门狗 `OperationActivityMonitor` 的 `checking` / `unknown` 投影。
6. 根因（代码级）：
   - `src/executor/local-cli-executor-adapter.ts:503` 的默认探针只判断 attempt 进程是否存在，
     返回 `unknown: "Process exists; no operation response..."`；`OperationActivityMonitor` 收到 `unknown`
     只更新界面状态，不升级、不终止、不上报。
   - `terminationSource` 预留的 `'idle_watchdog'`（同文件 `:58`）在全仓库从未被赋值，不存在任何自动收敛路径。
   - bash 工具没有默认超时。Pi 的 bash 工具本身支持 `timeout`（秒）且超时时会
     `killProcessTree(child.pid)` 并抛 `timeout:<n>`（系统安装
     `~/.pi/agent/install/releases/1.4.0/.../dist/core/tools/bash.js:50-100`），但模型不传就没有。
   - MetaWork 已经为 attempt 注入了 Pi 扩展（`src/executor/pi-agent.ts` → `dist/pi-attempt-tools.ts`），
     其中 `web_search` / `web_fetch` 自带连接与总时长上限；本次模型绕过它们自造 `links.py` + headless Chrome，
     走到了没有超时约束的路径。

## 2. 范围

### 2.1 本方案要做（L1：Executor 自治）

Executor（含其注入的 Pi 运行时扩展）自行识别"某一次工具调用卡住"，并自行处置，不经过 Kernel，不依赖用户：

1. **判定**：用组合证据判定单次工具调用停滞，而不是用静默时长单独判定。
2. **处置**：只中断这一次工具调用自己的进程树，把失败以工具错误的形式回给模型，让模型自行换路径。
3. **收敛**：同一 attempt 内工具停滞累计超阈值时，终止该 attempt 并如实报失败，由用户重新执行。
4. **可见**：把"是哪个工具、哪条命令、卡了多久、怎么处置的"落成持久事实并呈现在界面上。

### 2.2 本方案不做

- **L2（attempt 级自动恢复）**：不做自动重试、不做换绑定、不做 fallback/continuation 编排。
- **L3（任务级决策）**：不做 replan、不做取消/接管、不做任务状态机调整。
- 不改动 Kernel 的任何职责与代码路径；不新增第二套恢复决策器；不改任务/子任务状态语义。
  按 ADR-0053，Kernel 已是迁移期的 Durable Task Coordinator，本方案不向其增加任何决策职责。
- 不改变「不设任务总时限」的既有语义：任务级时限仍然不存在，本方案只引入**单次工具调用**级别的界限。
- 不废弃也不重构现有 `web_search` / `web_fetch` 能力（见 §8 次要项）。

## 3. 设计决策

### D1 决策归属：L1 归 Executor，不上 Kernel

单次工具调用卡住，是执行器自己发起、自己拥有、自己能观测的局部故障。把它做成"工具错误"回给模型，
不需要任何跨层决策，也不需要新的恢复决策器。模型拿到失败原因后拥有完整上下文，由它决定换路径、
换工具或如实报告缺证——这比上层拍板"取消任务"更贴近事实。

因此本方案**不新增任何决策器**：Executor 只做「观测 → 中断自己发起的调用 → 把结果如实回给模型」，
这是执行语义，不是恢复策略。

### D2 判定用组合证据，不把静默当死亡

沿用 2026-10-06 方案 §5.1 的红线：**沉默不能单独证明进程死亡，静默时长不能单独作为判据**。
判定"工具调用停滞"必须同时满足：

| 信号 | 取值 | 含义 |
| --- | --- | --- |
| 输出活性 | 该调用最后一段 stdout/stderr 之后无新增 | 没有新输出 |
| 计算活性 | 该调用进程树 CPU 时间与 IO 计数无增长 | 没有在算 |
| 产出活性 | attempt 工作区无新写入 | 没有在产出 |

三者同时成立且持续超过窗口，才判为停滞。合法长思考、长时间静默计算、慢速大文件写入都不满足"三者同时无"，不会被误杀。
窗口只约束**异常判定耗时**，不约束任务执行时长。

### D3 处置边界：只中断这一次调用，不终止 attempt

单次工具调用失败在 Pi 语义下是普通工具错误。Executor 不得因为一次停滞就终止 attempt、
不得改任务状态、不得触碰 attempt 之外的任何进程。

### D4 唯一的自动停止条件是三条件组合，不设默认墙钟硬超时

**不向 bash 注入默认 wall-clock timeout。** 墙钟上限与 D2 的组合证据判定互斥：只按时间切断会把
"慢但一直在推进"的合法长命令误杀，这正是 2026-10-06 方案 §5.1 要防的回归。

- 模型**自己显式传了** `timeout` 时，尊重模型的选择（那是模型的有意边界）。
- 模型没传时，**不注入**任何默认值；这次调用能跑多久由"有没有进展"决定，而不是由钟表决定。
- 唯一会自动中断该调用的条件，是 D2 的三条件组合证据持续超过判定窗口。

### D4' 进程组归属：定向中断是确定性的，不需要猜 pid

Pi 的 bash 工具以 `detached: true` 启动 shell（系统安装
`~/.pi/agent/install/releases/1.4.0/.../dist/core/tools/bash.js:57-63`），即**每一次工具调用都是一个独立的进程组组长**，
其后代继承同一 pgid；Pi 自身的 `killProcessTree(child.pid)` 用的就是这一组。

因此 Executor 侧的中断可以是精确的：枚举本次 attempt 的 pi 进程的后代 → 按 pgid 分组 → 定位到当前 in-flight
工具调用对应的那一组 → `kill(-pgid)`。这带来三个性质：

1. 整棵子树（bash → python → Chrome）一次清干净，不留孤儿进程。
2. 不影响同 attempt 的其他进程，也不影响 attempt 主进程本身。
3. 归属判定基于进程组而不是命令文本猜测；只有在无法唯一确定归属时才放弃中断（转 D6）。

### D5 判定与中断的执行位置：Harness 进程内的 guard 扩展

D4 已确立"三条件是唯一停止条件"。执行位置必须选在 **Harness 自己的进程内**，
因为只有那里能同时做到三件事：看到每个工具调用的事件流、拿到该调用的进程组、
把结果改写成工具错误（宿主 Adapter 只能杀掉整个 pi 进程，无法向它的循环里注入工具错误）。

- guard 作为 Pi 扩展注入每个 attempt 的运行目录，注册 `tool_execution_start / update / end`
  与 `tool_result` 钩子。
- 采样周期 15s，对每个 in-flight 调用读取：该调用进程组的累计 CPU 时间（`ps -o time`）、
  已收到的输出字节数、工作区指纹（cwd 目录 mtime + 写捕获 spool 大小）。
- 三信号全不动且持续超过 300s → 按 D4' 的归属中断，并写一条持久事实。
- 中断后的工具结果被改写为显式工具错误（含工具名、命令、停滞时长、"不要重试同一条命令"），
  模型据此换路径。
- 归属无法唯一确定时不猜测性 kill，只报事实；宿主据此立即停止 attempt（D6）。
- 事实通过 attempt 运行目录旁的 JSONL 侧通道交给宿主：宿主轮询后将其投影为持久 progress 事实，
  并据此执行熔断。两侧共用同一窗口与同一通道（`METACLAW_TOOL_STALL_*`），不会各算一套。

### D6 收敛：重复停滞熔断 → 如实报失败 → 用户重新执行

本方案不实现 L2/L3，因此当 Executor 无法在局部自愈时，唯一动作是**停止并如实报失败**：

- 同一 attempt 内工具停滞累计达到阈值（默认 3 次）→ 终止该 attempt，落失败 receipt，
  失败原因携带停滞证据（工具、命令、停滞时长、已中断的进程组、已尝试的次数）。
- 停滞但**无法中断**（归属不明）时立即停止，不再等待：继续等就是今次事故那种无声挂起。
- 失败沿既有 receipt 结算路径落地，界面明确显示「执行失败：工具调用反复停滞，已自动中断；请重新执行」。
- 不做自动重试、不做自动 replan、不做换绑定；用户重新执行即重新生成 attempt。

### D7 可见性：把归因做成事实，而不是一句"无可验证状态"

界面必须能回答"到底卡在哪"：

- 展示当前/最近停滞的工具名、命令摘要、停滞时长、进程树 PID、处置动作与结果。
- 展示"已自动中断该工具调用，模型正在改用其他途径"与"无法自动恢复，任务失败，请重新执行"两种不同结论。
- 停滞事实落库（见 §5），不依赖前端自行推断。

### D8 不越权

Executor 只允许：终止自己 attempt 名下的进程树、把失败回给模型、写自己的运行事实。
不允许：修改 task/subtask 状态、触碰其他 attempt 的进程、扩大工具授权、替用户决定任务去留。

## 4. 参数与默认值

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 工具默认墙钟 timeout | **不注入** | 模型显式传了才生效；系统不替模型设时长上限 |
| 判定窗口（`TOOL_STALL_WINDOW_MS`） | 300s，全局统一 | 三条件同时成立并持续超过该窗口才判停滞；**不按 AgentClass 区分** |
| 采样周期（`TOOL_STALL_SAMPLE_MS`） | 15s | CPU / 工作区采样周期 |
| 熔断阈值（`TOOL_STALL_FUSE_COUNT`） | 3 | 达到后终止 attempt 并报失败 |
| SIGKILL 宽限 | 5s | 先 SIGTERM；仅当记录的成员仍存活才升级 SIGKILL |
| 绝对墙钟上限 | **不提供** | 不实现任何"最多跑 N 小时"的限制 |

判定窗口是一个固定值，不按 AgentClass 区分：即使研究型任务，只要它还在读站点、还在思考、
还在写结论，就有输出/ CPU 活动，不会被误判；连 5 分钟都没有任何信号变化才是真异常。
不提供绝对墙钟上限：没有任何"跑满 N 小时就断"的路径，长任务只受进展判定约束。

## 5. 实现落点

| Seam | 文件 | 改动 |
| --- | --- | --- |
| 停滞判定与熔断（纯逻辑） | `src/executor/tool-stall-core.ts` | 三信号进度合成、停滞判定、事实解析、熔断、失败文案、`ps` CPU 时间解析、`ToolStallGuard`（归属判定 + 定向中断 + SIGKILL 宽限） |
| Pi 运行时扩展 | `src/executor/pi-tool-stall/index.ts`（构建复制为 `dist/pi-tool-stall/index.ts`） | 在 Harness 进程内注册 `tool_execution_start/update/end` 与 `tool_result` 钩子；被中断的调用结果改写为显式工具错误 |
| Harness 驱动 | `src/executor/pi-cli-driver.ts` | 每个 attempt 都装载 guard 扩展；发出 `METACLAW_TOOL_STALL_FACTS / _WINDOW_MS / _SAMPLE_MS` |
| Executor Adapter | `src/executor/local-cli-executor-adapter.ts` | 轮询停滞事实通道；把事实投影为持久 progress 事实；熔断与不可恢复停滞时停止 attempt 并报失败；`diagnostics.toolStalls` 保留全部事实 |
| 构建 | `tsup.config.ts` | `src/executor/tool-stall-core.ts` 作为独立 entry 输出到 `dist/tool-stall-core.js`，供扩展按相对路径导入 |

## 6. 护栏

1. **只杀自己人**：中断目标必须能证明属于本 attempt 的进程树；无法证明时不 kill，转 D6。
2. **不设默认墙钟上限**：系统不得替模型决定"命令最多跑多久"；只有模型自己写的 timeout 才生效。
3. **幂等**：同一工具调用的中断动作重复执行不产生副作用；不重复杀已退出的 pgid。
4. **不误杀长任务**：任何"有输出 / 有 CPU / 有工作区写入"的活动都会刷新计时并取消待判定的停滞。
5. **不静默失败**：中断必须以工具错误形式回到模型上下文，不能只写日志了事。
6. **事实完整**：每一次停滞与每一次中断都要有可审计记录（工具、命令、时长、进程树、结论）。
7. **可测**：所有判定支持注入时钟与注入进程树，测试不依赖真实挂起。

## 7. 验收矩阵

| 场景 | 期望 |
| --- | --- |
| bash 命令挂死且模型未传 timeout | 三条件成立后进程组被清理，模型收到停滞类工具错误并继续 |
| bash 命令运行 40 分钟但持续有输出 | 不被中断（无默认墙钟上限） |
| bash 命令运行 40 分钟但持续占 CPU、无输出 | 不被中断（有计算活性） |
| bash 命令长时间无输出但持续占 CPU（如压缩/编译） | 不被中断 |
| bash 命令无输出、无 CPU、工作区无写入 | 判定停滞，按进程组精确中断该调用，不影响同 attempt 其他进程 |
| 中断后模型改用其他途径 | 同一 attempt 继续，事实里记录"已自动中断并继续" |
| 模型请求挂起（无工具在跑） | 不误判为工具停滞；按 attempt 级无进展既有观测处理，必要时进入 D6 |
| 同一 attempt 内停滞 3 次 | attempt 终止，receipt 为失败且携带停滞证据，界面提示重新执行 |
| 停滞发生在多进程树的深层子进程 | 整棵进程组被清理，无孤儿 Chrome/python 残留 |
| 无法证明进程组归属的停滞 | 不执行 kill，立即停止 attempt 并报失败（不再无限等） |
| 正常长任务总时长超过任何阈值 | 不被终止（不引入任务总时限） |
| 兄弟子任务正常运行 | 不受本 attempt 停滞处置影响 |

## 8. 次要项与后续项（不在本次范围）

1. **能力缺口**：本次模型绕过已有 `web_search` / `web_fetch`（自带连接/总时长上限）自造 `links.py` + headless Chrome，
   说明"稳定网页抓取"的可发现性与提示仍不足。后续可评估：把有界抓取能力在能力投影与提示层做得更显眼，
   并把"无超时地自造抓取脚本"登记为可观测事实。
2. **L2/L3 归属**：attempt 级自动恢复与任务级决策的归属另行立项讨论（当前 Kernel 仍在该位置，
   本方案不触碰）。

## 9. ADR 影响

- 本方案不新增恢复决策器、不改 Kernel 职责，因此不要求新 ADR；它落在 ADR-0053 已确立的
  「Executor/Harness 拥有工具调用级 retry/repair」职责范围内。
- 需要在 [ADR-0024](../../docs/adr/0024-resource-partition-sandbox-and-runtime-elevation.md)（执行后端与运行时权限）
  增补一条：Executor 对**自己发起的单次工具调用**拥有自治的停滞判定与定向中断权，界限是"不终止 attempt 之外的任何东西、
  不改任务状态、不扩大授权"。
- 需要在 [ADR-0028](../../docs/adr/0028-transparent-execution-and-optional-service-specification.md)（透明执行）
  增补：工具调用级停滞必须有可展示的归因（工具、命令、时长、处置），不得只呈现"无可验证状态"。
- 实施完成后按仓库规矩同步 `CONTEXT.md` 与 `docs/current/technical-overview.md`（若涉及运行时契约变化）。

## 10. 风险与回退

| 风险 | 缓解 | 回退 |
| --- | --- | --- |
| 默认 timeout 误杀合法长命令 | 模型显式传 timeout 时以模型为准；默认值偏宽松（900s）；可按 AgentClass 关闭注入 | 配置项一键关闭注入，退回现状 |
| 组合证据误判（静默但正常的等待） | 三信号同时成立才判定；采样可见产出活性 | 调大窗口或提高采样精度 |
| 定向中断杀错进程 | 必须能证明归属本 attempt 的进程树，否则不杀 | 关闭 D5，仅保留 D4 |
| 模型收到超时后重复同一路径 | D6 熔断限制累计次数，最终如实报失败 | 阈值可配置 |

## 11. 待确认项

全部已确认并实施，无遗留待定项：

1. 判定窗口：全局固定 300s，不按 AgentClass 区分。
2. 熔断阈值：3 次。
3. 绝对墙钟上限：不实现。
4. 停滞事实：复用既有 progress 事实与 `diagnostics`，未新增持久字段与 migration。
5. 失败态文案明确提示“请重新执行任务”；界面沿用现有进度区展示，未新增交互。
6. 2026-11-02 那次挂起已在 10:07 由用户取消收敛（子任务转 `cancelled`，挂起进程已退出）。

## 12. 实施与验收记录（2026-11-02）

交付行为：

- Harness 进程内的 guard 对每个 in-flight 工具调用采样“输出 / CPU / 工作区”三信号；
  三者持续 300s 不变才判停滞，任一信号变动即清零重计。
- 停滞时按进程组归属只中断该调用（SIGTERM → 5s 宽限 → 仅当原成员仍活则 SIGKILL），
  并把结果改写为显式工具错误回给模型。
- 同一 attempt 内第 3 次中断时停止 attempt，失败文案含工具、命令、停滞时长与
  “请重新执行任务”；无法证明进程归属时不猜不杀，直接停止并如实报失败。
- 每次停滞/中断都成为持久 progress 事实，界面可见“哪个调用、多久没动、已怎么处置”。

验证：

- `tests/executor/tool-stall.test.ts`（14 项）：三信号判定、`ps` CPU 解析、事实解析、
  熔断、归属歧义不杀、长输出/长 CPU 不误杀、已结束调用不再追踪。
- `tests/executor/pi-tool-stall-guard.test.ts`（4 项）：扩展装配、定向中断与结果改写、
  持续输出不中断、无法归属只报不杀、开关关闭时不动。
- `tests/executor/local-cli-executor-adapter.test.ts` 新增 3 项：熔断停止并报失败、
  不可归属停滞立即停止、单次中断继续执行。
- `tests/executor` 全量 201 项通过；`npx tsc --noEmit` 通过；`npm run build` 产出
  `dist/tool-stall-core.js` 与 `dist/pi-tool-stall/index.ts`。
- 全仓 `npx vitest run` 的失败项与本改动无关（同一批 e2e/web 用例在改动前后同样失败，
  已用 stash 对照确认）。

ADR 同步：[ADR-0024](../adr/0024-resource-partition-sandbox-and-runtime-elevation.md)
增补“Executor 工具调用级停滞自治”，[ADR-0028](../adr/0028-agentclass-model-and-harness-routing-contract.md)
增补“Harness-owned tool-call stall guard”。未改动 Kernel 职责、未新增 schema。
