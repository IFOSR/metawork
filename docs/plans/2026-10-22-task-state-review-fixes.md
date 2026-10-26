# 任务状态评审修复与验收

- 日期：2026-10-22。
- 状态：F01–F15 的主要复现缺陷已修复，源码回归通过；完整安装/发布计划未关闭。
- 源码修复日期：2026-10-22；关闭提交：无，当前工作区未提交，未安装、未发布。
- 输入：[评审报告](2026-10-22-task-state-code-review.md)、[设计](2026-10-22-task-state-simple-design.md)、[实施方案](2026-10-22-task-state-implementation-plan.md)。
- 基于已有未提交实施继续修改，未 stash/reset 或覆盖其他工作。下述结果替代原实施记录中的旧测试结论。

## 修复对应关系

| 发现 | 实际修复 | 验证落点 |
| --- | --- | --- |
| F01 接受绕过 slot | 接受只提交决定与持久续跑；发布要求当前 slot，Git 前后及落库校验图、Task 与预约 token/version | `task-state-recovery-journeys`：其他任务占 slot 时无 publication，释放后仅发布一次，Executor 总计一次；取消后不发布 |
| F02 接受事务断点 | 状态/接受审计、Kernel application、观察事件、续跑 outbox、排队同事务提交；启动和周期恢复收集续跑；existing effect outbox 驱动重放 | 真实子进程在接受提交后、staging 前被 SIGKILL；磁盘 SQLite 重开，application=applied，接受审计一条、publication 一条，未重新启动 Executor |
| F03 部分取消误伤 Task | cancel fence 只读取已应用的 cancel_task，保留 cancel_subtasks 作用域 | `task-state-regressions`、取消原有套件 |
| F04 错误完成证据 | publication 精确匹配 delivery 操作；显式交付成功；execution/report 要求 certified/accepted receipt；事实按当前 generation/revision 读取 | 缺交付记录、其他 publication 成功、done 标签反例；completion atomicity 与 runner 测试 |
| F05 确定失败和关联重试 | 交付确定失败收敛 failed；`/task retry` 经 Kernel 创建 retryOf 关联任务，只补已有集成成果的交付/服务；原失败与成果保留 | `publication-delivery-recovery`、真实端口冲突后重试；新 Task 零 Subtask，重复命令不新增任务 |
| F06 服务虚假 runnable | 先满足执行/接受/交付前置条件，再允许服务工作推进 | 服务要求 + 未认证结果保持 needs_action |
| F07 迁移误判 | 按旧表结构识别旧契约；没有 driver 的 running 需处理；完成需当前图与 receipt/交付/服务证据；迁移写不可变审计；隔离旧未应用非取消事件/application | 真实 schema51 创建器、schema43 克隆升级/回滚/完整性检查、旧 pending event 保留 payload 并隔离 |
| F08 预约与安全释放 | 新 token、递增 slot_version、重新排队重置年龄；释放在事务中复核 residue，可校验预约与 Task 版本；候选选择复用 Kernel，支持无 Attempt 工作 | 旧轮次释放失败、Task CAS 失败、Executor 容量已满仍可选服务工作；scheduler、账户恢复和 E2E |
| F09 blocker 覆盖 | 按具体事项保留其它 waiting；Runtime/Session/启动恢复的事实写入移至 authority 事务 | 两事项都保留，注入失败后 dependencies/版本/审计完整回滚 |
| F10 虚构状态路径 | 删除自动找中间转换路径，只允许一次真实转换；被动观察不能离开 needs_action；明确授权才重新排队 | 被动完成不自动成功；unknown work 普通 resume/unblock 不再启动 Executor |
| F11 幂等键与事实事务 | 操作重放先查已提交身份；block/drain/service 区分轮次；不吞 operation result 持久化错误 | Task authority、生命周期事务及重复接受/重复重试回归 |
| F12 成功后服务管理 | succeeded 服务 owner 可显式 restart/start，Task 结论保持终态 | 真实 HTTP 服务重启更换 PID，原 Task 状态/版本不变；原任务失败但关联服务重试已成功时，也可继续显式重启，Executor 不重跑 |
| F13 客户端版本倒退 | TUI query/observation 保存比较 Task 版本，同 Task 跨 Turn 比较；Web 慢查询拒绝旧版本；同版本状态冲突丢弃并重取 | 真正 TUI reducer 的 v5 succeeded → v4 running 反例；TUI/Web 定向回归 |
| F14 wire 未切换 | hello、mirror、客户端能力与响应统一 v2；服务端拒绝旧客户端；Web/TUI 拒绝缺 v2 的 Server | Gateway 旧/缺能力拒绝，Web 收到 v1 Server 明确失败，vendored 客户端套件 |
| F15 端口错误丢失 | 保留原生结构化错误，EADDRINUSE 识别为 port_in_use；未知服务结果与确定失败分开 | 真实 TCP listener 占端口；原任务 failed/port_in_use，代码可见；释放端口后关联任务仅补启动 |

另外接通了 Task state outbox 到现有 conversation_activity_dirty 队列，两次持久写入同事务；新增服务 effect/未退出进程与续跑 effect 残留事实；补上了本地 Session 的 scheduler 注入。Gateway 控制命令的后台恢复结果现在正确标识工作仍在进行；旧 `/status` 测试改用现行 `/task dashboard`。没有通过放宽失败断言来掩盖未知操作重试。

## 用户案例和测试边界

`tests/e2e/task-state-recovery-journeys.test.ts` 有 7 个父测试案例，另有专用 SIGKILL 子进程测试入口。正常全量执行会跳过该入口，父测试以独立 Vitest 子进程启动它，断言确实收到 SIGKILL。

1. 接受事务提交后杀进程 → 重开磁盘数据库 → 只发布一次、文件内容正确、Task View 成功。
2. staging 抛错 → 正常恢复补完。
3. 要求启动服务但结果未接受 → 待处理。
4. 成功交付的常驻服务 → 显式重启成功，Task 不复活。
5. 端口占用 → failed/port_in_use → 文件仍可见 → 端口释放 → 关联 Task 只补服务 → 重复命令不复制任务。
6. 另一任务占名额 → 接受只排队 → 释放名额后发布成功且不重跑 Executor。
7. 同样排队但在 staging 前取消 → 无 publication，最终 cancelled。

此外 `publication-delivery-recovery` 覆盖真实文件复制失败、关联 Task 补交付、复制完成但保存前中断、失败终态下取消不改结论。Task regressions 覆盖多个事项、迁移、过期预约、事务回滚和投影投递。

这些是使用真实 Session/Kernel/SQLite/Git/文件系统/本地进程与端口的源码级 E2E。Planner 和 Executor 使用可控测试替身，不调用付费模型；不冒充已安装产品的 AI smoke 或浏览器点击验收。真实 SIGKILL 当前覆盖接受提交边界，不代表方案列出的所有崩溃检查点都已覆盖。

## 实测验证

| 命令/范围 | 结果 |
| --- | --- |
| `npm run lint` | 通过 |
| `npx vitest run --pool=forks` | 566 文件通过，19 文件跳过；3891 测试通过、34 跳过、0 失败（当次全量快照） |
| 全量后新增迁移隔离/服务重启案例的定向复验 | task-state-regressions + kernel-application-recovery + Web auth：47 通过；task-state-recovery-journeys：7 通过，专用 child 入口 1 跳过但由父测试实际执行 |
| 最后补充服务接管修复后的复验 | Kernel + Task regressions + 用户 E2E：104 通过，专用 child 入口 1 跳过；lint 再次通过 |
| vendored TUI app/render/reducer/controller + Gateway client 定向 | 5 文件、115 通过；80/120 列终端任务切换回归通过 |
| Planner `npm run check` | 通过，包括 Biome、依赖 pin、TS imports、shrinkwrap、tsgo、browser import smoke |
| Planner `npm run build:offline` | 通过 |
| `npm run build --prefix web` | TypeScript + Vite 通过；保留既有大 chunk 提示 |
| `npm run build` | tsup、schema/extension 生成通过；Pi PDF Python 资源下载遇到 curl HTTP/2 错误而失败，完整包未构建成功 |
| `git diff --check` | 通过 |

完整命令输出在 `/tmp/metawork-fixes-full-final.log`、`/tmp/metawork-fixes-final-additions.log`、`/tmp/metawork-fixes-journeys-final.log`、`/tmp/metawork-fixes-pi-final.log`、`/tmp/metawork-fixes-pi-check-final.log`、`/tmp/metawork-fixes-build.log`、`/tmp/metawork-fixes-web-build.log`、`/tmp/metawork-fixes-pi-build.log`、`/tmp/metawork-fixes-handover-final.log`、`/tmp/metawork-fixes-web-final.log`。这些是本机临时日志，永久回归证据是上述测试源码。

## 尚未等同于完整方案验收的部分

- 本机没有 Docker 命令，未运行 Docker 镜像迁移测试；已运行本机真实 better-sqlite3、历史 schema 创建器、克隆升级/回滚和 SIGKILL 测试。
- 未安装或升级用户 Runtime，未运行安装版 AI smoke、Desktop 打包/升级和真实浏览器交互案例。完整发布包还受 PDF 依赖下载失败阻塞。
- `/task retry` 本次覆盖可核实集成成果的交付/服务补做。没有可复用集成成果的执行失败仍需重新规划；不自动复制未知外部工作。归档仅保留独立 metadata，没有新增归档产品入口。
- 现有 Kernel 的 Attempt 重试次数策略和 Replan Job 预算保留；未将所有恢复类别改造成统一的绝对截止时间协议。这部分不能用新的 Task 汇总器测试替代验收。
- Authority 是纯 Task 汇总的调用者，Kernel 保留动作授权。接受/结果重试/剩余工作创建具备 application 同事务保证；其它 action family 沿用原有后置条件恢复。ADR-0049 已更正为实际边界，未宣称所有 application 都已经统一为同事务应用。

因此可以评审本次源码修复，但不能将“全量测试通过”写成“原方案全部实施/发布门槛完成”。
