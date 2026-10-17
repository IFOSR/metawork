# Desktop 退出卡住与升级恢复修复

- 计划日期：2026-10-17
- 状态：已完成本地实现、macOS arm64 安装与升级验收
- 完成日期：2026-10-17
- 范围：本地 arm64 DMG；不发布 release。

## 证据与原因

旧版 Server 已撤掉 runtime.lock、endpoint 和数据库连接，但进程在 Node
uv__threadpool_cleanup / uv_thread_join 中未退出。Desktop 升级 helper 仅按
runtime.lock 判断服务是否运行，恢复时跳过停止；launchd 仍持有该进程，
新启动复用旧 job，最终 startPrevious 超时，activation 停留 prepared。

另一处连接问题：Desktop 已显示 ready 后仍等待完整 Pi 文件清单检查，
connectPromise 长时间未释放，点击重新连接会复用旧 Promise。
不认定两个问题有共同底层原因。

## 修复

- Installer 明确停止时，在调用旧版正式 stop CLI 之前记录 launchd Server
  PID、当前用户、启动时间和安装内入口。无运行锁也执行停止收尾。
- 等待旧进程实际退出；超时后必须确认运行锁及 endpoint 已撤回，无持有
  Account/data 文件或网络/Unix socket，且 job/PID/启动身份未改变，才清理
  残留进程。权限、身份或资源检查失败则停止更新，保留恢复记录。
- 正常连接仍只等待现有 job，绝不强杀或替换运行中的服务。
- Pi 自动完整性检查独立于连接 Promise，每次 Desktop 运行最多启动一次。
- 不改变 Kernel、任务恢复策略、数据库或配置。

## 验证

- 50 项 lifecycle/installer/lock 回归和 23 项 Desktop 单元测试通过；Server 与
  Desktop 类型检查、Server/Web/Desktop 构建通过。
- 真实 launchd 故障注入：升级停止、运行锁丢失后停止均通过；使用真实
  0.1.15 Runtime 注入 exit 阶段停滞，连续两次停止通过。
- 最终 r2 包完整 clean-install smoke 通过，包含之前失败的重连菜单测试、
  配置激活、认证 Web，以及退出客户端后 Server 存活。
- 最终 r2 包从 0.1.17 upstream-result-fix 经 Finder 升级成功；重复打开两次、
  配置和数据保留、后台独立存活均通过。
- 最终 r2 包从真实 0.1.15 Runtime 开始，在已关闭运行锁/endpoint 的 exit
  阶段注入停滞，并中断更新 helper、移走 staging/helper：菜单修复成功
  rolled-back，随后重新升级 committed；配置、凭据和工作数据保留。
- 验收覆盖 ps 与 launchd 退出信息不同步的竞态；清理后等待真实退出，
  不把短暂的退出状态误认成 PID 复用。第一轮验收暴露的误报已修复，
  失败记录保留在构建目录，最终交付使用复验通过的 r2。
- DMG 镜像校验、应用 ad-hoc 签名、挂载内 app.asar/descriptor/helper 与被测
  应用一致性检查通过。原 upstream-result 修复仍在最终编译 payload 内。

## 交付

- 构建标识：`0.1.17-internal-desktop-exit-fix-r2-20261017`。
- 文件：`Release/MetaWork-0.1.17-desktop-recovery-fix-20261017-arm64.dmg`。
- SHA256：`a4a7e5d2f364b4a0da3957b6cbd6102975cfec9eded936601dd1496c9a4c1a3a`。
- 可分享的验收记录：`Release/desktop-recovery-fix-20261017-evidence/`。
- 完整构建及失败/复验记录：`.tmp/desktop-exit-fix-20261017/`。
- 用户当前安装未由本次测试替换；测试全部使用独立目录。未发布 release。
- Node 内部退出卡住以进程采样为依据；本修复在 Installer 侧保障安全停止
  和恢复，不声称修改或消除了 Node/libuv 内部问题。

关闭提交：`2d4c077e`；后续按用户授权纳入 v0.1.18 GitHub 发布。
