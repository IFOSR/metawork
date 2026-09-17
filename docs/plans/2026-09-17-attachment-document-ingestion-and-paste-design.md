# 附件上传与粘贴截图：问题、现状、需求与方案

> **Status:** Draft（待决策：第 5 节解析方案 1/2/3）
> **Date:** 2026-09-17
> **范围:** Web 输入框附件链路（上传 → 存储 → Planner 上下文 → Executor 工作区）、文档类格式支持、粘贴截图
> **相关:** ADR-0015（Planner 语义与工具化上下文）、ADR-0038（Executor 上下文连续性）

---

## 1. 问题

### 1.1 用户报告的现象

1. **无法上传附件**：点击回形针打开系统文件对话框后，文件**选不中**（表现为文件被置灰、点不动）。
2. **附件被拒**：拖入 `.docx` 后报错

   ```
   上传 首农团餐智能配餐系统整体设计方案.docx 失败:
   HTTP 415:{"error":"Unsupported attachment type for \"首农团餐智能配餐系统整体设计方案.docx\"
   (extension .docx); allowed: images (png/jpg/webp/gif) and text files."}
   ```

3. **无法粘贴截图**：不能通过 `Ctrl/Cmd+V` 把剪贴板里的截图直接贴进输入框。

### 1.2 代码定位（证据）

| # | 现象 | 位置 | 机制 |
| --- | --- | --- | --- |
| 1 | 文件选不中 | `web/src/components/Composer.tsx:138` | `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,…">` 白名单不含 `.docx`，系统对话框因此置灰该文件 |
| 2 | 415 拒绝 | `src/storage/file-attachment-store.ts:270-287` | `sniffOrThrow()`：先按魔数识别图片（`:55`），再查 `TEXT_EXTENSIONS`（`:66`），都不命中即抛 `AttachmentTypeError` |
| 2 | 错误文案 | `src/storage/file-attachment-store.ts:285` | 英文原文；经 `src/management/server.ts:434-439` 以 `HTTP 415:{"error":…}` 透传到 UI |
| 2 | 拖放绕过 accept | `web/src/components/Composer.tsx:79-86` | `onDrop` 直接取 `dataTransfer.files` 交给上传，**不做客户端预检**，所以拖 `.docx` 才会走到服务端 415 |
| 3 | 无粘贴能力 | `web/src/` 全局 | 搜 `onPaste` / `clipboardData` **零命中**：输入框只实现拖放与点击选择，剪贴板图片数据被浏览器默认行为丢弃 |

### 1.3 影响面

- 用户以为"文件选择器坏了"，实际是类型门禁**静默置灰**且没有解释。
- 报错是英文 + 裸 HTTP 状态码，与产品其余中文体验不一致。
- 办公文档（`.docx`/`.pdf`/`.xlsx`/`.pptx`）**完全不可用**——不是配置问题，是链路里从来没有这条能力。
- 粘贴截图缺失，与"可拖入或点击 📎 添加图片/文本附件"的占位符承诺不匹配（占位符没承诺粘贴，但这是用户的默认预期）。

---

## 2. 需求与已确认决策

### 2.1 用户明确要求

1. **办公文档必须完全支持**——"这些都是基础的文件格式，必须完全支持"。
2. **必须支持粘贴截图**。
3. **不要重复造轮子**——成熟库/工具已经解决解析，不应自研 ZIP/XML 解析器。

### 2.2 已确认

| 项 | 结论 |
| --- | --- |
| 解析责任 | 不自研解析器（撤回上一版"最小 ZIP 读取器"方案） |
| 粘贴截图 | 采用 `onPaste` + `clipboardData.items` 取 `image/*`，复用既有上传链路 |
| 类型清单 | 收敛为**单一来源**（现状 `accept` 与 `TEXT_EXTENSIONS` 是两份手工维护的相同列表，必然漂移） |

### 2.3 明确排除（见第 6 节）

`.doc` `.xls` `.ppt`（OLE 二进制老格式）、`.pages` `.key` `.numbers`（Apple 私有格式）、加密文档、扫描件 OCR。

---

## 3. 现状链路（事实基线）

### 3.1 上传

```
POST /api/attachments?sessionId&name      (src/management/server.ts:638 → 420-440)
  └─ FileAttachmentStore.saveAttachmentStream()
       识别：图片魔数 → 文本扩展名 → 否则 AttachmentTypeError/415
       落盘：<root>/<sessionId>/<attachmentId>__<safeName> + 同名 .meta.json
       限制：⛔ 无任何大小上限（可写满磁盘）
```

### 3.2 进入 Planner / Executor

```
提交消息 (src/management/web-gateway-session-runtime.ts:196-227)
  ├─ MAX_ATTACHMENTS_PER_MESSAGE = 32      (:28)
  ├─ MAX_ENRICHMENT_BYTES = 16 KB（所有附件共享） (:29)
  ├─ 文本附件 → buildTextExcerpt()：仅"前 64 行"原始字节 (:50-56, :212-215)
  ├─ 图片附件 → 走多模态 images 通道（内容原生给 Planner），此处只留路径 (:216-217)
  └─ 每个附件附一行「路径: <账号目录绝对路径>」(:210)
        ↓
  增强后的文本成为 Conversation 用户消息
        ↓
  物化为 current_user_input 任务证据 (src/execution/work-graph-runtime-service.ts:216-224)
        ↓
  Executor attempt：workingDirectory = 任务工作区 (src/execution/subtask-attempt-runner.ts:550)
```

### 3.3 关键结论：模型实际只能看到 16KB 摘录

- Planner 侧：文本附件只给"前 64 行"，文档类若放行则会是**二进制乱码**。
- "让 Executor 按路径读原文"**并不可靠**：附件存在账号数据目录，而 attempt 的 cwd 是任务工作区；原生 attempt 同用户大概率可读，**Docker attempt 未挂载账号目录则读不到**。
- `ContextRef` 现有类型（`src/planning/planning-agent-plan-schema.ts:59-73`）为 `current_user_input`/`interaction`/`artifact`/`task_resource`/`task_evidence`/`preference`——**没有"附件"这一类**。

### 3.4 环境能力矩阵（决定方案可行性的核心事实）

| 环境 | 可用的文档转换工具 |
| --- | --- |
| 原生 macOS attempt | `PATH` 在环境白名单内（`src/executor/harness-driver.ts:106-122`）→ `pdftotext` ✅ `pandoc` ✅ `unzip` ✅ `textutil` ✅ |
| Docker `attempt-codex` | `docker/Dockerfile.attempt-codex:8-9` 仅 `bash ca-certificates git python3 ripgrep` ❌ |
| Docker `attempt-pi` | `docker/Dockerfile.attempt-pi:7-8` 仅 `bash ca-certificates git python3 ripgrep curl` ❌ |
| Docker `runtime`（Server 本体） | `docker/Dockerfile.runtime:59-60` 无转换工具 ❌ |

**并且当前环境里 agent 并没有现成的文档能力**：

| 检查 | 结果 |
| --- | --- |
| Pi CLI 内置工具（`planner/AnyFusion-Pi/packages/coding-agent/src/core/tools`） | 仅 `read` `write` `edit` `bash` `grep` `find` `ls` |
| Pi 源码中的 pdf/docx/xlsx 处理 | 无 |
| 用户级 skill（43 个） | 无本地文档读取类；仅 `lark-doc`（飞书云文档）、`zhixiang-documents`（知识库上传） |

> 因此"让 agent 自己用成熟工具读"**只在原生 attempt 成立，在 Docker 沙箱不成立**；`完全支持` 若依赖它，就是依赖运行期环境而非产品能力。

---

## 4. 方案

### 4.1 总体架构

```
上传
 ├─ 识别：图片魔数 → 文档/文本扩展名（与服务端能力清单同源）
 ├─ 校验：单文件 ≤ 25 MB、总数 ≤ 32、文本抽取 ≤ 2 MB（超出截断并标注）
 ├─ 抽取：成熟解析库 → 纯文本（warnings / truncated）
 ├─ 落盘：<id>__<name>                    ← 原件
 │        <id>__<name>.extracted.txt      ← 派生全文（可复现、可缓存）
 └─ meta.json 增 extraction: { status, extractor, charCount, truncated, reason }
        │
        └─ 失败 → 立即 4xx + 中文可操作提示（不再等到发消息才暴露）
        ↓
提交消息
 ├─ Planner 摘录：来自 extracted 文本（不再是二进制前 64 行）
 ├─ 预算：建议 16 KB → 64 KB，并按附件数均分
 └─ 全文投递：把「原件 + extracted.txt」复制进任务工作区，
              消息里给「工作区相对路径」→ Executor 必定可读（含 Docker 沙箱）
```

**核心判断：MetaWork 只做"验收 + 抽取 + 投递 + 提示"，不自研格式解析。**

### 4.2 解析方案（三选一，实测数字）

| | 依赖 | 覆盖格式 | node_modules | 发布包增量 | Docker 一致性 | 需改镜像 |
| --- | --- | --- | --- | --- | --- | --- |
| **方案 1** | `officeparser@8` | **`.docx .pptx .xlsx .odt .odp .ods .odg .pdf .rtf .html .epub .csv .md`** | 149 MB | **+47.4 MB** | ✅ | 否 |
| **方案 2** | `mammoth` + `unpdf` + `exceljs` + `node-html-markdown` | `.docx .pdf .xlsx .html`（**缺 pptx / odt 系**） | 14 MB | +2.5 MB | ✅ | 否 |
| **方案 3** | 无（调宿主 CLI） | 依赖工具可用性 | ~0 | ~0 | ❌ 需补工具 | 是（3 个镜像） |

实测命令与结果：

```
npm install officeparser              → 149 MB / 压缩 47.4 MB；puppeteer 是 optional peer，实测未安装
npm install mammoth unpdf …           → 14 MB / 压缩 2.5 MB
当前 runtime tarball 基线              → 14.3 MB
```

`officeparser` 兼容性：`engines.node >= 22.13.0`（本项目要求 22.19+），提供 ESM 导出（`dist/index.mjs`）。

**推荐：方案 1。** 理由：

1. `.pptx` / `.odt` / `.ods` 在 Node 生态里**没有**其它可维护的独立库，只有 `officeparser` 一家全覆盖——自己写才叫造轮子。
2. 不在原生/Docker 之间产生行为差异；可单测；上传即失败可见。
3. 不需要给 3 个 Docker 镜像补系统工具，不动 attempt 运行期环境。
4. 唯一代价是发布包 +47 MB（一次性、可量化）。方案 2 省下 45 MB 换来的是"用户点名要求的格式不支持"。

**若必须零依赖**：只能选方案 3，并须接受"补 3 个镜像 + 原生探针 + 行为依环境而异"。

### 4.3 契约变更

| 变更 | 位置 | 说明 |
| --- | --- | --- |
| `AttachmentKind` 增 `'document'` | `src/storage/file-attachment-store.ts:25` | `enrichWithAttachments` 中 `document` 走 extracted 文本；图片通道不变 |
| `meta.json` 增 `extraction` | 同上 | `{ status, extractor, charCount, truncated, reason }` |
| 上传错误码 | `src/management/server.ts:434-439` | 415 语义保留，但错误体改为结构化 + 中文文案 |
| 能力清单端点（新增） | `src/management/server.ts` | `GET /api/attachments/capabilities` → 前端 `accept` 的唯一来源 |

不修改 `PlanningAgentPlan` schema（v8）：抽取文本随既有 `current_user_input` 通道进入证据链，避免触达 Planner 契约（那是 P1）。

### 4.4 边界与失败模式

| 情况 | 处理 |
| --- | --- |
| 原件过大 | 上限 **25 MB**（今天**完全没有上限**） |
| 抽取文本过大 | 上限 **2 MB**，超出截断并在 meta 与 UI 标注"已截断" |
| 加密 PDF / 扫描件（无文本层） | 抽取返回空 → 中文提示；扫描件引导改用截图（图片通道已可用） |
| 损坏文件 / 伪造扩展名 | 解析失败 → 明确中文提示，不落半成品 |
| 附件总数 | 32（沿用） |
| `.doc` `.xls` `.ppt` | 明确不支持 → "请另存为 `.docx`/`.xlsx`/`.pptx`" |
| `.pages` `.key` `.numbers` | 明确不支持 → 提示导出为 Office 格式 |

### 4.5 前端

1. **类型清单单一来源**：`accept` 由 `GET /api/attachments/capabilities` 生成，并加一致性测试（现状两份列表必然漂移）。
2. **选择器不再"选不中"**：放宽/移除 `accept` 的硬过滤（仅作建议），改为**选中后本地预检 + 中文提示**，不再静默置灰。
3. **粘贴截图**：`Composer` 增 `onPaste` → 取 `clipboardData.items` 中 `image/*` → 转 `File` → 与拖放/点击**共用同一上传函数**；纯文本粘贴保持默认行为不拦截。
4. **附件状态可见**：每个附件显示「抽取中 / 已抽取 N 字 / 已截断 / 不支持（原因）」，替代单行红色 415。
5. 三条入口（点击 / 拖放 / 粘贴）走同一校验与同一上传路径。

### 4.6 测试计划

- `tests/fixtures/attachments/`：真实小样本——docx（含中文与表格）、xlsx、pptx、pdf（有文本层）、pdf（扫描件，期望空）、rtf、损坏 zip、加密 pdf、超大文件
- 抽取器逐格式单测：段落/表格/中文/换行正确性、`warnings`、截断行为
- 上传端点：新错误码与中文语义、25 MB 上限、`extraction` 落盘
- 摘录回归（**关键**）：`document` 必须使用 extracted 文本，禁止出现二进制内容
- 投递：原生与 Docker 下 attempt 都能按工作区相对路径读到全文
- 前端：能力清单一致性、`onPaste`（构造 `ClipboardEvent`）、三入口行为一致
- E2E：拖入 `.docx` → 上传成功 → Planner 消息含真实文本摘录

### 4.7 分期

- **P0（本次）**：解析库接入 + 契约 + 上传校验与上限 + 摘录改用 extracted + 工作区投递 + 前端三入口与错误体验
- **P1（另立方案，可能需 ADR）**：附件作为一等 `ContextRef`（需改 plan schema，属 Planner 契约变更）、扫描件 OCR、文档内嵌图片抽取、超长文档分块/摘要

---

## 5. 待决策

1. **解析方案选 1 / 2 / 3？**（推荐 1；若在意发布包体积则选 2，并把 `.pptx`/`.odt` 明确列为 P1）
2. **摘录预算是否从 16 KB 提到 64 KB**（并按附件数均分）？不提高则长文档 Planner 仍只看开头。
3. **"附件投递进任务工作区"是否纳入 P0**（建议纳入；否则 Docker 沙箱下"完全支持"不成立）。

---

## 6. 明确不做

- 不自研 ZIP/XML/OOXML 解析器。
- 不支持 OLE 二进制老格式（`.doc`/`.xls`/`.ppt`）与 Apple 私有格式（`.pages`/`.key`/`.numbers`）。
- 不做 OCR（扫描件引导用户提供文本版或改用截图）。
- 不在 P0 修改 `PlanningAgentPlan` schema。

---

## 附录：复现与证据命令

```bash
# 类型白名单（前端）
grep -n "accept=" web/src/components/Composer.tsx

# 服务端类型判定与 415
sed -n '270,290p' src/storage/file-attachment-store.ts
sed -n '420,440p' src/management/server.ts

# 摘录预算与摘录实现
grep -n "MAX_ENRICHMENT_BYTES\|MAX_ATTACHMENTS_PER_MESSAGE\|buildTextExcerpt" \
  src/management/web-gateway-session-runtime.ts

# 确认没有粘贴处理
grep -rn "onPaste\|clipboardData" web/src/ || echo "(无)"

# 环境能力：Docker 镜像内工具
grep -n "apt-get install" docker/Dockerfile.attempt-codex docker/Dockerfile.attempt-pi docker/Dockerfile.runtime

# 环境能力：原生 PATH 白名单
sed -n '106,122p' src/executor/harness-driver.ts

# 解析方案实测
npm view officeparser version dist.unpackedSize engines dependencies
```
