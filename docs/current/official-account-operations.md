# 官方账号授权运行与验收

- 日期：2026-10-09
- 状态：主体集成及 2026-10-10 内置 AI 简化已部署；三个真实 AI 接口通过。完整长任务和多端执行验收仍待完成。
- 架构权威：[ADR-0047](../adr/0047-account-license-and-official-ai.md)。

## 部署

2026-10-10 已按用户更正迁移至 `/root/metawork-offical-server/`，原错误目录已移除。停服后整体移动目录，更新 systemd 的工作目录、启动命令、可写目录及 `.env` 数据库路径；数据库文件摘要一致且 SQLite 完整性检查通过，凭据和权限保留。服务已恢复并保持开机启动，公网健康/套餐接口分别返回 200，未登录权益返回 401，管理入口返回 404。访问地址和客户端配置无需更改；此次迁移未提交或推送 GitHub。

官方服务：`huoshan:/root/metawork-offical-server/`，systemd `metawork-official.service`，SQLite 位于 `data/official.sqlite`。HTTPS：`https://14.103.216.193:9222/`。应用服务仅监听 127.0.0.1:8780；nginx 在公网 9222 提供独立 HTTPS 入口，复用现有受信任证书。代理配置位于 `/etc/nginx/sites-available/metawork-official`，源码副本为 `official-server/deploy/nginx.conf`。原 443 `/metawork-official/` 入口暂保留。

```sh
ssh huoshan
cd /root/metawork-offical-server
systemctl status metawork-official --no-pager
curl -fsS http://127.0.0.1:8780/healthz
npm test
```

`.env` 权限 600，管理密钥已随机生成，不下发本地安装。只在服务器配置 `MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_ID`；2026-10-10 用户已补齐三个字段并重启加载。配置只在进程启动时读取，后续修改后须执行 `systemctl restart metawork-official`，再在有效权益下验收三个业务操作。不得把本机用户 Key 自动上传来填充空缺。

内部永久权益在用户完成注册后，通过 SSH 下的 `node admin.js grant-perpetual <email>` 签发。撤销用 `node admin.js revoke <email>`；禁用登录用 `disable`。公开套餐无永久选项，公网 `/v1/admin` 返回 404。管理脚本不将密钥输出或放入 argv。

更新时保留 `.env`、`data/`，只替换源文件与 lockfile，执行 `npm ci --omit=dev --ignore-scripts`，测试后重启。备份必须使用 SQLite backup API 或停服务后复制整个数据库；不能在写入时只复制主文件而忽略 WAL。当前部署备份目录只包含部署前程序/代理配置，不能当作数据库备份。

## 本机安装及升级

2026-10-10 本地试用 DMG 已完成，未发版、未提交或推送 GitHub：

- 平台：macOS Apple Silicon（arm64）；Desktop 0.1.9，试用编号 `0.1.9-internal-local20261010a`。
- 文件：`apps/desktop/release/official-account-20261010/MetaWork-darwin-arm64.dmg`，466345386 字节。
- SHA-256：`2629390d69bb3ba60ac16eaeaf04b9d120e1de9402fdb9f8b94d638562b4e717`。
- 来源：基线 `aaf15ef6bf1c135ddb3645eb1c4b539a83dd6586` 加当前未提交实现；同目录 `build-provenance.json` 记录文件摘要，`.tmp/official-account-dmg-20261010/` 保留源码快照、构建日志及验收脚本。
- 验证：Runtime/Web/Planner/Desktop 构建、Desktop 类型检查和 16 项测试通过；最终包的隔离首次安装、真实 9222 套餐查询、官方账号窗口、无模型设置保存、首次模型激活、菜单连接状态与桌面退出后 Server 存活通过。菜单验收等待首次 Pi 检查完成后再操作，避免启动期间重连请求被合并造成时序误判。
- 升级：隔离的 0.1.8 安装经 Finder 升级成功，保留原配置和数据库记录，连续两次重开正常且复用后台；未替换用户当前应用或数据。证据位于产物目录 `evidence/`。
- DMG 只读挂载后已核对应用、签名封印及完整 payload 清单；采用内部 ad-hoc 签名，未作 Apple 公证。首次打开可能需右键“打开”。
- 打包时限制：当时官方模型配置为空；2026-10-10 后续已配置并重启加载，客户端无需重新打包。真实支付和完整生产任务授权失效验收仍待完成。

以下三节保留当时排障过程；其中额度、推理覆盖及重复输出校验已被后续“内置 AI 简化”取代。

### 2026-10-10 内置 AI 配置加载排障

- 现象：客户端显示能力描述整理失败 HTTP 500；nginx 记录北京时间 09:04:45 和 09:04:59 两次 `POST /v1/ai/operation` 返回 503，确认请求已到官方服务。
- 原因：服务器 `.env` 在 08:21:21 更新，但服务仍是 08:14:57 启动的进程。`loadEnv()` 仅启动时执行，旧进程仍使用空模型配置；本地管理 API 将官方不可用异常映射成 500。
- 处理：09:06:42 重启 `metawork-official.service` 加载用户填写的配置，服务和健康检查正常；未修改账号或权益。
- 验证：在官方服务器使用已配置模型及正式 `capability_explanation` 提示词，以合成公开资料作一次真实上游请求；HTTP 200，约 5.9 秒，`finish_reason=stop`，通过正式业务输出 schema 校验。此检查覆盖上游连接及能力说明输出，不等同于三个业务完整登录态端到端验收。
- 后续：现有 DMG 可直接重试，不需要重新打包；未提交或推送 GitHub。

### 2026-10-10 内置 AI 响应误拦截及结构修复

- 09:08:17 的用量记录对应 `model_summary`，09:08:28 nginx 返回 503，说明重启后已进入上游调用。此前失败日志缺少细分原因，无法还原该次响应正文；用同一模型和固定业务提示词复现了下述两类问题。
- 模型资料提炼返回 HTTP 200 和合格 JSON，但文本提及被介绍的公开模型；它恰好与官方上游模型名称相同，被原先无条件的模型名检查误拒绝。现在仅对 `model_summary` 中调用者提交的同名公开模型（含供应商前缀）允许这种描述；密钥、其他未提交的内部模型名及原始上游元数据仍不返回。
- 完整 HTTPS 验证进一步发现 `capability_explanation` 偶发将 `boundaries` 生成为对象数组。提示词已明确它只能是中文字符串数组，并增加完整字段结构示例；没有放松业务 schema。
- `official_ai_failed` 增加失败阶段、HTTP 状态、耗时及脱敏校验路径。仅记录有界元数据，不记录输入/输出、模型配置、Key、会话或原始 Provider 错误。
- 完成：修复已部署 `/root/metawork-offical-server/` 并重启。本地和 huoshan 的 10 项集成测试通过。最终以临时诊断账号经真实公网 HTTPS 注册、登录、激活试用后，`model_summary`、`responsibility_rewrite` 各一次、`capability_explanation` 连续三次均返回 200 并通过正式输出 schema；耗时约 4.6–8.3 秒。临时账号及关联记录已清除，未更改用户账号权益。
- 证据：`.tmp/official-ai-live-20261010.mjs` 和 `.tmp/official-ai-live-20261010.log`。这些是合成业务输入的完整服务端调用，不宣称已自动重放用户原始资料。客户端无需重新打包；未提交或推送 GitHub。

### 2026-10-10 用户指定模型的输出预算修复

- 09:18:42 的用户请求命中新服务，日志为 `model_summary / completion_incomplete / upstreamStatus=200`，不是客户端缓存或未更新。
- 用户确认目标为 DeepSeek V4.1 Flash。使用产品同一 `parseOpenRouterCatalog` 转换其公开资料（`deepseek/deepseek-v4.1-flash`）并按真实 `ModelRoutingProfileService` 字段构造请求，复现默认推理模式返回 `finish_reason=length`、正文长度 0；上游报告 2049 个输出 token 全部为推理 token。此前简短合成输入未覆盖该情况。
- 同一资料显式 `thinking.type=disabled` 后返回 `stop` 和合格 JSON，约 3.5 秒；输出 636 token。官方服务新增可选 `MODEL_THINKING` 配置并校验枚举，huoshan 配置为 `disabled`，保持原 2048 输出上限和严格校验。未支持该参数的供应商可留空。
- 完成：服务已部署并重启，本地及 huoshan 各 10 项集成测试通过，覆盖参数传递、截断结果拒绝及安全结束原因日志。最终经公网 HTTPS、真实登录和试用权益，用户指定公开资料的 `model_summary` 连续三次返回 200（约 3.2–3.6 秒），同资料的能力说明、职责改写也均通过；临时账号及数据已清除。
- 证据：`.tmp/official-ai-v41-input.json`、`.tmp/official-ai-v41-live.mjs`、`.tmp/official-ai-v41-live.log`。客户端不需要重启、重新登录或重新打包；需重新触发获取操作以替换界面旧错误。未提交或推送 GitHub。

### 2026-10-10 内置 AI 简化（当前行为）

- 用户确认取消额外 AI 业务限制。已删除 token/温度/推理覆盖、30 秒业务超时、专用请求/响应大小和字数上限、服务端输入/输出 schema、名称/内容过滤、finish_reason 拒绝、请求去重、AI 并发/频率/每日额度。`MODEL_THINKING`、`AI_DAILY_GLOBAL_LIMIT` 已从服务配置移除，Zod 依赖也已删除。
- 官方服务保留固定业务 operation、账号/权益检查、JSON 解析和上游连接错误处理。生成使用供应商默认值，结果字段由本地设置消费者校验。登录/订单/管理端点的认证和校验继续有效；使用记录只用于审计，服务端每次生成独立标识，不阻断重复请求。
- nginx 的 AI 路由已取消请求体上限，代理使用 300 秒常规网络读超时；客户端仍使用其已有网络超时（当前 DMG 为 45 秒），本次没有修改客户端安装。
- 完成日期：2026-10-10。本地与 huoshan 的 9 项集成测试通过，覆盖历史用量超过旧额度、相同请求连续 125 次成功、5 个并发请求、较大资料/结果传输、固定提示词以及退出期间的权益边界。本机未安装 Docker，本次未重复 Docker 验证；原 Dockerfile 继续运行同一更新后的测试集。
- 已部署至 `/root/metawork-offical-server/`，服务健康且 nginx 配置检查通过。按用户指定 DeepSeek V4.1 Flash 的真实公开资料，经公网 HTTPS、登录和试用权益，模型资料提炼连续三次均为 200（约 7.6–11.2 秒），能力说明和职责改写也为 200；结果包含消费者使用所需字段。临时诊断账号及关联记录已清除。
- 证据：`.tmp/official-ai-simplification/live.mjs`、`live.log`、部署包及 huoshan 的 `backup-simplification-*` 回滚目录。ADR-0047、CONTEXT、技术概览和原设计同步修订；未提交、未推送、未发布，现有 DMG 可继续使用。

正式 Server 默认使用上述 HTTPS 地址；受信任部署可用 `METAWORK_OFFICIAL_SERVER_URL` 替换，但客户端强制 HTTPS、禁止携带 URL 凭证和跟随重定向。不要配置任意第三方地址，它将成为账号凭证接收方。

干净 native CLI 在未提供 Provider URL/Key 时直接安装模型空白配置，可进入本地登录、官方账号与设置页面；后续配置用户自己的 Planner/Executor。已明确填写一部分 Provider 环境变量但不完整的无人值守安装仍报错，不静默丢弃用户配置。Desktop 继续使用既有无模型安装路径。

升级不会恢复官方登录，也不会授予永久权益。历史数据保持在本机，本地 Web 登录及 Desktop 票据保护不变。官方账号会话、权益缓存不持久化，客户端关闭不等于退出 Server；点击“退出账号”关闭所有同 Server 接入端的新生产性准入。

旧 `internal/llm.json`、`internal/llm-credentials.json` 已停用于正式 Server 装配。为保留回退/研发信息，升级不自动删除或上传；维护人员确认无需旧版本后，可仅备份并移走这两个文件。**不得删除根 `credentials.json`、账号 Provider 凭据、Planner/Executor 登录或 routing/span 凭据。** `scripts/configure-internal-llm.mjs` 和 Desktop `prepare-development.ts` 为显式研发工具，不能用于普通发行安装或官方授权失败回退。

## 运行行为

Web/Desktop 顶部“登录 / 注册”或“账号与订阅”进入账号窗口。注册后选择七天试用，已订阅者刷新权益。月/年订单经 OPC Hub（微信 Native 扫码）真实支付：Web 弹窗展示二维码并轮询，官方服务接收网关 `PAYMENT.PAID` 回调（HMAC 验签）后事务结算并顺延/起算权益，重复回调不重复加时长；退款通道本期仅管理员/客服发起（`node admin.js refund ...`，全额退、恢复购买前权益），Web 无退款入口，无法结算的资金一律落 `payment_incidents` 台账（`node admin.js incidents`）人工对账。K8s 部署配置 `PAYMENT_HUB_BASE_URL=https://opchub-openapi.metafusion.cn`（生产网关；`https://opc-openapi.dev.metafusion.cc` 为测试网关，仅联调）、`PAYMENT_HUB_CLIENT_ID` / `PAYMENT_HUB_CLIENT_SECRET`（**生产凭证部署时经 K8s Secret 注入，不入库不进聊天**）与 `PAYMENT_NOTIFY_URL`——回调必须是**域名**（真实 Hub 以 `OPC_PARAM_INVALID` 拒绝 IP 字面量），路径 `/v1/payments/notify`；未配置时支付关闭、行为与未接入一致（ADR-0048）。全链路真实冒烟：`official-server/test/real-hub-smoke.mjs`（凭证走环境变量，13 步含真实下单/二维码/关单与本地服务端到端）。

生产性请求经 Gateway 在线核验，已有链内部使用当前事实；本地 UI 每五秒只读一次本机投影，不额外请求官方核验。TUI/飞书的生产性拒绝消息引导到 Web/Desktop，取消/历史访问不要求商业权益。已知到期立即阻断，后台核验只在活动工作达到 24 小时基准时发起一次；退款成功后的权益降级时序与到期/撤销一致（新请求即时阻断，24 小时仅影响已开跑工作）。

失去授权后，既有尝试可以受控完成并落盘，Kernel 阻断后续派发、重试、重规划。持久化应用与排队尝试暂缓恢复；重新登录/核验后通过既有恢复机制继续。当前进程更换账号必须先用旧账号完成或取消未结束任务。账号不构成本地数据隔离或跨机器同步承诺。

## 隐私及资源限制

内置 AI 上传当前编辑文本和必要模型公开资料，不上传整个 Workspace、对话历史或 Provider Key。官方密码以 scrypt 保存，随机会话仅存摘要；账号、订单及权益为持久事实。AI 用量仅记录账号/业务类型/请求标识/时间，30 天后清理，不记录正文。官方模型供应商保留政策需在配置供应商后确认并补充。

请求/响应、频率、并发和每日预算详见 [official-server README](../../official-server/README.md)。2026-10-10 根据用户要求移除 AI 专用额度、并发/频率、大小/字数、生成参数和重复内容/schema 检查；固定 operation 及账号/权益判断继续有效。旧的排障记录描述的是当时的版本，当前行为以本文“内置 AI 简化”及 README 为准。

## 已取得的验证证据

- macOS Node 22.23.3：TypeScript 检查及产品/Web 构建通过。
- 全量回归：536 个文件通过、12 个跳过；3485 项通过、22 项跳过。随后最终 Gateway 输入标签绕过修复及授权/Replan 针对性 54 项通过。覆盖旧响应隔离、单飞、24 小时周期、失败不快速重试、时钟/到期、排队派发与持久化恢复阻断。
- Management、native 安装及相关回归 89 项通过，覆盖本地认证/Origin/官方 token 不外泄和无模型安装。
- 官方服务 8 项集成测试（历史基线）在 macOS、huoshan Node 22.19.0 及 Docker Node 22.19.0 均通过，使用临时 SQLite 和上游桩；覆盖事务试用、幂等隔离、待支付无权益、AI 边界、并发/退出、管理签发与撤销。2026-10-14 支付/退款通道接入后扩至 22/22（9 项既有回归 + 13 项支付/退款桩测，含已结算行外部退款观测与丢 notify 重复支付笔退款），另有真实网关 smoke 13/13（见 [支付接入计划](../plans/2026-10-14-official-account-payment-integration.md)）。
- 真实 HTTPS `https://14.103.216.193:9222/healthz` 返回 200，无跳过 TLS 校验；套餐接口返回服务端价格，未登录权益接口返回 401，公网管理路径返回 404。nginx 与官方服务均为 active/enabled。
- 隔离本机安装 `/tmp/metawork-official-acceptance` 无 internal 凭据，能启动 Web 登录/设置。Chrome 已通过真实 HTTPS 下的注册、登录、七天试用、待支付订单、退出、重新登录及 1440/390 宽度交互；Server 重启后投影为 logged_out。测试账号已删除。

未完成证据：用户真实资料的客户端操作复核、真实 Planner/Executor 授权失效期间的长任务联调、完整 TUI/飞书联调。三个官方 AI 操作已取得上述真实 HTTPS 证据，Desktop 安装与升级已验收；不能以这些检查替代剩余完整执行验收。代码未创建 Git 提交或推送，等待用户验证。

## huoshan 上的 MetaWork Runtime（2026-11-06）

huoshan 上除官方账号服务外，另外部署了一份 MetaWork Runtime（Server + Planner + Memory），
与 `metawork-official.service` 相互独立：两者进程、端口、数据库与密钥互不影响。

- 机器：Ubuntu 24.04 LTS（`x86_64`），系统 Node `v22.19.0`（`/usr/bin/node`），无内置 Node。
- 版本：**v0.1.26**，releaseId `0.1.26-build-1121581`，安装根 `/root/.metawork`，
  `app/current -> releases/0.1.26-build-1121581`。
- 产物来源：GitHub Release `v0.1.26` 的 `linux-x64` 归档
  （`metawork-` / `planner-` / `memory-0.1.26-build-1121581-linux-x64.tar.gz`）与
  `manifest.linux-x64.json`。
- 传输路径：GitHub → huoshan 直连在该网络下只有约 28 KB/s，`install.sh` 下载 122 MB
  Runtime 归档超时中断（并在 ssh 断链时被 SIGPIPE 终止）；改为在本机从 GitHub Release
  取同一批产物，先按 `metawork-release-2026-03` 校验清单签名、再逐个校验 sha256 与字节数，
  然后分包传输到服务器，在服务器上重新执行同一套清单签名 + 产物校验后才解包安装。
  校验强度与 `install.sh` 等价，差别仅是下载链路。
- 服务：systemd `metawork-server.service`（已 enabled + active）。
  **必须通过托管启动器启动**：`ExecStart=/root/.local/bin/metawork server start`。
  该启动器导出 `METACLAW_PLANNER_COMMAND`、`METACLAW_PLANNER_SCHEMA_PATH`、
  `ANYFUSION_PI_SOURCE_ROOT`、`METACLAW_PI_ATTEMPT_EXTENSION`、`METACLAW_EXECUTOR_BACKEND` 等
  运行期路径。直接 `node <installRoot>/app/current/dist/index.js server start` 会绕过它们：
  `PlannerProcessSupervisor.resolveCommand()` 的 vendored 探测只匹配源码树
  `planner/AnyFusion-Pi/...`，安装布局是 `planner/packages/...`，于是回退到 PATH 里的
  `anyfusion-planner` 并失败。**症状**（2026-11-06 实测）：用户提问后 0.5 秒内 turn
  `status=failed`、无答案、`usage_observations=0`，界面上只看到账单卡片
  「本次账单 待确认 / 费用 暂无法计算 / Provider 未返回可验证的用量数据 no_usage_observed」，
  真实原因藏在轨迹事件 `proposal_transport_uncertain`：
  `Planner unavailable: spawn anyfusion-planner ENOENT`。

### 外网访问 MetaWork Runtime（2026-11-06）

Runtime 自身按设计只监听 `127.0.0.1:8788`（`ManagementServer` 硬编码 loopback），Web 端
`GET /api/auth/session` 会对任何可达客户端直接建立传输会话（loopback 就是它的信任边界），
因此**不能**直接把 8788 暴露到公网。外网访问采用两种方式：

1. **SSH 隧道（推荐，零暴露）**

   ```sh
   ssh -N -L 8788:127.0.0.1:8788 huoshan
   ```

   本机浏览器打开 `http://127.0.0.1:8788`。WebSocket 的 Origin 校验要求 loopback + 监听端口
   匹配，隧道下天然满足，无需任何改写。

2. **nginx 反代（当前启用的外网入口，不做 HTTP 认证）**

   `/etc/nginx/sites-available/metawork-runtime`（仓库副本 `official-server/deploy/nginx-metawork-runtime.conf`）
   **由 nginx 独占公网 `8788`** 并终止 TLS（复用 `14.103.216.193` 证书）；
   Runtime 自身改用 `METAWORK_WEB_PORT=18788` 只监听 `127.0.0.1:18788`，因此无法被直接访问：

   - systemd `metawork-server.service` 内 `Environment=METAWORK_WEB_PORT=18788`；
     `server-endpoint.json` 的 `webOrigin` 随之变为 `http://127.0.0.1:18788`；
   - 后端 leg 必须把 `Host` 与 `Origin` 改写成 `127.0.0.1:18788`：Runtime 的 WebSocket 与若干
     API 只接受「loopback + 自身监听端口」的 Origin，否则返回 403 `forbidden_origin`；
   - `Upgrade`/`Connection` 通过 `/etc/nginx/conf.d/metawork-websocket.conf` 的 `map` 透传，
     `proxy_read_timeout 3600s` 保证长连接不被切断。

   外网实测（公网 IP 发起）：`/` 返回 `200` 且不再出现 `WWW-Authenticate` 挑战、
   `/api/auth/session` `200` 并下发 `anyfusion_web_session` Cookie、`/assets/index-*.js` `200`、
   `/ws`（`Origin: https://14.103.216.193:8788`）返回 `101 Switching Protocols`。
   入口为 `https://14.103.216.193:8788/`。

   **安全边界（已知取舍，2026-11-06 按用户要求移除 Basic 认证）**：Runtime 的
   `GET /api/auth/session` 会对任何可达客户端直接建立传输会话，因此该入口的实际保护只有
   「端口不公开宣传 + TLS」；任何知道 `https://14.103.216.193:8788/` 的人都能创建任务并读取
   全部会话历史。若后续需要恢复门禁，可在该 `location` 里加 `auth_basic`，或改用
   `allow <IP>; deny all;` 的 IP 白名单（不弹登录框）。原 Basic 凭据文件
   `/etc/nginx/metawork-runtime.htpasswd` 与 `/root/.metawork-runtime-access.txt` 已删除。
