# 工作目录根限制与目录新建（2026-11-12）

## 背景

托管实例（Runtime）的用户可以在 Web 端浏览并选择任意本机目录作为 Workspace。
托管环境下这带来两个问题：

1. **可能选到不该选的目录**。实例容器里 `/root` 是 HOME，安装期 `npm install -g`
   留下的 npm 缓存（数万个碎文件）就在 `/root/.npm/_cacache`。
2. **选中大目录后运行极慢且失败**。Workspace 每次使用前都要把源目录"拍照存档"
   （git baseline capture），对 `/root` 这样的目录意味着遍历并哈希几万个文件；
   期间目录还在变化（Pi 执行器与自身状态在写），于是抛出
   `source_changing: Workspace changed during incremental capture`，
   启动阶段的异常经 `launchFailureEvent` 归类为 `infrastructure`，
   表现为"上游执行暂时不可用"并每 30 秒重试一次。

因此需要给"用户可选工作目录"一个明确的根。

## 决策

用户 2026-11-12 确认：

1. **根目录由部署配置指定**，通过环境变量注入到实例容器。
2. **未配置时不限制**，与历史行为完全一致（浏览起点回到 `homedir()`）。
3. **持久化方案 B**：`/workspace` 挂在实例已有 PVC 的 `workspace` 子路径上
   （`subPath`），不额外申请存储。
4. **根目录不存在时实例启动失败**（不是自动创建）。

## 契约

### 环境变量

| 变量 | 位置 | 语义 |
| --- | --- | --- |
| `METAWORK_WORKSPACE_ROOT` | 实例容器（Runtime） | 用户可选工作目录的根；未设置 = 不限制。兼容名 `ANYFUSION_WORKSPACE_ROOT`（走 `PRODUCT_ENVIRONMENT` 惯例）。 |
| `RUNTIME_WORKSPACE_ROOT` | 官方服务 | 官方服务配置；设置后注入到租户 Deployment 的 `METAWORK_WORKSPACE_ROOT`。 |

官方服务的 `RUNTIME_*` 变量全部是"留空 = 该能力关闭"的形状，
`RUNTIME_WORKSPACE_ROOT` 沿用同一形状。

### 边界判定

根在**启动期**解析一次并 `realpath` 规范化，此后所有判定都基于规范路径比较：

- `isWithinWorkspaceRoot(root, candidate)`：`candidate === root` 或以 `root + sep` 开头。
  分隔符用平台原生 `sep`——生产路径全部来自 `realpath()`，与平台一致。
- 判定一律发生在 `realpath` **之后**：符号链接别名与 `..` 拼写无法把候选路径挪出根外。

三处服务端边界（前端隐藏只是辅助，不是授权）：

| 接口 | 越界行为 |
| --- | --- |
| `GET /api/workspaces/browse` | 403 `browse_path_forbidden`；根位置 `parent` 为 null |
| `POST /api/workspaces/select` | 抛 `workspace_outside_root`（400） |
| `POST /api/workspaces/mkdir` | 403 `workspace_outside_root` |

### 新建目录

`POST /api/workspaces/mkdir`，与浏览同门槛（仅浏览器 cookie 会话）。

```
Body: { parentPath: string, name: string }
→ 201 { directory: { name, path } }
```

约束：

- `name` 必须是**单级**合法目录名：非空、≤128 字符、不含路径分隔符、
  不为 `.`/`..`、不含控制字符与 Windows 保留字符。
- `parentPath` 必须存在、是目录，且位于根内。
- `mkdir(recursive: false)`——一次调用只产生一个目录，父目录必须已存在。
- 重名 → 409 `directory_exists`。

### 启动期失败

Runtime 在 Server 模式下启动前校验根：不存在 / 不是目录 / 不是绝对路径 → 启动失败，
日志写明原因。`server status` / `stop` / `doctor` 与客户端启动不受影响——
运维命令必须始终可用。

## 部署侧

`/workspace` 走实例已有 PVC 的 `workspace` 子路径。K8s 的 `subPath` 挂载要求子目录
**在卷上已存在**，否则 kubelet `FailedMount`、Pod 卡在 CrashLoopBackOff。
因此 Deployment 带一个 initContainer：挂整卷（不带 `subPath`）先
`mkdir -p /workspace && chmod 700 /workspace`，主容器再以 `subPath: workspace` 挂载。

`initContainers` 与 `volumeMounts` 都在 `sandboxDeploymentManifest` 里生成，
因此**创建**与**升级**两条路径都会带上：

- 新实例：直接带上。
- 存量实例：Deployment 未变时继续按旧行为运行（env 未变，也没有 `/workspace`）；
  升级时 `patchDeploymentTemplate` 会一并补上 initContainer 与挂载，
  initContainer 先建目录，主容器随后挂载成功。

官方服务一旦配置 `RUNTIME_WORKSPACE_ROOT`，存量实例在下一次**重建**（升级/回收重建）
时才会获得 `/workspace`；在此之前它们保持原样，不会因为 env 变化而启动失败——
env 只在 Pod 创建时注入。

## 前端

`WorkspaceCreator`（ADD WORKSPACE 弹窗）承担浏览与新建：

- 面包屑来自服务端 `crumbs`；根限制下从根开始，不出现文件系统根。
- ".. 上级目录"来自服务端 `parent`，根位置服务端返回 `null`，前端自然不渲染。
- 新增"+ 新建目录"行：点击后在列表顶部展开输入行（回车提交、Esc 取消），
  成功后**自动进入新目录**并刷新列表。

## 验证

- `tests/workspace/workspace-root.test.ts`（16 项）：根解析与失败模式、边界判定、
  浏览起点/越界/符号链接逃逸、新建目录的合法名与越界。
- `tests/workspace/workspace-directory-service.test.ts`：新增"根外目录被拒绝"用例。
- `official-server/test/service.test.js`（48 项）：新增 `RUNTIME_WORKSPACE_ROOT`
  注入用例（initContainer / subPath 挂载 / env）与未配置时的对照用例。
- `tests/management/server.test.ts`（71 项）通过。

## 未决 / 后续

- 存量实例的 `/workspace` 迁移需要一次升级或重建，没有自动 patch。
- 根限制只约束"用户可选目录"；Planner 的授权根（`ANYFUSION_PLANNER_WORKSPACE`）
  是另一套语义，未合并。
