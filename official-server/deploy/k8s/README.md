# MetaWork 官方服务 K8s 部署

SQLite 是单写者本地文件，拓扑约束：**副本数固定为 1、更新策略 `Recreate`、RWO PVC**。镜像与清单都在本目录，配置全部经环境变量注入（容器内不落 `.env`）。

## 1. 构建并推送镜像

在有 Docker/OCI 构建能力的机器上（构建上下文为 `official-server/`）：

```sh
docker build --provenance=false --sbom=false -t registry.cn-shanghai.aliyuncs.com/metafusion/official-server:1.0.0 .
docker push registry.cn-shanghai.aliyuncs.com/metafusion/official-server:1.0.0
```

`--provenance=false --sbom=false` 必须带：Docker 29 默认附加 OCI 证明清单（`vnd.oci.empty.v1+json`），阿里云个人版仓库会以 `unknown manifest class` 拒收。

阿里云仓库需先 `docker login registry.cn-shanghai.aliyuncs.com`；若命名空间 `metafusion` 下没有 `official-server` 仓库，需在控制台预先创建（或开启自动创建）。然后把 `official-server.yaml` 里的 `image:` 替换为实际地址。镜像零运行时依赖（仅 `node:sqlite` 内置模块），不含任何凭证。

## 2. 准备命名空间与密钥

```sh
kubectl create namespace nexusfusionai
kubectl -n nexusfusionai create secret generic metawork-official-secrets \
  --from-literal=ADMIN_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=PAYMENT_HUB_CLIENT_ID='<生产 Client ID>' \
  --from-literal=PAYMENT_HUB_CLIENT_SECRET='<client secret>' \
  --from-literal=PAYMENT_NOTIFY_URL='https://metawork.nexusfusionai.com/v1/payments/notify' \
  --from-literal=MODEL_BASE_URL='...' --from-literal=MODEL_API_KEY='...' --from-literal=MODEL_ID='...'
```

未配置 `PAYMENT_*` 时支付/退款关闭，服务其余行为不变；`MODEL_*` 缺省时仅内置 AI 不可用。

**支付网关已配置生产**：`PAYMENT_HUB_BASE_URL=https://opchub-openapi.metafusion.cn`。生产凭证部署时经 Secret 注入，不入库不进代码；联调用测试网关 `https://opc-openapi.dev.metafusion.cc`（已全链路验证）。凭证按环境隔离、不通用。
系统域名（公网入口）为 `metawork.nexusfusionai.com`（当前无 DNS 记录，部署后 A 记录指向本 Ingress 外网地址），支付回调复用同域：`PAYMENT_NOTIFY_URL=https://metawork.nexusfusionai.com/v1/payments/notify`（`opchub-openapi.metafusion.cn` 是 Hub 自己的网关域名，不能用作我方回调）。

## 3. 部署

清单中镜像、网关、域名均已按生产值填好；唯一需按集群实际情况核对的是 Ingress 部分——`ingressClassName: nginx` 与 `cert-manager.io/cluster-issuer: letsencrypt` 两个注解（若导入现成证书，去掉 cert-manager 注解并把 `secretName` 指向既有 Secret）。然后：

```sh
kubectl apply -f official-server.yaml
kubectl -n nexusfusionai rollout status deployment/metawork-official
kubectl -n nexusfusionai get ingress metawork-official   # 等待外部地址，配置 DNS 解析
```

## 4. （可选）迁移 huoshan 存量数据

新库为空库，用户需重新注册。若要保留既有账号/订单/权益，在首次启动前把 huoshan 的 SQLite 装进 PVC：

```sh
kubectl -n nexusfusionai scale deployment metawork-official --replicas=0
scp huoshan:/root/metawork-offical-server/data/official.sqlite ./official.sqlite
kubectl -n nexusfusionai cp ./official.sqlite <pod>:/tmp/official.sqlite   # 或经中转卷
# 数据目录在只读根文件系统外，直接拷入 PVC 挂载点：
kubectl -n nexusfusionai exec <pod> -- cp /tmp/official.sqlite /app/data/official.sqlite
kubectl -n nexusfusionai scale deployment metawork-official --replicas=1
```

迁移会用 huoshan 的事务性备份替代（推荐 `sqlite3 .backup` 产物），WAL 未合并时不要直接拷主文件。

## 5. 部署后验收

```sh
# 健康与核心接口
kubectl -n nexusfusionai port-forward deploy/metawork-official 8780:8780
curl -fsS http://127.0.0.1:8780/healthz
# 真实网关全链路（13 步；凭证走环境变量；生产网关需生产凭证激活后可用）
cd official-server && PAYMENT_HUB_BASE_URL=https://opchub-openapi.metafusion.cn \
  PAYMENT_HUB_CLIENT_ID='<生产 Client ID>' \
  PAYMENT_HUB_CLIENT_SECRET='<client secret>' \
  PAYMENT_NOTIFY_URL=https://metawork.nexusfusionai.com/v1/payments/notify \
  node test/real-hub-smoke.mjs
```

资金流验收：Web 注册 → 扫码支付 ¥9.90 → 权益自动生效 → `admin.js refund` 演练恢复。

## 运维要点

- **存储**：PVC 使用集群阿里云 NAS 存储类 `cloud-nas-cnfs`（网络附加，节点故障/Pod 迁移数据不丢）。SQLite 单写者低频写入，NAS 可承载，但**多副本与多挂载仍被禁止**（NAS 虽支持多挂载，双进程写同一 SQLite 文件会损坏数据）；上线验收先建账号/订单即真实写库验证。
- **备份**：`kubectl -n nexusfusionai exec deploy/metawork-official -- node -e "require('node:sqlite').DatabaseSync ... .backup"` 或停服拷贝整个数据目录；不要只拷主文件忽略 WAL。NAS 不是备份，定期把备份同步到集群外。
- **升级**：`kubectl set image` 后 Recreate 会先停旧再起新（秒级停机）；schema 升级是 `CREATE TABLE IF NOT EXISTS`，启动即完成。回滚 = 换回旧镜像 tag（schema 只增不改，向后兼容）。
- **限流**：Ingress 后 `TRUST_PROXY` 不可信（代理非 loopback），per-IP 限流退化为全局桶，已通过 `HTTP_RATE_MAX`/`AUTH_RATE_MAX`/`EMAIL_RATE_MAX` 环境变量调高；notify 路由免限流。
- **扩容禁止**：不要把副本数调到 1 以上，也不要把 PVC 换成可多挂载的读写卷——SQLite 双写会损坏数据。多实例需先迁移 PostgreSQL 等服务端数据库，属独立立项。
