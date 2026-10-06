# PDF 基础处理、多模态接入与执行卡住修复方案

- Status：Implemented / Native macOS arm64 acceptance passed。按修订方案实施持续无活动检测，无默认固定总执行时限；证据不足时采用 §5.2 的状态待确认与用户控制分支。
- Plan date：2026-10-06。
- 2026-10-06 工具边界修订：Executor 复用系统安装的 Pi；撤回预设新增 `read_document` 及在仓库 Planner 分支自行实现 PDF 工具的方案。
- Implementation / completion date：2026-10-06。Closing commit：随已验收 Desktop 实现提交，具体提交见本文件末尾；用户已授权合并主干并推送 GitHub。
- Authority：遵循 ADR-0020、ADR-0024、ADR-0028、ADR-0033、ADR-0043、ADR-0046。

## 1. 已确认的问题

2026-10-06 的“统计 9 月份收到的发票并分类汇总”任务于 17:50 开始。Executor 已读取 128 封邮件并初步提取附件；128 不是发票数。17:53:10 起没有新的实际进展。

尝试 `sips` 转换 PDF 失败后，Executor 调用了未设置 timeout 的 `qlmanage -t -s 1200 -o . t1.pdf`。实际子进程仍存活，线程采样停在 NSRunLoop / Mach 消息等待，不能据此确定 PDF 损坏或 Quick Look 内部故障的具体原因。

确认存在四个产品缺口：

1. 模型能力过时。DeepSeek 官方 Models & Pricing、Vision 文档已确认 `deepseek-flash` 对应 DeepSeek-V4.1-Flash，支持图片输入；当前目录与本次任务配置未声明 `vision`。
2. 模型能力没有完整传给 Pi。`buildModelsJson()` 未输出 `input`，Pi 自定义模型默认 `['text']`，消息适配会移除图片。仅补目录标签不能修复整条链路。
3. PDF 能力接入尚未闭环。实际 Executor 通过 `/Users/yuanjubian/.pi/agent/bin/pi` 启动系统安装的 Pi 1.0.0，并非直接运行仓库的 Planner 分支。已检查该安装的实际 bundle：内置 read 声明支持文本和图片，未发现 PDF 专用解析分支。这不能证明 Pi 通过技能/扩展/外部工具无法处理 PDF；必须核对真实可用机制和隔离运行时差异。MetaWork 设置独立 HOME、PI_CODING_AGENT_DIR，目前显式准备模型配置和 Web 扩展，不能假设用户级 PDF 扩展/技能自动继承。
4. 超时与展示缺口。bash 默认无超时；宿主 idle watchdog 在 Harness operation 活跃时暂停，没有工具内部活动观测和持续无活动检测。后台定时产生 presentation heartbeat，前端把它显示成持续运行；尚未启动的依赖子任务也显示“Executor 已启动”。

依据（2026-10-06 查询）：

- https://api-docs.deepseek.com/quick_start/pricing
- https://api-docs.deepseek.com/guides/vision
- `src/configuration/model-capability-catalog.ts`
- `src/configuration/agent-runtime-renderer.ts` 的 `buildPlannerModelEntry()`
- `planner/AnyFusion-Pi/packages/coding-agent/src/core/model-registry.ts`
- `planner/AnyFusion-Pi/packages/ai/src/api/transform-messages.ts`
- `planner/AnyFusion-Pi/packages/coding-agent/src/core/tools/read.ts`、`bash.ts`
- `src/executor/local-cli-executor-adapter.ts`、`web/src/components/LiveExecutionPanel.tsx`
- 本地诊断证据 `.tmp/qlmanage-hang-sample.txt` 和本次 attempt 的会话日志。

官方视觉接口说明的是 JPEG/PNG/GIF/WebP 输入，不能把支持视觉等同于当前 Chat Completions 链路支持直接传 PDF。本方案采用本地解析/渲染后输入模型，不依赖原始 PDF 上传接口。

## 2. 交付目标

PDF 是通过实际执行工具提供、安装即具备的基础文档能力。电子文本 PDF、扫描 PDF、图片发票、多页混合 PDF 都有明确处理路径；用户不用安装 Python 包、配置 OCR 或选择权限。默认继续使用 deepseek-flash。

正常文件能读取、提取、分析并产出带来源的结果；异常文件能返回明确失败，持续无活动的操作进入有界检查与恢复。工具异常不能把整个任务无限挂起。模型与工具健康事实如实投影，能力声明不保证每个文件一定识别成功。

## 3. 修复模型视觉链路

- 更新官方 DeepSeek Flash 的已核实视觉事实及官方别名映射，不根据任意第三方端点上的同名字符串推断其实际支持。
- 将活动候选的有效视觉能力生成到 Pi `models.json`：`input: ['text', 'image']`；纯文本模型仍为 `['text']`。所有共享该生成器的调用方保持一致，Planner 的工具权限不因此扩大。
- 已有配置通过“保存并激活”形成新 revision，生成新的运行目录；保留历史 revision 与原任务绑定，不原地修补历史 models.json。
- 验证 tool result 图片经过 Pi 适配后作为合法的 user/image_url 内容送到 DeepSeek。现有适配器已具备该路径，优先修复配置传递，不新增第二套模型调用客户端。
- 用合成图片与合成发票做真实 API 测试，分别验证直接图片输入和“工具返回图片 → 下一轮模型识别”。不以 HTTP 200、模型名称或纯文本回复作为视觉验收。
- 视觉故障报告为具体输入/协议/服务错误；不能静默丢弃图像后声称识别成功。不把内部设置助手 LLM 改作业务文件识别服务，业务模型调用继续走原计费与凭据链路。

## 4. 复用系统 Pi 的 PDF 能力，不新增读取接口

MetaWork 负责正确调用和准备 Pi 的执行环境，不另造 `read_document` 或第二套 PDF 引擎。仓库 `planner/AnyFusion-Pi` 是 Planner 的受控组件，不能把修改其 read 当成对系统 Executor Pi 的修复。

先完成同一安装版本的能力验证：

1. 确认实际 Pi 可执行文件、版本、已加载扩展/技能和 PDF 依赖。区分内置工具直接读取、扩展工具、技能指导现有 bash 调用的处理路径。
2. 使用无敏感数据的文本、扫描和混合页 PDF，在系统 Pi 的正常环境运行，再在 MetaWork 的 attempt 环境运行。核对工具列表、依赖定位、模型图片声明和实际请求，定位能力是在版本、扩展发现、独立 HOME、依赖路径还是模型传递处丢失。
3. 已有能力可用时，沿用 Pi 原有工具名和调用方式，仅在安装/适配层将必要资源与依赖按受支持机制提供给 attempt。不得复制整个用户 HOME、私有凭据或全部未审查扩展；凭据仍由 revision 绑定注入。
4. 现有版本确实缺少可靠 PDF 路径时，先采用经验证的 Pi 版本或其已有 PDF 扩展/技能及依赖，通过安装流程准备并探测。若必须修改 Pi，改动归属 Pi 工具层及其发行流程，不在 MetaWork 新设同义工具。此时记录实际依赖、许可证、平台支持和升级影响后落实，不提前选定 PDF.js/画布库作为 MetaWork 新子系统。
5. 验收工具能提取文本 PDF、读取扫描页图像并送入 DeepSeek-Flash；不因模型支持视觉就声称能直接读取 PDF，也不因为有名为 PDF 的技能就声称依赖齐备。

复用的处理路径应满足：有文本层时提取文字与页码；扫描页及复杂表格由已有渲染路径提供图片供视觉模型识别；中文、混合页、损坏/加密文件有明确结果。临时产物放在 attempt 管理目录，页面与字节批量处理有界，保留来源与未完成范围；不默认设置任务或页面总执行时限。

已有读取接口若只能返回文本，必须验证扫描 PDF 的图像传输路径，而不是悄悄丢弃图像。纯文本模型或依赖缺失时明确报告能力条件不满足。Quick Look 这类依赖桌面服务的临时命令不作为已验证 PDF 基础能力的验收依据。

## 5. 持续无活动检测与恢复（按用户反馈修订）

取消“PDF 单页 30 秒、单批或普通命令 120 秒必须完成”和“普通命令最多 15 分钟”的默认总时限。执行多久与是否卡住分开判断：长任务只要有有效活动就继续运行，不因运行总时长被终止。用户明确指定的截止时间或外部接口的协议限制仍单独遵守，不伪装成无活动检测。

### 5.1 区分活动、存活和展示信号

| 信号 | 含义与处理 |
| --- | --- |
| 实际工作进度 | 页/块完成、处理字节增加、工具阶段推进、模型有效流式内容；更新该操作的最后进展时间 |
| 工具有效心跳 | 必须绑定具体 operation，并反映工作循环响应、内部检查点或可验证的计算/I/O 活动；能证明操作仍在正常执行时刷新活动时间 |
| 命令 stdout/stderr | 正常新增输出可作为活动证据；已识别的固定存活行、重复 keepalive 不能冒充业务进展。不根据文本语义猜测是否完成 |
| 进程存在、CPU/I/O 采样 | 辅助诊断；PID 存在不代表正常，低 CPU 不代表死进程，持续高 CPU 也不能证明有进展 |
| Runtime/界面定时心跳 | 只证明监控链路仍能发事件，不更新工具的最后活动时间，不重置卡住计时 |

分别记录 `lastProgressAt`、`lastActivityAt`、检查响应时间和进程状态，防止“工具已开始但没有结束”永久关闭监控。计时从操作开始或最后一次有效活动开始，后续有效活动刷新计时；各操作独立监控，不能让一个正常工具掩盖另一个卡住的工具。

没有输出不能单独证明进程死亡。静默计算、合法 I/O 等待、模型长思考需要各自可观测的操作状态；普通 shell 无法提供可靠语义进度时，应明确标为“疑似停滞/状态待确认”，不能仅凭静默时长宣称进程已死。

### 5.2 状态与建议初始阈值

- **正常执行**：存在进度或有效活动，允许长时间运行。界面同时保留最后实际进展时间，不能被单纯心跳覆盖。
- **等待活动**：建议连续 60 秒没有有效活动时展示“暂无新进展”，不终止操作。
- **疑似停滞**：建议连续 5 分钟无有效活动时启动主动健康检查；阈值按 PDF、shell、模型请求分别确定，并允许已知合法静默阶段使用专用等待策略。5 分钟是无活动检查阈值，不是任务总时限。
- **检查与收敛**：检查进程是否已退出、工具工作循环是否响应、子进程/请求状态和进展计数。建议检查窗口 30 秒。收到有效工作证据则继续执行；确认退出则回收结果；持续不响应且没有工作证据，报告 `operation_unresponsive` 或 `operation_stalled` 事实并走既有恢复决策。
- **证据不足**：检查器只能确认进程存在而无法确认工作状态时，保留“状态待确认”并给出诊断及用户控制入口；不虚构死亡。是否取消/重试由 Kernel 的明确停滞策略或用户指令决定，不能由 UI 或 Runtime 凭计时自行改变 Task 状态。

工具的独立定时器仍能跳动，不足以证明其阻塞子调用健康。Pi 的 PDF 操作应从实际解析/渲染路径发进度；支持心跳的工作循环也须携带检查点。不可中断的底层调用无检查响应时，按上述异常路径处理。模型供应方的连接 keepalive 与输出 token 分开记录，不能让空 keepalive 无限掩盖无结果状态。

### 5.3 分层落地

1. **Pi PDF 操作**：复用实际工具/扩展的进度、取消和子进程生命周期机制，按文件、页和阶段报告实际活动，保留已完成页。需要补充观测时在 Pi 工具/适配协议处补齐，不另造解析工具。无固定单页/单批 deadline。
2. **bash 与 Harness**：普通命令无默认总时限；工具 operation 活跃期间继续观测，而不是暂停所有 watchdog。显式调用 timeout 仅用于调用者明确要求的有界操作，不能作为所有命令的默认值。监控识别静默、检查响应及子进程状态。
3. **恢复与清理**：适配器提供规范化事实，Kernel 决定 attempt 级取消/重试/replan；Runtime 按 Decision 终止相关进程组并等待退出，清理宽限到期才升级强制终止。检查窗口和清理宽限限制的是异常处理耗时，不是正常任务执行时长。

可在工具内报告的文件解析错误仍返回当前受控会话，允许模型使用已有替代工具。运行时监控不能新增业务恢复决策器。持久记录停滞证据、最后有效活动、检查结果和清理结果，区分主动取消、无活动异常与进程实际退出。

## 6. 进度和发票结果质量

- 按真实操作显示“提取第 2/8 页”“识别第 3 份附件”等事实；文档总数未确认时不显示虚构百分比。
- 心跳只说明“执行进程尚未结束”，同时显示距离最后实际进展的时间。持续无有效活动时依次提示等待、疑似停滞、状态检查和实际恢复结果；普通无输出不能直接被 UI 判为失败。
- 依赖尚未满足的子任务显示“等待发票清单”，没有 attempt 就不显示“Executor 已启动”。中英文展示遵循已有本地化方案。
- 发票任务优先读取邮件已有的 XML 等结构化数据，再读取 PDF/图片；同一发票的 PDF/XML/OFD 多种格式去重，不把附件数当发票数。OFD 不伪装成 PDF 支持。
- 清单保存发票号、日期、开票方、金额、分类和邮件/附件/页码出处；金额按分或十进制定点计算。无法确认、重复、缺失字段、不同币种与冲红分别列出，不猜测数值填平总额。结果区分已确认金额与待核验项。

## 7. 模块归属与迁移

| Owner | 变更 |
| --- | --- |
| Configuration | 更新可核实模型事实、传递 input 模态、通过唯一激活生成新 revision |
| 系统 Pi / Executor Adapter | 复用已有 PDF 工具/技能，准备必要依赖和隔离环境，传递文本/图片结果与活动事实；不以仓库 Planner 分支替代系统 Pi |
| Executor/Runtime | 子进程和活动事实、持续无活动监控、失败规范化、可恢复产物与日志 |
| Resource / Kernel | 保留资源授权和唯一恢复决策，不从文档内容生成授权 |
| Routing | 投影真实已安装文档工具与视觉条件，不把业务职责变成硬能力 |
| Installation/Desktop packaging | 核实并准备实际 Pi 版本及 PDF 必需资源/依赖、启动前 readiness；不要求用户自行补齐，不新增 MetaWork PDF 引擎 |
| Web/Gateway | 基于实际 attempt/操作状态展示，心跳不等于业务进度，不直接写任务状态 |

不规划数据库 schema 变化；操作事实优先使用现有有界进度/trace 契约。若实施确需新增持久字段，先补对应 ADR、Repository/migration 和恢复验收。任何新增活动/停滞检测与恢复合同应同步 ADR-0024/0028 与当前技术文档，不静默改动历史授权含义。

## 8. 当前挂起任务的恢复顺序（实施时）

保留原 attempt、邮件来源、附件及日志，先核实文件仍可访问；本次检查已发现原 `/tmp/mailsept/t1.pdf` 路径不可访问，不能承诺临时文件完整。需要重新读取时按原授权范围幂等读取，避免重发邮件或产生外部写入。

优先通过既有操作取消/任务控制接口收敛挂起进程，核验命令子进程全部退出。不修改 SQLite 伪造完成，也不单纯清空运行状态。修复 Pi 能力接入后，通过“保存并激活”产生视觉配置新 revision；采用现有 Kernel/Planner 的受控重新规划或重建 generation 路径使用新绑定，不能让旧固定 revision 的 attempt 偷换配置。复用已验证输入，最终确认清单、分类报告和真实结束状态。

## 9. 实施顺序与验收

1. 补模型能力传递与图片协议回归，真实 DeepSeek 合成图片识别通过。
2. 同一系统 Pi 在正常环境与 attempt 环境对照验收，修复版本/技能/扩展/依赖接入；复用现有读取方式，文本、中文、表格、扫描、多页混合、加密/损坏文件及分页/体积限额通过。
3. 完成持续无活动检测、主动检查和进程树清理；验证长于 120 秒/15 分钟但有真实进度或有效心跳的操作不被中止；验证真实活动重置计时、界面心跳不重置计时、合法静默不被断言死亡、单个工具活动不掩盖另一个挂起工具。注入工作循环无响应、重复 keepalive、模型请求挂起、进程退出和取消竞争，验证检查及 Kernel 恢复路径。
4. 修复状态显示；以 fake clock 验证正常/等待/疑似停滞/检查/恢复和依赖未启动的区别。
5. 完整安装流程准备好系统 Pi 及其必要依赖，在用户无需手工补装 PDF 工具的原生环境，跑真实“合成 PDF → 工具 → DeepSeek → 结构化清单 → 报告”业务链路，检查图像确实发送、账单与来源完整。使用已有已授权真实发票任务最终验收，不把宿主命令 smoke 当业务链路成功。

通过标准：不会再调用 Quick Look 作为默认 PDF 通路；扫描发票图像真实到达模型；能得到可追溯的去重清单与分类统计；无活动操作触发检查，确认异常后在有界恢复流程中收敛，正常长任务持续执行，其他任务不被阻塞；界面不再把心跳或待依赖子任务显示为实际工作。当前 Desktop 原生链路为首要验收，可选 Docker 兼容性单独记录，不要求用户安装 Docker。

## 9. 实施交付记录（2026-10-06）

### 9.1 交付行为与边界

- Configuration 在新安装/激活候选中补齐官方 DeepSeek Flash 的 vision；第三方同名端点不自动推断。共享 Pi models.json 显式输出 input。Electron 中通过唯一“保存并激活”生成新 revision，旧 revision 保留。
- 同一系统 Pi 1.0.0 的正常环境未发现 PDF 扩展，隔离 attempt 原来也没有该能力。选择已发布的 MIT `@joemccann/pi-pdf@1.0.1` 读取子集，保留四个 pdf_* 工具名；来源、修改与许可证见 `integrations/pi-pdf/UPSTREAM.md`。未新增 read_document，未修改 vendored Planner 工具。
- 安装构建准备 checksum 固定的 CPython 3.12.12（python-build-standalone 20251014）及固定版本 pypdf/pdfplumber/PDFium/Pillow。解释器与包随 release 交付，不要求用户装 Python/Xcode/Poppler，不在任务中 pip install。Pi attempt 仅注入明确的扩展 loader，不复制全局扩展与凭据。
- PDF 输入 50 MiB、单批 5 页、输出捕获 2 MiB、图像最长边 2048px。文本优先提取，扫描页通过 pdf_to_images → read → DeepSeek；渲染 manifest 保存源 SHA、完成页及剩余页。损坏、加密、错误页码、越界输出返回明确错误。没有页面/批次总时限。
- OperationActivityMonitor 逐操作计时，开始工具不再暂停监控；有效模型增量/页检查点刷新活动，重复 checkpoint 与展示心跳不刷新。默认 60 秒等待、300 秒启动检查、30 秒限制检查窗口。fake clock 的 40 分钟持续进度不被中止。
- 原生 generic shell/Pi 检查器能确认 PID 是否消失，不能仅凭 PID 存在证明工作循环健康，故此情形报告 unknown 并保留等待/取消。未新增自动停滞重试政策，没有宣称静默即可确认死亡。退出事实进入既有终态回收；用户取消走 Kernel fence。检查、活动与清理事实进入现有 trace/receipt，不直接修改数据库状态。
- 不同工具的健康事实分别保留，一个工具恢复/推进不能清掉另一个工具的待确认状态。UI 的实际进展与活动时间独立于展示心跳；没有 attempt 时显示等待前置结果，有依赖标题时展示标题。终态清除旧健康提示。
- PDF worker 继承 Pi attempt 进程组；AbortSignal 有 5 秒清理宽限。取消时即使 Pi 先退出，也保留清理等待与容量，直到进程组退出；忽略 SIGTERM 的 worker 会被升级 SIGKILL。宽限只约束异常清理，不限制正常工作。

### 9.2 验收结果

- `npm run lint`、Runtime/Planner/Web/Desktop 构建通过。相关 Configuration、Executor、Attempt、安装更新及 Web 回归：**73 个文件、539 项测试通过**，日志 `.tmp/pdf-final-regression.log`。
- 真实进程测试验证 PDF worker 忽略 SIGTERM、父进程先退出时仍被回收。监控测试覆盖独立工具、重复检查点、长任务、无响应检查窗口、退出/不响应事实、迟到响应与清理。
- 系统 Pi 实际加载验证文本、中文扫描、混合页、表格、加密/损坏、页码/批量/50 MiB 上限及输出边界。复现脚本：`scripts/generate-pi-pdf-fixtures.py`、`scripts/check-pi-pdf.mjs`；后者通过 METAWORK_PI_PACKAGE_ROOT 指向系统安装包，不能指向 Planner。
- 直接合成图片 API 识别核对票号、日期、金额；Pi 工具链另通过转发计数证明 image_url 到达官方 DeepSeek，而非仅检查 HTTP 200。文本票 72.35 + 扫描票 128.60 = **200.95 CNY**。证据：`.tmp/pdf-acceptance/direct-vision-evidence.json`、`pi-live-evidence.json`。可复现 API smoke：`npm run smoke:pi-pdf`，DEEPSEEK_API_KEY 仅通过环境传入。
- 合成资料另外通过正式 Gateway → Planner → Kernel → 系统 Pi → 产物发布跑完整业务 Task，生成 invoices.json/report.md，逐字段和整数分合计一致，有实际 token 计量。Task `task_plan_event_proposal_f405105191718a64f7081e9189cc4e9fd8f676b33dd5210263b42a4f05a8866f` 已 done；证据 `.tmp/pdf-acceptance/business-chain-evidence.json`。
- 原卡住任务经正式取消结束，原 Pi/bash/qlmanage/tail 四个 PID 均退出；在新 revision 下重新执行原已授权任务。新 Task `task_plan_event_proposal_9c853c2a85c13357465bf0800c21863de5b212e15565bd5ccd576abf0d33a098` 的两个子任务已发布、Task done、无执行资源残留。
- 真实结果：**128 封邮件、去重后 16 张发票、价税合计 14,612.84 CNY**。独立复核票号唯一、逐条来源/日期/币种、整数分合计；PDF/XML/OFD 多格式及重复邮件未重复计数。字段不全、非发票材料与未解析范围单列，OFD 未冒充 PDF 能力。证据 `.tmp/pdf-acceptance/real-task-evidence.json`。
- Electron production-assets 实机 smoke 通过：原生身份 MetaWork、认证、页面、缩放/窗口、Renderer 恢复、重连和退出后 Server 存活。真实发票报告在 Electron 中可见。账单本地 finalized、coverage complete；外部消费提交未启用，不宣称外部扣费完成。证据 `.tmp/desktop-development/evidence/pdf-final-task-desktop.png`、`pdf-final-billing.json`、`electron-smoke.json`。

### 9.3 验收范围与记录

本次完成当前原生 macOS arm64 Desktop 链路，未将可选 Docker、Intel/Linux
平台或签名发布测试算作已通过。其他 Python 平台资产已固定哈希，仍需各自
发行验收；这不要求当前用户安装 Docker。

一次合成 fixture 最初放在开发仓库内部，触发 Workspace 导入将安装目录递归
纳入自身，返回 ENAMETOOLONG（PDF 工具尚未启动）。该测试 Task 已经由正式
Kernel 取消，其专属临时 worktree 已清理；随后使用仓库外独立临时 Workspace
完整通过合成验收。该 Workspace 导入边界问题另行跟踪，不将失败误报为 PDF
解析错误，也不以宿主命令替代后续业务链验收。
