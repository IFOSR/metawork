# MetaWork 真实任务验收记录

**记录日期：** 2026-10-13  
**状态：** 待 Review；本记录只汇总测试结果和问题，不包含本轮新增修复。  
**测试目标：** 验证 MetaWork 是否能够通过 Planner → Kernel → Executor 真正完成用户任务，而不只是生成说明文字。

## 结论

本轮还不能证明当前 MetaWork 已经具备稳定的真实任务执行能力。原因不是执行器已经执行失败，而是实际任务在进入 Planner 之前被官方订阅授权门禁拦截：当前 Server 的官方会话状态是 `logged_out`，任务返回 `official_authorization_required`。

因此，代码修改、工具安装/卸载和网页抓取三个真实场景都没有进入 Executor，不能把它们标记为成功或失败。现有 Gateway/Pi 自动化测试大部分通过，但生产边界 smoke 仍有独立脚本/客户端契约错误。

## 测试环境和证据

- Server：本机 `127.0.0.1:8788`，运行中的版本标识为 `0.1.15-internal-provider-protocol-20261013`。
- `/api/auth/session`：返回 `200`，本机会话有效。
- `/api/config/activation-status`：`status: idle`、`workConfigurationReady: true`、无活动 Task。
- `/api/config/executors`：Pi 和 Codex CLI 均显示为可用；已配置工程师、架构师、分析师等 Executor AgentClass。
- `/api/official-auth/status`：`state: logged_out`。
- 临时测试目录：`/tmp/metawork-real-ARikTL`。
- 测试目录中没有安装软件，没有修改仓库，也没有写入系统目录。

## 真实任务场景

### 1. 代码修复并运行测试

准备的 Workspace 内容：

- `price.js`：`total(items)` 初始只累加 `price`。
- `price.test.js`：已有普通价格测试，并额外要求支持 `price * quantity`。
- `package.json`：提供 `npm test` 脚本。

发送给 MetaWork 的任务要求：先运行失败测试，定位原因，修改 `price.js`，再次运行 `npm test`，只有实际测试通过后才能报告完成。

执行结果：任务在 Gateway admission 阶段被拒绝，返回：

```text
official_authorization_required
请在本机 Web / Desktop 登录 MetaWork 官方账号并刷新权益；历史浏览、导出和取消仍可使用。
```

证据：`price.js` 保持初始内容，`price.test.js` 没有被执行或修改。

### 2. 安装、调用并卸载本地工具

准备的任务要求：

1. 只在 `tool-case` 中使用 `npm --prefix` 安装 `left-pad@1.3.0`。
2. 用 Node 实际加载并调用该包。
3. 执行卸载。
4. 运行 `verify.sh`，确认 `node_modules/left-pad` 不存在。
5. 明确禁止 `sudo`、Homebrew、MacPorts、系统目录和 Workspace 之外的路径。

执行结果：因同一官方授权门禁未进入 Planner/Executor，因此没有安装任何软件，也没有执行卸载动作。

### 3. 实际网页抓取

准备的任务要求：

- 实际访问 `https://example.com/`。
- 获取 HTTP 状态码、页面 title 和 h1。
- 写入 `web-case/scrape-result.json`。
- 运行 `verify.py` 检查 `status=200`、title 包含 `Example Domain`。
- 网络失败时必须报告失败，不允许凭记忆伪造结果。

执行结果：同样在授权门禁处停止，未发起网络请求，未生成 `scrape-result.json`。

## 已运行的自动化测试

### Gateway/Pi smoke

命令：

```text
npm run smoke:gateway
```

结果：

- MetaWork Gateway 测试：21 个文件、159 个测试通过。
- AnyFusion-Pi 测试：7 个文件、124 个测试通过。
- 随后的原生多客户端 smoke 失败：

```text
TypeError: clientA.client.resume is not a function
    at scripts/smoke-unified-gateway.mjs:176
```

这说明底层单元/集成测试通过，但完整 smoke 脚本调用了当前客户端对象不存在的 `resume()` 方法，不能据此宣称多客户端生产路径通过。

### 停止按钮修复后的回归验证

本轮之前已完成的停止链路修复验证：

```text
npm test -- --run tests/web/composer-stop-control.test.ts tests/session/turn-cancellation.test.ts
npm test -- --run tests/web/auth.test.ts tests/integration/multi-client-control.integration.test.ts
npm run lint
npm run build
```

这些检查均通过。它们验证取消命令的路由、回执、Turn 取消和多客户端控制，不等价于真实 Executor 修改文件的验收。

### Native real-task smoke 前置检查

命令：

```text
npm run smoke:metawork -- --scenario planner-session --timeout 60 --max-duration 180
```

结果：尚未开始任务即失败，因为默认 Native 配置缺少：

```text
/Users/yuanjubian/.config/metawork/provider.env
```

脚本要求运行 `npm run setup:native` 或提供完整 Native Provider 配置。当前正在运行的 Desktop/Server 使用的是另一套已安装配置，因此这条 smoke 没有复用到当前 Web 会话。

## 已发现但暂不修复的问题

### P0：真实任务验收被官方授权门禁阻断

**现象：** Web 会话可以建立，配置和 Executor 也显示 ready，但提交业务任务返回 `official_authorization_required`。  
**影响：** 用户看起来已经登录本机 Web，但官方订阅会话在 Server 重启后丢失；没有刷新权益就无法验证真实执行。  
**当前处理：** 不绕过门禁、不复用本地 Provider 密钥；等待用户在 Web/Desktop 中重新登录官方账号并刷新权益后重跑三组场景。

### P1：`smoke-unified-gateway.mjs` 调用不存在的 `resume()`

**现象：** 159 个 Gateway 测试和 124 个 Pi 测试通过后，原生多客户端 smoke 在 `clientA.client.resume()` 处崩溃。  
**影响：** 多客户端恢复/重连的完整验收无法完成。  
**当前处理：** 只记录，不在本报告中修改。

### P1：Server 日志持续输出 Gateway journal maintenance 错误

运行 Server 期间反复观察到：

```text
Gateway journal maintenance failed: Cannot read properties of null (reading 'length')
```

**影响：** 日志持续刷屏，可能掩盖真实执行错误，并说明 journal maintenance 存在未处理的空值状态。  
**因果结论：** 本轮没有证据证明它直接导致业务任务拒绝；它与官方授权门禁和 `resume()` smoke 失败分开记录。  
**当前处理：** 只记录，不修复。

### P2：真实任务 smoke 与当前 Desktop/Server 配置不一致

Native smoke 固定查找 `~/.config/metawork/provider.env`、Planner/Codex/Pi 配置；当前运行服务来自 `~/.metawork` 安装目录和官方账号会话。两者配置根不一致，导致“脚本前置检查失败”和“Web 任务授权失败”是两条不同阻断链路。

**影响：** 现有 smoke 命令不能直接代表用户当前 Desktop 配置的真实执行能力。

## 尚未得到的结论

以下问题本轮没有足够证据判断：

- Pi/Codex 是否在当前官方授权恢复后真正修改文件并运行测试。
- Executor 是否会在“只输出成功声明、实际没有文件变化”时被 Completion Protocol 正确拦截。
- 本地 npm 工具安装、卸载以及权限边界是否能正常工作。
- 浏览器/HTTP 抓取是否能产生可验证产物。
- 长任务、取消、重连和清理阶段的最终状态是否能稳定收敛。

这些必须在官方登录恢复后，通过临时 Workspace 的实际文件、进程退出码、Task 状态、Subtask 状态、Attempt receipt 和产物路径共同确认，不能只看模型回复。

## 建议的下一轮验收顺序

1. 登录官方账号并刷新权益。
2. 重跑代码修复场景，核对 `price.js` 的实际 diff 和 `npm test` 退出码。
3. 重跑安装/卸载场景，核对包实际存在、可调用、卸载后不存在，并检查系统目录无变化。
4. 重跑网页抓取场景，核对真实网络响应、JSON 内容和独立验证脚本。
5. 对每个任务同时读取 Gateway 结果和权威数据库状态，确认没有“报告完成但没有实际副作用”。
6. 单独修复或更新 `resume()` smoke 契约后，再做多客户端恢复验收。

