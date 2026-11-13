# Web 工作台四项优化设计（Logo / 会话删除 / 登录 / 附件上传）

- 状态：已确认（2026-08-22，与用户逐项评审通过）
- 计划日期：2026-08-22
- 范围：Web 工作台（`web/`）+ Management HTTP 层（`src/management/`）+ 会话存储（`src/storage/`）+ 附件链路（网关协议已就绪）
- 约束：**全部改动仅本机调试，未经用户指令不得推送 GitHub**；遵循 ADR-0020 依赖方向、ADR-0031 网关契约；持久化改动同步补 Docker 可跑的测试。

## 背景与问题

用户对 Web 工作台提出四项优化：

1. 品牌 Logo 显示为 "AnyFusion"，需改为 "MetaWork"。
2. 历史会话无法删除或清空。
3. 没有用户登录逻辑（当前仅本机 bootstrap token 自动登录）。
4. 对话输入框不支持上传附件。

现状核实结论：

- 品牌文案分布在 `SessionSidebar.tsx`、`TokenGate.tsx`、`Composer.tsx`、`App.tsx`、`web/index.html`。
- `FileWebSessionStore` 只有读/写方法；Management HTTP 已有 `/api/sessions` 列表/创建/激活路由，无删除。
- 认证为 bootstrap token 换 httpOnly cookie（`/api/auth/bootstrap`、`/api/auth/session`、`/api/auth/logout`），无账密登录。
- 网关协议 `client-protocol.ts` 的 `user_message` 已携带 `attachments: GatewayAttachmentRef[]`（≤32），但无上传端点、会话层未承载附件、Planner/Executor 链路未打通。

## 方案

### 一、Logo 改为 MetaWork（纯前端）

- `SessionSidebar.tsx`：徽标 `AF` → `MW`，标题 `AnyFusion` → `MetaWork`。
- `TokenGate.tsx`：页面主标题改为 MetaWork。
- `Composer.tsx` 占位文案、`App.tsx` 连接文案中的 "AnyFusion" 替换。
- `web/index.html` `<title>` 改为 MetaWork。
- 重新执行 `vite build` 更新 `web/dist`。
- 说明：本次只改 UI 文案；AGENTS.md 中 "AnyFusion 为公开产品名" 的全面更名由用户后续单独决策。

### 二、会话硬删除 + 清空（无确认弹窗）

后端：

- `FileWebSessionStore` 新增：
  - `deleteSession(sessionId)`：先将会话文件移入 quarantine 目录（原子、失败可恢复），再从 `catalog.json` 移除条目；
  - `clearAllSessions(exceptId)`：批量硬删除，保留当前活跃会话。
- Management HTTP 新增路由：
  - `DELETE /api/sessions/:id`：运行中/活跃会话返回 `409`；其余硬删除返回 `204`；
  - `POST /api/sessions/clear-all`：清空除活跃外全部，返回删除数量；
  - 均要求认证，未认证 `401`。

前端（`SessionSidebar.tsx`）：

- 会话行 hover 显示删除按钮，点击即删（按用户要求不加确认弹窗）；
- 「会话」计数旁新增「清空」按钮；
- 删除当前选中会话后选中态回落到活跃会话。

测试：store 单测（含损坏文件、并发写）、路由分支测试（401/409/204）。

### 三、用户登录（A 方案：服务端预设账密）

服务端：

- 凭据来源优先级：环境变量 `ANYFUSION_WEB_USERNAME` / `ANYFUSION_WEB_PASSWORD` > 启动自动生成并打印终端（`admin / <random8>`）；可选 `ANYFUSION_WEB_PASSWORD_HASH`（scrypt）避免明文落盘。
- 新端点 `POST /api/auth/login {username, password}`：
  - constant-time 比较；成功签发与 bootstrap 相同的 httpOnly 会话 cookie；
  - 内存级防爆破：同 IP 连续失败 5 次锁定 30 秒。
- 保留 `/api/auth/bootstrap` 本机自动登录与既有 logout/session 端点。

前端：

- `TokenGate` 升级为正式登录页（MetaWork 品牌、用户名+密码+错误提示），调用 `/api/auth/login`；
- 页面保留「使用访问令牌登录」小字入口兼容旧流程；
- 未认证一律先展示登录页。

测试：扩展 `tests/web/auth.test.ts`（成功/失败/锁定/cookie 生效/旧 token 回归）。

### 四、附件上传（图片 + 文本类）

架构原则：**理解在 Planner，原文随行到 Executor，小内联大引用**（对齐 ADR-0015 工具化上下文）。

1. 存储层：新增 `src/storage/file-attachment-store.ts`
   - 目录 `<data>/attachments/<sessionId>/<attachmentId>__<safe-name>`；
   - 元数据 `{attachmentId, sessionId, name, mime, kind: 'image'|'text', size, sha256, createdAt}`；
   - 限制：图片 png/jpg/webp/gif ≤10MB；文本 txt/md/csv/json/代码扩展名 ≤5MB；单条消息 ≤32 个（协议上限）；魔数嗅探校验真实类型。
2. 上传通道：`POST /api/attachments`（multipart/form-data，需认证），错误码：401 未认证 / 413 超限 / 415 类型不符。
3. Planner 理解与提炼：
   - 图片 ≤1MB 作为多模态内容块内联（Planner 模型不支持视觉时降级为仅引用并在回复中说明）；
   - 文本文件内联头部摘录（前 64 行或 8KB）供路由判断；
   - 全部附件以清单（名称/kind/路径/sha256）进入 prompt；
   - Planner 子任务指令 = 提炼意图 + 相关性批注 + 附件原文路径引用（不转写全文）。
4. Executor 接收：子任务上下文（ADR-0021 契约扩展）新增附件清单；执行后端将附件复制进 attempt 工作区（符合 ADR-0024 沙箱与 artifact gate 边界），经路径工具化读取。
5. 前端 Composer：
   - 📎 按钮 + 输入区拖拽；选择即上传并显示进度；
   - 附件 chips（图片缩略图/文件名+大小）可单个移除；
   - 发送时把 `attachmentIds[]` 写入 WS `user_message.attachments`；
   - 对话流渲染消息附件（图片预览/文件卡片）。

测试：store 单测（类型嗅探、超限、路径隔离）、路由测试、协议 parity 测试扩展、Planner prompt 组装单测。

## 实施顺序与验证

1. M1：Logo + 会话删除/清空
2. M2：登录页 + 后端账密认证
3. M3：附件全链路（存储→上传→Planner→Executor→前端）
4. 验证：每步 `npm run lint` + `npm test`；文件路径/存储相关在 Docker 跑 POSIX 套件；最终 `npm run smoke:metaclaw` 回归。

## 交付纪律

- 所有代码与文档仅本地提交，未经用户指令不推送 GitHub。
- 完成后在计划文档补记完成日期、交付行为、验证结果与收尾提交号。
