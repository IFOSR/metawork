# 上游成果读取失败后的显式恢复

- 计划日期：2026-10-17
- 状态：已完成实现、真实任务副本与本地 DMG 安装升级验收
- 完成日期：2026-10-17
- 范围：修复恢复与重规划证据引用；不改界面；交付本地 arm64 DMG，不发布。

## 事实与边界

原任务首阶段已发布；第二阶段以 missing_upstream_input 失败。自动重规划
引用了拼写错误的证据 ID，随后启动恢复将等待决策的节点误判为无授权执行。
现有 Resume 因人工阻塞拒绝执行，未产生新 attempt。

Kernel 仍是唯一恢复授权者。Runtime 提供当前依赖发布、驱动证据能力、
原始终态 receipt、已拒绝 replan 和真实阻塞/残留事实；只允许显式恢复
已证明上游输入可用的失败节点。保留完成节点、原 receipt、决策和发布。
未知外部副作用、真实人工/权限阻塞、活跃或不确定执行不得被覆盖。

证据生成使用完整来源身份摘要，保留已有引用；Planning 预校验向同一轮
提案工具反馈不存在的任务证据引用，Kernel 仍做最终资格校验。
不增加 Planner 写库权限、Runtime 恢复策略或第二调度入口。

## 验收

覆盖长 ID/多完成节点、错误引用修正、显式恢复/重启/重复事件、拒绝恢复
的安全边界。用真实历史任务的隔离副本验证原成果保留与第二阶段继续；
完成构建、打包及安装检查。记录实际模型验收与其限制。

关闭提交：未提交；用户要求本地 DMG。

## 实现与验证记录

- 已实现：严格限定的上游输入显式恢复、旧 replan 的幂等收尾、等待决策
  节点的启动恢复识别、完整来源哈希与历史引用保留、隔离 Planner 预校验。
- 核心回归 191 项通过；补充组 92 项通过（有重叠）；新增启动识别回归后
  Startup 30 项通过；Worker 12 项通过；Desktop 23 项通过。Server/Desktop
  类型检查与 Server/Web/Desktop 构建通过。均为原生 macOS 验证。
- 原任务隔离副本真实模型验收：首阶段 7,024 字节及哈希不变；审校阶段经
  result_reference_get 实际读取后产生 5,917 字节定稿；仅增加一次成功
  continuation。Task=done，两节点 done，replan=cancelled，所有应用 applied。
- 完成后重新打开数据库再次 Resume=no_op，无残留、不重跑。
- 首轮隔离验收漏复制 Git integration worktree，已补齐测试副本后重测通过。
  第二轮已完成任务，测试脚本清理误调用不存在的 dispose；完成事实已从
  持久数据库独立复核，清理调用修正为 closeWhenIdle。失败日志均保留。
- DMG 全新安装、重连菜单、认证 Web、客户端退出后 Server 存活通过；
  镜像校验、ad-hoc 签名、挂载内容与被测 app 的关键文件一致性通过。

## 本地交付

- `Release/MetaWork-0.1.17-upstream-recovery-fix-20261017-arm64.dmg`
- Release ID：`0.1.17-internal-upstream-recovery-fix-20261017`
- SHA256：`0a2d7d86ba80dfe9445f37a96058ef03c9a1579a37dd45bb4b4ed46f98740fd4`
- 构建与完整验收：`.tmp/blocked-upstream-fix-20261017/`
- 精简验收记录：`Release/upstream-recovery-fix-20261017-evidence/`
- 用户原安装/数据库未修改；不发布 release；界面按要求保持原样。

最终 Finder 升级验收通过：从用户当前 upstream-result-fix Runtime 升级至本包，
activation=committed，配置/数据保留，连续两次重开及后台 Server 独立存活通过。
