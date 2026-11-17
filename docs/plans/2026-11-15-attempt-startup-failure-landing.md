# 启动准备失败的回执落地修复

- 日期：2026-11-15
- 状态：修复、本地 Release 和真实 Admin Web 正常/故障恢复验收完成；其他服务器尚未部署。
- 完成日期：2026-11-16。
- Closing commit：与本记录同批提交，主题
  `fix(execution): persist failures during attempt startup preparation`；用户已授权验收通过后提交并推送。

## 已确认问题

v0.1.27 和 v0.1.30 的普通 Attempt 都在 `beginRead()` 之后才将 Subtask
转为 `running`，而失败收尾固定以 `running` 为事务围栏。准备阶段抛错会使
失败回执回滚，二次围栏异常掩盖原始错误，派发进入 `uncertain`。runtime 行
此时尚未创建，不是被终态事务删除。该缺陷不需要并行才能触发。

其他服务器的实际触发异常未获直接证据，不能认定是 Git 并发竞态、内存或升级造成。
本次不自动修改现场遗留数据，不以“没有 runtime/receipt”推导“从未执行”。

## 最小修复

1. Execution owner 在认领后、异步只读准备前进入 `running`；准备阶段失败复用
   原有终态事务及资源清理。`running` 包含准备阶段，不证明 Executor 已启动。
2. 记录只读准备阶段、原始错误以及未调用 Executor 的事实。仅明确临时错误
   `EAGAIN` / `EBUSY` / `ETIMEDOUT` 和已有 integration 锁超时进入既有有限重试；
   Workspace 已失败、绑定失效、输入变化不自动重试，未分类错误继续明确阻塞。
3. 失败回执本身无法落地时保留两层错误并写脱敏日志；不放松事务围栏，不强行
   改写取消/后续尝试状态，不新增表或恢复队列。

## 验证

- 使用当前 Repository 接口、真实 SQLite 和 Git 工作树构建故障注入 fixture。
- 修改前确定性复现：单个 reader 的 `beginRead()` 抛错即收到
  `attempt terminal fence changed`（2026-11-15，本机 `/tmp/mw-startup-before.log`）。
- 新增 `tests/execution/attempt-startup-failure.test.ts`，17 项全部通过：
  - 单 reader 准备失败保留回执和原始错误，runtime 尚未创建，Executor 未调用，
    Subtask 进入 `awaiting_decision`，dispatch 结束，资源租约及会话/WorkUnit 认领释放。
  - 四种明确临时错误走现有 30 秒 retry 决策；显式执行授权 continuation 后正常
    完成，不被源 Attempt 缺少 runtime 阻塞。连续准备失败只使用现有两次同路重试，
    随后交还 Router；本测试未把有限重试解释为故障必然恢复。
  - 绑定失效、输入变更、真实 Git 工作树被改动、Workspace 失败后的临时 I/O 异常
    均不自动重试；实际工作树保护和 `needs_recovery` 操作记录保留。
  - 可控暂停点验证取消不被覆盖，以及准备阶段的 heartbeat-lost 回执可以落地。
  - 新结果已完成 Subtask 时旧尝试仍因围栏失败而回滚，不覆盖结果。
  - 准备前/Executor 调用后的回执写入故障通过真实 Supervisor 保持 `uncertain`，
    诊断同时保留原始错误和写入错误，stderr 脱敏；普通 Executor 异常不被标记为安全启动失败。
  - 三个真实 Git/SQLite reader 同时进入模拟 Executor，全部正常完成并释放共享认领。
- 连同 `context-preparation-recovery`、`conversation-shared-read`、
  `duplicate-dispatch-recovery`、`dispatch-conflict-settlement`、
  `workspace-completion-result`、`service-repair-continuation`：7 文件、114 项通过。
  命令为 `npx vitest run` 加上述测试路径和 `--testTimeout=60000 --hookTimeout=60000`；
  本机日志 `/tmp/mw-startup-focused.log`。
- `npm run lint` 和完整 `npm run build` 均通过（包括 PDF runtime 准备与 Web 构建）；
  本机日志 `/tmp/mw-startup-lint.log`、`/tmp/mw-startup-build.log`。
- 维护宿主检查显式设置 `RUN_PACKAGED_PI_E2E=1`，运行：
  `packaged-pi-native`、`durable-native-process-runner`、`attempt-execution-backend-reconciler`、
  `attempt-process-group`、`process-group-reaper`、`permission-workflow-service`、
  `read-only-workspace-boundary`。7 文件中 5 通过、2 失败；24 项中 19 通过、5 失败。
  实际 packaged Pi 的 Manager RPC/permission 与 Executor 进程测试通过。
  5 个失败逐项对比测试名和错误首行，均与
  `2026-11-12-web-recovery-review-test-failures.json` 完全相同（权限 3 项、只读边界 2 项）。
  结果 `/tmp/mw-startup-host.json`，日志 `/tmp/mw-startup-host.log`；没有宣称维护宿主全绿。
- `git diff --check` 通过。本轮没有重跑全仓测试；本地安装包及 Server 验收见下节。
  未连接其他服务器修改历史任务。

此结论覆盖已认领 Attempt 的共享只读准备失败，不是“所有启动/崩溃路径均可自动恢复”
的承诺。没有原始现场错误的旧 `uncertain` 记录仍须按原有证据规则核实，不能批量清除。


## 本地 Release 与 Admin Web 验收（2026-11-16 继续）

- 使用独立 staging 目录安装 production dependencies，正式 `package-release.mjs`
  生成本地 `0.1.30-preview.20261115` 的 Runtime / Pi / Memory 三个 tarball 与 manifest。
  本机开发签名仅用于此次验收，不作为公开正式 Release 发布。
- manifest 签名与三个 archive 的 SHA-256/字节数均核验通过。Runtime SHA-256：
  `00a5cc19ad51dd0ff4df21df547db65f03e404237baadf24c2d8a74a20a1b354`。
  打包器按构建宿主固定 upstream Pi 1.5.2，运行时使用 archive 内的独立副本。
- 本地正式停止旧 Server；SQLite backup 与原 release pointer 已保存；新候选从
  tarball 解包到独立 release 目录，复用原账号、配置、Workspace 和数据。
  `server-endpoint.json` 显示候选 Release `ready`，端口 8788。
- 发布包代码未添加测试后门。故障验收通过 loopback Node inspector 在
  `preparingRead` 边界为 batch order 1 的 Attempt 临时替换一次 `beginRead()`，
  抛出带 EBUSY code 的明确测试异常后立即恢复；包内文件保持原始 hash。
- 重启前确认当前官方账号为 Admin 且权益 active、无活动派发。用户重新登录后，
  使用该账号从 Web 新建两个真实会话、通过输入框提交请求；实际 Manager 规划、
  Router 路由及打包 Pi Executor 执行，未用模拟模型或直接修改任务数据。
- 本机证据目录 `/tmp/metawork-startup-release-20261115/`，包含 archive、manifest、
  hash 清单、DB backup、浏览器与故障注入脚本。账号 cookie、签名私钥和日志不入 Git。

### 真实任务结果

两次任务均为 A 宏观、B 基本面、C 合约三路公开资料研究，D 综合依赖前三路；
节点均为共享只读、文本交付，不要求生成文件。时间为北京时间 2026-11-16。

| 验收 | 正常任务 | 准备阶段一次 EBUSY |
| --- | --- | --- |
| 会话 | `conv_GQhfiB8EkrfQ` | `conv_DDE7x_Zcrgx1` |
| Web 最终状态 | 已完成 4/4，11:57 提交、12:01 完成 | 已完成 4/4，12:01 提交、12:06 完成 |
| Task | succeeded，summary 329 字符 | succeeded，summary 529 字符 |
| dispatch / receipt | 4 / 4，全部成功 | 5 / 5，1 次准备失败、4 次成功 |
| Retry Wake | 0 | 1，已 consumed；仅 B 新增一次 continuation |
| 收尾 | interaction 1；完成通知 sent 且仅投递 1 次 | interaction 1；完成通知 sent 且仅投递 1 次 |
| 残留 | 无恢复项、资源租约、WorkUnit/会话认领；会话名额 free | 同左，无 uncertain 或未消费唤醒 |

- 正常 Task：`task_plan_event_plan_conv_GQhfiB8EkrfQ_turn_W7ihhsjuuUoz_int_CApSGVMbHO`。
  数据库时间确认三个 reader 的执行区间重叠，D 在三路完成后才开始。
- 故障 Task：`task_plan_event_plan_conv_DDE7x_Zcrgx1_turn_QqyuH24QnsIX_int_8fYbSLUpDH`。
  12:02:09.712 在 B 的 `beginRead()` 前注入 EBUSY，此时 Subtask 已是 running；
  12:02:09.716 失败回执提交，保留原始异常及 `workspace_preparation`、
  `attemptStarted=false`、`externalSideEffect=false`。失败 Attempt 无 runtime，
  WorkUnit/会话认领已释放，没有启动 Executor。
- 唤醒设置为 12:02:39.718 到期，当前批次收尾后 12:03:32.398 自动消费并派发
  continuation；不是到期即保证启动。B 于 12:06:14.287 完成，随后 D 执行并完成。
  全程没有 `/task resume`、人工重试或数据库补写；A/C 各执行一次。
- 两个真实 Web 页面均显示最终答复及验收标记，浏览器 pageerror 为 0；保存页面文本、
  截图、失败前后 DB 只读快照。重新打开两个会话后仍显示已完成 4/4 及最终答复，
  pageerror 为 0。`artifacts_json=[]` 符合此次不生成文件的文本交付要求。
- 故障注入后核对发布包 dist 全部 2,879 个文件，hash 均未变化；一次性方法替换已恢复，
  inspector 已关闭，候选 Server 继续运行。
- 本地候选 `server doctor` 的 dispatch_queue、conversation_slots、schedule_entries、
  blocked 四项均 OK。首次最终快照后再观察 100 秒（超过一个 60 秒巡检周期），
  两个任务的状态、派发、回执、唤醒、交互、通知及资源快照完全一致，没有重复收尾。

验收范围为本机 macOS arm64 + Web，以及明确的共享只读准备失败；本地开发签名包
不作为公开正式 Release。GitHub 源码提交不代表其他服务器已经升级，也不代表
历史无回执 uncertain 已获安全重跑授权。维护宿主的 5 项既有失败仍按上文保留。
