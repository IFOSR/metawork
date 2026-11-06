# Executor 工具面移除启动期 allowlist

- Status：Implemented（源码实施与聚焦验证完成；尚未安装/发布到本地 release）
- Plan date：2026-11-05
- Completion date：2026-11-05
- 触发事故：2026-11-05 会话 `conv_hxJdxPnoc3eG` 的任务
  「调研 DeepSeek Super Agents 架构并与 MetaWork 对比」三级节点
  「异同对比与 MetaWork 可借鉴建议」（attempt `…_272aac47c8e13855_primary`）。
  该 attempt 需要读取两个上游 `ResultReference`，但运行期工具面只有
  `read`/`bash`/`edit`/`write`，`result_reference_get` 不存在；模型手搓证据
  MCP JSON-RPC 四次失败后，退化为对 `~/.metawork/accounts/local-default`
  （190 GB）做 `grep -rl`，12:57:33 至 13:23:20 共 25 分 47 秒零输出，
  界面只能显示「持续无活动，正在检查执行状态」。任务最终仍成功
  （13:25:27 `succeeded`），代价是这段完全可避免的空转。
- 关联 ADR：[ADR-0052](../../docs/adr/0052-executor-owned-tool-capabilities-and-kernel-boundary.md)
  （Executor 拥有工具面；本次为 2026-11-05 修订）、
  [ADR-0053](../../docs/adr/0053-planner-graph-coordinator-and-executor-authority.md)。
- 前序方案：[Executor 工具调用级停滞自治与定向中断方案](2026-11-02-executor-tool-call-stall-autonomy.md)
  （本次停滞属于“CPU 活跃但零产出”，绕过了按静默判定的停滞守卫）。

## 1. 已核实的事实

1. `pi` 的 `--tools` 是**全局 allowlist**，pi 自身帮助文本写明
   「Applies to built-in, extension, and custom tools」。扩展注册的
   `web_search`、`web_fetch`、`evidence_*`、`result_reference_*`、`pdf_*`
   也在其过滤范围内。
2. 2026-10-28 提交 `1c3ed69c` 把 `--tools` 的来源从 `workspaceAccess` 改为
   Executor affordance 投影，`piExecutorToolArgs()` 只映射
   `workspace-command-validation`/`workspace-read-write`，因此正常 attempt
   一律以 `--tools read,bash,edit,write` 启动。该提交修掉了“只读工作区连
   shell 都没有”的旧问题，同时静默删除了全部扩展工具。
3. 实测断点：263 个 attempt 会话中，最后一个调用 `web_fetch` 的是
   2026-10-27 21:55；10-28 之后 `web_search`/`web_fetch`/`result_reference_get`
   调用次数为 0。10-27 及之前累计 `web_fetch` 3 059 次、`web_search` 1 802 次、
   `result_reference_get` 47 次。
4. 文档与实现当时已互相矛盾：`CONTEXT.md`、`docs/current/technical-overview.md`
   与 ADR-0052 都写明正常 Attempt 保留完整工具面、evidence/ResultReference
   工具为 bound attempt 无条件装配、web 工具才跟随 affordance；实现却把两者
   一起删除。
5. 唯一被裁到 `read` 的路径是 `executeResponseOnly()`（contract correction）。
   其 prompt 明确要求「Do not execute the task, use tools, inspect files,
   change the workspace」，正文也不在该 prompt 内；历史上该路径使用
   `--tools ''`。28 次 correction 平均 3.7 秒、最长 12.5 秒，说明收紧工具面
   并未损害其能力。

## 2. 决策

1. **执行型 Attempt 不再接受任何启动期工具 allowlist**：`buildLaunch` 对非
   response-only 启动不传 `--tools`/`--no-tools`，由 Pi 使用完整注册表加
   Executor 为该 Attempt 装配的扩展。affordance 只决定**装配什么**
   （`METACLAW_PI_WEB_TOOLS_ENABLED`、`seedWebExtension`、evidence 工具安装），
   不再决定**删除什么**。
2. **response-only correction 收紧到零工具**：`--no-session --no-tools`。
   该入口的契约是「只输出一条 completion trailer，不产生任何动作」，
   正文不在 prompt 内，`read` 无实际用途，故不再保留。
3. 删除 `piExecutorToolArgs()`；`HarnessLaunchInput.executorAffordances` 保留，
   因为装配与 web 开关仍依赖它。
4. 不在本次引入通用 denylist：如未来需要“某个 AgentClass 禁用某个工具”，
   应作为显式声明的 `--exclude-tools` 加真实沙箱，而不是回退到 allowlist。

## 3. 改动

- `src/executor/pi-cli-driver.ts`：正常 Attempt 不传工具参数；response-only
  改为 `--no-session --no-tools`；删除 `piExecutorToolArgs()` 与相关注释。
- `tests/executor/pi-cli-driver.test.ts`：把「由 affordance 推导工具面」改为
  「发布 affordance 也不得引入 `--tools`」的回归断言；response-only 断言改为
  无工具启动。
- `docs/adr/0052-executor-owned-tool-capabilities-and-kernel-boundary.md`：
  重写工具面段落、Consequences 与 Validation，并追加
  「Amendment: no launch-time tool allowlist (2026-11-05)」记录成因。
- `docs/current/technical-overview.md`、`docs/current/technical-overview.zh-CN.md`、
  `CONTEXT.md`：同步为「完整注册表 + 仅 response-only 缩减（无工具）」。

## 4. 验证

- `npm run lint`（tsc --noEmit）通过。
- `npx vitest run tests/executor tests/execution`：95 文件 / 701 测试全部通过。
- `npm test`：52 个失败均位于 `tests/e2e`、`tests/session`、`tests/web`、
  `tests/account`、`tests/acceptance`（源码文本断言与旧 spy 期望）；用
  `git stash` 在干净树上复跑 `tests/web/conversation-view.test.ts` 与
  `tests/e2e/independent-branch-failure.test.ts`，失败一致，确认与本次改动无关。
- `npm run build` 通过；产物中已无 affordance→allowlist 的分支，response-only
  使用 `--no-tools`。

## 5. 本地试用包（2026-11-05）

- DMG：`apps/desktop/release/MetaWork-darwin-arm64-toolfix1-20261105.dmg`
  （389,203,750 字节；SHA-256 `04e233c21d203645ad230f658aa9982dbf25ac0a866aea0ba906d3e8602a48d6`）。
- 构建方式：`node .tmp/toolfix-dmg-20261105/build.mjs`；releaseId
  `0.1.25-toolfix1-20261105`，内部（ad-hoc 签名 + 密封）包，`builtFromWorkingTree: true`，
  构建记录 `.tmp/toolfix-dmg-20261105/build-info.json`。
- 验证：`hdiutil verify` 校验通过；DMG 内含 `MetaWork.app` 与 `/Applications` 软链；
  `codesign --verify --strict` 通过；payload 内 `dist/server-composition-*.js` 已含
  `--no-tools` 且不再含 affordance→allowlist 分支；`dist/pi-attempt-tools.ts` 与
  `dist/pi-tool-stall/index.ts` 均随包存在。
- 未发布、未替换真实安装与数据库。

## 6. 未完成 / 后续

- **安装与发布**：本地运行的是 `~/.metawork/app/releases/0.1.24-tokenfix4-observation-20261105`，
  需先由用户本地试用 `toolfix1` 包并通过后，再提交与发布；发布后新工具面才会在真实 Attempt 生效。
- 生效后的确认方式：任一研究型子任务的 attempt 中应出现 `web_fetch` 或
  `result_reference_get` 调用（此前自 10-27 起为 0），且不再出现“只有 4 个工具”
  的自我盘点。
- 可选后续：把 completion trailer 的生成质量从根上收紧，使 response-only
  correction 的触发频次进一步下降；以及为“CPU 活跃但零产出”的工具调用补充
  停滞判定（见 2026-11-02 方案 §5 的后续项）。
