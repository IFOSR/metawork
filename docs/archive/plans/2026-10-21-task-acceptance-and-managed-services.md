# 任务验收、公开交付与受管服务实施

- 日期：2026-10-21
- 状态：源码实施、原生自动化、本地 DMG 干净安装与隔离升级验收完成；真实模型及外部平台门槛未执行
- 依据：`docs/tech-debt/task-acceptance-and-local-service-findings.md`

## 实施顺序与关闭条件

1. 统一 receipt / safe projection 归属解析，覆盖 primary、correction、跨任务/代际拒绝；接受必须进入原 publication 链路，不能直接完成任务。
2. Gateway、CLI、Web、TUI、Feishu 使用同一 pending decision 与期望身份，提供接受、重试和过期反馈。
3. 创建任务时固定公开目录，实际发布代码与文件，检查外部修改及路径逃逸；公开投影只展示 Workspace、任务目录、相对文件和交付状态。
4. 持久化受管服务规格与状态，从公开目录启动、健康检查、查询/日志/停止/重启以及 Server 恢复；保持 Planner 与 Kernel / Runtime 边界，补充真实依赖指导。
5. 同步 ADR、CONTEXT、技术概览与问题文档；运行各拥有层测试、类型检查与真实临时 Workspace / HTTP 服务用户案例。

## 验证记录

- 根仓库全量 `npm test`：562 个文件通过、18 个文件跳过；3853 个用例通过、32 个用例跳过，无失败。
- 最后服务规格边界校验及公开交付回归：`npx vitest run tests/execution/managed-local-service.test.ts tests/e2e/task-result-service-acceptance.test.ts tests/server/task-view-history-association.test.ts tests/delivery/user-artifact-publication-service.test.ts`，4 个文件、33 个用例通过。
- `npm run lint`、`npm run build`：通过；Web 保留已有的大包体积提示。
- Vendored Planner `npm run check`、`npm run build:offline`：通过。
- coding-agent 下执行 `node node_modules/vitest/vitest.mjs --run test/metawork-tui-controller.test.ts test/metawork-tui-result-actions.test.ts test/metawork-tui-render.test.ts`：3 个文件、54 个用例通过。
- 用户案例 6 个全部通过，实际检查临时用户目录文件、HTTP 200/503、独立 API frontier、接受不增加 Executor 次数、重试保留历史及已有项目更新。服务层验证真实 Server 进程退出后的恢复及受管进程组清理。
- 客户端覆盖 Gateway 协议、生产 TaskView 回调、飞书签名动作、Web SSR 动作和 TUI 控制/渲染；没有以命令文字代替实际服务验收。

## 完成记录

- 完成日期：2026-10-21（源码与上述自动化范围）。
- 已交付：统一 receipt/result 归属与六字段接受/重试；所有客户端的决策入口；创建时固定公开目录；普通/Git Workspace 完整代码交付及冲突保护；公开路径与文件投影；Kernel 授权的持久化受管服务与健康门；独立依赖推进和已有 Task 的有界服务动作；schema 51 与 ADR/CONTEXT/技术总览同步。
- 关闭提交：未提交（用户未要求创建提交）；变更保留在工作区供审阅。
- 未执行：本机无 Docker，容器回归未运行；真实模型任务与真实飞书消息验收未运行。测试 Planner/Executor 使用确定性后端，但文件、Git、SQLite、进程和 HTTP 为真实执行。
- 未升级用户已安装 Runtime，未修复或重启现场用户任务/服务，未对外发布安装包；下述隔离安装验收不代表现场任务已经修复。
- 完整矩阵：[问题与实施记录](../tech-debt/task-acceptance-and-local-service-findings.md#十三实施与验收记录2026-10-21)。

## 本地试用 DMG（2026-10-21）

- 文件：`Release/MetaWork-0.1.19-task-acceptance-services-20261021-arm64.dmg`，320691652 字节；仅本地交付、Apple Silicon、ad-hoc 签名，未公证或对外发布。
- Release ID：`0.1.19-internal-task-acceptance-services-20261021`；包含当前 Runtime、Web、Planner，数据库兼容版本 51。
- SHA-256：`a40e2e0d01846a4681ec018b8ceb84e3bdd6c839f86df51a12eb66e611941175`。
- Desktop 类型检查、构建、9 个文件 24 个测试通过。DMG 校验和、挂载后的应用签名、完整签名 inventory，以及 Runtime/Web/Planner 与当前构建的哈希比对通过。
- 实际 Electron 干净安装通过：隔离 HOME、受限 PATH、已认证界面、空配置保存、首次激活、失败探测保留配置、菜单与退出后 Server 存活；未调用付费模型。
- 使用与交付应用完全一致的副本，通过 LaunchServices/Finder 在 `/tmp/metawork-acceptance-upgrade-20261021` 验证旧版升级。隔离数据库从 schema 50 升到 51，原配置及测试数据保留；历史中断记录与失效 helper 恢复、两次重新打开、Server 独立存活均通过。
- 可分享证据在 `Release/task-acceptance-services-20261021-evidence/`；构建日志与完整源码来源记录在 `.tmp/task-acceptance-service-dmg-20261021/`。
