# 结果恢复与停止状态闭环修复

- 日期：2026-11-04
- 状态：已完成；2026-11-05 按用户授权发布 v0.1.25，Apple Silicon DMG 与全部 14 个附件已上传并验证
- 依据：ADR-0023、TaskStateAuthority 与持久化结果身份契约
- 完成日期：2026-11-04（实现及本地验证）
- 实现 closing commit：`4af1201c`（fix: close result recovery and stale running state loops）
- 发布源码：`a22f9e1`；发布及 CI 记录见 [v0.1.25 发布记录](../archive/plans/2026-11-05-v0.1.25-release.md)

## 2026-11-05 实时运行态遗漏修复

用户升级后反馈停止按钮仍显示运行。只读核对确认已安装并运行
`0.1.24-tokenfix3-recovery-20261104`，没有 `running` / `queued` Task。
原会话于 `2026-11-05T01:13:55.627Z` 完成用户发起的删除，关联 Task
已归档，因此不再从该会话恢复原显示记录；其他保留会话仍存在 Task
已终止而 Turn 投影为 running 的同类样本。调查不改写真实数据库。

上轮修复遗漏了 WebSocket observation：`page` / `locate` 使用
`settleObservedTurn`，但初始 baseline 和增量 patch 直接发送原始投影。
客户端还会忽略同 revision 的终态校正，且没有新 Turn 事件时不会主动
收敛。这是未完成的修复，不属于升级后的正常行为，也不能以删除记录
代替修复。

本次将同一只读校正应用到 baseline / patch；有最新 cursor 的重连也会
校验历史运行态。观察连接有界跟踪最多 50 个未收敛 Turn，已提交的任务
终态或完成事实变化时使用既有 reset / baseline 刷新，不伪造日志版本、
不修改执行事实。客户端允许同 revision 的 running → 终态校正，并拒绝
随后旧 running 数据覆盖终态。删除事件不会被该刷新恢复。

相关回归共 9 文件、97 项通过，覆盖真实 SQLite observation、客户端缓存、
读模型重建、并行观察、Gateway、取消与输入框运行判断。包含首次连接、
增量更新、无新日志完成、重连、同版本反向覆盖及删除记录不复活。
另有 1 项真实 Chrome + 构建后 Server/Web 测试通过：在隔离安装中注入
历史 running 命令投影，确认停止按钮先出现，完成事实经 WebSocket 传递
后消失，刷新后不复现。根目录 TypeScript 与完整构建通过。

补修与本地验收完成日期：2026-11-05。新版
`0.1.24-tokenfix4-observation-20261105` 通过镜像、严格签名及 payload
校验；运行时 54 个和 Web 18 个 JS/CSS/HTML 文件与已测试构建逐一一致。
在独立安装目录从用户当前 `0.1.24-tokenfix3-recovery-20261104` 升级，
认证页面、两次重开、后台服务独立存活以及配置/数据保留均通过。
验收证据：`.tmp/token-limit-dmg-20261104/output6/mac-arm64/finder-evidence.json`。

最新本地 DMG：`apps/desktop/release/MetaWork-darwin-arm64-observationfix6-20261105.dmg`
（389,204,487 字节），SHA-256：
`d2c65f14939e875e60088b6a01804bf11fb03b25e3987c581c27d04dd8cf0e70`。
该本地验收阶段未替换用户真实安装，也未发布 Release。后续按用户授权，
源码以 `4af1201c` 提交，并发布版本号更新后的 v0.1.25 安装包；上传
文件的校验值及全量 CI 未通过项见上述发布记录。

## 事故事实

只读核对本机账户 SQLite，确认问题属于同一条恢复链。时间沿用事故记录：

1. 12:49:07，前序三步已有结果，最后汇总结果仅 57 字节，完成验收未通过。
2. 12:49:09，一次完成说明校正仍未通过；Kernel 随后生成自动接受决定，application 留在 pending、attempts=0。
3. 13:25 与 14:24 的 resume 没有可恢复 Subtask，界面却仍推荐“继续未完成部分”。
4. 14:25:38，用户 retry-result 排空旧 application 时先接受了旧结果，新重试因结果身份变化被拒绝。
5. 14:26:10，Task 被记为 succeeded；12:49 后没有新 Executor receipt，不能据此认为业务答案重新生成或修复。

失败控制命令的 Turn 没有关联 taskId，虽有 completedAt 仍显示 running。事故 Task 没有持久化取消事件，不能认定点击停止已成功取消 Task。调查未改写用户数据库，也未向真实任务发送控制命令。

## 原因与交付行为

Kernel 原有自动接受分支把“安全且可交付的文本”当成“完整结果”，并且只有控制 workflow 注册了该 action，正常执行 workflow 不能消费它。移除自动接受分支，恢复 ADR-0023 的约束：一次校正失败或不可用后等待用户决定。结果应用由同一个 Runtime 方法负责，正常执行与控制 workflow 均注册接受/重试 action；应用校验用户事件来源及 Task、Subtask、generation、revision、attempt、result 身份。历史隐式接受决定收敛为 rejected_without_effect，不抢占新用户重试。

TaskView 原先按 action kind 合并持久化动作，能留下旧结果身份。现在用实时安全结果身份替换结果动作，明确无待决结果时清除旧动作；终态不展示接受/重试。活动卡片复用 BlockedActions 的精确结果控制，Dashboard 和卡片只在 TaskView 有继续目标时推荐 resume，不再把任意 needs_action 当成 resume。失败交付仍保留恢复入口，Kernel 在提交时重新验证 blocker、binding 和外部效果安全。

Session/Gateway 原先使用整个会话的 backgroundWork 判断控制命令是否结束。现在控制命令返回即结束该 Turn，后续执行由 Task activity 表达；Planner 或明确 Task 取消被受理后关闭 Turn，无后台所有者的孤立 Turn 也能取消。取消按活动 trace/任务所属 Turn 定位；孤立命令可结束，取消旧 Turn 或命令 Turn 均不能转而取消任意后台 Task。只读观察用当前六态 Task 终态和已完成系统命令事实修复历史 running 投影，保留真正活跃的 Turn。

## 验证

- 最终专项：17 文件、262 项通过，覆盖 Kernel、真实 SQLite workflow、Runtime recovery、结果身份、Gateway、取消、Dashboard、Web 活动卡片、Pi 参数与 Desktop readiness。
- 另一次检查中，4 项依赖真实 Executor 的端到端用例按环境条件跳过；不计入上述通过数。
- 真实 SQLite 回归重现“旧隐式接受 pending → 用户 retry”，验证旧决定无状态写入或 outbox，只有用户重试恢复最后一步；另覆盖明确接受及接受重放。
- Web 活动卡片回归验证精确接受/重试按钮，以及没有继续目标时不显示继续。
- 根目录、Web、Desktop TypeScript 检查均通过。
- 最终 DMG 镜像校验、严格代码签名及签名 payload 清单验证通过。
- 原样打包应用通过 LaunchServices/Finder 升级验收：由 `0.1.24-tokenfix2-20261104` 升级至 `0.1.24-tokenfix3-recovery-20261104`，包括中断升级记录、过期 helper 锁、认证界面、两次重新打开、Server 独立存活及原配置/数据保留。
- 初轮测试包因内部版本后缀排序被判为降级，未交付；最终包采用高于原测试版的版本标识，不放宽防降级检查。Electron 重复下载连接超时后使用 SHA-256 一致的本机 Electron 44.5.1 缓存完成构建。

## 本地验收（发布前历史记录）

本次仅构建本地 DMG，包含先前 Pi 可选输出 token 上限移除和 Desktop Gateway readiness 协议修复；不发布 GitHub Release，不替换用户数据。旧事故 Task 已接受旧结果成为终态，升级不会篡改该历史事实，也不会自动重跑；需要新的用户请求重新生成最终答案。新案例在校正耗尽后应展示明确接受/重新执行，重新执行只重做待决步骤；拒绝的控制命令回复后停止按钮应恢复，后台任务取消需使用任务自己的停止入口。

11-04 本地包：`apps/desktop/release/MetaWork-darwin-arm64-recoveryfix5-20261104.dmg`（389,192,443 字节）。SHA-256：`3f1eb9d486627cf3686d560cb388322709324258fb3cdf52c39b5a312c8b01f4`。验收证据位于 `.tmp/token-limit-dmg-20261104/output5/mac-arm64/finder-evidence.json`；构建记录为 `.tmp/token-limit-dmg-20261104/build-info5.json`。未发布，未替换真实安装或数据库。
