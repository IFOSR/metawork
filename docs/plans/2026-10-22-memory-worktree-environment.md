# 记忆工作区环境说明（metawork-memory-tdai）

> 本文件是 `metawork-memory-tdai` worktree 的**环境说明**，不是设计文档。
> 设计方案见 [`2026-10-22-memory-system-tdai-integration-design.md`](2026-10-22-memory-system-tdai-integration-design.md)。

## 1. 工作区身份

| 项 | 值 |
|---|---|
| 路径 | `/Users/yuanjubian/orca/workspaces/metawork/metawork-memory-tdai` |
| 分支 | `IFOSR/metawork-memory-tdai` |
| 基线 | `main` @ `d19e412e`（含 574 行记忆系统设计文档） |
| Orca 位置 | 与 `main`、`metawork-vertical-architecture`、`metawork-task-status-refactor` **并列**（`parentWorktreeId: null`，无 lineage） |
| Node | v22.23.3（MetaWork 要求 ≥22.19；TDAI 要求 ≥22.16） |

## 2. 隔离约定

本工作区**不得**影响主工作区与用户真实数据。

| 资源 | 隔离方式 | 实际位置 |
|---|---|---|
| TDAI 数据 | `data.baseDir` 指向工作区 | `<worktree>/.tmp/tdai/MemoryCore/tdai-data/` |
| TDAI 端口 | 固定 `127.0.0.1:8420` | 与用户主目录 `~/.memory-tencentdb` **无交集**（已验证不存在） |
| TDAI 源码 | 放在 gitignore 的 `.tmp/` 下 | `<worktree>/.tmp/tdai/`（上游 commit `6a4bb55`） |
| MetaWork 数据库 | 本工作区不连用户库 | 实验只读用户库数据时必须显式指定路径，不写回 |
| 凭证 | 只在进程 env 中注入 | 不落盘、不进 Server `process.env`、不进前端 |

`.tmp/` 与 `.tmp-*/` 已在仓库 `.gitignore` 中，实验产物不会污染提交。

## 3. 已就绪的环境

| 组件 | 状态 | 验证方式 |
|---|---|---|
| MetaWork 依赖 | ✅ 318 包 | `npm run lint` 通过（`tsc --noEmit`，exit 0） |
| Web 依赖 | ✅ 309 包 | `npm ci --prefix web --ignore-scripts` exit 0 |
| Pi fork（AnyFusion-Pi）依赖 | ✅ 426 包 | `npm install` exit 0；`build:offline` 见 §6 |
| TDAI MemoryCore 依赖 | ✅ 597 包 | `npm install --legacy-peer-deps` exit 0（`--legacy-peer-deps` 用于跳过可选 peer：`openclaw`、`node-llama-cpp`） |
| TDAI sidecar | ✅ 可启动 | `GET /health` → `status: ok`、**`stores.ftsAvailable: true`**、`embeddingService: false`（按设计关闭） |
| 抽取用 LLM | ✅ 通 | 探针见 §5 |

## 4. TDAI sidecar 启停

配置文件：`<worktree>/.tmp/tdai/memory-gateway.worktree.yaml`（隔离数据目录、pipeline 已按方案 §5.4 调参）。

```bash
cd <worktree>/.tmp/tdai/MemoryCore
export TDAI_GATEWAY_CONFIG="$PWD/../memory-gateway.worktree.yaml"
export TDAI_GATEWAY_API_KEY="worktree-local-dev-key"     # Bearer 闸门
export TDAI_LLM_BASE_URL="<见 §5>"
export TDAI_LLM_API_KEY="<见 §5>"
export TDAI_LLM_MODEL="<见 §5>"
node --import tsx src/gateway/server.ts
```

探活与验证：

```bash
curl -s http://127.0.0.1:8420/health | python3 -m json.tool
```

**已验证的接口契约**（对应设计 §6）：

| 检查 | 结果 |
|---|---|
| L0 写入 `/v3/conversation/add` | ✅ 接受未在 meta 层注册的 `team_id`/`agent_id` 字符串 → **不需要注册作用域，不需要作用域表** |
| L0 查询 `/v3/conversation/query` | ✅ 按 `team+agent+user` 正确隔离；换 `team_id` 查不到（total=0） |
| Bearer 闸门 | ✅ 缺 `Authorization` 返回 401 |
| 数据落盘 | ✅ 全部落在工作区内 `tdai-data/` |

## 5. 抽取用 LLM（复用用户已配置的 Provider）

设计 §7.3 要求：协议必须 `openai-compatible`，模型需 `structured-output` 能力。
用户现有 Provider 目录已满足该约束，探针（`.tmp/probe-llm.mjs`，只打印状态不打印密钥）结果：

| Provider | 协议 | 模型 | 探针结果 |
|---|---|---|---|
| `custom-model-7` | openai-compatible | `/drex/weights/drex-v1.5-Q8_0.gguf`（本地） | ✅ HTTP 200 |
| `deepseek` | openai-compatible | `deepseek-chat` | ✅ HTTP 200 |
| `custom-model-8` | openai-compatible | `inception/mercury-decide:free` | ⚠️ HTTP 400（该模型不接受 chat/completions 形态） |

凭证来源：`~/.metawork/credentials.json` → `providers.<name>`，与 `ProviderDefinition.apiKeyRef`（`file-secret:anyfusion/providers/<name>`）一致。

> 抽取实验优先用**本地** `custom-model-7`：不出机器、免费。
> `deepseek` 作为备选（会出网，实验数据需为脱敏样本）。

## 6. 尚未完成 / 下一步

- [ ] Pi fork `build:offline` 产物验证
- [ ] MetaWork `npm run build` 全链路验证
- [ ] **Phase 0 质量实验**：用真实多轮会话的全部 turn 回灌 `/v3/conversation/add`，观察 L1/L3 抽取质量（方案 §13 Phase 0，门槛：不达标即停）
- [ ] Phase 1：ADR-0015 修订 + 新 ADR 草案
- [ ] Phase 2+：实现（本工作区尚未写任何实现代码）

## 7. 复现本环境

```bash
# 1. worktree
orca worktree create --name metawork-memory-tdai \
  --repo id:42f287eb-c43f-4949-921b-26d68a6160f1 \
  --base-branch main --setup run \
  --comment "记忆系统接入 TDAI；基于 main d19e412e；需隔离 TDAI sidecar 端口 8420 与数据目录。"
orca worktree set --worktree path:<worktree-path> --no-parent   # 与 main 并列，不做子工作区

# 2. 依赖
npm install
npm ci --prefix web --ignore-scripts
(cd planner/AnyFusion-Pi && npm install && npm run build:offline)

# 3. TDAI
mkdir -p .tmp && git clone --depth 1 https://github.com/TencentCloud/TencentDB-Agent-Memory .tmp/tdai
(cd .tmp/tdai/MemoryCore && npm install --legacy-peer-deps)
```
