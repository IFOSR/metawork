# Web 工作台四项优化实施计划

> **状态：已全部交付（2026-08-22，本机验证通过，未推送远程）**
>
> 交付提交：
> - `2d186e6` feat: rename web brand to MetaWork and add hard session deletion（M1）
> - M2 登录提交（feat: add username/password login for web workspace）
> - M3 附件提交（feat: end-to-end attachment pipeline for web conversations）
>
> 验证：`npm run lint` 通过；全仓 vitest 套件分域全部通过（session/planning/kernel/execution/executor/management/storage/web 等，仅 Docker-only 集成用例按预期跳过）；`web/dist` 已重建。
>
> 已知 MVP 边界：图片附件在 Planner 侧以路径引用降级（无视觉通道）；Executor 沙箱内通过绝对路径读取附件原文，attempt 工作区物理复制留作后续增强。

**Goal:** 为 Web 工作台交付 Logo 更名、会话硬删除/清空、账密登录、附件上传四项能力。

**Architecture:** 前端 React/Vite（`web/`），HTTP 层 `src/management/server.ts`，会话存储 `FileWebSessionStore` + `WebSessionCatalog` + `ManagementWebSessionRuntime` 三层，认证复用 `WebAuthService` 的会话 cookie，附件走「存储层 → 上传端点 → Planner 理解 → Executor 工作区」链路。

**Tech Stack:** TypeScript ESM（Node 22.19+）、node:test（仓库测试框架）、React 18、Vite。

---

## M1：Logo 更名 + 会话删除/清空

### Task 1: Logo 文案改为 MetaWork

- Modify: `web/src/components/SessionSidebar.tsx`（`AF`→`MW`，`AnyFusion`→`MetaWork`）
- Modify: `web/src/components/TokenGate.tsx`（`<h1>`）
- Modify: `web/src/components/Composer.tsx`（占位文案）
- Modify: `web/src/App.tsx`（连接中文案）
- Modify: `web/index.html`（title）
- Test: `tests/web/workspace-shell.test.ts` 断言品牌文案处同步更新
- 验证：`cd web && npx vitest run src`（如有组件测试）或根目录 `npm test -- tests/web`

### Task 2: FileWebSessionStore 删除方法

- Modify: `src/storage/file-web-session-store.ts`
  - 新增 `async deleteSession(sessionId): Promise<boolean>`：校验 ID 合法 → `rename` 会话文件到 quarantine 目录（`<id>.<ts>.deleted.json`）→ 从 catalog 移除条目并原子写回 → 返回是否存在过
  - 新增 `async deleteAllSessions(exceptId?): Promise<number>`：批量执行上述步骤，返回删除数
- Test: `tests/storage/file-web-session-store.test.ts`
  - 删除存在的会话：catalog 与文件均移除，返回 true
  - 删除不存在的会话：返回 false 且不动 catalog
  - `deleteAllSessions(exceptId)`：保留 exceptId，其余删除
  - 非法 ID 抛错
- 运行：`npm test -- tests/storage/file-web-session-store.test.ts`

### Task 3: Catalog 与 Runtime 层暴露删除

- Modify: `src/management/web-session-catalog.ts`：新增 `deleteSession(id)`、`clearAll(exceptId?)`（封装 store 并维护内存索引，若有）
- Modify: `src/management/web-session-runtime-types.ts`：`ManagementWebSessionRuntime` 增加 `deleteSession(id): Promise<'deleted' | 'not_found' | 'active'>`、`clearAllSessions(): Promise<{ deleted: number }>`
- Modify: `src/management/web-gateway-session-runtime.ts`：
  - `deleteSession`：目标为当前活跃会话时返回 `'active'`（路由转 409）；否则调 catalog 删除并发 `session_catalog` 事件
  - `clearAllSessions`：以当前活跃会话为 except 调 catalog.clearAll 并发事件
- Test: 扩展 `tests/web/conversation-view.test.ts` 或就近的 runtime 测试

### Task 4: Management HTTP 路由

- Modify: `src/management/server.ts`（在 `sessionMatch` 路由附近）
  - `DELETE /api/sessions/:id` → 401 / 409（active）/ 404 / 204
  - `POST /api/sessions/clear-all` → 200 `{ deleted: number }`
- Test: `tests/web/` 新增或扩展 server 路由测试（参照现有 `/api/sessions` 测试基建）

### Task 5: 前端接入

- Modify: `web/src/api/http.ts`：`deleteSession(id)`、`clearSessions()`
- Modify: `web/src/components/SessionSidebar.tsx`：
  - props 增加 `onDelete(sessionId)`、`onClearAll()`；
  - 行 hover 显示「删除」（`.session-row-delete`）；「清空」按钮放计数旁（仅 sessions.length > 0 时显示）
- Modify: `web/src/styles.css`：删除按钮与清空按钮样式
- Modify: `web/src/App.tsx`：接两个 handler——删除后若删的是选中项则回落到活跃会话；成功后刷新列表（优先依赖 WS `session_catalog` 事件）
- Test: `tests/web/workspace-shell.test.ts` 扩展

### Task 6: M1 构建与回归

- `cd web && npm run build`（更新 dist）
- 根目录 `npm run lint`、`npm test`
- 本地提交：`feat: rename web brand to MetaWork and add hard session deletion`

## M2：账密登录

### Task 7: 凭据提供者

- Create: `src/management/login-credentials.ts`
  - `resolveLoginCredentials(env)`：读 `ANYFUSION_WEB_USERNAME`/`ANYFUSION_WEB_PASSWORD`（可选 `ANYFUSION_WEB_PASSWORD_HASH`，scrypt 格式 `salt:hash`）；未配置则生成 `admin` + 随机 8 位密码
  - `verifyLogin(username, password, creds)`：constant-time 比较（明文或 hash）
- Test: `tests/management/login-credentials.test.ts`（env 解析、hash 校验、生成回退、constant-time 不抛错）

### Task 8: 登录端点 + 防爆破

- Modify: `src/management/web-auth.ts`：新增 `loginAttempts` 内存结构（IP → {fails, lockedUntil}），`registerLoginFailure(ip)` / `isLocked(ip)`（5 次锁 30s）
- Modify: `src/management/server.ts`：
  - `POST /api/auth/login`（在认证检查之前注册）：锁定返回 429；凭据错误 401；成功 `Set-Cookie: sessionCookie()` + 204
  - deps 注入 credentials
- Test: 扩展 `tests/web/auth.test.ts`（成功设 cookie、错密码 401、5 次后 429、bootstrap 回归）

### Task 9: 登录页前端

- Modify: `web/src/api/http.ts` 或新建 `login()` helper（POST /api/auth/login）
- Modify: `web/src/components/TokenGate.tsx` → 升级为登录页（用户名+密码表单、MetaWork 品牌、错误条、底部「使用访问令牌登录」切换链接保留旧 token 输入）
- Modify: `web/src/App.tsx`：未认证渲染登录页；登录成功进入工作台
- Modify: `web/src/styles.css`：登录页样式
- Test: `tests/web/workspace-shell.test.ts` 相应断言

### Task 10: M2 构建与回归

- `cd web && npm run build`；`npm run lint`、`npm test`
- 本地提交：`feat: add password login for web workspace`

## M3：附件上传（图片 + 文本类）

### Task 11: 附件存储层

- Create: `src/storage/file-attachment-store.ts`
  - `saveAttachment({sessionId, name, bytes})` → `{attachmentId, name, mime, kind, size, sha256}`
  - 类型嗅探（魔数）：png/jpg/webp/gif → kind `image`（≤10MB）；文本扩展名白名单 → kind `text`（≤5MB）；不符抛 `AttachmentTypeError`
  - 目录 `<data>/attachments/<sessionId>/<attachmentId>__<safe-name>`
- Test: `tests/storage/file-attachment-store.test.ts`（类型嗅探、超限、路径穿越拒绝、元数据往返）

### Task 12: 上传端点

- Modify: `src/management/server.ts`：`POST /api/attachments`（multipart/form-data 解析，需认证）→ 201 元数据 / 401 / 413 / 415
- Test: 路由测试

### Task 13: Planner 链路

- Modify: 会话输入承载附件（`web-gateway-session-runtime.ts` submit 已有 `attachments: []` 占位 → 传入真实 refs；`client-protocol.ts` 已支持）
- Modify: Planner prompt 组装（定位 `src/planning/` 中 prompt 构建点）：
  - 图片 ≤1MB 内联多模态块（模型不支持视觉时降级引用）
  - 文本文件头部摘录（64 行 / 8KB）
  - 附件清单（name/kind/path/sha256）
- Test: prompt 组装单测

### Task 14: Executor 接收

- Modify: 子任务上下文（ADR-0021 契约）增加附件清单字段；attempt 启动时复制附件进工作区（对齐 artifact gate）
- Test: 执行链路单测

### Task 15: 前端 Composer

- Modify: `Composer.tsx`（📎 按钮、拖拽、chips、进度）、`ConversationTurn.tsx`（消息附件渲染）、`http.ts`（uploadAttachment）
- Modify: 发送逻辑把已传 `attachmentIds[]` 写入 WS 消息
- Test: `tests/web/workspace-shell.test.ts`

### Task 16: M3 构建与总回归

- `cd web && npm run build`；`npm run lint`、`npm test`
- Docker POSIX 测试：`docker build -f Dockerfile.test -t metaclaw-test . && docker run --rm metaclaw-test`
- `npm run smoke:metaclaw`
- 本地提交：`feat: end-to-end attachment pipeline for web conversations`

---

## 纪律

- 全程本地提交，**不推送 GitHub**。
- 每个任务完成即验证，不留红色测试。
