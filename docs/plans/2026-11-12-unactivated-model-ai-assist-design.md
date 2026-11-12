# 未激活模型的 AI 辅助可用性（2026-11-12）

## 背景

设置页新增 Provider 或模型后，**不点"保存并激活"**时，这些事实只存在于浏览器内存：

| 事实 | 位置 | 服务端可见？ |
| --- | --- | --- |
| Provider 端点与协议 | 浏览器内存 | ❌ |
| API Key | 浏览器输入框 | ❌ |
| 已激活配置 | — | ❌ |

"保存"与"激活"是**同一个原子动作**（`POST /api/config/activate` 同时提交 config 与
secrets），凭据只在激活时入库（`stageSecrets`，`server-composition.ts`）。没有
"只存草稿"的中间态。

于是需要调用模型的辅助功能拿不到任何可用通道：

| 调用点 | 解析路径 | 未激活时 |
| --- | --- | --- |
| 更新模型能力/信息<br>`model-routing-profile` | 前端传 `preferredModel` → 查已激活配置 | **必然失败** |
| 更新智能体能力<br>`agent-capabilities` | `capability_explanation` 分支 → 从已激活配置找模型 | **必然失败** |
| 更新智能体介绍<br>`agent-responsibility` | 无 preferredModel → 官方内置 AI | 官方 AI 不可用才失败 |

失败的直接原因是 `resolvePreferredModel` 只认可"已激活配置里的 Provider"或
"官方公开预设"（kimi / deepseek / code-cli），且解析失败抛 `PreferredModelError`
后**不回退**官方内置 AI——这是刻意设计（*"解析不到就如实呈现，不静默回退官方
内置 AI 掩盖配置缺失"*）。

## 两个不能破坏的约束

1. **SSRF 边界**：客户端提交的 `baseUrl` 不得成为任意代理目标。Runtime 主进程的
   出网不受 egress proxy 管控（代理只覆盖 attempt 容器）。
2. **不掩盖配置缺失**：不得悄悄换一个模型给出看似正常的结果。

## 关键事实：降级不会造成张冠李戴

三条调用点的"事实依据"都不来自"用哪个模型生成"：

| 调用点 | 事实依据来源 |
| --- | --- |
| 更新模型能力/信息 | OpenRouter 公开模型目录 |
| 更新智能体能力 | 前端传入的模型事实 |
| 更新智能体介绍 | 前端传入的模型事实 |

生成的是描述文本，事实依据准确即可；谁来写这段文字不影响结论正确性。

## 实施

### 一、降级而不是阻断（最小方案）

`InternalLlmService.generate`：`PreferredModelError` 不再直接抛出，改为

- 有官方内置 AI → 用官方 AI 完成本次生成，并通过 `onDegraded` 回调把
  { modelId, reason, usedBy } 交回调用方；
- 无官方内置 AI → 保留原始可操作错误（没有任何通道能完成请求）。

降级信息沿调用链透出到三个接口的响应体（`degraded` 字段），前端如实显示：
"你指定的模型（X）尚未保存激活，本次结果由官方内置 AI 生成。"

### 二、错误文案指向"尚未保存激活"

原文案"缺少 API Key""端点未在已激活配置中找到"会让用户误以为自己漏填 Key、
反复重填。改为：

- `用户配置模型（X）尚未保存激活，其端点既不在已激活配置中，也不是官方公开预设：…`
- `用户配置模型（X）的 Kimi 的 API Key 尚未保存：…`
- `固定模型（X）尚不可用：请在模型设置中保存并激活对应 Provider…`

### 三、待激活 Provider 暂存区（方案 3）

新增 `src/configuration/pending-provider-store.ts`，落盘位置
`<account config>/pending-providers.json`：

- 内容：`providerRef → { baseUrl, protocol, apiKeyRef, savedAt }`；
  API Key 本体仍写进凭据库，暂存区只留引用。
- **写入时机**：`discoverProviderModels` **发现成功之后**（连接测试通过即证明
  该密钥可用），且本次带明文 API Key（即用户在设置页刚填的）。已激活
  Provider 的重新发现不带明文 Key，不写暂存。
- **读取时机**：`resolvePreferredProviders` 合并"已激活 ∪ 待激活"，**已激活优先**。
- **清理时机**：Provider 成功激活后从暂存区移除，避免两处事实长期分叉。

**边界保持**：端点来自本机落盘数据，不是客户端任意输入，因此不放松 SSRF 约束；
密钥始终走凭据库，不新增明文通道。

#### 密钥必须落在独立的 pending 命名空间

待激活密钥写 `file-secret:anyfusion/pending/<providerRef>`，**不写**
`file-secret:anyfusion/providers/<providerRef>`。凭据库因此多一个 `pending`
命名空间，与 `providers`、`internal` 物理隔离。

原因：用户**编辑已激活的 Provider** 并填入无效密钥、尚未保存激活时，若写入
正式引用就会直接覆盖正在生效的密钥——原本可用的模型立刻失效，所有使用它的
任务一起坏掉。独立命名空间让这条路径不存在。

合并时"已激活优先"同样重要：编辑未保存的新密钥不参与解析，AI 辅助仍用已激活
的那份有效密钥；只有**全新 Provider**（不在已激活配置里）才使用待激活密钥。

### 四、能力说明路径能查到编辑态的 Provider

编辑态的模型不在已激活配置里，服务端无法从 `modelRef` 反查 `providerRef`。
`ModelFactSchema` 增加可选 `providerRef` 字段，前端在构造模型事实时带上
（客户端只传引用，不传密钥）。

## 用户流程

**不变**：填模型 → 点"保存并激活"。没有新按钮、没有新步骤。

用户能感知的差别：填完模型点一次"连接测试"后，"添加模型""更新智能体能力"
"更新智能体介绍"等 AI 辅助功能立即可用，不必先激活整个配置。

## 验证

- `tests/configuration/internal-llm-service.test.ts`：降级走官方 AI 且原因如实上报；
  无官方通道时保留原始错误。
- `tests/configuration/agent-capability-description.test.ts`：能力说明返回降级信息。
- `tests/configuration/preferred-model-resolver.test.ts`：文案指向"尚未保存激活"。
- `tests/configuration/pending-provider-store.test.ts`：暂存区读写与清理（5 项）。
- `tests/configuration/credentials-file-secret-store.test.ts`（9 项）：待激活密钥与
  已激活密钥**互不覆盖**——这是"填了无效 key 却弄坏原本可用模型"的直接防线。
- `tests/management/server.test.ts`（71 项）与 `tests/configuration/` 全量通过，
  剩余 5 项失败为既有的 Windows POSIX 权限断言（改动前后一致）。

## 已知边界

- 用户填了密钥但最终未保存激活时，待激活密钥留在凭据库的 `pending` 槽位。
  它不参与任何活跃路径（不参与 Planner 路由、Executor 执行），但会留在磁盘上。
  清理策略（按时间过期）尚未实现。
- 用户从配置中删除某个 Provider 时，它在 `pending` 命名空间里的同名暂存密钥
  不会被自动清除；只有同名 Provider 再次激活时才会被清掉。

## 实施记录

- 镜像 anyfusion-runtime 0.1.25.5（本次改动全部在 Runtime 侧）、official-server 1.5.8
  （租户 Deployment 模板：initContainer + subPath 挂载 + `METAWORK_WORKSPACE_ROOT` 注入）。
- official-server 1.5.8：digest sha256:76fb124d281950b6f47dff5bfc7a4854f4845b130bbd31979a948a970a79e586，
  远端验证 `imagetools inspect` + `--pull=always` 拉取运行冒烟通过（healthz / 控制台 v1.5.8 /
  `/_auth/redeem` 别名路由仍返回 401 `sandbox_access_invalid`）。
- official-server 单测 48/48；仓库 `npm run lint` 干净。
- anyfusion-runtime 0.1.25.5：digest sha256:4470ae5f6dc5bca38dc51a1b2a33b7a1dc287c4eb21c11bdb798a022aaee113a。
  远端验证：`imagetools inspect` 确认 tag 落地；`--pull=always` 拉取后核查镜像内容——
  dist 含 `anyfusion/pending` 凭据命名空间、`METAWORK_WORKSPACE_ROOT`、`workspaces/mkdir`
  端点与 `onDegraded` 降级标记；web/dist 含"新建目录"与"尚未保存激活"文案；
  容器启动走到预期的 `active configuration is missing`（镜像内未装 release，
  托管实例由 startScript 先跑 install-cli）。
