# Web 用户旅程与升级收敛复查

- 计划/本批交付日期：2026-11-12。
- 状态：本批修复和 8788 用户旅程已验证；整体升级验收未关闭。
- Closing commit：`9c321a3d`（2026-11-12）。用户追加授权后提交至 `feature/no-kernel-convergence`，并纳入本地主干合并；未推送远端。整体升级验收的未关闭项保留如下。
- 依据：ADR-0055、ADR-0020、2026-11-08 continuation record、2026-11-10 全盘 review、2026-11-11 Web 与完成收尾记录。
- 用户约束：所有真实 Web 验证使用现有 8788，未另外部署验收 Web。

## 本批发现与修复

| 严重性 | 用户可见问题与根因 | 交付行为 |
| --- | --- | --- |
| 高 | 服务准备 continuation 运行期间，周期恢复并发校验，看不到已完成 producer 就写入终局失败；随后服务已启动，Task 仍 failed | 每 Task 串行服务校验；存在未完成 active Subtask 时不判服务失败；回归覆盖重入和 running/ready/blocked producer |
| 高 | macOS `/tmp` 与 `/private/tmp` 字符串不同，固定提交的合法服务配置被误判为未发布，退回自动发现，8123 和 `/health` 被随机端口、无健康检查替代 | 服务 worktree owner 使用 realpath 验证同一 checkout，再核对固定 commit 文件；原生 Git 回归覆盖路径别名、外部目录和未跟踪文件 |
| 高 | 项目内 manifest 初读时才附加 directory，下一轮 revision 检查却用未规范化的原值，误报规格改变；新 Task 改旧规格又未进入 update | 在读取边界统一目录后计算 revision；同 Workspace 已登记规格改变时先 prepare，再通过授权 stop/update/start |
| 高 | 必需服务尚未就绪就固化不可变最终答复，内容仍说“等待平台启动”，且包含模型臆造的控制面板操作 | 必需服务成功事实出现前不创建最终答复；完成回复补充平台记录的状态、地址、`/service status` 与 `/service stop`，原执行记录明确标注 |
| 高 | 重复“重试未完成部分”复用已经 failed 的 successor，却一直回复“已创建”，用户按提示再次操作仍无进展 | 返回真实 successor 状态和下一步；新 command Turn 关联 successor；TaskView 保留 retryOfTaskId，失败 successor 不再提供无效链式重试按钮 |
| 高 | 恢复请求未检查所属 Task、已结算状态，application 一律 retrySafe=true；effect 无 application row 时无法取得配置 pin | Session 与执行应用边界检查 owner；pending/retry_authorized 根据真实 postcondition 判断 retrySafe；effect 读取所属 Work Graph 配置版本 |
| 中 | 空恢复队列检查 retired blocked 状态；没有可继续 Subtask 或外部结果未知时仍推荐 resume；部分结果接受提示与按钮不一致 | 使用 needs_action；有剩余目标且结果可核实时才提示 resume，其他情况说明核对实际结果、结束旧任务保留产物再重规划；修正接受/失败提示 |
| 中 | 无图 successor 会出现空节点解引用或一直“读取计划”；系统命令错误显示 Manager 规划中 | 空图安全渲染，失败读取显示真实缺图说明；终局和系统命令不伪装为规划中 |
| 中 | journal compact 在读取/提交失败前已推进 cursor，下一空批次伪报恢复、清空退避，再反复失败 | 仅成功 replaceSegments 后推进；缺片重试停留同批次；测试恢复原字节后 replay 无损 |

未恢复旧 Kernel、Docker、Codex 或历史 schema 路径。为使现行 native 持久化测试可运行，147 个测试/fixture 的 fresh DB 初始化改用现有 `initializeDatabaseSchema`，未引入历史迁移。服务修复、服务策略、application diagnosis 的旧 import/字段改为当前 owner 契约。

## 8788 真实用户验收

环境为 `/tmp/mw-planning-e2e-RDW7Um`，Workspace `test`，会话 `conv_K5mjHTmHfQoV`。使用真实浏览器和官方账号登录（凭据不写入仓库），实际 Manager/Executor 模型执行，不使用模拟最终结果。修改前确认无活动任务并保存 SQLite 备份到用户本地备份目录；没有手改任务终局状态。

1. 登录后选择 Workspace/会话，点击原失败任务的重试按钮。关联失败 successor 的新 Turn 如实说明失败；最终浏览器检查该 Turn 的重试按钮数量为 0，页面无空图崩溃。
2. 复现原服务准备竞争：服务变为 running，但 Task 提前 failed。修复后重新提交正常用户请求，不修改历史失败记录。
3. 第一轮继续暴露路径别名问题：Task 成功但 8123 不通，实际记录 origin=discovered、随机端口、healthPath=null。确认根因并修复，未将该轮算作通过。
4. 明确项目 manifest 后重新执行：`task_plan_event_plan_conv_K5mjHTmHfQoV_turn_p9aFu7_RilaQ_int_QyPXHHVT2p` 成功，`8123/health` 实际 HTTP 200，body 为 `{"status":"ok"}`，响应头 `X-MetaWork-Review: verified-20261112`。通过 Web `/service status mini-service` 返回 healthy 和正确地址。
5. 最终复验 Task：`task_plan_event_plan_conv_K5mjHTmHfQoV_turn_aFHQYH0kHTkL_int_rOoGkmqr9g`。再次触发新 commit 的服务准备，Task succeeded；最终答复写入“平台服务 mini-service：已通过健康检查”、地址和状态/停止命令。刷新浏览器后相同答复和 Task 状态保持，直接请求健康接口仍为 200/正确 body/响应头。
6. 按最终答复执行 `/service stop mini-service`，Web 返回 stopped，健康接口连接被拒绝。测试服务已停止；8788 主服务继续运行。
7. 点击文件产物预览并下载 server.mjs，下载 5173 字节，核对包含健康路径及验收响应头；390px 视口 document scrollWidth=390，无横向溢出。最后刷新/停止流程 pageErrors=[]。

证据（本地 `/tmp`，非交付产物）：
- `/tmp/mw-review-service-final-success.png` 与 `.txt`：最终成功、真实服务回复。
- `/tmp/mw-review-service-final-stop.png`：按提示停止成功。
- `/tmp/mw-review-retry-final.png`：失败 successor 的可操作提示。
- `/tmp/mw-review-mobile.png`、`/tmp/mw-review-downloaded-server.mjs`：窄屏与真实下载。

## 自动验证

- `npm run lint`：通过，日志 `/tmp/mw-review-lint7.log`。
- `npm run build`：通过（完整 schema、Pi extension、Web 类型检查/生产构建），日志 `/tmp/mw-review-build5.log`。保留现有 Vite 大 chunk 提示。
- 专项：78 文件、587 项通过，日志 `/tmp/mw-review-final-focused2.log`。含全部 Web、Task、服务准备/进程/修复、最终回复、恢复请求和 journal 回归。
- 补充现行服务策略与 application postcondition：2 文件、25 项通过，日志 `/tmp/mw-review-owner-policies2.log`。
- 原生打包 Pi：1 项通过，日志 `/tmp/mw-review-packaged-pi2.log`。只将 packaging host 的已管理 release staged 到独立测试目录，Manager/Executor 在隔离目录运行，对本地确定性模型接口做 RPC/工具测试；未使用个人 Pi 配置/会话作为运行时回退。
- 最新完整套件：718 文件，479 passed / 216 failed / 23 skipped；断言 3769 passed / 427 failed / 37 skipped，另 5 个异步错误，241.73 秒。使用 60 秒测试/Hook 默认超时定位悬挂；显式 opt-in 测试另行执行。日志 `/tmp/mw-review-full-final.log`，结构化[失败清单](2026-11-12-web-recovery-review-test-failures.json)。96 个文件加载失败、120 个文件包含断言失败；不能将所有失败都归为旧契约。与前一完整复查相比没有新增失败文件。旧报告中的历史全绿不能代表当前代码。

## 仍未关闭的验收项

1. 完整 maintained-host 套件未全绿。大量 fixture 仍引用已删除的 Kernel/金额模块、Docker/TUI、旧模型选择和旧 SQL 表；也有现行接口 fixture 尚未更新。保留真实失败，不删测试或恢复废弃生产实现来取得全绿。最终报告附失败清单与计数；当前不能声明整个升级无 bug。
2. 现有 test Workspace 的目录事件 journal 在本次修改前已缺少一个磁盘 segment：`93eedddb-bd46-4100-8546-0dac500ce0a4.json`，sequence 11384，event `event_OSNclnXYd_bS`。全量索引核对只发现该一片缺失；未找到可验证原始备份。现已修复虚假恢复/重试日志循环，但缺失字节不能凭空补写。未删索引或伪造历史；需要原始 segment/备份才能无损恢复。当前目录与会话读取实测可用，不等于历史 replay 完整。
3. 本轮真实任务走现有单候选模型；外部多候选 Router 服务可用性及生产切换没有因此获得验收。签名干净安装、Linux、Desktop、Feishu 不在本轮 macOS arm64 + Web 的完成结论内。
4. 数据库历史失败 Task 保留原结论和证据；正常新任务已验证能完成旧目标。最终服务状态是完成时事实，后续显式 stop 不回写历史成功结论，实时状态由 `/service status` 查询。

## 同日追加：快捷复制与完成会话刷新稳定性

- 本批交付日期：2026-11-12；状态：复制和已确认的刷新缺陷完成本地修复。此阶段用户报告的“任何完成会话整页持续闪动”未稳定复现，不能以以下抽样结果断言全部原因已消除；最终定位见文末追加记录。Closing commit：`9c321a3d`。
- 问题和回答增加无文字、无边框的复制图标，保留键盘可操作语义、复制成功/失败反馈。普通回答复制完整可见 Markdown 正文，系统命令复制完整返回文本；HTTP/Clipboard API 不可用时使用兼容复制，恢复焦点、选区，避免滚动跳动。两种方式均失败时明确报告失败。
- 已证实的刷新缺陷：`MarkdownContent` 原来按附件数组对象身份重建渲染插槽。内容相同的新数组也会卸载图表、图片和附件控件，重置图表展开/图例状态，并可能改变布局。现改为按附件内容判断；真实回答变化仍正常更新。
- 公共刷新优化：官方账号状态每 5 秒刷新时，状态未改变则保留原 React state，避免无必要的整页及账号区域重新渲染；不停止权益检查或任务状态更新。
- 浏览器回归使用 8788 origin 上的浏览器本地路由 fixture，无额外 Web 服务、无持久数据写入。覆盖相同快照连续刷新后图表 DOM 身份、展开状态、图例选择和滚动位置；长问题/回答复制、异步 API 被拒绝后的兼容复制、键盘焦点/选区/滚动恢复、复制失败反馈、真正变化的回答更新与窄屏图标。
- 对照验证：临时仅恢复旧附件数组依赖，同一浏览器回归因展开状态丢失而失败；恢复修复后通过。证据：`/tmp/mw-copy-stability-before.log`、`/tmp/mw-copy-ui-browser-final.log`。
- `npm run lint` 与 `npm run build --prefix web` 通过；现有 Vite chunk 提示仍在。Web 套件及新增浏览器回归合计 61 文件 / 392 项通过，追加选区/失败反馈断言后浏览器回归再次通过。日志：`/tmp/mw-copy-ui-lint.log`、`/tmp/mw-copy-ui-build.log`、`/tmp/mw-copy-ui-tests.log`。
- 真实 8788 已登录会话验证：短回答、研究报告、`/service stop` 历史命令回复，剪贴板内容与授权读取的原文逐字匹配。三个会话分别观察 16 秒（覆盖多次 5 秒轮询），最终记录均为 conversation DOM mutation=0、滚动位置/高度不变；390px document 宽度=390，无 pageerror。一次前序长会话采样捕获过两个布局位置，随后未稳定复现，未将其当作连续闪动已定位的证据。
- 另验证真实长报告：列表预览 1746 字符、完整正文 9573 字符 / 19509 字节，复制结果为完整 9573 字符且逐字匹配。证据：`/tmp/mw-copy-long-answer.log`。
- 证据：`/tmp/mw-ui-final.log`、`/tmp/mw-ui-copy-desktop.png`、`/tmp/mw-ui-copy-mobile.png`。前端生产文件已更新，8788 主进程未重启，HTTP 200；用户刷新即可人工复验。本批没有重跑此前仍有 216 个失败文件的完整套件，也不改变其未关闭结论。
### Error passthrough review (2026-11-12)

The recovery review now preserves bounded upstream Manager, Router, and Executor
diagnostics through the task and Web projections. Executor workspace preflight
failures keep their original paths and text in `ControlFailure.summary`; Router
decision failures include the persisted unavailability reason; task state uses
attempt receipt failure text when deriving its reason; and taskless planning
failures prefer the latest planner or submission trace event. Localized labels
and recovery actions remain additional fields. Configuration mismatch notices
also show the original failure summary.

Validation: focused Executor, Router, and Web failure tests pass (36 tests),
`npm run lint` passes, `npm run build` passes, and the existing service on
`http://127.0.0.1:8788` responds with HTTP 200. The service was not restarted.

### Completed conversation periodic layout shift — confirmed and fixed (2026-11-12)

Status: implemented and validated locally on 8788; completion date 2026-11-12.
Closing commit: `9c321a3d`, committed after the user explicitly authorized local
commit and integration into main. No remote push was requested or performed.
This finding supersedes the earlier inconclusive completed-page flicker sample.

- Reproduced in the user's “收集上海做小红书 GEO” conversation
  (`conv_KfqM02JA7aiG`). A MutationObserver captured insertion/removal of
  `正在整理历史，已有内容可先浏览。` while the completed Turn height remained
  unchanged; canvas scroll extent alternated between 4,793 and 4,855 pixels.
- WebSocket evidence confirmed background freshness transitions, rather than
  task execution: projected sequence remained 1146, source sequence temporarily
  became null (`preparing: true`) then returned to 1146 about one second later.
  The same pattern occurred in the other GEO conversation at sequence 505.
  `createAccountEventJournal.sourceSequence` reports null while historical
  projection/rebuild work is pending. The Web window maps that freshness to
  `preparing`; the view incorrectly inserted an in-flow loading banner above
  already loaded reports on each transition.
- `ObservedConversationView` now distinguishes initial loading from background
  synchronization. With existing Turns, preparation feedback waits 1.5 seconds,
  and persistent synchronization/connection/error feedback uses a sticky,
  zero-height overlay. These state changes cannot add/remove a row above the
  virtual list. Initial loading and retry/error feedback remain available;
  resource polling and real content updates continue normally.
- Added `conversation-freshness-stability-browser.test.ts`, exercising the
  actual ObservedConversationView/store/resource hook on the 8788 acceptance
  origin. At 1440, 756 and 390 pixels, both tail and user-scrolled reading
  positions remain identical across brief/repeated/persistent freshness and
  disconnect/reconnect transitions. Real answer patches still render, and at
  least three resource reads occur. The regression fails against the pre-fix
  view and passes against the fix.
- Validation: lint and Web production build pass (existing chunk-size advisory).
  The focused browser/store batch passes: 3 files, 16 tests. Real logged-in
  8788 browser observation lasted 45 seconds at 1440px and 45 seconds at 756px
  in the reported conversation, plus 35 seconds in the other GEO conversation.
  Both actual background freshness transitions were captured; sampled report
  positions, row heights and canvas scroll extent stayed constant, with no
  page errors. Evidence: `/tmp/mw-jitter-watch.log`,
  `/tmp/mw-jitter-frames.log`, `/tmp/mw-jitter-accept.log`,
  `/tmp/mw-freshness-tests.log`, `/tmp/mw-freshness-before.log`.
- The frontend production assets are served by the existing 8788 service;
  the service process was not restarted. The previously reported full-suite
  failures remain outside this focused verification.
- Additional real-page stimulus validation: delivered brief/repeated/persistent
  freshness frames through the existing WebSocket message handler in the actual
  logged-in GEO page, with no server/database mutation. At 1440/756/390px, report
  geometry and scroll extent/offset were identical before, during and after each
  transition, both within the report and at its tail. Narrow layouts were checked
  against the document scroller as well as the canvas. The temporary browser
  instrumentation was removed and the page reloaded afterward. Evidence:
  `/tmp/mw-jitter-stimulus.log` (six position/width combinations).
