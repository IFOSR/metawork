# Executor 搜索/抓取后端：DeepSeek 优先（本地 vendor）

- 计划日期：2026-11-14。
- 状态：本地实现与专项验证完成，**未提交、未推送**，等待用户验收。
- 范围：`src/executor/pi-agent.ts`（attempt 内自研 Pi 扩展）、
  `src/executor/pi-cli-driver.ts`、`src/configuration/runtime-private-binding-resolver.ts`、
  `src/executor/prompt-builder.ts` 与对应测试。
- 明确不做：Manager/Planner 侧 Web 工具（仍按 2026-09-12 handoff 归 Executor 所有）、
  独立搜索密钥、metering 计费台账、`ori_question`/域名/时间过滤参数、
  release 打包资产与签名清单变更。

## 结论

不引入 npm pi-package（`@dumbmice/pi-deepseek-websearch` 属用户级扩展，
MetaWork 的 Manager/Executor 使用隔离 `PI_CODING_AGENT_DIR`，不能也不应读取它）。
把 DeepSeek Search/Fetch 的客户端逻辑直接 vendor 进 MetaWork 自己的 attempt 扩展，
后端链变为 **DeepSeek Search API → Bing HTML**，百度后端整体删除。DeepSeek 凭据
**复用已配置的 DeepSeek Provider API Key**，不新增独立搜索密钥。

## 交付行为

1. **凭据复用**：`resolveRuntimePrivateConfigurationBinding` 在解析 attempt Provider
   环境后，若配置中存在启用且可解析的 DeepSeek Provider（`providerRef === 'deepseek'`
   或 host 为 `api.deepseek.com`），额外注入
   `DEEPSEEK_API_KEY` 与 `DEEPSEEK_SEARCH_BASE_URL`（Provider baseUrl 去掉尾部 `/v1`）。
   缺失、无效或密钥不可解析时**不阻断** binding：只回落到 Bing。该路径未改动
   Planner 环境解析，Manager 仍无 Web 工具。
2. **`web_search`**：有 DeepSeek 凭据时先调 `POST {base}/v1/tools/search`
   （`query` + `count`），结果映射回既有 `data.web[]` 结构并附加
   `site` / `publishedAt` / `authority` / `rerankScore`；`provider` 取
   `deepseek-search-api`。失败（401/402/403/429/5xx/超时/无结果/超 128 字符上限）
   记录原因后回落 `bing-html-curl`；两者都失败仍返回既有“网络不可用/反爬拦截”
   结构化错误并附带两侧原因。原有 30 次/attempt 预算、attempt 内缓存、
   `elapsedMs` 与 Bing 反爬页识别保持不变。
3. **`web_fetch` 按 affordance 分流**：`pi-cli-driver` 在 materializeHome 时写入
   `METACLAW_PI_WEB_FETCH_BACKEND`；具备 `public-web-search + public-web-fetch +
   source-citation` 的 research attempt 取 `deepseek`（`POST /v1/tools/fetch`，
   服务端渲染 + 提取，返回 `deepseek-fetch-api`），其余 attempt 取 `curl`，
   以便 workspace 任务仍能抓 `localhost`/内网服务。DeepSeek 侧 402/429/5xx/网络故障
   回落 curl；401/403/404/413 视为该 URL 的终态并返回 `retryable:false` + 换源指引。
4. **Prompt/工具描述**：`web_search` 与 `src/executor/prompt-builder.ts` 的 Web 约束
   改为“DeepSeek 优先、Bing 兜底、禁止手写 curl 搜索”，并新增一条
   “使用 publishedAt/authority 判断时效与权威性”的指引。
5. **成本可见性**：DeepSeek 调用在工具 `details` 中带 `estimatedCostUsd`
   （0.00075/次），不进入 metering 台账。

## 验证

- `npx tsc --noEmit` 通过。
- `npx vitest run tests/executor/pi-agent.test.ts`：14 项通过，覆盖 DeepSeek 优先
  结果映射、500 重试后回落 Bing、无凭据时的双侧失败原因、research fetch 走
  DeepSeek、403 不回落、默认 curl 保留 localhost。
- `tests/configuration/runtime-private-binding-resolver.test.ts` 新增 3 项
  （复用 DeepSeek 凭据 / 密钥不可解析时保留 Bing 兜底 / attempt 本身跑 DeepSeek），
  通过；其余 2 项既有失败与本次无关（stash 基线复现）。
- 回归对比：`tests/executor` + `tests/configuration` 失败数 99 / 通过 389（改动前）
  → 失败数 99 / 通过 398（改动后），无新增失败；`tests/execution` 前后完全一致
  （66 失败 / 438 通过），均为既有未关闭失败。
- `node scripts/emit-pi-attempt-extension`（经 `npx tsx src/emit-pi-attempt-extension.ts`）
  生成物可被 TypeScript 正常转译。

## 已知限制 / 后续

- 只有配置里存在可解析的 DeepSeek Provider 时才有 DeepSeek 搜索；执行模型跑在
  其他 Provider 且未配置 DeepSeek 时静默回落 Bing（`web_search` 返回的 `provider`
  字段即事实来源）。
- 搜索按次计费未接入 usage/metering；`web_fetch` 没有独立预算上限。
- 未提供 DeepSeek 的 `ori_question`、域名/语言/时间过滤与 `need_content`。
- 现有 attempt 扩展仍是单文件、零运行时依赖；本次未新增打包资产，
  release 资产清单与签名无需变更。

## 发布构建（0.1.29，CI 多平台）

- 版本号：`package.json` / `web` / `apps/desktop` 及各自 lockfile `0.1.27 → 0.1.28`。
- 构建：`tsup` + planner schema + pi-attempt-extension + `prepare-pi-pdf`（PDF 步骤因
  GitHub 下载超时失败；`dist/pi-pdf` 从上一签名构建按 inventory 逐文件 sha256 校验
  还原，2536/2536 一致）。
- 打包源：`.tmp/release-028-source` worktree（HEAD `f9d2efa1` + 本地未提交改动补丁），
  `npm ci --omit=dev`，Pi pin 使用本机 `1.5.0`（与仓库 pin 的 lockSha256 一致）。
- 产物：
  - Runtime/Pi/Memory 归档与 `manifest.darwin-arm64.json`（`local-verify` dev key，
    `--release-id 0.1.28-build-f9d2efa1`）。
  - `apps/desktop/release/MetaWork-darwin-arm64.dmg`：345,067,049 bytes，
    SHA-256 `c44fdac6147c73ccc0d850a53ee8f991047262bbb8510edacd017ae9c62b2ebd`，
    ad-hoc 签名（无 Developer ID），`codesign --verify --strict` 通过（构建目录与挂载后）。
  - `build-info.json` 记录 `development: true`、`published: false`、`sourceCommitContainsChange: false`。
- 平台范围：0.1.29 由 `.github/workflows/release-build.yml` 在 tag `v0.1.29` 上构建
  `darwin-arm64`、`darwin-x64`、`linux-x64`（Windows 排除，ADR-0055 D13），并使用
  `metawork-release-2026-03` 生产信任根签名、macOS 公证。
- 0.1.28 本地 dev dmg 仅作验收用，已被 0.1.29 CI 构建取代；0.1.29 的产物由 CI
  从干净 tag 构建，manifest revision 与源码一致。
