# Executor 执行过程可观测性 & 服务日志噪音：问题复盘与解决方案

> **本文用途**：独立参考资料，供其他项目/团队借鉴。不依赖本仓库其他文档，可单独分发。
> **覆盖范围**：两个真实生产问题的完整复盘——(1) Executor 执行过程在界面上信息密度过低；(2) 服务日志高频刷屏。
> **代码基线**：MetaWork `0.1.23-log-*`（提交 `9e1a4d2` 与之前的 6 个提交）。

---

## 0. 背景与术语

一次 40 分钟的长程任务（生成银行信贷行业报告）暴露了两个看似无关、实则同源的问题：**信息在某一层被拿到后又被丢弃**，导致外部看到的是"沉默"或"噪音"，而不是真实状态。

| 术语 | 含义 |
|---|---|
| **Executor** | 真正干活的执行进程（本项目是 Pi CLI），以 JSONL 事件流写到 stdout |
| **Progress / trace 事件** | 从 Executor 事件流提炼出的、给用户看的一行行进度，落库并经 WebSocket 推送前端 |
| **Journal** | 事件持久化层（分段落盘 + SQLite 索引 + 读模型投影） |
| **Reconciler** | 每分钟运行一次的任务状态自愈检查（孤儿派发项、僵尸排程、陈旧会话槽） |
| **Maintenance loop** | Journal 的后台维护循环，本项目每 25ms 一次 tick |

---

# 问题一：Executor 执行过程信息密度过低

## 1.1 现象

前端"执行详情"面板长这样，20 分钟没有任何有价值信息：

```
19:11:10  进度   Executor processing cycle completed
19:11:10  进度   Executor processing cycle started
19:11:13  进度   Executor model response stream started
19:11:17  进度   Executor started tool: bash          ← 不知道执行了什么命令
19:11:17  进度   Executor completed tool: bash        ← 不知道输出了什么
19:11:17  进度   Executor processing cycle completed
19:11:58  进度   Executor processing cycle started
```

用户原话：**"只知道它现在有输出，却不知道输出的是什么，那等于没有信息。"** 长程任务因此被误判为卡死或死循环。

## 1.2 根因：三层各丢一部分

数据本身完整存在（Pi 的 stdout 里 thinking、tool 参数、tool 结果、增量 delta 全都有），问题出在提炼链路上：

```
pi CLI stdout (JSONL)
  ├─ thinking 块                     ← 有
  ├─ toolCall.arguments              ← 有
  ├─ tool_execution_end.result       ← 有
  └─ message_update 增量             ← 有
        │
        ▼  ① 驱动层 parseProgressLine()
           · 只读 type==='text' 的正文块 → reasoning 模型的回复正文为空 → 返回 null
           · tool_execution_end 只取工具名和参数，不取 result
        │
        ▼  ② 格式化层 formatExecutorProgress()
           · 正则捕获了参数细节，输出时又丢掉（关键！）
        │
        ▼  ③ 前端渲染
           · 只渲染一行 summary，无展开
```

### 定位方法（可复用）

不要猜"是没产生还是没显示"，用落库的记录直接判定：

```bash
# 统计"工具开始"事件里带参数的比例
sqlite3 anyfusion.db "select count(*) from gateway_trace_read_events where body_json like '%Executor started tool%';"
sqlite3 anyfusion.db "select count(*) from gateway_trace_read_events where body_json like '%started tool%—%';"
```

实测结果：**770 条 / 0 条**。而直接调用驱动层函数能得到完整参数 —— 证明信息是在**格式化层**被删掉的，不是源头没有。

### 问题②的确切代码（最隐蔽的一处）

```ts
// src/executor/error-utils.ts （修复前）
const toolActivity =
  /^Executor (started|completed) ((?:MCP )?tool):\s*([A-Za-z0-9_.:/-]+)(?:\s+[—-][\s\S]*)?$/iu
  .exec(normalized);
if (toolActivity) {
  // 捕获组 4（参数部分）被匹配到了，却没有出现在返回值里
  return `Executor ${toolActivity[1]} ${toolActivity[2]}: ${toolActivity[3]}`;
}
```

### 问题①的确切代码

```ts
// src/executor/harness-driver.ts （修复前）
export function assistantMessageText(value: unknown): string | null {
  ...
  const text = message.content
    .filter(item => item.type === 'text' && typeof item.text === 'string')  // ← thinking 被过滤
  ...
}
```

reasoning 模型（如 deepseek-v4-flash）的助手消息常是 `[thinking, toolCall]`、正文为空 → 该函数返回 `null` → 驱动层 `message_end` 分支返回 `null` → **"stream started" 之后完全没有事件**。

## 1.3 解决方案

### 改动 1：不再丢弃参数（`src/executor/error-utils.ts`）

```ts
const toolActivity =
  /^Executor (started|completed|failed) ((?:MCP )?tool):\s*([A-Za-z0-9_.:/-]+)(?:\s+[—–-]\s*([\s\S]*))?$/iu
  .exec(normalized);
if (toolActivity) {
  const detail = toolActivity[4]?.trim();
  const suffix = detail ? ` — ${truncateText(redactSensitiveText(detail), 300)}` : '';
  return `Executor ${toolActivity[1].toLowerCase()} ${toolActivity[2]}: ${toolActivity[3]}${suffix}`;
}
```

顺带把动词从 `started|completed` 扩到 `started|completed|failed`（此前失败态落不到这条分支）。

### 改动 2：新增「工具结果摘要」（`src/executor/pi-cli-driver.ts`）

```ts
// tool_execution_end 分支
const detail = toolArgSummary(event.args);
const result = toolResultExcerpt(event.result);   // 新函数
text: `Executor ${failed ? 'failed' : 'completed'} tool: ${name}`
    + `${detail ? ` — ${detail}` : ''}${result ? ` → ${result}` : ''}`;
```

`toolResultExcerpt()` 读取 `result.content[]` 里 `type === 'text'` 的文本，压缩空白后截断 **200 字**。

### 改动 3：新增「思考摘要」（`harness-driver.ts` + driver）

```ts
// 新函数 assistantMessageThinking()：取 content 中 type === 'thinking' 的 thinking 文本
// driver 的 message_end 分支：正文为空时回落
const thinking = assistantMessageThinking(event.message);
if (thinking) {
  return { kind: 'status', text: `Executor reasoning: ${executorActivityExcerpt(thinking)}` };
}
```

## 1.4 长度预算与脱敏（关键设计）

展示"过程"不等于把原始日志倾倒给用户。所有摘要都经过 `redactSensitiveText()` 后截断：

| 字段 | 上限 | 位置 |
|---|---|---|
| 工具参数 | 120 字 | `toolArgSummary` → `executorActivityExcerpt(value, 120)` |
| 工具结果 | 200 字 | `toolResultExcerpt` |
| 思考摘要 | 240 字 | `executorActivityExcerpt` 默认值 |
| 最终单行 | 300 字（兜底 500） | `formatExecutorProgress` |

安全取舍：
- 结构化工具调用（bash 的 `command`、read 的 `path`）**展示参数**——这是用户明确要的信息；
- 非结构化的原始 shell 行（某些 CLI harness 的裸命令行）仍折叠成 `Executor started a workspace command`；
- 密钥形态（`Bearer …`、`sk-…`）由 `redactSensitiveText` 抹除，并有单测断言。

## 1.5 效果（实测输出）

```
Executor started tool: bash — grep -n "归母净利" 光伏核心28家_…/隆基绿能_601012/2025年度报告.md | head -5
Executor completed tool: bash — grep -n "归母净利" … → 1234:归属于上市公司股东的净利润 -64.20亿元
Executor failed tool: bash — cat missing.md → cat: missing.md: No such file
Executor reasoning: 年报里归母净利在"主要会计数据"一节，先定位再抽取。
```

## 1.6 为什么改完就是"准实时"（无需新建通道）

链路本来就是推送式的，**没有轮询**：

```
onProgress → appendExecutionTrace(kind = executor_progress)
           → InteractionTraceStream（内存保留最近 200 条）
           → gateway journal（持久化）
           → WebSocket trace_delta 帧
           → 前端抽屉追加 + 自动滚动（CSS 已有 white-space: pre-wrap）
```

因此本次改动**零新增基础设施**：不加模型调用、不改数据库 schema、不改协议。

## 1.7 本次未做（P1 范围）

| 项 | 说明 |
|---|---|
| 真·增量流（打字机） | Pi 的 `message_update` 里有 `thinking_delta / text_delta / toolcall_delta`，仍未解析。必须节流（建议 150–250ms 合并一帧），否则 40 分钟任务会产生上万条事件 |
| 历史深度 | 内存只留最近 200 条；全量在 journal 里，查看历史需要分页（当前每页 10 条） |
| 单事件体积 | 网关单事件上限 64KB，流式设计必须切块 |

---

# 问题二：服务日志高频刷屏

## 2a. 每 25 毫秒一条错误（属故障，必须修）

### 现象

```
Gateway journal maintenance failed: Cannot read properties of null (reading 'length')
```

单次部署累计 **417 条**，一个 60 秒观察窗口内新增 383 条。

### 根因链

```
EventJournalMaintenance 每 25ms tick（account-event-journal.ts: intervalMs: 25）
  → journal.maintain → ConversationReadProjector.apply
  → SqliteConversationReadModel.putContentChunk
  → content(): SELECT length(body), substr(body, ?, ?) ...
  → row.chunk.length        ← row.chunk 可能是 null
```

**触发条件：存储内容为空（0 字节）。** SQLite 的 `substr(x'', 1, 5)` 返回 **NULL**（而不是空 blob），于是：

- `conversation_read_bodies` 表里存在一条 `length(body)=0` 的行（空 final answer，例如被中止的 attempt；其哈希正是空串的 `e3b0c442…`）；
- 查询命中该行，`chunk` 为 NULL；
- `row.chunk.length` 抛 TypeError → 被 `onError` 捕获 → 打一条日志；
- 下一个 25ms tick 再抛一次 —— **无限刷屏**。

> 这是"日志噪音"里最危险的一类：噪音背后是真故障，而且频率由定时器决定，不是由业务决定。

### 修复（`src/storage/conversation-read-model-repo.ts`）

```ts
// 类型修正 + 归一化
{ byte_length: number; chunk: Buffer | null }
...
const chunk = row.chunk ?? Buffer.alloc(0);
recordNavigationRead('conversation_content_read', chunk.length);
if (offset > row.byte_length || (chunk.length && (chunk[0]! & 0xc0) === 0x80)) throw …
let end = Math.min(chunk.length, maxBytes);
while (end > 0 && end < chunk.length && (chunk[end]! & 0xc0) === 0x80) end--;
```

一处修复同时覆盖：`putContentChunk` 的探测读、`verifyContent` 的空内容校验、以及整个投影循环。

### 验证

- 修复前：每 25ms 一条
- 修复后：60s / 30s / 20s 三个观察窗口 **新增 0 条**
- 回归测试：写入空串 → `byteLength=0`；`putContentChunk` 不抛；`verifyContent=true`；越界 chunk 仍抛 `invalid_content_chunk`

## 2b. 每 60 秒一条空转日志（属噪音，按策略收敛）

### 现象

```
[reconciler] task state is consistent; nothing to reconcile
```

`server-composition.ts` 无条件打印 reconcile 报告的所有行，而 `task-state-reconciler.ts` 在"无事可做"时也会 push 这句话。节奏是 `setInterval(..., 60_000)` → **约 1440 行/天**，长期运行的部署里会把真实日志淹掉。

### 方案选择（三选一）

| 方案 | 效果 | 代价 | 是否采纳 |
|---|---|---|---|
| 只在有变更时打印 | 噪音归零 | 失去"服务活着"的心跳佐证 | ✗ |
| 改为 debug 级、需显式开启 | 默认静默 | 需要引入日志级别 | ✗ |
| **保留但降频（10 分钟一次汇总）** | 噪音降 10 倍，心跳保留 | 略改代码 | ✓ |

### 实现（`src/execution/reconcile-log-throttle.ts`）

> **关键原则：只节流"输出"，不降"检测"频率。** 该 reconciler 是孤儿派发项/僵尸排程的安全网，降频检测会带来风险。

```ts
observe(lines: readonly string[]): string[] {
  const findings = lines.filter(line => line !== RECONCILE_IDLE_LINE);
  if (findings.length > 0) { this.idleChecks = 0; this.loggedAt = null; return [...findings]; }
  this.idleChecks += 1;
  const at = this.now();
  if (this.loggedAt === null) {            // 启动基线
    this.loggedAt = at; this.idleChecks = 0; return [RECONCILE_IDLE_LINE];
  }
  if (at - this.loggedAt < this.intervalMs) return [];   // 窗口内静默
  const minutes = Math.max(1, Math.round((at - this.loggedAt) / 60_000));
  const idle = this.idleChecks;
  this.idleChecks = 0; this.loggedAt = at;
  return [`${RECONCILE_IDLE_LINE} (${idle} idle checks in the last ${minutes}m)`];
}
```

行为：

| 情况 | 输出 |
|---|---|
| 启动首次空闲 | 打一条基线 |
| 之后每分钟空闲 | 静默（累计计数） |
| 满 10 分钟仍空闲 | 打一条汇总，带抑制次数 |
| 出现任何真实发现 | **立即打印**，并重置窗口 |

### 验证（实等 11 分钟）

```
08:58:16 启动
09:09:16 本次进程内 reconciler 行数：1
        [reconciler] task state is consistent; nothing to reconcile (10 idle checks in the last 10m)
```

单测覆盖：基线、10 分钟窗口汇总与计数、真实发现立即打印并重置、混合报告按发现处理。

---

# 3. 三条可推广的经验

1. **永远不要在格式化边界丢信息。**
   一个"匹配到了却没用"的正则，从外部看与"上游根本没发"完全无法区分。本次能定位，靠的是"落库文本 770 条 / 0 条带参数"与"直接调用驱动可得参数"的对比 —— 所以**保留可判定的原始证据**比保留漂亮的展示更重要。

2. **定时回调里的日志必须可节流。**
   频率一旦由 `setInterval` 决定（25ms、60s），任何无条件 `console.log` 都会变成刷屏。规则：检测保持频率，输出必须有节流/去重/分级。

3. **"空值"是一等公民。**
   本次三个问题全部由空值触发：空正文（导致无进度事件）、空内容（SQLite 返回 NULL 导致崩溃）、空参数（导致只剩工具名）。凡是可能为空的地方，都要显式定义语义并加测试。

---

## 附录 A：涉及文件清单

| 类别 | 文件 |
|---|---|
| 进度提炼 | `src/executor/pi-cli-driver.ts`、`src/executor/harness-driver.ts`、`src/executor/error-utils.ts` |
| 进度展示 | `web/src/components/ExecutionDetailDrawer.tsx`（无需改动，`pre-wrap` 已支持） |
| Journal 崩溃 | `src/storage/conversation-read-model-repo.ts` |
| Reconciler 降频 | `src/execution/reconcile-log-throttle.ts`、`src/server/server-composition.ts` |
| 测试 | `tests/executor/error-utils.test.ts`、`tests/execution/reconcile-log-throttle.test.ts`、`tests/storage/conversation-read-model.test.ts` |

## 附录 B：自查命令

```bash
# 1) 判断"进度信息是被丢弃还是没产生"
sqlite3 anyfusion.db "select count(*) from gateway_trace_read_events where body_json like '%Executor started tool%';"
sqlite3 anyfusion.db "select count(*) from gateway_trace_read_events where body_json like '%started tool%—%';"

# 2) 是否存在空内容记录（会触发 substr 返回 NULL）
sqlite3 anyfusion.db "select account_id, conversation_id, hash, length(body) from conversation_read_bodies where length(body)=0;"

# 3) journal 维护错误是否仍在发生（对照观察窗口）
grep -c "Gateway journal maintenance failed" server-9001.log

# 4) 空闲日志频率（降频后应约 6 行/小时）
grep -c "\[reconciler\]" server-9001.log
```

## 附录 C：验收清单（给评审用）

- [ ] 执行面板能看到：工具名 + 命令参数 + 结果摘要 + 思考摘要
- [ ] 参数/结果/思考都有长度上限，且密钥形态被打码
- [ ] 40 分钟以上的任务，面板持续有新事件（不再出现长时间空白）
- [ ] 空内容记录不再导致 journal 维护报错（观察窗口新增 0 条）
- [ ] 空闲期 reconciler 日志约 6 行/小时，且有真实发现时立即打印
- [ ] 上述行为均有对应单测覆盖
