# 任务状态重构优化（worktree 准备说明）

状态：环境就绪，方案待定（尚未开始实现）
日期：2026-10-22
基线 commit：`d19e412e`（`origin/main`，`feat: improve result acceptance, managed services and command completion`）

## Worktree

- 路径：`/Users/yuanjubian/orca/workspaces/metawork/metawork-task-status-refactor`
- 分支：`feature/task-status-refactor`（从 `origin/main` 切出）
- 与主工作区 `/Users/yuanjubian/program/metawork`（`main`）相互独立
- 主工作区当前有未跟踪目录 `Release/`，与本分支无关

## 环境准备（已验证）

| 项 | 结果 |
| --- | --- |
| Node / npm | v22.23.3 / 10.9.9（满足 ≥22.19） |
| 根依赖 `npm install` | 通过（318 包，`better-sqlite3` 原生模块可加载） |
| Web 依赖 `npm ci --prefix web --ignore-scripts` | 通过（309 包） |
| Planner 依赖 `npm ci --prefix planner/AnyFusion-Pi` | 通过（426 包） |
| Planner 构建 `npm run build:offline`（vendored AnyFusion-Pi） | 通过 |
| Desktop 依赖 `npm install --prefix apps/desktop --ignore-scripts` | 通过（331 包，Electron 二进制未下载） |
| `npm run lint`（tsc --noEmit） | 通过 |
| 聚焦测试 `vitest run tests/task tests/kernel tests/work-graph` | 176 项通过 |

独立配置目录（避免与本机安装/主工作区共用端口、socket、数据库）：

```text
export METAWORK_CONFIG_HOME=~/.config/metawork-task-status-refactor
export ANYFUSION_CONFIG_HOME=~/.config/metawork-task-status-refactor
```

目录已创建；如需完整原生安装（Pi 运行时、launchd 服务、native 权限）再执行
`npm run setup:native`，它会写入上述配置目录。

## 任务状态相关代码面（现状索引，待设计）

- `src/task/`：`task-lifecycle.ts`、`task-lifecycle-transition-port.ts`、`task-engine.ts`、
  `task-view.ts`（对外 DTO）、`task-runtime-service.ts`、`task-control-types.ts`、
  `task-user-state.ts`、`task-blocker-guidance.ts`
- `src/kernel/`：`executor-status-projection.ts`、`control-kernel.ts`、`kernel-workflow.ts`、
  `task-scheduler.ts`
- `src/work-graph/`：`types.ts`（Task/Subtask/Attempt 状态枚举）、`validation.ts`、`frontier.ts`
- TUI 投影：`planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/`
- 契约文档：ADR-0017（Kernel/Executor 状态投影）、ADR-0021（Work Graph v4）、
  ADR-0022/0023（控制面与恢复）、ADR-0025/0026（单任务并发与可靠性）、
  ADR-0032（结果优先交付与完成认证）、ADR-0043（显式观察与客户端读模型）

## 待明确的问题（下一步）

1. 「任务状态」重构的目标：状态枚举收敛、状态机显式化、投影单一来源，还是对外读模型统一？
2. 状态定义当前分布在 `src/work-graph/types.ts`、`src/task/`、Kernel 投影与 TUI 面板，
   需要先确定唯一权威位置（ADR-0020 依赖方向约束）。
3. 是否需要新增 ADR（状态机/投影权威）以及对应的 `CONTEXT.md` 更新。
4. 迁移策略：是否需要保留既有状态值的兼容映射与一次性数据迁移。

## 约束

- 遵循 ADR-0020 的模块归属与依赖方向；不新增第二套语义路由或第二份状态权威。
- 持久化变更需同步 repositories 与 Docker 测试（`docker build -f Dockerfile.test`）。
- 不提交 `dist/`、数据库、凭据或本地工作区状态。
