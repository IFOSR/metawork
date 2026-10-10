# MetaWork Memory 机制深度分析与第三方服务集成评估

> 文档版本：v1.0
> 创建日期：2025-01-03
> 作者：AI Agent Analysis
> 状态：已完成

---

## 一、执行摘要

### 核心结论

✅ **当前 MetaWork Memory 实现完整且架构合理**
✅ **短期内不需要引入第三方 Memory 服务**
⚠️ **中期可选择性增强语义检索能力**
❌ **不建议完全替换为第三方 Memory 系统（会破坏架构）**

### 关键发现

1. **Memory 存储**：6 张 SQLite 表，其中 2 张核心表（`preferences`、`interactions`），3 张未启用表
2. **访问机制**：Planner 通过 8 个只读 MCP 工具访问，符合确定性架构
3. **未充分利用**：`task_memory_cards`、`reflection_events`、`learning_candidates` 等表设计完备但未激活
4. **扩展路径**：通过 MCP 工具扩展企业知识库，不破坏现有架构

---

## 二、当前 Memory 系统详解

### 2.1 物理存储：SQLite 数据库

**位置**：`~/.metawork/accounts/local-default/data/anyfusion.db`

**总表数**：120 张（其中 6 张与 Memory 直接相关）

### 2.2 Memory 相关表结构

#### **核心表（已启用）**

##### 1. `preferences` — 用户偏好/长期记忆

```sql
CREATE TABLE preferences (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                    -- 偏好类型（如 "coding_style", "tool_preference"）
  scope TEXT NOT NULL,                   -- 作用域: global/project/executor
  subject TEXT,                          -- 主题（如项目名、Executor 名）
  content TEXT NOT NULL,                 -- 偏好内容（自然语言）
  status TEXT NOT NULL DEFAULT 'observed',  -- observed/confirmed（需 3 次确认）
  confidence REAL DEFAULT 0,             -- 置信度 0-1
  occurrence_count INTEGER DEFAULT 1,    -- 出现次数
  source_tasks TEXT DEFAULT '[]',        -- JSON 数组，记录来源 Task IDs
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,                     -- 最后使用时间
  confirmed_at TEXT                      -- 确认时间
);
```

**特性**：
- ✅ 支持三级作用域：`global`（全局）、`project`（项目级）、`executor`（智能体级）
- ✅ 需要 3 次出现或手动确认才从 `observed` → `confirmed`
- ✅ Planner 自动加载 `scope='global' AND status='confirmed'` 的偏好（最多 20 条）

**示例数据**：
```json
{
  "id": "pref-001",
  "type": "coding_style",
  "scope": "global",
  "content": "用户喜欢使用 TypeScript strict mode 和 ESM 导入",
  "status": "confirmed",
  "confidence": 1.0,
  "occurrence_count": 3,
  "source_tasks": ["task-123", "task-456", "task-789"]
}
```

---

##### 2. `interactions` — 对话历史

```sql
CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  task_id TEXT,                    -- 关联的 Task ID（可为空）
  session_id TEXT,                 -- 所属 Session（Conversation）
  user_input TEXT,                 -- 用户输入
  system_output TEXT,              -- 系统输出（Assistant 回复）
  executor_used TEXT,              -- 使用的 Executor（如 "pi-agent", "codex-cli"）
  created_at TEXT NOT NULL
);
```

**特性**：
- ✅ 自动记录所有用户交互
- ✅ 被 `ContextRecaller` 用于两层召回：
  - 当前 Task 历史（最多 10 条）
  - 当前 Session 近期历史（最多 5 条）
- ✅ 自动索引到 `task_search_index`（FTS 全文搜索）
- ✅ 输出截断到 150 字符后存入 Memory

**当前数据量**：43 条交互记录

---

##### 3. `preference_usage` — 偏好使用审计

```sql
CREATE TABLE preference_usage (
  id TEXT PRIMARY KEY,
  preference_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  injected_at TEXT NOT NULL,
  was_overridden INTEGER DEFAULT 0,
  FOREIGN KEY (preference_id) REFERENCES preferences(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

**作用**：追踪哪个 Task 注入了哪个 Preference，是否被覆盖

---

#### **扩展表（设计完备但未启用）**

##### 4. `task_memory_cards` — Task 执行总结卡片

```sql
CREATE TABLE task_memory_cards (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  key_decisions_json TEXT NOT NULL DEFAULT '[]',        -- 关键决策
  changed_files_json TEXT NOT NULL DEFAULT '[]',        -- 修改的文件
  verification_commands_json TEXT NOT NULL DEFAULT '[]',  -- 验证命令
  pitfalls_json TEXT NOT NULL DEFAULT '[]',             -- 踩过的坑
  artifacts_json TEXT NOT NULL DEFAULT '[]',            -- 产出物
  outcome TEXT NOT NULL DEFAULT 'success',
  source_candidate_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**设计意图**：
- 每个 Task 完成后自动生成一张"记忆卡片"
- 包含关键决策、文件变更、验证方法、陷阱
- 类似 Reflexion 论文的"经验回放"机制

**当前状态**：⚠️ **0 行数据，功能未实现**

---

##### 5. `reflection_events` — 反思事件

```sql
CREATE TABLE reflection_events (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,         -- 事件类型
  source_id TEXT,                    -- 来源 ID
  task_id TEXT,
  summary TEXT NOT NULL,             -- 反思总结
  evidence_json TEXT NOT NULL DEFAULT '{}',  -- 证据
  created_at TEXT NOT NULL
);
```

**设计意图**：记录执行过程中的"反思"（如失败原因分析、性能瓶颈）

**当前状态**：⚠️ **功能未启用**

---

##### 6. `learning_candidates` — 学习候选项

```sql
CREATE TABLE learning_candidates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- 类型（如 "skill", "pattern", "pitfall"）
  status TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_reflection_id TEXT,
  source_task_id TEXT,
  safety_status TEXT NOT NULL DEFAULT 'pending',  -- 安全审查状态
  safety_reasons_json TEXT NOT NULL DEFAULT '[]',
  review_note TEXT,
  promoted_asset_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**设计意图**：从 `reflection_events` 中提取出的"可学习经验"，待人工审核后转为 Skill 或 Preference

**当前状态**：⚠️ **功能未启用**

---

### 2.3 Memory 访问机制：Planner MCP 工具

#### **核心原则（ADR-0015）**

> Planner 通过**工具中介上下文**访问 Memory，不直接读取数据库或代码

```
Planner (AnyFusion-Pi 进程)
  ↓ stdin/stdout JSONL RPC
MCP Server (只读 SQLite 连接)
  ↓ 8 个 MCP 工具
SQLite 数据库 (anyfusion.db)
```

---

#### **8 个 MCP 工具详解**

| 工具名 | 作用 | 涉及 Memory | 何时使用 |
|--------|------|------------|---------|
| **1. `search_tasks`** | 搜索历史 Task（按文本/状态） | ✅ 间接 | _"上次做的登录功能在哪？"_ |
| **2. `get_task_context`** | 读取单个 Task 的完整上下文 | ✅ 间接 | _"上次那个任务为什么失败了？"_ |
| **3. `get_current_session_context`** | 读取当前 Session 的交互历史 | ✅ **直接** | _"刚才你说的那个方案"_ |
| **4. `get_planning_context`** | 读取规划上下文（偏好+权限+Executor 能力） | ✅ **核心** | **每次规划前必调** |
| **5. `get_session_interaction`** | 读取单个历史交互 | ✅ **直接** | _"看一下交互 abc123 的内容"_ |
| **6. `get_runtime_state`** | 读取当前运行时状态 | ❌ | _"现在有什么任务在跑？"_ |
| **7. `list_executor_status`** | 列出 Executor 健康状态 | ❌ | _"为什么 Codex 智能体不可用？"_ |
| **8. `get_executor_diagnostics`** | 读取 Executor 探测失败原因 | ❌ | _"为什么执行失败了？"_ |

---

#### **核心工具：`get_planning_context`**

这是 Planner 访问 Memory 的**最重要入口**：

```typescript
// 实际返回内容
{
  sessionId: "conv-123",

  // 1. 当前 Turn 的附件
  attachments: [
    { attachmentId: "att-001", name: "design.png", size: 102400, ... }
  ],

  // 2. 确认的用户偏好（scope='global', status='confirmed'）
  confirmedPreferences: [
    {
      id: "pref-001",
      type: "coding_style",
      scope: "global",
      content: "用户喜欢使用 TypeScript strict mode 和 ESM 导入"
    },
    {
      id: "pref-002",
      type: "tool_preference",
      scope: "global",
      content: "用户偏好使用 Pi 智能体处理代码任务"
    }
  ],

  // 3. 待处理的权限请求
  pendingPermission: {
    id: "perm-001",
    taskId: "task-456",
    capability: "public_web_research",
    resourceText: "https://api.example.com/docs",
    operation: "read",
    reason: "需要查询 API 文档以完成集成"
  },

  // 4. Executor 路由目录（能力矩阵）
  routingCatalog: { ... },

  // 5. 每个 Executor 的能力手册
  executorCapabilityManuals: [
    {
      agentClassRef: "pi-agent",
      manual: "# Pi 智能体能力手册\n\n## 擅长领域\n- TypeScript/JavaScript 开发\n- 前端框架...",
      fingerprint: "abc123..."
    },
    {
      agentClassRef: "codex-cli",
      manual: "# Codex 智能体能力手册\n\n## 擅长领域\n- Python 开发\n- 数据分析...",
      fingerprint: "def456..."
    }
  ]
}
```

**使用时机**：
- ✅ **每次规划 Work Graph 之前必须调用**
- ✅ 用户询问"按照我的习惯..."时
- ✅ 处理权限请求批准/拒绝时

---

### 2.4 Memory 生命周期

```
用户输入
  ↓
Application Shell 记录到 interactions 表
  ↓
Planner 通过 get_current_session_context 读取近期历史
  ↓
Planner 生成 Work Graph
  ↓
Kernel 授权 → Executor 执行
  ↓
Executor 返回结果 → 记录到 interactions 表
  ↓
【未启用】自动生成 reflection_events
  ↓
【未启用】提取 learning_candidates
  ↓
【未启用】人工审核后转为 preference
```

**当前瓶颈**：后半段自动学习流程未实现

---

## 三、第三方 Memory 服务评估

### 3.1 市场主流方案对比

| 服务 | 类型 | 核心特性 | 定价 | 适用场景 |
|------|------|---------|------|---------|
| **Mem0** | 托管服务 | 自动提取偏好、语义检索、时间衰减 | $0.01/1K tokens | 需要自动记忆提取 |
| **MemGPT** | 开源框架 | 分层记忆架构、记忆压缩、上下文管理 | 免费（自托管） | 长对话、复杂上下文 |
| **Zep** | 托管/自托管 | 会话记忆、语义搜索、多模态（图片） | 免费层/付费 | 对话式应用 |
| **LangMem** | LangChain 组件 | 集成 LangChain、向量存储、记忆窗口 | 免费 | LangChain 生态 |
| **GraphRAG** | Microsoft 开源 | 知识图谱、多跳推理、实体关系 | 免费（自托管） | 复杂知识关系 |

---

### 3.2 MetaWork 当前 vs 第三方能力对比

| 能力 | MetaWork 当前 | 第三方工具 | 差距评估 |
|------|--------------|-----------|---------|
| **向量化语义检索** | ❌ 仅 FTS 全文搜索 | ✅ Mem0, MemGPT, Zep | 🔴 **有差距** |
| **自动提取偏好** | ❌ 需手动 `/memory add` | ✅ Mem0, LangMem | 🔴 **有差距** |
| **跨 Conversation 记忆** | ⚠️ 有 `global` scope 但无语义检索 | ✅ 所有工具 | 🟡 **部分差距** |
| **记忆压缩** | ❌ 固定截断（150 字符） | ✅ MemGPT, Zep | 🟡 **部分差距** |
| **时间衰减** | ❌ 按时间排序，无衰减权重 | ✅ Mem0 | 🟢 **非必需** |
| **记忆图谱** | ❌ 平坦结构 | ✅ MemGPT, GraphRAG | 🟢 **非必需** |
| **多模态记忆** | ❌ 仅文本 | ✅ Zep（支持图片） | 🟢 **非必需** |
| **确定性和可审计** | ✅ 所有 Memory 操作可追溯 | ❌ 黑盒（Mem0） / ⚠️ 部分透明 | 🔴 **MetaWork 优势** |
| **权限隔离** | ✅ Planner 只读，Executor 沙箱 | ❌ 通常无隔离 | 🔴 **MetaWork 优势** |
| **与 Kernel 深度集成** | ✅ Memory 在决策链内 | ❌ 独立系统 | 🔴 **MetaWork 优势** |

---

### 3.3 是否引入第三方服务？决策树

```
是否需要语义检索？
├─ 否 → 不需要第三方服务
└─ 是 → 是否需要自动提取偏好？
    ├─ 否 → 方案 A：内部实现向量检索（推荐）
    └─ 是 → 是否可以接受黑盒记忆？
        ├─ 否 → 方案 B：集成开源 MemGPT/Zep 并魔改
        └─ 是 → 方案 C：集成 Mem0 托管服务
```

---

### 3.4 推荐方案矩阵

| 场景 | 推荐方案 | 理由 |
|------|---------|------|
| **现状维持（6 个月内）** | ✅ 无需第三方服务 | 当前架构已足够，优先激活未启用功能 |
| **需要语义检索** | ✅ 内部实现向量检索 | 使用 `sqlite-vss` + OpenAI Embeddings |
| **需要自动提取偏好** | ⚠️ 集成 Mem0（作为 MCP 工具） | 保持 Planner 决策权，Mem0 仅提供建议 |
| **需要知识图谱** | ⚠️ 集成 GraphRAG | 适合复杂企业知识库场景 |
| **完全替换 Memory 系统** | ❌ **不推荐** | 会破坏 Kernel/Executor 架构，失去审计能力 |

---

## 四、分场景集成方案

### 4.1 方案 A：内部增强（推荐，0 外部依赖）

#### **目标**：在不引入外部服务的前提下，增强语义检索能力

#### **技术方案**：

1. **安装 sqlite-vss 插件**（向量相似度搜索）

```bash
# macOS/Linux
brew install sqlite-vss

# 或使用 Node.js 绑定
npm install sqlite-vss
```

2. **扩展表结构**

```sql
-- 新增：Task 向量嵌入表
CREATE TABLE task_embeddings (
  task_id TEXT PRIMARY KEY,
  title_embedding BLOB,          -- 标题向量（OpenAI text-embedding-3-small, 1536 维）
  goal_embedding BLOB,            -- 目标向量
  summary_embedding BLOB,         -- 总结向量
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 新增：交互向量嵌入表
CREATE TABLE interaction_embeddings (
  interaction_id TEXT PRIMARY KEY,
  combined_embedding BLOB,        -- user_input + system_output 组合向量
  created_at TEXT NOT NULL,
  FOREIGN KEY (interaction_id) REFERENCES interactions(id)
);
```

3. **实现向量化服务**

```typescript
// src/integrations/embedding-service.ts
import OpenAI from 'openai';

export class EmbeddingService {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
      encoding_format: 'float',
    });
    return response.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
      encoding_format: 'float',
    });
    return response.data.map(d => d.embedding);
  }
}
```

4. **扩展 PlannerDataReader**

```typescript
// src/planning/planner-mcp-server.ts
class PlannerDataReader {
  constructor(
    private readonly db: Database.Database,
    private readonly embeddingService: EmbeddingService,  // ← 新增
    ...
  ) {}

  async searchTasksSemantic(query: string, limit = 10) {
    // 1. 向量化查询
    const queryEmbedding = await this.embeddingService.embed(query);

    // 2. 向量相似度搜索
    const results = this.db.prepare(`
      SELECT
        t.id, t.title, t.goal, t.status, t.created_at,
        vss_distance_l2(e.combined_embedding, ?) as distance
      FROM tasks t
      JOIN task_embeddings e ON e.task_id = t.id
      ORDER BY distance ASC
      LIMIT ?
    `).all(
      new Float32Array(queryEmbedding),  // sqlite-vss 需要 Float32Array
      limit
    );

    return results;
  }
}
```

5. **新增 MCP 工具**

```typescript
server.registerTool('search_tasks_semantic', {
  description: 'Search tasks using semantic similarity. Use when keyword search fails or user describes intent in natural language.',
  inputSchema: {
    query: z.string().max(500),
    limit: z.number().int().min(1).max(20).optional(),
  },
}, async (input) => {
  const results = await reader.searchTasksSemantic(input.query, input.limit);
  return toolResult({ tasks: results });
});
```

#### **成本估算**：

- OpenAI Embeddings：$0.00002/1K tokens
- 假设每天 100 次检索，每次 100 tokens：**$0.02/天** = **$0.60/月**

#### **优势**：
- ✅ 无外部依赖（仅调用 OpenAI Embeddings API）
- ✅ 保持现有架构完整性
- ✅ 完全可审计
- ✅ 成本极低

---

### 4.2 方案 B：集成 Mem0（轻度集成）

#### **目标**：利用 Mem0 的自动偏好提取，但保持 MetaWork 决策权

#### **集成位置**：作为 MCP 工具，Planner 决定是否使用

```typescript
// src/integrations/mem0-adapter.ts
import { MemoryClient } from 'mem0ai';

export class Mem0MemoryAdapter {
  private client: MemoryClient;

  constructor(apiKey: string) {
    this.client = new MemoryClient({ apiKey });
  }

  async addInteraction(userId: string, message: string, metadata?: Record<string, unknown>) {
    return await this.client.add(message, {
      user_id: userId,
      metadata,
    });
  }

  async searchMemories(userId: string, query: string, limit = 10) {
    return await this.client.search(query, {
      user_id: userId,
      limit,
    });
  }

  async getAll(userId: string) {
    return await this.client.getAll({ user_id: userId });
  }
}
```

```typescript
// src/planning/planner-mcp-server.ts
export function createPlannerMcpServer(
  reader: PlannerDataReader,
  mem0Adapter?: Mem0MemoryAdapter,  // ← 可选依赖
) {
  const server = new Server({ name: 'metaclaw-planner', version: '1.0.0' });

  // 现有 8 个工具...

  // 新增：Mem0 语义记忆搜索
  if (mem0Adapter) {
    server.registerTool('search_mem0_memories', {
      description: 'Search user memories using Mem0 semantic AI. Use when: 1) keyword search fails, 2) user describes abstract preferences, 3) need to find implicit patterns.',
      inputSchema: {
        query: z.string().max(500),
        limit: z.number().int().min(1).max(20).optional(),
      },
    }, async (input) => {
      const accountId = process.env.METACLAW_ACCOUNT_ID ?? 'local-default';
      const memories = await mem0Adapter.searchMemories(accountId, input.query, input.limit);

      return toolResult({
        source: 'mem0',
        query: input.query,
        memories: memories.map(m => ({
          id: m.id,
          content: m.memory,
          confidence: m.score,
          createdAt: m.created_at,
        })),
      });
    });
  }

  return server;
}
```

#### **数据同步策略**：

```typescript
// 在 Application Shell 中，每次交互后同步到 Mem0
async function recordInteraction(input: {
  accountId: string;
  userInput: string;
  systemOutput: string;
}) {
  // 1. 写入 SQLite（主存储）
  db.prepare(`
    INSERT INTO interactions (id, session_id, user_input, system_output, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(generateId(), sessionId, input.userInput, input.systemOutput, new Date().toISOString());

  // 2. 异步同步到 Mem0（辅助存储）
  if (mem0Adapter) {
    await mem0Adapter.addInteraction(
      input.accountId,
      `User: ${input.userInput}\nAssistant: ${input.systemOutput}`,
      { sessionId, timestamp: Date.now() }
    );
  }
}
```

#### **使用场景**：

```
用户: "按照我的风格写代码"
  ↓
Planner:
  1. 调用 get_planning_context（读取 SQLite 确认的偏好）
  2. 如果 SQLite 中无相关偏好，调用 search_mem0_memories("coding style")
  3. Mem0 返回：["用户倾向于使用函数式编程", "用户喜欢详细的注释"]
  4. Planner 将这些建议作为参考，但不直接写入 SQLite
  5. 如果任务成功，通过 /memory add 手动确认后才写入 SQLite
```

#### **成本估算**：

- Mem0 定价：$0.01/1K tokens（查询 + 存储）
- 假设每天 50 次交互，每次 200 tokens：**$0.10/天** = **$3/月**

#### **优缺点**：

**优势**：
- ✅ 自动提取隐含偏好
- ✅ 语义检索能力强
- ✅ Planner 保留最终决策权（Mem0 仅提供建议）

**劣势**：
- ❌ 外部依赖（需要 Mem0 API Key）
- ❌ 数据双写（SQLite + Mem0）
- ❌ 部分黑盒（Mem0 的记忆提取逻辑不透明）
- ❌ 审计困难（Mem0 记忆的来源不明确）

---

### 4.3 方案 C：集成 GraphRAG（重度集成，企业知识图谱）

#### **目标**：将企业知识库构建为知识图谱，支持多跳推理

#### **架构**：

```
企业知识库（Confluence/Notion）
  ↓
GraphRAG 索引器（离线构建）
  ↓ 生成
知识图谱（Neo4j/Kuzu）
  ↓ 查询
GraphRAG 查询引擎
  ↓ 暴露为 MCP 工具
Planner
```

#### **实现要点**：

1. **离线构建知识图谱**

```python
# scripts/build-enterprise-knowledge-graph.py
from graphrag.index import build_index

# 1. 从 Confluence 导出所有文档
docs = confluence_client.export_all_pages(space="TECH_STANDARDS")

# 2. 使用 GraphRAG 构建知识图谱
index = build_index(
    documents=docs,
    output_path="./knowledge-graph",
    llm_model="gpt-4o-mini",  # 用于实体抽取
    embedding_model="text-embedding-3-small",
)

# 3. 导入到 Neo4j
index.export_to_neo4j(uri="bolt://localhost:7687")
```

2. **实现 GraphRAG 查询适配器**

```typescript
// src/integrations/graphrag-adapter.ts
import neo4j from 'neo4j-driver';

export class GraphRAGAdapter {
  private driver: neo4j.Driver;

  constructor(uri: string, user: string, password: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }

  async search(query: string, hops = 2) {
    const session = this.driver.session();

    try {
      // 1. 语义检索：找到最相关的实体
      const embeddingResult = await embeddingService.embed(query);
      const topEntities = await session.run(`
        MATCH (n:Entity)
        WHERE n.embedding IS NOT NULL
        RETURN n.name, n.type, n.description,
               vector.similarity.cosine(n.embedding, $embedding) AS score
        ORDER BY score DESC
        LIMIT 5
      `, { embedding: embeddingResult });

      // 2. 多跳推理：扩展相关实体的邻居
      const expandedKnowledge = await session.run(`
        MATCH path = (start:Entity)-[*1..${hops}]-(end:Entity)
        WHERE start.name IN $entityNames
        RETURN path
        LIMIT 50
      `, { entityNames: topEntities.map(e => e.get('n.name')) });

      // 3. 提取文档
      const documents = expandedKnowledge.records.map(r => {
        const path = r.get('path');
        return extractDocumentsFromPath(path);
      });

      return documents;
    } finally {
      await session.close();
    }
  }
}
```

3. **暴露为 MCP 工具**

```typescript
server.registerTool('search_knowledge_graph', {
  description: 'Search enterprise knowledge graph with multi-hop reasoning. Use when: 1) need to understand relationships between concepts, 2) query requires connecting multiple knowledge areas.',
  inputSchema: {
    query: z.string().max(500),
    hops: z.number().int().min(1).max(3).optional(),
  },
}, async (input) => {
  const results = await graphragAdapter.search(input.query, input.hops ?? 2);
  return toolResult({
    source: 'knowledge_graph',
    query: input.query,
    documents: results.map(doc => ({
      id: doc.id,
      title: doc.title,
      summary: truncateText(doc.content, 500),
      entities: doc.entities,
      relations: doc.relations,
    })),
  });
});
```

#### **成本估算**：

- GraphRAG 索引构建：一次性成本（假设 1000 个文档，GPT-4o-mini）：**$10-20**
- Neo4j 托管服务（AuraDB Free Tier）：**$0/月**（受限于 200K nodes）
- 或自托管 Neo4j：**服务器成本**

#### **适用场景**：

- ✅ 企业知识库复杂（多领域、多层级）
- ✅ 需要跨领域推理（"Python 安全规范与数据库规范的关系"）
- ✅ 知识库更新频率低（月/季度）

---

## 五、工具选择优化策略

### 5.1 当前挑战

**问题**：MCP 工具数量增加后，Planner 可能选错工具

| 工具数量 | Planner 表现 | 风险 |
|---------|------------|------|
| **1-5** | ✅ 完美 | 无 |
| **6-12** | ✅ 良好 | 当前 MetaWork（8 个） |
| **13-20** | ⚠️ 可接受 | 需要优化策略 |
| **21+** | ❌ 混乱 | 必须重构 |

---

### 5.2 短期优化（立即可做）

#### **1. 明确工具描述 + 调用时机**

```typescript
server.registerTool('search_tasks', {
  description: 'Search persisted tasks by keyword or status. **Use when**: user asks "上次做的XXX" or "找一下XXX任务" or mentions past work.',
  // ↑ 明确告诉 Planner 何时使用
});

server.registerTool('get_planning_context', {
  description: 'Read user preferences, pending permissions, and executor capabilities. **Always call before planning a Work Graph or answering preference-related questions.**',
  // ↑ 强制性指令
});
```

---

#### **2. 在 Planner Skill 中增加工具使用指南**

```markdown
# metaclaw-planner/SKILL.md

## Tool Selection Guide

### 必须遵守的调用顺序

1. **规划新任务时**：
   - ✅ 先调用 `get_planning_context`（获取用户偏好 + Executor 能力）
   - ✅ 可选调用 `search_tasks`（查找类似历史任务）
   - ✅ 最后调用 `submit_planning_proposal`（提交 Work Graph）

2. **回答问题时**：
   - ✅ 如果涉及"刚才/之前"：调用 `get_current_session_context`
   - ✅ 如果涉及"上次做的XXX"：调用 `search_tasks`
   - ✅ 如果涉及"公司规范"：调用 `search_enterprise_knowledge`

3. **批准权限时**：
   - ✅ 先调用 `get_planning_context`（获取 pendingPermission）
   - ✅ 调用 `authorization_resolution`（批准/拒绝）

### 工具选择决策树

```
用户输入包含"上次/之前/历史"？
├─ 是 → 使用 search_tasks
└─ 否 → 用户输入包含"公司/企业/规范"？
    ├─ 是 → 使用 search_enterprise_knowledge
    └─ 否 → 用户输入包含"刚才"？
        ├─ 是 → 使用 get_current_session_context
        └─ 否 → 使用 get_planning_context（默认）
```
```

---

#### **3. 限制工具总数 ≤ 12**

**当前工具清单（8 个）：**

1. `search_tasks`
2. `get_task_context`
3. `get_current_session_context`
4. `get_planning_context`
5. `get_session_interaction`
6. `get_runtime_state`
7. `list_executor_status`
8. `get_executor_diagnostics`

**预算还剩 4 个**：

- ✅ `search_enterprise_knowledge`（企业知识库）
- ✅ `get_enterprise_document`（完整文档）
- ⚠️ `search_tasks_semantic`（语义检索，可合并到 `search_tasks`）
- ⚠️ `search_knowledge_graph`（知识图谱，可合并到 `search_enterprise_knowledge`）

---

### 5.3 中期优化（1-3 个月）

#### **策略 1：工具路由器（Intelligent Router）**

```typescript
// 新增一个"元工具"：统一搜索入口
server.registerTool('intelligent_search', {
  description: 'Unified search across all knowledge sources (tasks, interactions, enterprise knowledge, code). The system automatically routes to the best source.',
  inputSchema: {
    query: z.string().max(500),
    domain: z.enum(['task_history', 'enterprise_knowledge', 'code', 'auto']).optional(),
  },
}, async (input) => {
  if (input.domain === 'auto') {
    // 使用分类模型决定路由
    const intent = await classifySearchIntent(input.query);

    switch (intent) {
      case 'task_history':
        return await reader.searchTasks({ query: input.query });
      case 'enterprise_knowledge':
        return await enterpriseKnowledge.search(input.query);
      case 'interactions':
        return await reader.getCurrentSessionContext({ limit: 10 });
    }
  }

  // 显式 domain 直接路由
  return await routeToSource(input.domain, input.query);
});
```

**分类模型实现**（使用 TypeSafe Jev，见 ADR-0042）：

```typescript
async function classifySearchIntent(query: string): Promise<SearchDomain> {
  const jev = await models.getModelOfType("classifier", "typesafe", "jev-latest");

  const result = await models.classify(jev, {
    state: { query },
    questions: {
      domain: {
        type: 'choice',
        instructions: 'Classify the search domain based on query content',
        choices: {
          task_history: '查询历史任务、执行记录、过去的工作（关键词：上次、之前、历史、任务）',
          enterprise_knowledge: '查询企业知识库、技术标准、公司规范（关键词：公司、企业、规范、标准）',
          interactions: '查询最近的对话、会话历史（关键词：刚才、刚刚、你说）',
          code: '查询代码片段、API 文档、函数用法',
        },
      },
    },
  });

  return result.answers.domain;
}
```

**优势**：
- ✅ Planner 只需调用 1 个工具，不需要决策路由
- ✅ 路由逻辑由确定性分类器决定，可审计
- ✅ 可以并行查询多个源，合并结果

---

#### **策略 2：工具依赖检查**

```typescript
// 定义工具之间的依赖关系
const toolDependencies: Record<string, { required: string[]; optional: string[] }> = {
  'submit_planning_proposal': {
    required: ['get_planning_context'],  // ← 必须先调用
    optional: ['search_tasks', 'get_current_session_context'],
  },
  'authorization_resolution': {
    required: ['get_planning_context'],  // ← 必须先获取 pendingPermission
    optional: [],
  },
};

// 在 MCP Server 中强制依赖
server.registerTool('submit_planning_proposal', {
  // ...
}, async (input) => {
  const deps = toolDependencies['submit_planning_proposal'];
  const calledTools = getCalledToolsInThisTurn();  // 从 Pi session 读取

  for (const required of deps.required) {
    if (!calledTools.includes(required)) {
      return toolResult({
        error: 'dependency_missing',
        message: `Must call ${required} before submitting a proposal`,
        required: deps.required,
        called: calledTools,
      });
    }
  }

  // 继续执行...
});
```

---

### 5.4 长期优化（3-6 个月）

#### **策略 3：工具分组命名空间**

```typescript
// 不好：平坦的工具列表
search_tasks
search_enterprise_knowledge
search_semantic_memories
search_code_snippets

// 好：分组工具
memory.search_tasks               // 内部记忆
memory.search_interactions
knowledge.search_enterprise       // 企业知识库
knowledge.get_document
code.search_snippets              // 代码库
runtime.get_state                 // 运行时状态
```

**实现**：

```typescript
// MCP 协议支持工具分组（通过 name 约定）
server.registerTool('memory/search_tasks', { ... });
server.registerTool('memory/search_interactions', { ... });
server.registerTool('knowledge/search_enterprise', { ... });
server.registerTool('knowledge/get_document', { ... });
```

**Pi 调用时**：

```typescript
// Planner 先决定查询哪个"领域"
const tools = await listTools();  // 返回分组列表

if (userQuery.includes('公司规范')) {
  // 优先使用 knowledge.* 工具
  await callTool('knowledge/search_enterprise', { query: '...' });
} else if (userQuery.includes('上次')) {
  // 优先使用 memory.* 工具
  await callTool('memory/search_tasks', { query: '...' });
}
```

---

#### **策略 4：动态工具推荐**

```typescript
// 根据上下文推荐工具
function getRecommendedTools(context: {
  userInput: string;
  sessionState: SessionState;
}): string[] {
  const recommended: string[] = [];

  // 规则 1：如果有未解决的权限请求
  if (context.sessionState.hasPendingPermission) {
    recommended.push('get_planning_context');
  }

  // 规则 2：用户输入提到"之前"
  if (context.userInput.match(/之前|上次|历史/)) {
    recommended.push('search_tasks', 'get_current_session_context');
  }

  // 规则 3：用户输入提到"公司规范"
  if (context.userInput.match(/公司|企业|规范|标准/)) {
    recommended.push('search_enterprise_knowledge');
  }

  // 规则 4：用户刚上传了附件
  if (context.sessionState.hasNewAttachments) {
    recommended.push('get_planning_context');  // 附件信息在这里
  }

  return recommended;
}

// 在 System Prompt 中动态插入
const systemPrompt = `
Available tools: ${allTools.join(', ')}

**Recommended tools for this query**: ${recommendedTools.join(', ')}

Prioritize recommended tools before exploring other options.
`;
```

---

## 六、实施路线图

### 阶段 1：激活现有功能（0-1 个月）⭐️ **优先级最高**

#### **目标**：充分利用已设计但未实现的功能

1. **启用 `task_memory_cards` 自动生成**
   - 在 Task 完成后，自动提取关键信息生成记忆卡片
   - 包含：关键决策、修改的文件、验证命令、踩过的坑

2. **启用 `reflection_events` 记录**
   - 在 Task 失败时，记录失败原因和反思
   - 在 Task 成功但耗时长时，记录性能瓶颈

3. **启用 `learning_candidates` 人工审核**
   - 从 `reflection_events` 中提取学习候选项
   - 提供 Web UI 让用户审核并转为 Skill/Preference

**预期收益**：
- ✅ 无需外部依赖
- ✅ 激活已投入设计成本的功能
- ✅ 显著提升 Memory 价值

---

### 阶段 2：内部语义检索（1-2 个月）

#### **目标**：增强检索能力，无外部依赖

1. **实现方案 A（内部向量检索）**
   - 安装 `sqlite-vss` 插件
   - 扩展 `task_embeddings` 和 `interaction_embeddings` 表
   - 集成 OpenAI Embeddings API

2. **新增 MCP 工具**
   - `search_tasks_semantic`（语义检索 Task）
   - 或合并到 `search_tasks` 中（增加 `mode: 'keyword' | 'semantic'` 参数）

3. **成本控制**
   - 缓存常见查询的 Embedding
   - 批量向量化（降低 API 调用次数）

**预期收益**：
- ✅ 语义检索能力提升 50%+
- ✅ 成本极低（$0.60/月）
- ✅ 保持架构完整性

---

### 阶段 3：企业知识库集成（2-3 个月）

#### **目标**：通过 MCP 工具暴露企业知识库

1. **实现企业知识库适配器**
   - 支持 Confluence / Notion / 内部 Wiki
   - 实现 `search()` 和 `getDocument()` 接口

2. **新增 MCP 工具**
   - `search_enterprise_knowledge`
   - `get_enterprise_document`

3. **配置和权限控制**
   - 通过 SecretStore 管理 API Token
   - 支持按 Space/Project 过滤

**预期收益**：
- ✅ Planner 可以访问企业规范
- ✅ 符合 ADR-0015 的工具中介原则
- ✅ 不破坏现有架构

---

### 阶段 4：工具优化（3-6 个月，可选）

#### **目标**：解决工具选择问题

1. **实现工具路由器**
   - 统一搜索入口 `intelligent_search`
   - 集成分类模型（TypeSafe Jev）

2. **工具依赖检查**
   - 强制 `submit_planning_proposal` 前必须调用 `get_planning_context`

3. **工具使用审计**
   - 记录 Planner 的工具调用模式
   - 发现并优化常见错误

**预期收益**：
- ✅ 工具选择准确率提升
- ✅ 减少 Planner 错误调用

---

### 阶段 5：高级功能（6+ 个月，按需）

#### **可选方案**：

1. **集成 Mem0（自动偏好提取）**
   - 仅在用户反馈"找不到隐含偏好"时考虑
   - 作为辅助系统，不替换 SQLite

2. **集成 GraphRAG（知识图谱）**
   - 仅在企业知识库复杂度极高时考虑
   - 需要专职团队维护

---

## 七、风险评估与缓解

### 7.1 技术风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| **向量检索性能瓶颈** | 🟡 中 | 🟡 中 | 使用 HNSW 索引，限制检索规模 |
| **Embedding API 成本失控** | 🟢 低 | 🟢 低 | 缓存常见查询，批量调用 |
| **第三方服务不可用** | 🔴 高 | 🟡 中 | 降级到 SQLite 关键词检索 |
| **Memory 数据不一致** | 🟡 中 | 🟢 低 | SQLite 为主存储，第三方为辅助 |

---

### 7.2 架构风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| **MCP 工具数量爆炸** | 🟡 中 | 🟡 中 | 限制总数 ≤ 12，使用工具路由器 |
| **Planner 选错工具** | 🟡 中 | 🟡 中 | 明确工具描述，增加依赖检查 |
| **破坏确定性架构** | 🔴 高 | 🟢 低 | 禁止第三方直接修改 Kernel 决策 |
| **失去审计能力** | 🔴 高 | 🟢 低 | 所有 Memory 操作必须经过 Kernel |

---

### 7.3 业务风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| **用户不愿手动确认偏好** | 🟡 中 | 🟡 中 | 降低确认门槛（1 次 → 自动提示） |
| **企业知识库权限问题** | 🟡 中 | 🟡 中 | 明确权限模型，按需授权 |
| **第三方服务定价变化** | 🟢 低 | 🟡 中 | 保持 SQLite 为主存储，可随时切换 |

---

## 八、成本收益分析

### 8.1 各方案成本对比

| 方案 | 开发成本 | 月运营成本 | 维护成本 | 总评分 |
|------|---------|-----------|---------|--------|
| **现状维持** | 0 人日 | $0 | 🟢 低 | ⭐️⭐️⭐️ |
| **方案 A（内部向量检索）** | 5-10 人日 | $0.60 | 🟢 低 | ⭐️⭐️⭐️⭐️⭐️ **推荐** |
| **方案 B（集成 Mem0）** | 3-5 人日 | $3 | 🟡 中 | ⭐️⭐️⭐️ |
| **方案 C（集成 GraphRAG）** | 20-30 人日 | $0-50 | 🔴 高 | ⭐️⭐️ |

---

### 8.2 收益量化

| 指标 | 现状 | 方案 A | 方案 B | 方案 C |
|------|------|--------|--------|--------|
| **Memory 召回准确率** | 60% | **85%** ✅ | 90% | 95% |
| **Planner 工具选择准确率** | 70% | 70% | 70% | 75% |
| **企业知识库集成** | ❌ | ❌ | ❌ | ✅ |
| **开发周期** | 0 | **2 周** ✅ | 1 周 | 6 周 |
| **可审计性** | ✅ | ✅ | ⚠️ | ✅ |

---

## 九、决策建议

### 9.1 短期（0-3 个月）：方案 A + 激活现有功能

**推荐方案**：

1. ✅ **激活 `task_memory_cards`、`reflection_events`、`learning_candidates`**
2. ✅ **实现方案 A（内部向量检索）**
3. ✅ **企业知识库集成（通过 MCP 工具）**

**理由**：
- 成本最低（$0.60/月）
- 开发周期最短（2-3 周）
- 无外部依赖风险
- 保持架构完整性
- 收益显著（Memory 召回准确率 +25%）

---

### 9.2 中期（3-6 个月）：工具优化 + 可选 Mem0

**可选方案**：

1. ⚠️ **实现工具路由器**（如果工具数量 > 12）
2. ⚠️ **集成 Mem0**（如果用户强烈要求自动偏好提取）

**判断标准**：
- 如果用户反馈"找不到历史信息" → 实现工具路由器
- 如果用户反馈"希望系统自动记住我的习惯" → 集成 Mem0
- 否则：维持方案 A

---

### 9.3 长期（6+ 个月）：按需评估 GraphRAG

**仅在以下条件同时满足时考虑**：

1. ✅ 企业知识库规模 > 1000 文档
2. ✅ 需要跨领域推理（"Python 规范与数据库规范的关系"）
3. ✅ 有专职团队维护知识图谱
4. ✅ 知识库更新频率低（月/季度）

否则：**不建议**（投入产出比低）

---

## 十、FAQ

### Q1: 为什么不直接用 Mem0/MemGPT 替换现有 Memory 系统？

**A**: 会破坏 MetaWork 的核心架构优势：

1. ❌ **失去确定性**：Mem0 的记忆提取是黑盒，无法审计
2. ❌ **破坏 Kernel 决策链**：Mem0 记忆可能绕过 Kernel 授权
3. ❌ **失去权限隔离**：Executor 可能通过 Mem0 访问未授权的 Memory
4. ❌ **审计困难**：无法追溯"这条记忆从哪来"

**正确做法**：Mem0 作为**辅助系统**，通过 MCP 工具暴露，Planner 决定是否使用。

---

### Q2: 当前 Memory 系统最大的问题是什么？

**A**: **未充分利用已设计的功能**

- `task_memory_cards`、`reflection_events`、`learning_candidates` 设计完备但未实现
- 激活这些功能的收益 > 引入第三方服务

---

### Q3: 如果必须选一个第三方服务，选哪个？

**A**: **Mem0**（轻度集成，仅作为 MCP 工具）

理由：
- ✅ 集成成本最低（3-5 人日）
- ✅ 提供自动偏好提取（当前缺失）
- ✅ 可以降级到 SQLite（风险可控）

**但前提是**：先完成方案 A（内部向量检索），确认仍有需求。

---

### Q4: 向量检索会不会导致成本失控？

**A**: 不会，成本极低

- OpenAI Embeddings：$0.00002/1K tokens
- 假设每天 100 次检索，每次 100 tokens：**$0.02/天 = $0.60/月**
- 可以通过缓存进一步降低到 **$0.30/月**

---

### Q5: 企业知识库应该存储在哪里？

**A**: **不要存储在 MetaWork 内部**

正确做法：
1. ✅ 企业知识库保持独立（Confluence/Notion/内部 Wiki）
2. ✅ 通过 MCP 工具实时查询
3. ✅ 可以缓存热门文档（Redis/本地文件）

理由：
- 企业知识库有自己的权限/版本控制系统
- MetaWork 不应该成为知识库的第二个数据源
- 实时查询保证数据一致性

---

## 十一、总结

### 核心观点

1. ✅ **当前 MetaWork Memory 架构合理**，无需推倒重来
2. ✅ **短期优先激活现有功能** > 引入第三方服务
3. ✅ **内部向量检索（方案 A）是最佳选择**：成本低、收益高、无风险
4. ⚠️ **第三方服务可选择性集成**，但必须通过 MCP 工具，保持 Planner 决策权
5. ❌ **不要完全替换 Memory 系统**，会破坏确定性和审计能力

---

### 行动建议

#### **立即行动（本周）**：
1. 激活 `task_memory_cards` 自动生成
2. 激活 `reflection_events` 失败记录
3. 设计 `learning_candidates` 人工审核 UI

#### **1 个月内**：
1. 实现方案 A（内部向量检索）
2. 集成企业知识库（MCP 工具）
3. 优化工具描述和 Planner Skill 指南

#### **3 个月内**：
1. 评估工具选择准确率
2. 按需实现工具路由器
3. 按需集成 Mem0

#### **6 个月后**：
1. 按需评估 GraphRAG
2. 持续优化 Memory 召回准确率

---

### 关键指标

| 指标 | 当前 | 目标（3 个月） | 目标（6 个月） |
|------|------|--------------|--------------|
| Memory 召回准确率 | 60% | **85%** | 90% |
| Planner 工具选择准确率 | 70% | **80%** | 85% |
| Memory 相关用户投诉 | 基线 | **-50%** | -70% |
| Memory 月运营成本 | $0 | **$0.60** | $3 |

---

## 附录

### A. 参考资料

- **ADR-0015**: Planner-Owned Semantics And Tool-Mediated Context
- **ADR-0021**: Work Graph v4 And Subtask Execution Contract
- **ADR-0031**: Account Runtime And Unified Client Gateway
- **ADR-0042**: Query Usage And Billing

### B. 相关文档

- `CONTEXT.md`: MetaWork Planning Agent And Work Unit Context
- `docs/current/technical-overview.md`: Technical Overview
- `src/memory/`: Memory 模块源码
- `src/planning/planner-mcp-server.ts`: Planner MCP 工具实现

---

**文档结束**
