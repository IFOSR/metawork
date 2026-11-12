# 官方服务实例创建与查询方案（一期）

- 方案日期：2026-11-09
- 状态：基础能力已实施并部署（1.4.5 + anyfusion-runtime 0.1.25.3）；免密登录与自动登录方案 2026-11-11 确认（§9，门票 Cookie 长期有效与密码登录体验对齐），待实施（需 Runtime 0.1.25.4）。集群部署验收、ADR 与 `CONTEXT.md`/technical-overview 更新在上线验收时补记。
- 确认依据：用户 2026-11-09 确认六项决策——工作负载镜像已备好；每实例需要 PVC 持久化；一个账号一个实例，30 天无访问标记回收后人工处理；两个接口放在官方服务内；接口与资源命名 `/v1/runtimes` 采纳；访问域名为 `*.metawork.nexusfusionai.com`；集群为阿里云 ACK，已安装 VPA 组件（`ack-vertical-pod-autoscaler`）。2026-11-10 确认：**免密线一期整体不做**（域名开放访问，后续另立项）；HTTPS 证书使用**指定通配证书**（覆盖 `*.metawork.nexusfusionai.com`，TLS Secret `metawork-nexusfusionai-com-tls`）；资源与 Secret 命名由方案提出、最终待定；查询接口增加**步骤级 `steps` 进度字段**；文档与产品措辞统一为**"实例"**（接口路径、表名、配置键沿用 runtime 命名）；实例资源落在**已存在的 namespace `nexusfusionai`**（与官方服务同 namespace，不新建独立 namespace）。集群核对全部完成：CNI Terway（`terway-eniip` 7/7）、VPA CRD 存在、通配 DNS 已添加。
- 文档定稿日期：2026-11-10
- 实施完成日期：2026-11-10（服务端接口、K8s 客户端、六步管线、回收标记、部署清单、admin 台账与单元测试已交付；集群部署与真实域名验收待执行）
- 交付验证：`official-server` `npm test` 34 项全部通过（含本地 K8s 桩：创建/幂等重放/一账号一实例 409/402 权益/六步 running 轮转、失败步骤记录与逆序回滚、中断续跑只补建缺失资源、30 天回收标记、admin 台账与 close 逆序删除含 PVC、`RUNTIME_IMAGE` 缺失 503）；宿主机连跑 4 轮全绿；根仓库 `npm run lint` 通过。Docker 套件本机不可用（无 docker），留待部署环境执行。
- 收尾提交：未创建提交，等待用户验证。

## 1. 需求与核心决策

官方服务新增接口：一键创建 K8s 资源（承载 Pod 的 Deployment、Service、Ingress、VPA、PVC）并生成专属域名；查询构建信息（状态、步骤级进度、域名、资源与 VPA 投影）。对外产品叫法为**实例**。免密登录与自动登录已确认实施（钥匙 et 60 秒 + 门票 Cookie 7 天 + Runtime 会话采纳），完整设计见 §9。

1. 接口放在 `official-server/server.js`，复用既有 Bearer session 认证、权益核验、幂等键、限流与 SQLite 模式；不新增独立 provision 服务。
2. 创建为异步流程：接口落库并触发 K8s 资源创建，返回 `provisioning`；就绪状态与步骤进度由查询接口返回。
3. 一个账号同时只有一个活跃实例（`provisioning/running/suspended/recycle_pending`），数据库部分唯一索引强制——**不随试用/购买/续费/过期变化**；`suspended`（停机）同样占名额，防止停机期间另建新实例造成数据归属混乱。
4. 每个实例一个 PVC 持久化工作区数据；实例关闭需人工确认后才删除 PVC。
5. 生命周期：权益失效超宽限（默认 1 天）→ **停机**（scale 0，`suspended`，PVC 保留、计算成本归零）→ 停机超保留期（默认 30 天）→ 标记回收 `recycle_pending` → 人工确认后关闭（含删除 PVC）→ 此后才可重建全新实例。续费后 owner 查询即**重启同一实例**（数据/域名/sandboxId 不变）。另有与权益无关的活跃度回收：running 30 天无本人查询同样标记 `recycle_pending`。停机和回收都只做标记/缩容，**不自动删除**。
6. 调用方不可传镜像、命令或环境变量；镜像由服务端配置注入（已备好的工作负载镜像）。
7. 域名体系：`<slug>.metawork.nexusfusionai.com`；官方服务自身继续使用顶级域 `metawork.nexusfusionai.com`，两者并存不冲突。
8. 证书：租户 Ingress 直接引用**指定通配证书**的 TLS Secret（覆盖 `*.metawork.nexusfusionai.com`），全部实例复用同一个 Secret；不走 cert-manager 逐主机签发。
9. K8s API 经 in-cluster ServiceAccount 访问，`fetch` 原生实现，保持官方服务零运行时依赖（仅 `nodemailer`）。

## 2. 系统边界

```text
Web / Desktop 客户端 ──(既有 Bearer session)──> official-server（现有 Deployment，8780）
                                                  │ ① in-cluster ServiceAccount
                                                  │    在 nexusfusionai namespace（既有）创建
                                                  │    PVC / Deployment / VPA / Service / Ingress
                                                  ▼
用户浏览器 ──> https://<slug>.metawork.nexusfusionai.com
              （单 Ingress，指定通配证书；无访问门禁，知道域名即可访问）
                  → 租户 Service → 实例 Pod(+PVC)
```

实例资源与官方服务**同 namespace（`nexusfusionai`，已存在，不新建）**；官方服务经专用 ServiceAccount 持有该 namespace 内白名单资源种类的写权限，不授予任何 cluster-scope 权限。没有 namespace 级隔离层，隔离收敛为三层：资源命名前缀 `mw-rt-`、标签选择型 NetworkPolicy（只作用于实例 Pod）、Role 资源种类白名单。将来如需迁去独立 namespace，仅改 `RUNTIME_NAMESPACE` 与清单，代码不变。

## 3. 接口设计

### 3.1 创建：`POST /v1/runtimes`

认证：既有 Bearer session；创建消耗真实集群资源，执行与 `/v1/ai/operation` 相同的权益门禁（`assertEntitlement` 模式），无有效权益返回 402 `entitlement_inactive`。

请求：

```jsonc
{
  "idempotencyKey": "rt-20261110-001",  // 8–128，字符集与订单一致
  "name": "my-workspace",               // 可选展示名（≤48 字符）；slug 由服务端生成
  "tier": "small"                       // 可选，固定档位 small；预留扩展，不接受任意值
}
```

响应 202：

```jsonc
{ "sandbox": { "sandboxId": "rt_...", "status": "provisioning",
               "domain": "my-workspace-7f3a.metawork.nexusfusionai.com", "createdAt": "..." } }
```

规则：

- 幂等：同 `idempotencyKey` 重放返回既有实例；换 key 重复创建遇活跃实例返回 409 `sandbox_exists`（部分唯一索引兜底）。
- 限流：`runtime:<accountId>` 独立桶，默认 5 次/分钟。
- 失败：任一步骤失败即回滚已建资源，状态落 `failed` 并在 `steps` 中标注失败步骤与原因（不记正文）；`failed/closed` 不占"一个账号一个实例"名额，可重新创建（新 sandboxId）。

### 3.2 查询：`GET /v1/runtimes/{sandboxId}` 与 `GET /v1/runtimes`

归属校验照抄订单详情（`WHERE account_id = ?`），他人实例返回 404。列表接口返回本人全部实例（按创建时间倒序，上限 50）。

响应 200：

```jsonc
{
  "sandbox": { "sandboxId": "rt_...", "status": "provisioning", "domain": "...",
               "podPhase": "Pending", "resources": { "...": "..." },
               "vpa": null,
               "steps": [
                 { "name": "storage",   "status": "done", "at": "..." },
                 { "name": "workload",  "status": "done", "at": "..." },
                 { "name": "autoscale", "status": "pending" },
                 { "name": "network",   "status": "pending" },
                 { "name": "ingress",   "status": "pending" },
                 { "name": "ready",     "status": "pending" }
               ] }
}
```

步骤级进度 `steps`：固定六步，列表顺序即执行顺序，**首个 `pending` 即当前进行中的步骤**：

| 步骤 | 含义 | 完成判据 |
| --- | --- | --- |
| `storage` | PVC 就绪 | K8s create/get 成功（Bound 由后续 Pod 挂载隐式保证） |
| `workload` | Deployment 就绪 | K8s create/get 成功 |
| `autoscale` | VPA 就绪 | K8s create/get 成功 |
| `network` | Service 就绪 | K8s create/get 成功 |
| `ingress` | Ingress 生效，域名可路由 | K8s create/get 成功 |
| `ready` | 实例服务可访问 | readinessProbe（`GET /`）通过，Pod Ready |

- 每步完成即落库（`steps_json`），`ready` 由查询/GC 路径的 Pod 就绪轮询刷新；`status=running` ⇔ 六步全部 `done`。
- 任一步 `failed` → 整体 `failed`，该步携带原因字段。
- 服务重启打断的 `provisioning` 实例：确定性命名 + get-or-create 使管线可安全续跑，续跑后 `steps` 如实续记，不重复建资源。
- Pod 实时状态查询按单节流（复用 `hubQueryAllowed` 的 5 秒模式），节流窗口内回读库内投影；查询同时刷新库内 `pod_phase`。
- VPA 已安装但尚未产出推荐时如实返回 `vpa: null`。
- `status=recycle_pending` 的实例仍可访问（回收标记不阻断使用，删除只由人工执行）。
- **回收信号源**：免密不做后没有 verify/redeem 回调，`last_access_at` 改由**本人查询实例信息时刷新**（owner 查询 = 访问，距上次写入超过 60 秒才落库，避免读请求频繁写库）。30 天无查询即标记回收。

## 4. K8s 资源模型（namespace `nexusfusionai`，已存在复用）

每个实例（命名前缀 `mw-rt-<短id>`，确定性命名先 get 再 create，天然幂等）：

| 资源 | 规格 |
| --- | --- |
| PVC `mw-rt-<id>-data` | `cloud-nas-cnfs`，RWO，默认 10Gi（`RUNTIME_PVC_SIZE` 可调） |
| Deployment `mw-rt-<id>` | 1 副本、Recreate；镜像 = `RUNTIME_IMAGE`（配置注入）；挂载 PVC；档位化 requests/limits |
| VPA `mw-rt-<id>` | `autoscaling.k8s.io/v1`，`updateMode: Auto`，min/max 按档位；集群已装 `ack-vertical-pod-autoscaler` |
| Service `mw-rt-<id>` | ClusterIP，targetPort = `RUNTIME_PORT`（8788） |
| Ingress `mw-rt-<id>` | 单个；host = `<slug>.metawork.nexusfusionai.com`；TLS secretName = `metawork-nexusfusionai-com-tls`（指定通配证书）；注解：`proxy-read-timeout`/`proxy-send-timeout` 3600、`proxy-buffering off`（WebSocket 长连接） |

同 namespace 共存基线（实例与官方服务同住 `nexusfusionai`，三条共存纪律）：

- **不设 namespace 级 ResourceQuota**——配额一旦过紧，官方服务自身重启时会调度失败；一期仅设 LimitRange 兜底单容器默认值，集群总量靠 ACK 节点池承载。
- **NetworkPolicy 必须用 pod 标签选择器只选中实例 Pod**（专用 label，如 `app.kubernetes.io/part-of: metawork-sandbox`）：default-deny 其入流量、仅放行 ingress-controller namespace 进入，出流量放行 DNS 与 443；绝不能做 namespace 级 default-deny，否则会切断官方服务自身流量（CNI 已确认 Terway，可用，见 §8 第 1 条）。
- **官方服务改挂专用 ServiceAccount**（现有 official-server.yaml 未声明 `serviceAccountName`，实施时同步补上），Role 绑定该 SA，不放大到 `default` SA。

RBAC：专用 ServiceAccount + `nexusfusionai` 内 Role，仅 `pods/services/ingresses/persistentvolumeclaims/deployments.apps/verticalpodautoscalers.autoscaling.k8s.io` 的 get/list/create/delete。

### 4.1 镜像契约（已在仓库确认，无需人工核对）

`docker/metawork-server-k8s.yaml` 已给出 MetaWork Server 容器化约定：

| 项 | 值 |
| --- | --- |
| 监听 | `METAWORK_WEB_HOST=0.0.0.0`、`METAWORK_WEB_PORT=8788` |
| 就绪探针 | `httpGet /`（未鉴权返回 Web 首页） |
| 数据目录 | `/data`（PVC 挂载点），SQLite 单写者 → RWO + Recreate |
| 首次启动 | 容器内 `install-cli.js install/update` 落盘后 `server start` |

就绪判定无需人工确认：探针用 HTTP `GET /`，只依赖端口与首页可达。注意首次启动要落盘安装 release，就绪时间显著长于普通 Web 服务，`initialDelaySeconds` 需给足（现成清单为 10s + 10s 周期，实测后调整）——这段等待在 `steps` 中表现为 `ready` 长期 `pending`。

Pod 监听 `0.0.0.0` 后 Runtime 的 Origin 校验进入 remoteMode，只要求 Origin 主机名与 Host 头一致（`src/management/server.ts:693-701`）；nginx-ingress 默认保留原始 Host，无需任何改写 snippet。

## 5. 数据模型与生命周期

```sql
CREATE TABLE IF NOT EXISTS runtimes (
  id TEXT PRIMARY KEY,                 -- rt_...（对外字段名 sandboxId）
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT, slug TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL, image TEXT NOT NULL,
  status TEXT NOT NULL,                -- provisioning|running|suspended|failed|recycle_pending|closed
  domain TEXT NOT NULL,
  pod_phase TEXT, vpa_json TEXT, steps_json TEXT,
  last_access_at TEXT,                 -- 本人查询实例信息时节流刷新
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX runtimes_account_active ON runtimes(account_id)
  WHERE status IN ('provisioning', 'running', 'suspended', 'recycle_pending');
```

- slug：`name` 清洗为合法主机段（`[a-z0-9]`，3–30 字符，缺省用 `runtime`）+ 4 位 hex 后缀；`domain = <slug>.metawork.nexusfusionai.com`。
- 生命周期维护 sweep（并入现有 retention 周期，重入保护，WAL 先查后写）：
  1. **权益停机**：`running` 且 owner 权益失效（`entitlement` 不可用，含账号 disabled）超过 `RUNTIME_EXPIRE_GRACE_DAYS`（默认 1 天）→ Deployment scale 0 → `suspended`（PVC 保留）。
  2. **停机超期回收**：`suspended` 超 `RUNTIME_SUSPEND_KEEP_DAYS`（默认 30 天）→ 标记 `recycle_pending`。
  3. **活跃度回收**：`running` 且 `now - last_access_at > 30 天` → 标记 `recycle_pending`。事件只记日志，**不自动删除**。
- 重启：`suspended` 实例的 owner 权益恢复 `usable` 后，查询接口即 scale 1 → `ready` 步重置 pending → 复用六步管线就绪（数据/域名/sandboxId 不变，零新建资源）。
- 人工处理：`admin.js runtimes`（列出 suspended/recycle_pending/failed）与 `runtimes close <id>`（SSH loopback 管理）；close 逆序删除全部 K8s 对象含 PVC（资源删除名独立于 Deployment 名：PVC 为 `mw-rt-<id>-data`），行置 `closed`，域名随之不可达。
- 行长期保留（对齐 accounts/licenses 纪律）；`failed` 行保留失败步骤与原因字段供排查。

## 6. 命名总表（方案提出，最终待定）

| 名称 | 建议值 | 备注 |
| --- | --- | --- |
| 对外产品叫法 | 实例 | 接口路径/表名/配置键沿用 runtime 命名（`/v1/runtimes` 已确认） |
| 租户资源前缀 | `mw-rt-<短id>` | PVC/Deployment/VPA/Service/Ingress 共用 |
| 租户 namespace | `nexusfusionai` | 已存在复用，与官方服务同 namespace；将来迁移仅改 `RUNTIME_NAMESPACE` |
| TLS Secret 名 | `metawork-nexusfusionai-com-tls` | 已确认 |
| 实例域名 | `<slug>.metawork.nexusfusionai.com` | slug = 名称清洗 + 4 位 hex |
| 接口路径 | `/v1/runtimes` | 已确认 |

## 7. 配置增量（Secret/env）

| 键 | 说明 |
| --- | --- |
| `RUNTIME_BASE_DOMAIN` | 缺省 `metawork.nexusfusionai.com` |
| `RUNTIME_NAMESPACE` | 缺省 `nexusfusionai`（已存在，复用） |
| `RUNTIME_IMAGE` | 已备好的工作负载镜像引用（调用方不可传） |
| `RUNTIME_PORT` | 缺省 `8788` |
| `RUNTIME_TLS_SECRET` | 指定通配证书的 TLS Secret 名，缺省 `metawork-nexusfusionai-com-tls`（已确认） |
| `RUNTIME_RECYCLE_DAYS` / `RUNTIME_PVC_SIZE` | 缺省 30 天 / 10Gi |
| `RUNTIME_STORAGE_CLASS` | 缺省 `cloud-nas-cnfs` |
| `RUNTIME_IMAGE_PULL_SECRET` | 可选；私有仓库拉取凭据 Secret 名（docker-registry 类型，同 namespace 预建） |
| `RUNTIME_RELEASE_ID` | 可选；设置后租户容器启动先经 `install-cli` 落盘安装（已激活跳过/换版本 update/全新卷 install），否则直接前台启动 |
| `RUNTIME_OPENAI_BASE_URL` | 可选；租户 Deployment 的 `OPENAI_BASE_URL` 占位（配置模板渲染必须非空） |
| `RUNTIME_RATE_MAX` | 创建接口每账号限流，缺省 5 次/分钟 |
| `RUNTIME_EXPIRE_GRACE_DAYS` | 权益失效宽限，超期停机（scale 0）；缺省 1 天，0 = 失效即停 |
| `RUNTIME_SUSPEND_KEEP_DAYS` | 停机数据保留，超期标记回收交人工；缺省 30 天 |
| `RUNTIME_ACCESS_SECRET` | 免密令牌 HMAC 密钥，≥32 字符（免密上线时注入） |
| `RUNTIME_ACCESS_URL_TTL_SECONDS` | 钥匙链接有效期，缺省 60 秒 |

`K8S_API_BASE`（本地桩地址）与 `RETENTION_SWEEP_MS`（周期清理间隔）仅测试可覆盖，前者非 test 环境启动即拒绝；生产 K8s API 固定 `https://kubernetes.default.svc` 并校验 SA CA 证书。

## 8. 前置条件与风险（集群为阿里云 ACK）

现有官方服务已在该 ACK 集群生产运行，以下事实由 `official-server/deploy/k8s/official-server.yaml` 现网部署证实，方案直接沿用：nginx ingress controller（`ingressClassName: nginx` 与 `nginx.ingress.kubernetes.io/*` 注解）、CNFS NAS 动态存储类 `cloud-nas-cnfs`、标准 K8s API 形态（`networking.k8s.io/v1`、in-cluster ServiceAccount/SA RBAC）。

部署前需在集群实际核对（本机无集群访问权限，由运维执行）：

1. **CNI 已确认 Terway**（2026-11-10 集群实际核对：`terway-eniip` DaemonSet 7/7 就绪），NetworkPolicy 可用，§4 的 default-deny 实例网络隔离保留。
2. **VPA CRD 已确认**（2026-11-10 集群实际核对：`verticalpodautoscalers.autoscaling.k8s.io` 存在，2026-11-09 注册；组件 `ack-vertical-pod-autoscaler` 已安装）。
3. **通配 DNS 已添加**（2026-11-10 用户确认：`*.metawork.nexusfusionai.com` A 记录已指向现有 ingress SLB 外网地址，与 `metawork.nexusfusionai.com` 同一入口）；顶级域记录保持现状。集群验收时解析一个实际 `<slug>.metawork.nexusfusionai.com` 验证生效。
4. **证书 Secret 落位**：指定通配证书（已确认覆盖 `*.metawork.nexusfusionai.com`）以 TLS Secret `metawork-nexusfusionai-com-tls`（名已确认）放进 `nexusfusionai`（与租户 Ingress 同 namespace，天然满足）；部署前核对该 Secret 已存在且证书在有效期内。
5. **CNFS 按租户供给**：租户数 = PV 数，CNFS 动态供给按 PV 建子目录，初期量级无风险；扩容后关注 NAS 吞吐配额。
6. **探针与 NetworkPolicy 共存**（部署后首个实例验证）：readinessProbe（`GET /`）由 kubelet 发起，源是节点而非 Pod，个别 policy agent 会把它拦在 default-deny 之外；若被拦，为探针来源加一条 ingress 放行规则。

运行期风险：

7. **VPA 驱逐**：Auto 模式会驱逐 Pod，由 Deployment 重建，PVC 数据不受影响；表现为实例进程重启（秒级）。官方会话为内存态（ADR-0047），重启后实例回到未登录态——owner 从 Web 再点一次「进入实例」（新 et → 重新采纳）即恢复，一次点击。
8. **门禁与自动登录**：原"无访问门禁/实例未登录官方账号"两项风险由 §9 免密方案消除（全路径 auth-url 门禁 + et 自动登录）。方案落地后的残余边界：et 泄露窗口 = TTL（60 秒且一次性）；门禁 Cookie 长期有效但 host-only 不出本机，泄露风险与密码登录会话同级，由 revoke/`access_generation` 兜底；suspended（停机）实例同样受门禁保护，续费后经免密入口重启并重新采纳会话。
9. **客户端入口**：Web/Desktop 的创建/查询/进入入口是另一条工作线，本方案交付服务端接口、门禁与免密协议（Runtime 镜像 0.1.25.4 由本仓库构建）。

## 9. 免密登录与自动登录方案（2026-11-11 确认实施，待实施）

- 决策：原二期预留的 L1 门禁与 L2 会话采纳（方案 A）合并为一个特性实施——免密 URL 同时完成**开门、自动登录官方账号、权益刷新**三件事。钥匙（et）60 秒一次性；门票（门禁 Cookie）长期有效（跟随账号生命周期）；免密 URL 由独立接口与查询响应内嵌双通道提供；Runtime 镜像出 0.1.25.4（新增 exchange 端点与会话采纳）。
- 安全推论（不可拆分）：自动登录必须搭配全路径门禁——开放域名 + 自动登录 = 任何人以 owner 身份使用实例。门禁与本特性一同上线。

### 9.1 用户视角

1. owner 在 Web/Desktop 点「进入实例」→ 拿到一次性钥匙链接（60 秒有效）。
2. 打开链接：种 7 天门票 Cookie → 实例 Runtime 自动登录 owner 官方账号（无需密码）→ 权益在线核验刷新 → 跳转实例 UI。
3. 之后**长期直接访问域名即可**（门票放行，与账号密码登录体验一致，正常使用不会看到未登录）；换浏览器/清 Cookie/账号被 revoke 后，回 Web 再点一次即可（一次点击恢复）。

### 9.2 三类令牌

| 令牌 | 载体 | TTL | 一次性 | 用途 |
| --- | --- | --- | --- | --- |
| et 兑换令牌 | 钥匙链接 URL 参数（HTTPS） | 60 秒（`RUNTIME_ACCESS_URL_TTL_SECONDS`） | 是（内存 Map 兑换即焚） | 门禁兑换 + 官方会话兑换共用同一枚 |
| 门禁 Cookie `mw_rt` | 浏览器，host-only，HttpOnly+Secure+SameSite=Lax | **长期有效**（跟随账号生命周期：未 revoke、`access_generation` 未变即有效，无固定过期） | 否 | auth-url 放行；与账号密码登录体验一致 |
| 官方会话 `sessionToken` | 租户 Runtime 内存（ADR-0047 内存态纪律） | 遵循内存态纪律 | — | productionAuthorization / 权益核验 / 内置 AI |

### 9.3 接口契约

| 接口 | 认证 | 作用 |
| --- | --- | --- |
| `POST /v1/runtimes/{id}/access-url`（新） | Bearer + 权益 | 签发钥匙链接 `{ accessUrl, expiresIn }`；每账号限流；每次现签 |
| `GET /v1/runtimes/{id}`（扩展） | Bearer | 响应内嵌 `access.accessUrl`（现签，Web UI 直接用） |
| `GET /v1/runtime-access/redeem?et=`（新，免 Bearer） | et | 校验（HMAC/一次性/audience）→ 种长期门禁 Cookie → 302 `/_sandbox/exchange?et=` |
| `POST /v1/runtime-access/session`（新，免 Bearer） | et（请求体，自含 sandboxId） | **Runtime↔官方会话兑换**：校验 et → 为 owner 账号签发官方会话（`sessions.instance_id = sandboxId`，列已存在）→ 返回登录形状 `{ sessionToken, account, entitlement }` |
| `GET /v1/runtime-access/verify`（新，免 Bearer） | 门禁 Cookie | auth-url 回调：纯 HMAC 验签 → 200 放行 / 401 |

### 9.4 交互时序

```text
① owner 查询/点进入 → 现签 et → 钥匙链接
② 浏览器打开链接 → Ingress /_auth → official-server redeem
   校验 et → 种门禁 Cookie → 302 /_sandbox/exchange?et=
③ 租户 Runtime GET /_sandbox/exchange → 服务端直调官方 POST /v1/runtimes/{id}/session
   → 签发官方会话 → Runtime 采纳（LocalAuthorizationService.adoptSession）
   → verifyForProduction() 权益刷新 + 每日核验调度 → 种 Web 会话 → 302 /
④ 用户落地：已登录、权益 active、任务可派发
⑤ 后续请求：nginx auth-url 回调 verify（纯 HMAC，零 DB）→ 放行
```

### 9.5 改动清单

| 组件 | 改动 | 规模 |
| --- | --- | --- |
| `official-server/server.js` | 4 个新端点 + et 签发/一次性 Map + Cookie 签发/验签 + 会话签发（复用 sessions/grant） | ~150 行 |
| 租户 Ingress 模板 | 单 Ingress 拆双（`/_auth` 不带 auth-url，其余带）+ `auth-url`/`auth-response-headers` 注解 | 模板改动 |
| `official-server.yaml` | `RUNTIME_ACCESS_SECRET`（≥32 字符）注入 | 1 行 |
| **anyfusion-runtime 0.1.25.4（重建）** | ① `GET /_sandbox/exchange`（收 et → 调官方 session 兑换 → 采纳 → 种 Web 会话 → 302 /）；② `LocalAuthorizationService.adoptSession`（复用 accept/schedule，不改登录协议）；③ Web UI 零改动 | Runtime ~80 行 |
| Web/Desktop 客户端 | 「进入实例」按钮调 access-url 接口 | 另一条工作线 |

### 9.6 安全要点

1. 门禁闭合：除 redeem 外全部路径过 auth-url——陌生访问者无 Cookie 进不来，**不可能冒充 owner 使用已注入的官方会话**。
2. et 一次性 + 60 秒 + 绑定三元组（账号/实例/域名 audience），跨域名兑换被拒。
3. 会话兑换只认 et、只兑给绑定 sandboxId——租户 Runtime 无法为他人/他实例兑换。
4. 门禁 Cookie 与官方会话解耦：Cookie 长期有效、随 revoke/`access_generation` 失效；泄露风险与密码登录会话同级（HttpOnly+host-only），由撤销机制兜底。
5. 不记录 et/Cookie/会话明文（既有审计纪律）。

### 9.7 参数记录

et 60 秒一次性、双接口、Runtime 0.1.25.4、门禁与自动登录一同上线。2026-11-11 用户反馈修订：门票 Cookie 原 7 天过期会造成"到期直接打开显示未登录"，与账号密码登录体验不一致 → 改为**长期有效**（跟随账号生命周期：revoke/`access_generation` 失效，无固定过期）。

## 10. 验证计划

- 单元：`official-server/test/service.test.js` 增项（`K8S_API_BASE` 指向本地桩）：创建/幂等重放/409 一账号一实例/402 权益/202→running 轮转、`steps` 落库与查询投影、任一步失败回滚与 `failed` 原因、重启打断后管线续跑不重复建资源、查询节流与 `pod_phase` 回读、`last_access_at` 刷新与 30 天回收标记、admin close 流转。
- `npm run lint`；`docker build -f Dockerfile.test`（SQLite 相关照旧走容器）。
- 集群验收：测试实例真实创建 → 六步 `steps` 逐步推进可见 → 通配域名解析与证书生效 → 免登录直接访问 → WebSocket 长连接 → VPA 驱逐后 PVC 数据保留 → admin close 后域名不可达。
- 实施完成需按仓库规范补 ADR（官方服务新增实例托管能力，扩展 ADR-0047 边界）并更新 `CONTEXT.md` 与 technical-overview。

## 11. 实施记录（2026-11-10）

### 交付行为

- `official-server/server.js`：`runtimes` 表（部分唯一索引强制一账号一活跃实例）+ `POST /v1/runtimes`（权益门禁/幂等/限流/校验）+ `GET /v1/runtimes/{id}`、`GET /v1/runtimes`（归属校验、`steps` 六步进度、Pod/VPA 实况 5 秒节流回读、本人查询刷新 `last_access_at`）+ K8s 客户端（in-cluster ServiceAccount，原生 `node:http`/`node:https`，保持零依赖；`K8S_API_BASE` 仅测试可覆盖，非 test 环境启动即拒绝）+ 六步创建管线（确定性命名 get-or-create、失败记步骤原因并逆序回滚、`waitForReady` 就绪轮转、重启续跑：启动扫描与查询路径双入口）+ 30 天回收标记（并入 retention 周期，只标记不删除；周期本身 try/catch 兜底且新增 `busy_timeout=5000`）。
- `official-server/admin.js`：`runtimes`（recycle_pending/failed 台账）、`runtimes close <sandbox-id>`（逆序删除五类资源含 PVC，行置 `closed`；provisioning 中拒绝关闭）。
- `official-server/deploy/k8s/`：新增 `sandbox-rbac.yaml`（专用 ServiceAccount + namespace 级 Role 白名单六种资源 + RoleBinding）、`sandbox-baseline.yaml`（标签选择型 NetworkPolicy——只圈实例 Pod 的 default-deny 入流量与 DNS/443 出流量、LimitRange 单容器默认值；头注写明三条同 namespace 共存纪律）；`official-server.yaml` 补 `serviceAccountName` 与 Secret 注入 `RUNTIME_IMAGE`（optional）。
- `official-server/README.md`、`.env.example`、`deploy/k8s/README.md`：公开接口、管理命令、配置键与部署步骤同步。

### 实施中发现并修复的问题

1. **retention 周期与 SQLite 锁竞争**：测试以 `RETENTION_SWEEP_MS=50` 加速回收标记后，周期写与测试连接写冲突触发 SQLITE_BUSY 且未捕获会杀死进程。修复：连接加 `PRAGMA busy_timeout = 5000`，retention 回调整体 try/catch（本轮放弃下轮重试）。
2. **`k8sReason` 参数错位**：调用点传 `result.status`（数字）而函数按结果对象取 `.status`，所有失败原因都被记成 `k8s_undefined`。修复：函数改为接收状态码。
3. **查询路径抢先翻转 running**：`refreshLive` 仅凭"Pod Ready"就把 provisioning 置 running，创建步骤未完成时失败会被运行态掩盖。修复：加"五个创建步骤全部 done"门槛。
4. **回收测试语义错误（测试侧）**：回拨 `last_access_at` 后轮询查询接口，而"owner 查询 = 访问"会把信号刷新回当前时间，回收永远不触发（偶发通过是 sweep 抢先）。修复：回拨后只等 sweep 落标再查证。

### 迭代复查修复（2026-11-10，复查至零问题）

迭代规则：上一轮发现即下一轮输入，修复后重新全量验证，直到出现零问题轮次。

- **Round 1**：①LimitRange 的 apiVersion 误写为不存在的 `limits.k8s.io/v1beta1`（apply 会被拒），改为核心组 `v1`；②`k8sRequest` 无超时，K8s API 挂起会把管线永远钉在 inflight，加 10s socket 超时按 `k8s_unreachable` 处理交由续跑；③SA/证书文件缺失时异常路径不友好，统一折算为 `k8s_unreachable`；④私有镜像拉取缺 `imagePullSecrets` 支持，新增 `RUNTIME_IMAGE_PULL_SECRET`；⑤`K8S_API_BASE` 的"仅测试可覆盖"启动校验无测试覆盖，补第 35 项用例。
- **Round 2**：①**Pod 名假设错误（真实集群必挂）**——`waitForReady`/`refreshLive` 按名 GET Pod，而 Deployment 生成的 Pod 名带 ReplicaSet 随机后缀，按名查询永远 404；测试桩无条件返回 Ready Pod 完全掩盖了它。修复：改为 `list pods?labelSelector=app=<资源名>`（RBAC 已含 list），桩同步支持 Pod 列表。②测试连接未设 busy_timeout，密集写审计行时撞 sweep 写锁抛 `database is locked`，测试连接补同款 pragma；sweep 改"先查后写"（WAL 读不阻塞）消除空转写锁。③`secret.example.yaml` 补 `RUNTIME_IMAGE`/`RUNTIME_IMAGE_PULL_SECRET` 键。④补 `last_access_at` 刷新断言（§10 承诺覆盖）。
- **Round 3**：①Terway 的 NetworkPolicy 实现可能拦截 kubelet 发起的 readinessProbe（源为节点而非 Pod），补入部署核对清单（§8 第 6 条）与清单头注。②方案 §7 配置表与实现对齐（补 `RUNTIME_STORAGE_CLASS`/`RUNTIME_IMAGE_PULL_SECRET`/`RUNTIME_RELEASE_ID`/`RUNTIME_OPENAI_BASE_URL`/`RUNTIME_RATE_MAX` 与测试专用键说明）。
- **Round 4**：清理死代码——`k8sConnectionCache.insecure` 死字段、`sandboxIngressManifest` 无调用方的第三个参数。
- 清单机器校验：四个 YAML 经 js-yaml 全量解析验证结构正确。

### 遗留事项

- 集群部署验收（§10）：真实镜像 + 真实域名 + 通配证书 Secret + VPA 驱逐保留 PVC；通过后按仓库规范补 ADR 并更新 `CONTEXT.md`、technical-overview。
- `docker build -f Dockerfile.test` 套件：本机无 docker，未执行。
- 二期预留：免密门禁 L1（§9.1）、实例官方账号会话 L2（§9.2）。

### 生命周期迭代（2026-11-10 第二批，用户确认参数后实施）

用户追问"过期停机、续费后是重启还是重建"，确认口径：**停机重启同一实例（数据保留），仅人工删除 PVC 后才可重建全新实例**；参数宽限 1 天、停机保留 30 天。

- 状态机新增 `suspended`：唯一索引活跃集合扩为四状态（suspended 占名额，防停机期间另建）；`DROP INDEX IF EXISTS` + 重建索引完成存量迁移。
- sweep 扩展为生命周期维护（异步 + 重入保护）：①running + 权益失效超宽限（含 disabled 账号立即停机）→ scale 0 → suspended；②suspended 超保留期 → recycle_pending；③running 30 天无本人查询 → recycle_pending（原活跃度回收不变）。
- 重启链路：owner 查询时权益已 `usable` → `deployments/scale` merge-patch 回 1 → `ready` 步重置 pending → 复用六步管线就绪（零新建资源）。
- RBAC 增 `deployments/scale` 的 get/patch/update；`k8sRequest` 支持自定义请求头（merge-patch 的 Content-Type）。
- **复查捕获资源泄漏 bug**：PVC 实际名带 `-data` 后缀，而回滚/admin close 按 Deployment 名删除——桩 404 静默放行、真实集群 PVC 永远删不掉。修复：`SANDBOX_RESOURCES` 增独立 `resourceName` 映射，创建/读取/删除统一走 `sandboxTargetName`。
- 测试增至 37 项：过期停机（suspended + 402 拦新建）、续费重启（409 占名额 + 零新建 + scale 1）、停机超期回收（suspended 进台账 + recycle_pending + close 后续费重建新 sandboxId）、回滚断言改等待完成（原断言在删除落盘前读取，属竞态）。

### 全流程自查与自省（2026-11-10 第三批）

用户要求"自查整体流程、每个流程节点、最后自省"。逐节点核查状态机全部 10 条转换路径与并发交叉，捕获并修复：

- **停机保留期被查询重置（语义 bug）**：`touchLastAccess` 每次查询同时刷新 `updated_at`，而停机保留期判据用 `updated_at`——suspended 期间持续查询会让"停机超 30 天回收"永不触发。修复：新增 `suspend_at` 列（ALTER 存量库补列，重复执行吞掉），停机时刻落 `suspend_at`，保留期判据改 `coalesce(suspend_at, updated_at)`；测试同步验证"suspended 期间查询不影响回收判据、recycle_pending 落定后不可逆"。
- 镜像同步重建推送 `official-server:1.4.2`（digest `sha256:fa3bbf66...`）。

验证：37 项单测 × 3 连绿、根仓库 lint 通过。

**自省（如实记录当前弱点与未验证项）**：

1. **幂等重放要求有效权益**：过期用户重放旧 `idempotencyKey` 得 402 而非返回既有实例视图——重放语义作为"创建请求"处理，口径未与用户显式确认。
2. **启动 sweep 未直接测试**：进程启动时扫描 `provisioning` 续跑的路径与查询续跑共用 `provision()`，但启动入口本身无用例（需要双进程测试基建）。
3. **close 与 restart 的并发缝隙靠推理闭环**：close 在 restart scale 成功后到达时，资源先被 scale 1 再被删除——行为无害（Pod 短暂拉起后被删）但无用例。
4. **运维无告警**：`recycle_pending` 积压只存在于 `admin.js runtimes` 台账，无推送通知；依赖人工巡检（现行纪律）。
5. **生产侧全部未验证**：1.4.2 未部署；清单未经真实 apiserver apply；kubelet 探针与 NetworkPolicy 共存（§8 第 6 条）、通配证书、真实镜像首装时长均待集群验收。
6. **规模假设**：sweep 对每个 running 实例逐个查 entitlement（同库零网络），数百实例量级无压力；千级以上需改批量 JOIN。

### 官方服务地址钉生产（2026-11-10 第四批）

用户确认实例指向的官方服务地址走部署环境变量。核查发现风险：源码烘焙默认 `DEFAULT_OFFICIAL_SERVICE_URL` 是 huoshan 的 9222 **开发入口**（`src/authorization/official-service-client.ts:18`），租户 Deployment 模板此前未显式注入该变量——实例内 Runtime 的登录/权益/AI 会指向错误环境。修复：租户模板显式注入 `METAWORK_OFFICIAL_SERVER_URL`（缺省 `https://metawork.nexusfusionai.com` 生产域名，可用 `RUNTIME_OFFICIAL_SERVER_URL` 覆盖）。客户端强制 HTTPS，不能改用集群内 Service 的 http。镜像重建推送 `1.4.3`（digest `sha256:657ff3c2...`），37 项单测全绿。

### 首个真实实例联调（2026-11-10 第五批，进行中）

集群实跑：创建 202 ✓、六步创建全 done（0.9s，RBAC 修复后 403 消失）、Pod 拉起 ✓、VPA 实时建议回读 ✓。暴露两个镜像契约缺口并修复：

1. **租户模板缺 `METAWORK_SECRET_STORE=file`**：Linux 容器无 Keychain，`createLegacyProductionSecretStore` 启动即抛错（`src/configuration/production-secret-store.ts:51`），install 守卫正常但 server crash loop。已加入租户模板 env。
2. **RBAC 未随部署应用**：节点首次部署只 apply 了 official-server.yaml，sandbox-rbac/baseline 缺失 → storage 步 `k8s_403`。已指导节点侧 heredoc 补建 RBAC + patch serviceAccountName，403 消失。

镜像重建推送 `1.4.4`（digest `sha256:02dc2020...`），37 项单测全绿。待办：节点 set image 1.4.4 → close 卡死的 rt_3e11（provisioning 卡死、inflight 已释放、close 可删）→ 重建实例验证 running。

### 免密登录方案确认（2026-11-11 第六批，待实施）

用户确认实施免密登录：接口返回免密地址，打开即访问实例、自动登录官方账号并刷新权益。§9 由预留转为正式设计（L1 门禁 + L2 会话采纳合并，不可拆分——开放域名+自动登录=任何人以 owner 身份使用实例）。参数按建议值采纳：et 60 秒一次性、门禁 Cookie 7 天、双接口、Runtime 0.1.25.4。本批仅更新方案文档，未动代码；实施待用户指令。

### 门票有效期修订（2026-11-11 第七批）

用户反馈：门票 Cookie 7 天过期后直接打开实例会显示未登录，与账号密码登录（服务端会话无固定有效期）体验不一致。修订：门禁 Cookie 改为**长期有效**——HMAC 含签发时间但过期判定移除，失效仅由 revoke/`access_generation` 触发；`RUNTIME_COOKIE_TTL_DAYS` 配置删除。泄露风险与密码登录会话同级（host-only + HttpOnly + HTTPS），兜底机制相同。

### 免密登录实施（2026-11-11 第八批）

§9 方案全量实施：官方服务新增 access-url/redeem/verify/session 四端点（session 兑换路径定为 `/v1/runtime-access/session`，et 自含 sandboxId 免传 id）、租户 Ingress 拆双（`-auth` 门禁入口 + 主 Ingress auth-url 全验）、`runtimes.access_generation` 列（revoke 时 +1 失效全部门票）、`RUNTIME_ACCESS_SECRET` 启动强校验（RUNTIME_IMAGE 存在时）。Runtime 侧：`LocalAuthorizationService.adoptSession`（复用 accept/schedule/verifyForProduction，权限语义同登录）、`OfficialServiceClient.exchangeSandboxSession`、ManagementServer `GET /_sandbox/exchange`（et → 兑换 → 采纳 → 302 /）、组合根 hoist officialServiceClient 并注入 sandboxSessionExchange。verify 即活跃信号（刷新 last_access_at，60 秒节流）。official-server 单测 41 项全绿（新增 3 项免密用例：归属/402/404 守卫、redeem+门票属性+generation 撤销、session 兑换消费与 gate 前置）；根仓库 lint 通过。

### 官方服务控制台（2026-11-11 确认实施，随 1.5.0 交付）

确认在官方服务内内置静态控制台（`console-dist`，手写零构建 SPA）并新增公开首页：

- 页面：首页（品牌+价格表，价格来自 /v1/plans 不写死）→ 登录/注册 → 控制台（账户权益、套餐购买含微信扫码二维码、实例列表含状态/进度/域名/创建/进入按钮）。
- 认证：token 存 localStorage + Bearer（现有 API 零改动）；每次加载经 /v1/auth/session 校验，401 清 token 回首页。HttpOnly Cookie 会话作为二期安全演进。
- 托管：server.js 静态文件服务（GET /、/console/*，防穿越 + nosniff，API 前缀优先），Dockerfile COPY console-dist。
- 用户侧「停机实例」按钮一期不做（停机/回收走自动+人工）。

### 实施记录（第八批）

- 官方服务免密五端点 + 租户 Ingress 拆双 + access_generation 撤销：official-server 1.4.6 实现并推送；单测 40 项（后随控制台用例增至 41 项）。
- Runtime 免密采纳：LocalAuthorizationService.adoptSession（复用 accept/schedule/verifyForProduction）、OfficialServiceClient.exchangeSandboxSession、ManagementServer GET /_sandbox/exchange（et → 兑换 → 采纳 → 302 /）、组合根 hoist officialServiceClient 注入 sandboxSessionExchange；lint 通过，进入 anyfusion-runtime 0.1.25.4。
- 工作区回退事故：另一分支撤销操作误伤本特性文件（测试/清单/文档/Runtime 改动回退到 HEAD）。恢复方式：server.js/admin.js 从 1.4.6 镜像提取（与推送产物字节一致）；Runtime 改动与测试用例从实施记录重放；未跟踪文件（方案文档/console-dist/两清单）未受影响。重放过程中额外修复：种子 INSERT 列数不匹配、测试环境 sweep 写锁竞争（RETENTION_SWEEP_MS 200 + busy_timeout 10000）、免密用例信封命名与实现对齐。
- 控制台：console-dist 三件套 + vendored qrcode-generator（MIT）+ server.js 静态托管（防穿越/nosniff/API 优先）+ Dockerfile COPY + 单测（首页 HTML/app.js MIME/穿越 404/API 优先）。
- 镜像：official-server 1.5.0（digest sha256:d2d5cc03...，含控制台）与 anyfusion-runtime 0.1.25.4（digest sha256:3ee4c201...）已推送；冒烟通过（healthz/控制台 HTML/app.js MIME）。
- 单测最终 41 项 × 2 连绿 + lint 干净。集群升级与免密/控制台真机验收待用户执行（命令见交付）。

### 实例版本更新（2026-11-11 确认实施，随 1.5.2 交付）

用户确认：running/suspended 实例可升级；无一键回滚（配置回滚即全员降级通道）；无「不再提醒」选项。

- 版本判定：服务端配置镜像（RUNTIME_IMAGE + RUNTIME_RELEASE_ID）即最新版；实例存储镜像与之不同 = 有更新可用。版本比较用发布号逐段数字比较（0.1.25.10 > 0.1.25.9）。
- 实现：`POST /v1/runtimes/{id}/upgrade`（owner + running/suspended + 幂等 + inflight 拒绝）→ strategic-merge patch 整体替换 Deployment Pod 模板 → running 走 `updating` 状态轮询就绪回 running；suspended 仅换模板即时完成。install-cli 事务化 update 保留工作区数据。
- 状态机增量：`updating`（属活跃名额，唯一索引已含）；sweep 的停机/回收规则不碰 updating（短窗口豁免）。
- 回滚通道：运维把配置回滚到旧镜像 → 存量实例重新出现更新按钮（同一机制反向降级）。
- RBAC：deployments 增加 patch verb。镜像 official-server 1.5.2 已推送；单测 43 项 × 3 连绿 + lint 干净。集群升级 + 真机验收待用户执行。

### 就绪收敛修复（2026-11-11 第五批）

真实集群首跑暴露：Pod 已 1/1 Ready、五步创建全 done，但实例状态卡在 provisioning。三处缺陷与修复：

- **D1 安装期超过等待上限**：waitForReady 默认 180s，而首次启动需落盘安装 release（~600MB 拷 NAS，实测 5+ 分钟）→ 必然超时放弃，ready 步留 pending。`RUNTIME_READY_TIMEOUT_MS` 默认提到 900s。
- **D2 状态收敛完全依赖用户查询**：关闭页面即永远停在"部署中"。维护 sweep（60s 周期）新增就绪兜底：创建步骤全 done 且 Pod Ready 即收敛为 running，无查询也生效。
- **D3 节流误伤状态检查**：refreshLive 的 5s 节流把 Pod 状态检查一起跳过了（刷新太快反而看不到变化）。节流只保留在 touchLastAccess（写库 60s），Pod 检查不再被节流。

同时：门禁按用户澄清移除（免密是便捷手段而非准入条件）——沙盒域名可直接访问、用户在沙盒内账号密码登录；免密链接只省去输密码。verify 端点降级为活跃度信号记录。

镜像 official-server 1.5.5 已推送（digest sha256:bc70fc58...）；单测 44 项 × 3 连绿 + lint 干净（新增"无查询也会收敛"用例）。

### 控制台重构与权益适配（2026-11-11 第六批）

控制台页面重写与两处行为修复：

- **布局**：首页（公开落地页：右上角导航与 hero CTA 均随登录态切换）→ 登录/注册 → 后台改为左侧菜单 + 中央正文（实例/套餐/账户三菜单），样式对齐 MetaWork Web 深色主题。
- **列表键名不一致修复**：控制台曾读 `payload.instances`，服务端实际返回 `sandboxes` → 实例列表永远为空。前端兼容两键，并新增静态契约一致性回归测试（读源码断言两侧键一致）。
- **套餐页按权益适配**：内部永久=不可再购（全部卡片显示"已拥有内部永久权益"）；有效订阅=当前套餐显示"续费"；试用中=试用卡片"不可再试"；已过期/无权益=显示购买或一键激活。判断口径与服务端 `entitlementUsable` 对齐（状态、生效时间、到期时间三重检查）。
- **实例页**：单实例详情（名称/状态/版本/进度/规格/创建时间/域名）；部署中与更新中每 3 秒自动轮询 steps；版本更新按钮带确认弹框；running 显示域名与免密进入；权益失效引导购买；权益生效（试用激活/支付成功）后自动创建实例并跳到实例页显示进度。
- **patchDeploymentTemplate 返回值修复**：升级路径原先裸 return 导致 500。
- **upgrade 门禁顺序修复**：状态检查提前于镜像比对，provisioning 实例不再被误报 already_latest。

镜像 official-server 1.5.6 已推送（digest sha256:1541249c9732aaefd2ba0fb87184637fec86ad1b138ef0aebc68c7755003aeaa，单一 OCI manifest）。注意：首次推送因 buildx 默认附加 provenance/sbom attestation（vnd.oci.empty.v1+json）被阿里云 ACR 拒绝（unknown manifest class），tag 未落地；加 `--provenance=false --sbom=false` 重建后推送成功。远端验证：imagetools inspect 解析 + `--pull=always` 强制拉取运行冒烟通过（healthz / 控制台 HTML v1.5.6 / app.js 新函数标记）。单测 45 项全绿（新增契约一致性用例）。部署清单已同步 `official-server:1.5.6`。

### 免密链接 /_auth 路由修复（2026-11-11 第七批，1.5.7）

生产实机暴露：浏览器打开免密链接 `https://<域名>/_auth/redeem?et=…` 返回 401 `session_invalid`。根因：租户 `-auth` Ingress 无 rewrite 注解，`/_auth` 前缀**原样**转发到官方服务，而官方服务只注册了 `/v1/runtime-access/*`——`/_auth/redeem` 匹配不到路由，掉进兜底会话门禁。测试直连 `/v1/runtime-access/redeem` 未经过 ingress 路径映射，因此未暴露（生产侧验证缺口的又一实例）。

修复：官方服务为 redeem/verify/session 增加 `/_auth/*` 别名路由（与 `/v1/runtime-access/*` 同 handler，同样豁免 per-IP 通用限流）。存量实例的 `-auth` Ingress 对象无需任何变更，升级镜像即全量生效；Runtime 侧回调用的是服务对服务直连 `/v1/runtime-access/session`，不受影响。

回归：单测 46/46（新增用例断言 `/_auth/redeem` 无会话 302 → `/_sandbox/exchange`，并静态断言路由覆盖 `/_auth` 前缀防止 ingress 形状与路由再漂移）。镜像 official-server 1.5.7 已推送（digest sha256:6b4c79ce51645ff61035823f5b8205b08b1f849b997f128cb53a1791576e21dd，`--provenance=false --sbom=false` 构建）；远端验证：imagetools inspect + `--pull=always` 拉取运行，无会话请求 `/_auth/redeem` 返回 401 `sandbox_access_invalid`（路由命中证据）。

### 升级进度与就绪语义修复（2026-11-12 第八批，1.5.9）

真实缺陷（生产实机暴露）：实例点"更新实例"后状态瞬间变"运行中/已完成"，但容器
还在执行 install-cli（release 落 NAS，~600MB），Web 服务根本没起来。

根因三处叠加：

1. **就绪判定只看"有没有 Ready 的 Pod"**。Recreate 策略下 patch 模板后旧 Pod 仍
   存在（terminating，Ready 仍为 True），新 Pod 还在拉镜像——旧 Pod 的 Ready 被
   当成新 Pod 的 Ready，升级瞬间就报完成。判定必须**按镜像匹配**，并排除
   terminating 的 Pod。
2. **版本字段显示的是期望值**。`image` 在点按钮瞬间就被改成新版本，拿它当"版本"
   会让用户以为新代码已经跑起来了。新增 `applied_image` 列记录**实际运行**的镜像。
3. **升级路径从不更新 steps**。"部署进度"永远显示创建时的旧值。

实施：

- 新增 `applied_image` / `service_ready` 两列（`ALTER TABLE` 迁移）。
- `detectServiceReady` 统一就绪判定：镜像匹配 + 非 terminating + Ready；Deployment
  rollout 收敛作为附加条件（`status` 缺失时不阻塞——信息缺失不应永久卡住）。
- 升级进入 `updating` 时把 `ready` 步骤置 pending，就绪后置 done → 前端显示
  "更新中 n/6" → "完成"。
- 前端：`serviceReady` 作为"进入实例"按钮与域名链接的门槛；未就绪时提示
  "实例正在更新到版本 X，就绪后可进入"。
- 停机/续跑/兜底 sweep 同步维护 `service_ready`；`waitForReady` 支持 `updating`。

镜像 official-server 1.5.9 已推送（digest sha256:9b6aeed021b4977bf86b3fb77d2fc9ba58b905b64cd16d7a9a12fc530be5a59c）；
远端验证 `imagetools inspect` + `--pull=always` 拉取运行冒烟通过；单测 49/49
（含"旧 Pod 仍 Ready 时不得判定升级完成"的竞态回归用例）。

### 存量实例进入入口修复（2026-11-12 第九批，1.5.10）

`service_ready` 是 1.5.9 后加的列，存量实例该值为 0，而**没有任何路径会写它**：
控制台实例页读的是列表接口，列表也不触发检测——于是升级官方服务后，老实例的
"进入实例"按钮永久消失。

修复：三条路径都补检测并回填 `applied_image` / `service_ready`——
列表接口、详情接口（`refreshLive`）、维护 sweep 的存量收敛分支（running 且未
就绪的实例重新检测）。用户在 1.5.10 上刷新实例页即可恢复入口。

镜像 official-server 1.5.10 已推送（digest sha256:8abcc47aacea61d58218e2fc4bc245df445d00d0388e85b230318de5adb5a35e）；
远端验证 `imagetools inspect` + `--pull=always` 拉取运行冒烟通过；单测 50/50
（含存量实例恢复入口的回归用例）。

### 部署模板漂移与实例重建（2026-11-12 第十批，1.5.11）

产品级缺陷：官方服务的部署模板随配置变化（新增环境变量、挂载、initContainer、
镜像发布号），但模板**只在创建实例或版本更新时**写进集群。配置在实例创建之后
变更时，存量实例的 Deployment 仍是老模板——新增的工作目录根限制、持久化挂载、
发布号对齐全都不生效，且没有任何提示（用户视角就是"配置了却不生效"）。

实施：

- `deploymentTemplateDrifted` 比对镜像、env 集合、挂载、startScript（含发布号）
  与 initContainer 数量；Deployment 尚不存在时不算漂移。
- 详情与列表接口返回 `templateDrifted`；控制台在漂移时把按钮显示为"重建实例"
  并提示"配置已变更，需重建才能生效"。
- 实例升级接口在漂移时放行（镜像相同也允许重建）——否则 `already_latest` 会
  挡住生效路径。

镜像 official-server 1.5.11 已推送（digest sha256:58340dad071f8299727452e5e3d51bb47b7c809256b36bd1d0c356f1414fbca3）；
远端验证通过；单测 51/51（含漂移检测与重建的回归用例）。

### 遗留运行锁清理（2026-11-12 第十一批，1.5.12）

真实缺陷（重建实例实机暴露）：租户容器启动死循环——install-cli 报
"running Server cannot be safely coordinated"，server start 报"已在运行（PID 1）"。

根因：运行锁是 PID 文件锁，却放在 PVC 上跨容器存活。旧容器被 Recreate 删除时
收到 SIGKILL，exit 钩子来不及清锁；新容器里 PID 1 永远存在（当前进程自己），
`kill -0 1` 恒为"存活"→ 旧锁被误判为"Server 已在运行"。影响**所有**容器重启
场景（重建/OOM/节点迁移），不止重建。

修复：startScript 开头 `rm -f /data/anyfusion/data/runtime.lock`——容器即实例，
Pod 启动时容器内不可能有别的 Server 进程，此刻的锁必然是遗留的。startScript
变化会触发漂移检测，存量实例自动出现"重建实例"按钮，重建即拿到修复后的脚本。

镜像 official-server 1.5.12 已推送（digest sha256:32a651878aedf404557bfcd792f85549071b909a7811f2d53e4c20ce045a3bda）；
远端验证通过；单测 51/51（注入用例新增清锁断言）。
