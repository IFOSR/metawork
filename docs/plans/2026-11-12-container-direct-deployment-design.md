# 容器直跑镜像改动方案（2026-11-12）

对应决议：[ADR-0056](../adr/0056-container-image-direct-deployment.md)。

## 改动清单

### Runtime（anyfusion-runtime 0.1.25.6）

1. **迁移守卫 + 迁移前备份**（`src/storage/database.ts`）：
   - `readSchemaVersion` 结果高于 `CURRENT_SCHEMA_VERSION` → 明确报错拒绝启动
     （现状是落到 `unsupported pre-release SQLite schema (N)` 的晦涩报错）。
   - 低于当前版本（即将执行迁移）→ 先 `PRAGMA wal_checkpoint(TRUNCATE)`，整库拷贝
     到数据库同目录 `backups/<name>.pre-migration-<from>-<timestamp>`，再迁移。
2. **首启配置引导**（新模块 `src/configuration/container-bootstrap.ts`）：
   - 仅当 `METAWORK_CONTAINER_BOOTSTRAP=1` 且 active 配置缺失时执行；形状与
     `install-cli` 非交互安装一致（`buildConfiguration` 骨架：providers/models 为空、
     planner/codex/pi 三套 harness 与 AgentClass、permissionProfiles）。
   - 原生路径无该环境变量，保持原"提示先运行 install"行为。
3. 容器宿主 env 注入 `METAWORK_CONTAINER_BOOTSTRAP=1`（由 official-server 模板注入）。

### official-server（1.5.13）

1. 租户 startScript 简化为：

   ```sh
   rm -f /data/anyfusion/data/runtime.lock;
   mkdir -p /data/anyfusion/app && ln -sfn /app /data/anyfusion/app/current;
   exec node /app/dist/index.js server start
   ```

   - 清运行锁保留（1.5.12 的修复，锁仍在 PVC 上跨容器存活）。
   - `app/current → /app` 兼容层让所有 `appCurrent/dist/...` 查找（schema、扩展）
     原样工作。
2. 租户 env 注入 `METAWORK_CONTAINER_BOOTSTRAP=1`；移除 `RUNTIME_RELEASE_ID`
   （容器路径不再使用；install-cli 保留在镜像内，回退到旧 official-server 即恢复
   旧启动路径，回退安全）。
3. `runtimeEnv.releaseId` 与官方服务清单里的 `RUNTIME_RELEASE_ID` secretKeyRef 一并
   移除；`.env.example` 同步。

### 不动的部分

- `install-cli` 与原生 macOS 安装路径（ADR-0056 明确分叉）。
- 官方服务的 `applied_image` / `service_ready` / 漂移检测：镜像 tag 即版本，语义
  不变反而更简单。
- 工作目录根限制、initContainer、`/workspace` subPath 挂载全部保留。

## 存量实例迁移

- 无数据迁移：卷上配置/数据库/工作区原地保留；`releases/` 旧拷贝成为死重（可后续
  手工清理）。
- 部署节奏：官方服务升 1.5.13 → startScript 变化触发漂移检测 → 实例页「重建实例」
  → 重建即切换（无 30 分钟拷贝）。

## 验收

1. 全新实例（空 PVC）创建 → 就绪 ≤2 分钟，配置自动播种。
2. 存量实例重建 → 数据保留，快速就绪；`app/current` 兼容层下 plan schema / 扩展正常。
3. 版本更新 → ≤3 分钟生效。
4. 降级守卫：被新版本迁移过的卷用旧镜像启动 → 明确报错。
5. 原生 install-cli 路径回归（未改动，单测全绿）。

## 实施记录（2026-11-12）

- 镜像：anyfusion-runtime 0.1.25.6（digest sha256:cc37f85f64f19d5f56e713dd0e7173eb9cbb07686f4fab9ce5323f1abb6b5e95）、
  official-server 1.5.13（digest sha256:1ae3280fa1c46bcb354ad8ac03e1d1af3b53d1e115bb794ecb3f60b2a52d6c1d）均已推送；
  `imagetools inspect` + `--pull=always` 拉取验证通过（dist 含引导与迁移守卫代码，
  official-server startScript 为直跑形态）。
- 实施中发现的一处设计修正：`activateDraft` 强制要求先 probe，而占位 Provider 无有效
  凭据、真探测必然失败——引导分支的 ConfigurationService 注入**直通 probe** 实现，
  正常激活路径不受影响。
- 测试：迁移守卫 3 项、首启引导 3 项（含降级拒绝、迁移前备份落盘、直跑断言）；
  official-server 51/51；`npm run lint` 干净；storage+configuration 全量
  636/641（5 项失败为既有 Windows POSIX 权限断言，改动前后一致）。

### 补丁（0.1.25.7）：新建目录表单死锁

`creating` 同时被当作"表单展开"与"请求在途"使用：点开表单的瞬间 busy 为真，
把输入框、创建、取消全部禁用——无法输入、无法取消。拆分为 `creating`（表单展开）
与 `submitting`（请求在途），busy 只含后者；表单内控件仅在 submitting 时禁用。

### 补丁（0.1.25.8）：占位凭据自愈

生产实机暴露（新用户全新实例崩溃循环）：首启引导播种的占位 Provider 是 enabled
的，而启动期凭据解析**失败关断**——0.1.25.6/0.1.25.7 只播种了配置、没播种凭据：

  Provider credential could not be resolved: default-provider

修复：

- 占位 Provider/Model 标记 `systemManaged: true`（系统 owned）
- 新增 `ensureBootstrapProviderCredentials`：每次容器启动补写缺失的 systemManaged
  占位凭据（首启覆盖 + 已坏存量卷重启即自愈），发生在 Planner 绑定解析凭据之前；
  **绝不触碰用户自己的 Provider 凭据**
- 镜像 anyfusion-runtime 0.1.25.8 已推送（digest
  sha256:be0ca59ce7dac15600fc76716f92d1fc4579ce421f17dcecdfae421074ebebe6）；
  引导测试扩至 6 项（自愈/不碰用户凭据/不覆盖已有凭据/systemManaged 断言）

### 补丁（0.1.25.9）：自愈放宽为"enabled 且凭据缺失"

生产实机暴露：0.1.25.6/.7 播种的卷，其 Provider 没有 systemManaged 标记（该标记
0.1.25.8 才加入种子），0.1.25.8 的自愈按标记圈范围把它们跳过——新用户实例继续
崩溃循环（`Provider credential could not be resolved: default-provider`）。

修复：自愈判定改为"enabled 且凭据缺失"——任何 enabled Provider 缺凭据都补占位值。
托管实例里凭据缺失必然是引导产物（激活/暂存流程都会写钥匙）；补进去的占位值让调用
得到供应商 401（设置页可见、可替换），好过实例被锁死在崩溃循环里。

镜像 anyfusion-runtime 0.1.25.9 已推送（digest
sha256:228575cdfcbea9431312176cbc11391286c0e304d6c422c5cd047c4be9353fcd）；
回归用例覆盖"无 systemManaged 标记的 .6/.7 播种卷必须被自愈"；测试 6/6、lint 干净。
