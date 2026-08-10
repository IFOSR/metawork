# Executor `error` 恢复刷新机制

> 状态：已完成
> 计划日期：2026-07-30
> 完成日期：2026-07-30
> 实施提交：`317c406`（`fix: recover errored executors through refresh`）

## 目标

建立仅面向 `error` Executor 的事件驱动恢复检查，允许成功 probe 将其恢复为
`healthy`，同时保持 Planner 并行规划、Kernel 准入权威和已有 Task 的可靠状态闭环。

## 已确认行为

- 只刷新 enabled 且当前为 `error` 的 Executor；不反向巡检 healthy/unverified。
- 单 Executor probe 超时 30 秒；失败保持 error，成功自动恢复 healthy。
- Planner 与刷新并行，Kernel 准入前汇合；相关候选恢复时在同一原生 Planner thread
  中最多修订一次。
- 初始计划无可用候选时由 Planner 自然语言解释；已有 Task 保存延迟提案并由 Kernel
  标记 `blocked`。
- Executor 恢复后，Kernel 重新准入延迟提案；满足当前 frontier 时激活新 revision，
  Task 静默转为 `ready`，但不立即派发。
- 自动触发仅限 Session 启动、planning cycle、Task resume/recovery、Executor 配置变化；
  另提供 `/executor refresh [name|all]`，不增加后台轮询。
- SQLite 首次发布基线升级到 v28，不兼容 v27。

## 验证

- 宿主机 `npm run lint`：通过。
- 宿主机 `npm run build`：通过。
- Docker 全量 Vitest：181 个测试文件通过、4 个跳过；702 个测试通过、15 个跳过。
- 真实 `npm run smoke:metaclaw`：通过原生 Planner session 两轮记忆 smoke。
- `docker/shell.ps1` PowerShell 语法解析：通过。
- `docker/persist-ssh-environment.sh` Bash 语法解析：通过。
- Docker shell 拓扑定向测试：2 个测试文件、4 个测试通过。
- 定向恢复回归覆盖：仅 error 刷新、disabled/healthy 跳过、并发 probe 合并、
  timeout 保持 error、恢复检查审计、手工刷新后容量重试。

## 实际交付

- 新增 Execution 层 `ExecutorRecoveryRefreshService`，统一 error 筛选、30 秒超时、
  同 AgentClass 并发合并、脱敏审计及 `error → healthy` 投影。
- Executor adapter 改用结构化 `probe()`；本地 Docker、镜像、control network、
  命令/配置分层检查，认证和 provider 网络类历史故障追加最小远端验证。
- Session 的初始、automatic、conflict planning cycle 共用 Planner/refresh 并行汇合；
  相关候选恢复后在同一原生 Codex thread 中最多修订一次。
- Kernel wire/ledger 升级到 v5；已有 generation replan 可持久化
  `waiting_for_availability` 延迟提案，并在 `executor_recovered` 后重新准入、转为
  `ready`，不直接 dispatch。
- 增加 Session 启动、Task recovery、Executor 变更和
  `/executor refresh [name|all]` 事件入口；未增加周期健康轮询。
- SQLite 首次发布基线升级到 v28，Docker shell 使用 v28 数据卷并保证
  `metaclaw-control` internal network 存在且连接正确。
- Planner MCP 可读取 bounded `recentRecoveryChecks` 和脱敏 failure；相关 ADR、
  `CONTEXT.md` 与技术债记录已同步。
