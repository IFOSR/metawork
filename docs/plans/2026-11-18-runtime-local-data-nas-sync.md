# 实例数据本地化 + NAS 异步同步（local-sync 数据模式）

- 日期：2026-11-18
- 状态：实现完成（代码默认仍为 pvc 模式，生产切换经 `RUNTIME_DATA_MODE=local-sync` 显式开启），待部署验证。
- 授权：用户提出实例提速需求——数据放 Pod 内本地盘（不绑节点），用户数据异步同步到 NAS 做持久化；确认接受「冷启动 1–3 分钟恢复」与「节点故障丢最近几分钟数据（RPO=同步间隔）」两个取舍，同步间隔 60 秒。

## 背景

实例数据盘此前 NAS（~46ms/事务 fsync 往返，卡顿主因）→ ESSD 云盘（~1ms）。
用户仍嫌慢，且明确要求**不与节点绑定**：Pod 完全可抛弃，NAS 是事实源，
本地写速度，冷启动从 NAS 恢复。生产排查发现两个旧实例仍建在 NAS 上（旧版
服务所建，10Gi `cloud-nas-cnfs`），已由用户手工 close 清理。

## 设计

Pod 结构（`RUNTIME_DATA_MODE=local-sync`）：

```
Pod（实例）
 ├─ init: restore   ── 本地空且 NAS 有快照 → 恢复到 /data；随后清 -wal/-shm
 ├─ main: server    ── /data（emptyDir，读写全本地 μs 级）；不挂同步卷（实例间隔离）
 └─ sidecar: sync   ── 60s 周期同步到 /sync/mw-rt-<id>（NAS RWX）+ preStop 终止前强制同步
```

同步内容（三档，全部幂等、单步容错）：

1. **SQLite 一致性快照**：`find /data -name '*.db'|'*.sqlite*'` 逐库经
   `node:sqlite DatabaseSync.backup()` 写 NAS（临时名 + 原子改名）——杜绝
   拷贝活库造成的不一致；
2. **git 工作区镜像**：`.git` 目录逐个 `git push --mirror` 到 NAS 裸仓
   （增量）；
3. **其余文件增量**：按 `.stamp` mtime 只拷变更文件（记忆文档、附件等；
   删除不传播，恢复可能复活已删文件——接受，注释已写明）。

恢复：init 容器在本地目录为空时先 `cp` NAS 的 `rest/` 与 `db/` 回 `/data`
（db 覆盖 rest，自含完整数据），再删除遗留 `-wal/-shm`（快照自含完整状态，
旧 WAL 属于不一致状态）。服务端启动脚本（清锁 + app/current 链接）不变，
在 init 之后执行。

生命周期语义：

| 事件 | 行为 |
|---|---|
| 运行中 | 全本地读写，μs 级 |
| 计划内停止（停机/升级） | sidecar preStop 强制同步一次，丢失窗口 ≈ 0；`terminationGracePeriodSeconds` 300s |
| Pod 重建/换节点 | init 从 NAS 恢复（约 1–3 分钟，取决于数据量） |
| 节点整机故障 | 丢最近一个同步周期（默认 60s） |

## 服务端改动（`official-server/server.js`）

- `RUNTIME_DATA_MODE`：`pvc`（默认，现状不变）| `local-sync`。配套环境变量：
  `RUNTIME_SYNC_PVC`（默认 `metawork-runtime-sync`）、
  `RUNTIME_SYNC_INTERVAL_SECONDS`（60）、`RUNTIME_LOCAL_DATA_SIZE`（emptyDir
  sizeLimit，25Gi）、`RUNTIME_TERMINATION_GRACE_SECONDS`（300）、
  `RUNTIME_SYNC_MOUNT`（官方服务挂载同一同步卷的路径；设置后 admin close
  连带删除实例 NAS 子目录）。
- 创建管线 `storage` 步：local-sync 下不再创建实例 PVC，改为校验共享同步卷
  存在（缺失 → `sync_pvc_missing`，实例落 failed 可重试）。
- `sandboxDeploymentManifest`：volumes 换 `emptyDir + sync PVC`；新增 restore
  init 容器与 sync sidecar（均只挂 data+sync；main 不挂 sync，用户代码触不到
  其他实例快照）；terminationGracePeriodSeconds。
- admin close：local-sync 且配置 `RUNTIME_SYNC_MOUNT` 时删除 NAS 子目录
  （close 语义 = 实例全部持久数据删除）；未挂载则跳过并记日志。
- `detectTemplateDrift` 不变：模式切换后存量实例自然显示「重建实例」，即
  cutover 路径。
- pvc 模式全部代码路径不变（默认值兜底）。

## 集群侧前置（ops，一次性）

`deploy/k8s/sandbox-baseline.yaml` 增加 RWX 同步卷 PVC
`metawork-runtime-sync`（`cloud-nas-cnfs`，1Ti）。启用模式前 `kubectl apply`
；官方服务 Deployment 如需 close 清理 NAS 目录，追加同一 PVC 挂载 +
`RUNTIME_SYNC_MOUNT=/sync`。

## 验证

- **数据同步生命周期演练（WSL，真实 SQLite/git/文件系统执行渲染脚本本体，
  `test/local-sync-scripts.test.js`，3/3 通过）**：
  | 场景 | 数据路径 | 结果 |
  |---|---|---|
  | 重新部署 / 版本更新 / 停机恢复（Pod 重建，本地空） | restore 从 NAS 快照恢复 | ✅ DB 行、git HEAD、记忆文件全部还原 |
  | 容器崩溃重启（emptyDir 随 Pod 保留，本地非空） | restore 跳过，本地现态继续 | ✅ 本地数据未被触碰 |
  | 停机 / 升级（preStop 终止前强制同步） | 最后写入进快照后 Pod 才终止 | ✅ 恢复含最后写入 |
  | Pod 硬删 / 节点故障（无 preStop） | 快照停在最后同步周期 | ✅ preStop 覆盖内的写入在、未同步增量丢（RPO=间隔） |
  同步产物三件套逐一核验：SQLite 快照可打开且行数正确（checkpoint 后主文件
  自含）、git 镜像 HEAD 与源仓一致、rest 文件内容一致。
- **本轮演练揪出两个真实 bug（已修复）**：
  1. `DatabaseSync` 调用缺 `new`——`node:sqlite` 强制构造调用，缺即抛错被
     `catch` 吞掉，**SQLite 备份从未执行过**（`&& mv` 永不触发）；
  2. `node:sqlite` 22.x（22.19/22.23 实测）**没有 `backup()` 方法**——改为
     `PRAGMA wal_checkpoint(TRUNCATE)` 后只拷主文件（checkpoint 后主文件自含
     完整状态，之后的写入进新 `-wal` 不污染拷贝），兼容全部 22.x。
  附带修复：脚本构建器抽到 `sandbox-scripts.js`（路径可注入，容器内缺省
  `/data`、`/sync` 不变），服务端改 import；转义错误（`\\$(...)` 导致 shell
  不展开）一并清除。
- `official-server` 测试 57/57（新增：local-sync 模式端到端——创建→running 的
  模板断言（emptyDir/sync 卷、restore init、sync sidecar + preStop、grace
  300s、不创建实例 PVC）+ close 不删 PVC 且标记 closed；跨数据模式更新防护——
  模式不一致时视图隐藏入口、升级 409 `data_mode_conflict`）。
  （WSL 侧全量套件 60 项中另有 1 项环境相关失败，按用户指示未追查；本地
  Windows Git Bash 侧同代码 57/57。）

### 自查发现并修复（2026-11-18）

1. **增量同步 mtime 竞态（数据丢失窗口）**：原实现把 `.stamp` 打成扫描结束
   时刻，扫描期间在写的文件（mtime 介于旧戳与新戳之间）下轮扫描会被永久
   漏掉。修复：扫描前记 `NOW`，扫完 `touch -d @NOW`，在途修改下轮必然重扫。
2. **git 扫描重复**：`find /data /workspace` 对同一卷重复列目录（/workspace
   是 /data 的 subPath），mirror 推送做双倍功。修复：只扫 /data（两种
   workspaceRoot 配置下 .git 都在其内，maxdepth 不变）。
3. **跨数据模式原地更新（切换期高危）**：模式是全局 env，切换后存量实例点
   「更新」会把模板整体换成另一类卷——云盘→emptyDir 会让数据留在盘外不可见。
   修复：`runtimes.data_mode` 列记录实例创建时模式（旧行缺省视为 pvc）；
   upgrade 对模式不一致返回 409 `data_mode_conflict`；provision 更新续跑路径
   同守卫；`sandboxView` 在不一致时隐藏更新/重建入口并暴露 `dataModeMismatch`；
   控制台对不一致实例显示迁移指引。迁移路径 = close + 重建（与升级门禁文案
   一致）。

### 已知限制（如实）

- `rest/` 增量不传播删除：恢复可能复活已删除文件（重建后可再删）。
- 同步瞬间正在写的非 DB 文件可能截断入快照（下一周期重扫自愈；SQLite 不受
  影响——它走 backup API）。
- NAS 子目录容量无自动回收：仅 admin close 清理；长期运行需关注 NAS 用量。
- local-sync 的 emptyDir `sizeLimit`（默认 25Gi）超限时是 kubelet 驱逐而非
  写入报错，表现为 Pod 重启进入恢复流程。

集群侧待办：ops apply baseline PVC → `RUNTIME_DATA_MODE=local-sync` 切换 →
真实实例冷启动恢复与 60s 同步观测。

## 推送批次（2026-11-18）

- 镜像 `official-server:1.5.19` 已推送
  （digest `sha256:6a4319ce5e14c47626a0bf86ac4e3546e36efaa2e7b549e8ffebd8a6d19645c1`，
  WSL Docker 构建，`--provenance=false --sbom=false`，部署清单已同步 tag）。
- 代码提交：`cf117eb8`（分支 `local/container-deploy-integration-squashed`，
  含 2026-11-17 控制台/订阅批次与 2026-11-18 local-sync 批次，22 文件）。
- 集群升级与 local-sync 启用（用户执行）：apply sandbox-baseline（同步卷 PVC）
  → set image 1.5.19 → 注入 `RUNTIME_DATA_MODE`/`RUNTIME_SYNC_MOUNT` 与同步卷
  挂载 → 老实例确认数据后 admin close（云盘/PVC 一并删除）→ 用户侧重建即
  local-sync 实例。
