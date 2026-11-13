# 支持的平台（2026-11-07）

本文件是发布与验收的平台口径。它与 [ADR-0055](../adr/0055-no-kernel-target-architecture-and-contract-reset.md)
Decision ledger 的 D13/D14 一致：验收范围是本机 macOS arm64 + Web 客户端；其他平台按下面的
声明执行，不因为"代码还在"就默认可交付。

| 平台 / 表面 | 状态 | 说明 |
| --- | --- | --- |
| macOS arm64（本机 Web + Runtime） | **受支持，本轮验收范围** | 唯一在本轮做完整验收的组合 |
| macOS Web 客户端（浏览器） | **受支持，本轮验收范围** | 通过 `metawork server start` 提供，默认只绑 `127.0.0.1` |
| Electron Desktop（macOS） | 代码保留，**本轮不验收** | 需要在 Web 验收通过后单独验收 |
| Linux x64/arm64（Runtime） | **运维方自建，不随本仓验收** | 本仓不再提供 Docker 执行后端；沙箱与部署由运维方负责 |
| Feishu 集成 | 代码保留，**本轮不验收** | 不再作为验收阻塞项 |
| Windows | **不维护、停止发布更新**（D13） | 代码与测试不删除，避免破坏历史分支；不接受缺陷修复承诺，CI/发布不再覆盖 |
| Docker 执行后端 | **已移除**（D12） | `METACLAW_EXECUTOR_BACKEND=docker|container` 直接报错 |

## Windows 的具体含义

- 不再随 release 发布 Windows 产物，也不在发布说明中承诺 Windows 可用。
- 仓库中的 Windows 相关代码、路径分支和测试保留在树里，但不再更新、不再修复、不再作为
  合并门槛。修改这些代码不是必须的，删除它们也不是本轮的验收条件。
- 本地 Docker 测试资产已按 D12 退役；SQLite/POSIX 路径测试使用本轮受维护的 macOS 原生环境。

## 与发布元数据的关系

发布 manifest 的 `platform`/`arch` 字段继续描述产物本身；本文件的表格描述"是否受支持"。
两者冲突时以本文件为准，并在同一次发布里修正 manifest 或撤回产物。
