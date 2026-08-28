# MetaWork Pi TUI System Command Separation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Approved, pending implementation

**Plan date:** 2026-08-28

**Review completed:** 2026-08-28; no product decisions remain open.

**Design:** [MetaWork Pi TUI 系统命令与 AI 任务分离设计](2026-08-28-pi-tui-system-command-separation-design.md)

**Goal:** 保留现有 `pi-tui`，让系统命令快速、紧凑地展示，让普通输入继续使用真实
AI 任务生命周期，并修复已复现的基础交互 Bug。

**Architecture:** Gateway v2 继续使用现有事件和 `commandKind`。只有
`user_message` 作为 `ai_turn` 并等待语义异步工作；其他 command kind 作为
`system_command`，等待命令本身完成但不等待无关后台任务。Pi reducer 和 view 分别
投影两种交互，Web 保持不变。

**Tech Stack:** Node 22.19+, TypeScript ESM, Vitest, Gateway v2,
`@earendil-works/pi-tui`.

---

## 实施约束

- 直接在当前主干实施，不创建分支或 worktree。
- 不覆盖当前 worktree 中已有的 build、installer 和 Orca Enter 修改。
- 不新增 Gateway event kind，不升级协议，不引入新 TUI package。
- 不修改 Web 页面、组件、样式或交互。
- 每个生产修改先写失败测试，再写最小实现。
- 分阶段提交，不推送 GitHub。

## Task 1: 修正 Gateway 系统命令等待

**Files:**

- Modify: `src/gateway/conversation-gateway-runtime.ts`
- Test: `tests/gateway/conversation-gateway-runtime.test.ts`
- Test: `tests/session/conversation-session.test.ts`

**Steps:**

1. 增加 `/help` 不调用 Planner 的测试。
2. 构造未完成的 Conversation background work，增加 `/help` 在后台任务完成前已经
   completion 的失败测试。
3. 增加 `user_message` 仍等待自身异步工作并产生 `final_answer` 的回归测试。
4. 运行：

```bash
npm test -- \
  tests/gateway/conversation-gateway-runtime.test.ts \
  tests/session/conversation-session.test.ts
```

5. 在 Gateway 中按 command kind 设置：

```ts
awaitAsyncWork: mailboxCommand.command.kind === 'user_message'
```

6. 保持 `await conversation.executeGatewayCommand(...)`，确保系统命令 handler 自身
   已完成；禁止恢复全局 `backgroundWork` 等待。
7. 重跑测试并提交：

```bash
git commit -m "fix: keep system commands off semantic background waits"
```

## Task 2: 在 Pi TUI 中分开两类 interaction

**Files:**

- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-model.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-reducer.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-view.ts`
- Test: `planner/AnyFusion-Pi/packages/coding-agent/test/metawork-client-reducer.test.ts`
- Test: `planner/AnyFusion-Pi/packages/coding-agent/test/metawork-client-view.test.ts`

**Steps:**

1. 增加 `slash_command`、`permission_resolution`、`cancel_turn` 都归类为
   `system_command` 的失败测试。
2. 断言系统命令完成或失败后只有 command output/error，`currentTurn` 为空。
3. 增加 `user_message` 仍归类为 `ai_turn`、保留六阶段和结果的回归测试。
4. 增加 replay/live 等价、命令与后续 AI Turn 不互相继承输出的测试。
5. 运行：

```bash
npm --prefix planner/AnyFusion-Pi/packages/coding-agent test -- \
  test/metawork-client-reducer.test.ts \
  test/metawork-client-view.test.ts
```

6. 增加 `system_command | ai_turn` 分类和最小 command view model。
7. Result/error reducer 根据 interaction kind 更新 command 或 AI Turn。
8. View 对系统命令只显示“命令执行中/命令结果/命令失败”；只有 AI Turn 显示
   “任务进度/最终结果/结果已验证”。
9. 重跑测试并提交：

```bash
git commit -m "fix(tui): separate system commands from ai turns"
```

## Task 3: 修复现有 Pi TUI 基础交互 Bug

**Files:**

- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/anyfusion-client-mode.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/metawork-client-view.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/components/metawork-conversation-selector.ts`
- Modify: `planner/AnyFusion-Pi/packages/tui/src/terminal.ts`
- Test: corresponding files under `planner/AnyFusion-Pi/packages/coding-agent/test/`
- Test: `planner/AnyFusion-Pi/packages/tui/test/terminal.test.ts`

**Steps:**

1. 增加并修复以下回归测试：

- 连接状态只出现一次；
- 使用真实 Terminal width，不固定为 120；
- 长 `/config` 输出下 Composer 仍可见，并有截断或翻页提示；
- 新 interaction 不继承旧命令结果；
- `/conversations` 的 attach/create/Esc 后焦点回到 Editor；
- selector 默认以 title/status 为主，不突出内部 ID；
- 已知内部错误转换为用户可读提示；
- Orca `\n`、普通 `\r`、Apple Terminal Shift+Enter、Kitty 和 bracketed paste
  输入不冲突。

2. 优先复用 `pi-tui` 已有 viewport、Editor 和 selector 能力，不新增 package。
3. 运行：

```bash
npm --prefix planner/AnyFusion-Pi/packages/tui test
npm --prefix planner/AnyFusion-Pi/packages/coding-agent test -- \
  test/anyfusion-client-mode.test.ts \
  test/metawork-client-view.test.ts \
  test/metawork-conversation-selector.test.ts
npm --prefix planner/AnyFusion-Pi run build:offline
```

4. 提交：

```bash
git commit -m "fix(tui): stabilize terminal interaction and presentation"
```

## Task 4: 兼容回归和真实验收

**Files:**

- Modify tests under `tests/gateway/` only as needed
- Modify this design and implementation plan when closing
- Modify: `docs/README.md`
- No production changes under `web/src`

**Steps:**

1. 增加 Gateway 测试证明 slash command 仍发布现有 result/final payload，
   `user_message` 的语义事件保持不变，replay 保留 `commandKind`。
2. 运行完整门禁：

```bash
npm run lint
npm test -- \
  tests/gateway/conversation-gateway-runtime.test.ts \
  tests/session/conversation-session.test.ts \
  tests/gateway/file-event-journal.test.ts
npm run build --prefix web
npm --prefix planner/AnyFusion-Pi/packages/tui test
npm --prefix planner/AnyFusion-Pi/packages/coding-agent test -- \
  test/metawork-client-reducer.test.ts \
  test/metawork-client-view.test.ts \
  test/anyfusion-client-mode.test.ts \
  test/metawork-conversation-selector.test.ts
```

3. 确认 `git diff -- web/src` 为空。
4. 构建并启动最新本地版本：

```bash
metawork build
metawork server restart
metawork server status
metawork tui
```

5. 在真实 TUI 中依次验证：

```text
/help
/config
/task list
/does-not-exist
只回答当前 Workspace 的目录名称，不修改文件。
/conversations
```

6. 验收前四条只显示命令结果/失败；普通输入显示真实 AI 过程；长输出、Enter、焦点、
   状态栏和退出后 Server 常驻均正常。
7. 启动 `metawork web`，执行一个 slash command 和一个普通只读请求，确认现有 Web
   展示与交互无回归。
8. 将文档状态改为 Completed，记录完成日期、测试和 closing commit，提交文档；不推送
   GitHub。

## 完成定义

- 系统命令不进入 Planner、不显示 AI 阶段、不等待无关后台任务。
- 普通输入的 AI 任务流程和结果完整性无回退。
- Enter、长输出、重复状态和 selector 焦点问题关闭。
- replay 分类稳定，Web 生产代码不变且 build 通过。
- `metawork build` 后真实 Server/TUI/Web 联调通过。
- 文档完成记录已补齐，没有推送 GitHub。
