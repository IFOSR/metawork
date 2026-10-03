# TUI 工作区任务概览与切换

- 日期：2026-10-03；实施完成日期：2026-10-03。状态：代码及定向验证完成，已纳入实施提交并按用户授权同步 GitHub。
- 用户约束：左侧保留现有执行过程；右侧改为跨会话的任务概览与选择入口。
- Owner：native TUI presentation/controller 负责列表、焦点、导航与草稿；Gateway/Application Shell 提供授权目录、活动任务及 Task 到 Turn 定位；Task Domain 继续拥有状态语义。
- 复用 Workspace 目录和 Conversation activity 资源，按目录页加载任务，超出范围明确提供加载入口；后台定时刷新与当前观察增量更新，不为每个任务保持完整历史订阅。
- 右侧显示状态汇总、任务名、所属会话；F6 聚焦，方向键选择、Enter 查看，Esc 返回编辑；窄屏同一列表以浮层呈现。不展示单任务 trace、Subtask、费用或模型细节。
- 选择时按 Conversation/Task 定位所属 Turn，复用观察协议；不发送执行 attach、停止或调度命令。迟到资源按 Workspace、导航代际隔离；草稿和阅读位置按会话保留。
- 删除旧右侧单 Turn 详情呈现；其账单展示移到左侧所属 Turn。左侧 Task 详情补充查询独立于 Dashboard 是否聚焦。
- 新增只读 `get_conversation_resource: locate`，将已有 HTTP Task/Turn 定位能力暴露给 native Gateway；仍经相同授权与有界读模型，不改变业务状态，不新增持久化或第二调度器。
- 验收：两个执行任务、一个排队任务、一个阻塞任务；跨/同会话切换、旧 Turn 定位、后台更新不抢焦点、草稿隔离、分页、断线/撤权/Workspace 切换、窄屏及真实终端按键。
- 收尾提交：`3e463bb4a1ccea6a6c7179d90794274f52e668df`（`feat: unify multi-client observation and task navigation`）；已推送 `origin/main`。

## 实际交付

右侧按任务列出服务端 TaskView 阶段、任务名称、所属会话，并汇总已加载范围内各状态数量。两项同会话任务保持独立行。F6 聚焦后 ↑/↓ 或 PgUp/PgDn 选择、Enter 定位、Esc 返回；宽屏支持直接点击任务行，窄屏使用同一份列表浮层。`r` 刷新目录，更多会话和单会话更多活动任务都有显式入口；任务页可以返回首批。任务终态后退出活动概览，其左侧结果和历史仍保留。

只有选中会话保留详细观察，其他会话复用授权 activity 查询。后台读取串行、间隔至少 500 ms，一轮至少约 3 秒；实际周期随已加载会话数量与响应延迟增长，不能称为全 Workspace 的无延迟推送。当前会话观察到的活动事实立即更新概览，并防止较旧的在途查询覆盖。目录首批每 10 秒静默刷新；用户加载超过首批后保留分页，由 Workspace 事件更新目录，并可按 `r` 回到首批刷新。统计标注“已加载任务”，不冒充全量计数。

Task 定位经授权索引返回其原 Turn 与附近窗口（附近记录预算 40 KiB，额外目标 Turn 受 16 KiB 实体限制），不扫描历史审计。首次观察基线未到时最多等待 5 秒并允许后续导航使其失效；快速切换以最终点击为准。当前选中 Turn 的资源查询不再依赖右侧面板打开。费用格式化复用旧逻辑，展示位置迁至所属 Turn，执行过程主体保持原样。草稿按 Conversation 隔离，阅读位置最多保留 64 个选中 Turn。

## 验证与限制

- `npm run lint`、root `npm run build`（Server/Web）通过；vendored `npm run build:offline` 通过。
- native 9 文件、98 tests 通过：Task overview、render、App、controller、navigation、reconnect、bounded replay、Gateway wire、observation client。
- 新终端交互用例在 80/120 列下驱动真实 TUI 组件树与按键分发，Gateway 使用受控 fixture；覆盖两个执行任务、一个排队、一个阻塞，跨会话/同会话旧 Turn 定位、草稿保留、后台更新不抢焦点、鼠标选择、迟到定位响应不覆盖最后选择，且不提交执行命令。此证据不是运行多个真实模型的现场验收。
- Gateway 协议镜像与观察服务 2 文件、8 tests 通过：native `locate` envelope 被 Server 接受；旧任务索引定位、响应预算、未知任务和授权撤销拒绝。
- `git diff --check` 通过。日志为本机临时证据：`/tmp/metawork-dashboard-native-final.log`、`/tmp/metawork-dashboard-gateway-tests.log`、`/tmp/metawork-dashboard-native-build-final.log`、`/tmp/metawork-dashboard-root-build.log`。
- vendored 全量 `npm run check` 在源码隔离副本执行，避免其自动格式化改动无关工作树；仍被既有 `main-runtime.ts` 等未使用变量/import 警告阻断。单独全量 `tsgo --noEmit` 仍有既有 examples 导出、Web tools Fetch 类型及旧 reducer fixture 等错误；本次文件无新增类型错误，生产源码离线构建通过。未把这些门宣称为通过。
- 没有替换正常安装、停止运行中服务或触碰真实任务；未向飞书或外部模型发送请求。用户重建本地安装并重启服务/重新进入 TUI 后验证。

复现 native 回归（在 `planner/AnyFusion-Pi/packages/coding-agent`）：

```sh
npx --no-install vitest run test/metawork-tui-render.test.ts test/metawork-task-overview.test.ts test/metawork-tui-app.test.ts test/metawork-tui-controller.test.ts test/metawork-navigation-requests.test.ts test/metawork-reconnect-presentation.test.ts test/metawork-bounded-replay.test.ts test/metawork-gateway-wire.test.ts test/gateway-observation-client.test.ts
```
