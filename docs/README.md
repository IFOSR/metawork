# MetaWork 文档

本目录只保留**现行权威**文档。历史计划、已完成或被取代的方案在
[`archive/`](archive/README.md) 中归档保存，仅作追溯，不再作为实现依据。

权威顺序（与 [`AGENTS.md`](../AGENTS.md) 一致）：
代码与测试 → 已接受 ADR → [`CONTEXT.md`](../CONTEXT.md) → `current/` 技术文档 →
现行计划 → 归档材料。

## 现行架构与契约（本轮收敛）

- [2026-11-11 完成收尾与状态一致性修复](plans/2026-11-11-task-completion-status-consistency-fix.md)
  —— 真实黄金/英伟达/天气任务复用已认证结果恢复，修复鸡蛋任务 TaskView 超预算、轨迹历史冒充实时卡片及错误上下文被显示为澄清；运行于 8788。

- [2026-11-11 Planning 故障追踪与真实 Web E2E](plans/2026-11-11-planning-web-e2e-fix.md)
  —— Admin 实测并修复提案/澄清上下文、空白回复、发布回写、Git 文件预览下载、窄屏和目录分页。前批完整 Web、真实三子任务汇总和 Memory 引用链通过；完整 maintained-host 与多候选 Router 仍未关闭。原隔离实例已按用户要求接管 8788，后续问题见完成收尾修复记录。

- [2026-11-10 全盘代码 Review 与修复报告](plans/2026-11-10-metawork-full-code-review-report.md)
  —— 对照 PRD/技术方案，记录 R-01～R-32 及逐项验证状态；新增金额链删除、fresh schema 67、Pi/native-only、Manager/Router 边界、快照保护和逐调用用量。当前 lint 通过，最近专项 182 通过 / 3 失败，最新全量未完成；历史浏览器/Electron 验收单独保留，整体仍未验收，仅本地修改。

- [2026-11-08 本地续作与验证记录](plans/2026-11-08-metawork-convergence-continuation-record.md)
  —— 按批次保留实现与验证证据；最新续作记录 R-25～R-32、三项失败、未重跑的 Pi/native 整批和后续修复顺序。旧全绿仅代表历史批次，仅本地修改，整体尚未完成。
- [ADR-0055：无 Kernel 目标架构与契约重置](adr/0055-no-kernel-target-architecture-and-contract-reset.md)
  —— **已接受（2026-11-07，产品 Owner 豁免交叉评审）**，含 D1–D14 决策台账。Phase 2–7 的权威。
- [目标契约设计](plans/2026-11-07-metawork-target-architecture-contract-design.md)
  —— owner 端口、持久事实表与幂等键、Route/Permission 契约、Kernel 17 类决策映射、命名与网络契约。
- [目标架构与契约重置实施方案](plans/2026-11-07-metawork-target-architecture-contract-reset-implementation-plan.md)
  —— P2–P7 批次表、退出条件、回滚点、批次记录。
- [产品与架构收敛实施计划](plans/2026-11-07-metawork-product-convergence-implementation-plan.md)
  —— 需求到批次的映射与阶段门；[技术实施方案](plans/2026-11-07-metawork-product-convergence-technical-implementation-plan.md)。
- [产品需求](plans/2026-11-07-metawork-product-requirements.md)、
  [复盘报告](plans/2026-11-07-metawork-product-convergence-retrospective-report.md)（事实基线）、
  [复盘证据](plans/2026-11-07-metawork-product-convergence-review-evidence.json)、
  [B0.2 失败分类记录](plans/2026-11-07-b0-2-baseline-failure-classification-record.md)。
- [P2-A 上游 Pi 集成 Spike](plans/2026-11-07-p2a-upstream-pi-integration-spike.md)
  —— 上游 1.5.0 能力结论与 fork 模块迁移矩阵。

## 当前技术文档

- [`CONTEXT.md`](../CONTEXT.md)：契约、领域词汇、运行时不变式、产品边界。
- [技术概览](current/technical-overview.md) / [中文技术概览](current/technical-overview.zh-CN.md)。
- [斜杠指令参考](current/commands.md)：唯一的当前指令清单。
- [支持的平台](current/supported-platforms.md)：本轮验收范围为 macOS arm64 + Web；Linux 由运维方自建；
  Desktop/Feishu 延后；Windows 仅声明不维护。
- [Phase 5 运行时安全](current/phase-5-runtime-security.md)：隔离边界与 Host 强制（无 OS 沙箱/容器/egress proxy）。
- [账户运行时与网关运维](current/account-runtime-and-gateway-operations.md)。
- [官方账号服务运行与验收](current/official-account-operations.md)。
- [Web 用户路径验收报告](current/2026-10-27-web-acceptance-test-report.md)。

## 现行计划（尚未被 ADR-0055 取代）

- [Workspace 内部 Git 与会话 Worktree 并行模型](plans/2026-10-29-workspace-internal-git-session-worktree-design.md)
  与[详细技术方案](plans/2026-10-29-workspace-internal-git-session-worktree-technical-design.md)。
- [多任务调度路线图](plans/future-multi-task-scheduling-roadmap.md)、
  [A2A Executor 传输路线图](plans/future-a2a-executor-transport-roadmap.md)。

## ADR

见 [ADR 索引](adr/README.md)。已接受 ADR 是权威；提案状态的 ADR 不构成实现依据。

## 归档

[`archive/`](archive/README.md) 保存历史计划、已完成方案、事故复盘与旧版技术文档。归档材料：
不更新、不作为实现依据、其中的链接可能指向已删除的代码。需要引用历史结论时请引用
**当前权威文档**中的对应条目。
