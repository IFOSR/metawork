# ADR-0056: 容器部署直接运行镜像内代码

- 状态：已接受并实施
- 日期：2026-11-12
- 相关：[官方服务实例创建与查询方案（含 §14 容器直跑镜像与引擎统一）](../plans/2026-11-09-official-runtime-provisioning-design.md)

## 决策

K8s 容器部署（托管实例）不再把 release 代码拷贝到 PVC 上运行。容器直接运行镜像内的
`/app` 代码；镜像 tag 即版本。PVC 职责收窄为**状态存储**：SQLite 数据库、配置修订、
凭据、工作区、Planner 会话、升级日志。

原生 macOS 安装路径**保持不变**：`install-cli install/update/rollback`、版本化
`releases/` 目录 + `current` 指针、事务化升级日志继续服务原生场景。两条路径从此分叉。

## 背景

`install-cli` 源自 macOS 原生安装模型：没有镜像，代码必须以版本化目录形式落盘，用
`current` 指针切换、事务日志保证升级可回滚。容器部署复用同一路径后，每次创建/升级
都要把 ~2-3GB、数十万个小文件（`node_modules` 为主）拷到 NAS 类 PVC 上，实测
5-30+ 分钟（CNFS NAS 对小文件写极慢），且 PVC 上新旧两份 release 使存储翻倍。

在 K8s 形态下，镜像本身就是不可变的版本化产物——它天然提供版本化、可回滚（改回
tag）与一致性。把代码再拷一份到 PVC，唯一保留的独特价值是"数据库迁移与代码切换在
同一事务中"，而这个耦合可以在 server 启动路径以迁移守卫 + 迁移前备份等价覆盖。

## 语义

### 版本与回滚

- **升级** = 官方服务把租户 Deployment 镜像改为新 tag → Pod 滚动重建 → 新代码生效。
  全程无代码拷贝。
- **回滚** = 镜像 tag 改回旧版本。若新旧版本之间数据库结构发生过迁移，旧代码启动时
  会命中降级守卫拒绝启动（见下），需恢复迁移前备份。

### 迁移守卫（降级保护）

server 启动打开数据库时：

- 卷上 schema 版本 **高于** 当前代码支持版本 → 拒绝启动，错误信息写明卷被哪个版本
  迁移过、如何恢复（使用迁移前备份，或使用不小于迁移版本的镜像）。
- 卷上 schema 版本 **低于** 当前版本 → 先做迁移前备份（`PRAGMA wal_checkpoint` 后
  整库拷贝到数据目录 `backups/`），再执行迁移。

### 首启引导（全新 PVC）

容器环境（`METAWORK_CONTAINER_BOOTSTRAP=1`）下 active 配置缺失时，server 启动自动
播种最小配置（空 provider/model + planner/codex/pi 三套 harness 与 AgentClass 骨架，
形状与 `install-cli` 非交互安装一致），随后正常启动。原生路径不受影响：没有该环境
变量时保持原有的"提示先运行 install"行为。

### `app/current` 兼容层

Runtime 多处代码按 `ANYFUSION_INSTALL_ROOT/app/current/dist/...` 查找随版资源
（plan schema、pi-pdf、stall-guard、web 扩展）。容器 startScript 启动时建立
`app/current → /app` 符号链接，这些查找原样工作，Runtime 代码零改动。

## 后果

- 容器创建/版本更新从 5-30+ 分钟降到 1-3 分钟；PVC 不再存两份代码。
- 跨迁移边界的降级需要恢复数据库备份（迁移单向性所致，与旧设计相同；旧设计同样
  无法把迁移过的库回退），差别仅在于本设计把它显式化并给出可操作错误。
- 容器与原生的升级/回滚语义从此不同：原生按 release 目录回滚，容器按镜像 tag 回滚。
  `install-cli` 保留在镜像内，旧版 official-server 的 startScript 回退后存量卷照常
  工作，回退安全。
- `RUNTIME_RELEASE_ID` 不再被容器路径使用。
