# 多 Provider 与模型配置实施方案

> 状态：待实施
> 计划日期：2026-08-16
> 关联：ADR-0027（Configuration Control Plane）、ADR-0020（模块归属）、ADR-0018（路由契约）、CONTEXT.md、[Web 交互界面设计](2026-08-15-anyfusion-web-interaction-interface-design.md) §8.2、[Server 升级实现计划](2026-08-11-metawork-server-upgrade-implementation-plan.md)
> 用途：让用户在设置界面（与 admin CLI）配置多个 OpenAI 兼容 Provider 和多个模型，并把模型绑定到 AgentClass。Harness 配置本期明确不开放（执行边界保持代码所有）。

## 1. 目标与范围

- 多 Provider：新增/编辑/启用/停用 OpenAI 兼容 Provider（baseUrl + 凭证引用）。
- 多模型：新增/编辑/启用/停用模型，绑定到既有 Provider。
- 模型生效路径：AgentClass 的 `modelPolicy` 绑定（fixed 钉一个模型；auto 给 Planner 可选列表）。Planner 在授权目录投影中看到可用模型，Kernel 校验绑定不变。
- **不做**：Harness 编辑（`anyfusion-planner`/`codex-cli`/`pi-cli` 保持 canonical，启动强制收敛不变）、第二套配置验证、provider 协议扩展（本期只支持 `openai-compatible`）。

## 2. 现状与缺口（为什么今天配不了）

配置 schema（v2）本身能描述多 Provider/Model，但运行时有三层断裂：

1. **安装期静态文件是事实权威**。Planner 读 planner home 的 `models.json`/`settings.json` + `METACLAW_PLANNER_ENV_FILE`（provider.env）；Executor 读 `METACLAW_EXECUTOR_*_HOME` 模板 + `METACLAW_*_EXECUTOR_ENV_FILE`。这些都是安装期一次性渲染的静态文件，单 provider、单模型。
2. **激活的 revision 不带凭证**。revision 里 Provider 只有 `apiKeyRef` 引用；迁移只把 `secretImportPlan` 写进报告，从不落库（`configuration-migration-service.ts`），`KeychainSecretStore`/`FileSecretStore` 无生产实例。
3. **运行时绑定没有 environment**。`ConfigurationService.getRuntimeBinding` 只返回 `{revisionId, bindingFingerprint}`；`resolveRuntimePrivateConfigurationBinding`（能产出 `OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL`）没有生产调用方；`MetaclawSession` 的 fallback binding 不带凭证（`metaclaw-session.ts:469-472`）。

结论：多 provider/model 不是"UI 没开"，而是**凭证与生效链路没接通**。本方案按 ADR-0027 把权威迁到「revision + SecretStore」，安装期文件降级为导入源。

## 3. 目标架构

```
设置页 / admin CLI
  → POST /api/config/secrets（写 SecretStore，得 apiKeyRef）
  → POST /api/config/activate（validate → compile → probe → activate，配置只含引用）
  → 激活钩子渲染 generated agent 配置
      ~/.anyfusion/generated/agent-runtime/<revisionId>/
        planner/{models.json,settings.json}        ← 支持多 provider 段
        codex/config.toml                          ← [model_providers.*] 多段
        pi-home/.pi/agent/{models.json,settings.json}
  → 运行时读取点切换到 generated 目录
      Planner supervisor（ANYFUSION_PLANNER_HOME → generated planner home）
      Executor 驱动（attempt home 模板 → generated codex/pi-home；
                    凭证 → runtimeBinding.environment，来自 SecretStore）
```

关键决策：

- **SecretStore 为凭证唯一权威**：默认 `FileSecretStore`（`resolveAnyFusionPaths().secrets`，即 `~/.anyfusion/config/secrets`，0o700/0o600，已存在且完整）。引用规范统一为 `file-secret:anyfusion/providers/<providerRef>`；`keychain:` 引用留作后续 macOS 可选增强（`KeychainSecretStore` 已实现，本期不接）。
- **revision 不含明文**：activate 请求体和 snapshot 只携带 `apiKeyRef`；凭证只经 `/api/config/secrets` 进出 SecretStore。迁移/诊断报告继续只写哈希。
- **生成配置按 revision 分目录**：`generated/agent-runtime/<revisionId>/` 不可变；激活写新目录，回滚切回旧目录。generation 钉 revision 的既有语义不变（CONTEXT.md：激活只影响新 generation，运行中任务 fail-closed 不替换）。
- **生效时机**：Executor 绑定对新 attempt 立即按 revision 生效；Planner 模型切换对**新 Planner session** 生效（planner 进程在 session 启动时读 models.json/settings.json，长会话不热切换）；UI 沿用现有 `runningRevisionId` / `restartRequired` 语义提示。
- **env 文件降级**：`provider.env` / `METACLAW_*_ENV_FILE` 不再是运行时权威，仅作为安装期/容器的导入源（legacy import 读它们建首个 revision 并落 SecretStore）。驱动的 env-file 直读逻辑（`readProviderEnvFile`）在 Task 2 完成后移除，避免双权威。

## 4. 任务分解（每步独立可提交）

### Task 1：SecretStore 生产接线与 legacy 导入落库

**Files:** `src/index.ts`、`src/configuration/configuration-migration-service.ts`、`src/configuration/legacy-configuration-reader.ts`（引用规范）、`src/configuration/index.ts`（导出）、`docker/entrypoint.sh`（容器同样落库）、`tests/configuration/`、`tests/docker/`

**Steps:**

1. 生产装配 `FileSecretStore(resolveAnyFusionPaths().secrets)`，启动时 `initialize()` + `assertSecurePermissions()`。
2. legacy 导入把 `OPENAI_API_KEY` 实际写入 SecretStore：引用从 `keychain:anyfusion/imported/openai` 改为 `file-secret:anyfusion/providers/<providerRef>`（schema 允许两种前缀，见 `schema.ts:16`）；报告继续只写 `valueSha256`。
3. 导入幂等：同一值重复导入不新增 revision、不改写已有 secret（按引用存在性跳过）。
4. entrypoint.sh 的 legacy 播种（`~/.config/anyfusion`）保持不变——它本来就喂给同一条 import 路径。

**Validation:** 新增/更新配置迁移测试：导入后 `secretStore.get(ref)` 能取回原值；报告无明文；权限断言生效。`npx vitest run tests/configuration/`。

### Task 2：runtime binding 生产接线（凭证进 attempt 环境）

**Files:** `src/configuration/configuration-service.ts`（getRuntimeBinding 扩展）、`src/session/metaclaw-session.ts:469`、`src/session/scripted-session.ts`、`src/index.ts`（全部 `new MetaclawSession(...)` 构造点）、`src/gateway/server.ts`、`src/executor/local-cli-executor-adapter.ts`、`tests/configuration/`、`tests/session/`

**Steps:**

1. `getRuntimeBinding` 改为经 `resolveRuntimePrivateConfigurationBinding` 产出 `{ revisionId, bindingFingerprint, environment }`（SecretStore 注入 ConfigurationService 构造参数）。
2. 所有 `MetaclawSession` 构造点传入 `getRuntimeBinding`，删除 env-less fallback；解析失败 fail-closed（attempt 报 configuration failure，不回退到环境变量）。
3. Executor 驱动移除 `readProviderEnvFile` 直读（`harness-driver.ts`、`codex-cli-driver.ts`、`pi-cli-driver.ts`），凭证只来自 `runtimeBinding.environment`；home 模板播种保留（Task 3 换模板来源）。
4. `METACLAW_CODEX_EXECUTOR_ENV_FILE` / `METACLAW_PI_EXECUTOR_ENV_FILE` 从生产读取路径删除，仅保留在 installer/entrypoint 的导入语境；`native-install-lib.mjs` 的 launcher 渲染同步收窄。

**Validation:** 单测覆盖「revision + SecretStore → attempt 环境含三元组」与「secret 缺失 → 明确 configuration failure」；`npm run smoke:anyfusion -- --scenario artifact`（native）通过，证明凭证链等价。

### Task 3：激活时渲染 generated agent 配置（多 provider 生效点）

**Files:** 新增 `src/configuration/agent-runtime-renderer.ts`、`src/configuration/configuration-service.ts`（activate/rollback 钩子）、`src/planning/planner-process-supervisor.ts`（plannerHome 解析）、`src/executor/codex-cli-driver.ts`、`src/executor/pi-cli-driver.ts`（homeTemplateDir 来源）、`src/installation/paths.ts`（沿用 `generatedAgentRuntime`）、`tests/configuration/`、`tests/executor/`

**Steps:**

1. renderer 输入 active revision，输出 `generated/agent-runtime/<revisionId>/` 下三套配置：
   - planner `models.json`：每个 enabled provider 一段（`openai-responses` api、`apiKey: "$OPENAI_API_KEY"`、models 数组取该 provider 下 enabled 模型）；`settings.json`：`defaultProvider`/`defaultModel` 取 planner AgentClass 的 modelPolicy 绑定，`enabledModels` 为全部可选 `provider/modelId` 列表。
   - codex `config.toml`：`[model_providers.<ref>]` 多段 + 顶层 `model`/`model_provider` 取 codex-cli AgentClass 绑定；保留本期已验证的必要字段（`model_reasoning_effort`、`preferred_auth_method="apikey"`、`requires_openai_auth=false`）。
   - pi `models.json`/`settings.json`：同 planner 结构。
2. `activateDraft` 成功后渲染新目录并切换「当前 generated」指针（先写临时目录再原子 rename，失败不污染旧目录）；`rollback` 同理。
3. Planner supervisor 的 plannerHome、两个驱动的 `homeTemplateDir` 默认读当前 generated 目录；现有 `METACLAW_PLANNER_HOME` / `METACLAW_EXECUTOR_*_HOME` 环境变量降级为测试/调试覆盖。
4. Planner 凭证环境变量命名冲突处理：多 provider 时渲染侧为每段生成 `apiKey: "$OPENAI_API_KEY__<PROVIDER_REF>"` 形式，由 runtime binding/supervisor 按绑定注入对应变量（保持 fork 不改）。

**Validation:** 渲染器单测（多 provider 输出结构、原子切换、回滚）；驱动/supervisor 读取点测试；`tests/docker/shell-schema-isolation.test.ts` 的模板断言改为对渲染器输出断言（模板迁入 renderer，docker/*-config 静态模板删除）。

### Task 4：设置 API 与 Web 表单扩展

**Files:** `src/management/server.ts`（secrets 端点）、`src/management/routes-config.ts`、`web/src/components/ProviderForm.tsx`、`ModelForm.tsx`、`SettingsPanel.tsx`、`web/src/config-edit.ts`、`tests/management/`、Web 设计文档 §8.2

**Steps:**

1. `POST /api/config/secrets`：`{ providerRef, apiKey }` → 写 SecretStore（`file-secret:anyfusion/providers/<providerRef>`），返回 `{ apiKeyRef }`；永远不回读明文（GET 只返回「已配置」）。
2. Provider 表单开放：新建/编辑 `baseUrl`、`region`、`enabled`、凭证（新建必填、编辑可留空保持不变）；Model 表单开放：新建 `modelId` + `providerRef` + capabilities/reasoning/enabled。
3. AgentClass 表单的 `modelPolicy` 下拉数据源改为全部 enabled 模型（现有 `selectModelPolicy` 已支持 fixed/auto）。
4. 设置页首的「安装期权威」声明替换为「凭证由 SecretStore 托管，revision 只含引用」。
5. 激活失败的 `probe_failed`/`validation_failed` 逐条展示（已有），补「凭证缺失」专属提示。

**Validation:** `tests/management/` 新增 secrets 端点测试（写入后可解析、无明文回读、未授权 401）；web `tsc --noEmit` + `vite build`；浏览器手工验证新建 provider → 绑定模型 → 激活 → 新 revision 生效。

### Task 5：多模型路由语义与 Planner 可见性

**Files:** `src/configuration/projections.ts`（Planner 安全投影）、`src/planning/`（catalog 注入点）、`tests/configuration/`、`tests/planning/`

**Steps:**

1. 确认/扩展 Planner 目录投影：每个 executor AgentClass 的 modelPolicy（fixed 模型或 auto 候选列表）进入 Planner 可见的静态 catalog；动态 health 不变。
2. `auto` 模式的 `allowedModelRefs` 顺序即 Planner 选择序；Kernel 绑定校验不变（`resolveRuntimePrivateConfigurationBinding` 的 `modelPolicyAllows` 已覆盖）。
3. 文档化语义：「多模型 = 同一 AgentClass 的候选列表，或多个绑不同模型的 AgentClass」；不新增 AgentClass 类型的创建入口（本期 AgentClass 只改绑定不新建，canonical 收敛不变）。

**Validation:** 投影单测（多模型出现在 catalog、disabled 不出现）；既有 Kernel 绑定校验回归。

### Task 6：安装器、文档与收尾

**Files:** `scripts/install-native-macos.mjs`、`scripts/native-install-lib.mjs`、`README.md`、`README.zh-CN.md`、`CONTEXT.md`、`docs/current/technical-overview*.md`、`AGENTS.md`（导航如需）

**Steps:**

1. `setup:native` 保持单 provider 引导（简单默认），安装完成后由设置页/admin CLI 追加 provider/model；README 增加多 provider 配置说明。
2. CONTEXT.md 更新「Executor path invariant」与配置权威段落：env 文件降级为导入源、SecretStore/generated 目录成为运行时权威。
3. Web 设计文档 §8.2 的「前置任务声明」标记完成并链接本方案。

**Validation:** 文档与代码一致；`npm run lint && npm run build && npm test`；两条 live smoke（native）通过。

## 5. 兼容与迁移

- 产品未发布，无兼容包袱：env 文件权威直接下线，不保留双读。
- 首次启动迁移：已有安装（`~/.config/anyfusion` 存在）经 legacy import 自动落成 revision + SecretStore 条目，用户无感。
- Docker：entrypoint 已播种 `~/.config/anyfusion`（2026-08-16 起），容器走同一条 import 路径，无需额外工作；`docker/*.env` 仍是容器导入源。

## 6. 验收标准

- [ ] 设置页新建第二个 provider + 模型并激活成功，`GET /api/config` 返回新 revision，secret 不明文出现在任何 API 响应/revision/报告中。
- [ ] artifact smoke 使用**非默认模型**绑定的 AgentClass 完成执行（receipt 的 bindingFingerprint 对应该 revision）。
- [ ] 激活后 Planner 新 session 使用新默认模型；Executor attempt 环境按 revision + SecretStore 注入。
- [ ] secret 缺失/错误时 attempt fail-closed，报 configuration failure，不静默回退。
- [ ] 回滚到旧 revision 后 generated 目录切回，运行中任务不受影响。
- [ ] `npm run lint` / `npm run build` / `npm test` / 两条 native smoke 全绿；`tests/docker/` 断言更新到渲染器。

## 7. 风险与开放问题

- **Planner 热切换**：长会话中切换默认模型需要新建 Planner session 才生效；如需会话内切换，得给 fork 加受控的模型切换 RPC（本期不做）。
- **probe 成本**：activate 闭环的 probe 已存在；多 provider 后可考虑加「provider 可达性」可选检查，失败只警告不阻塞（probe 失败仍阻塞）。
- **Keychain**：macOS 钥匙串存储作为 SecretStore 可选后端，接口已就位，单独立项评估。
