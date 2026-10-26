> 当前 Workspace 执行契约（ADR-0050）：新任务只有 In-place Workspace 写入。Executor 使用 Conversation 绑定 Workspace 的授权 `cwd`；只读任务通过只读源挂载和 Runtime scratch 运行，不申请 Workspace write lease，也不创建 publication。Worktree backend、候选发布和自动复制仅作为历史迁移事实，不能被新任务选择或恢复。

# Phase 5 Runtime Security And AgentClass Operations

## Runtime topology

The default backend runs the canonical Codex/Pi CLI as a trusted child process
inside the unified Runtime container. A write attempt uses the Conversation-bound
Workspace (or an authorized child path) as its `cwd`; a read-only attempt uses a
Runtime-owned scratch directory and a read-only Workspace boundary. Capability,
evidence and model-gateway services use loopback addresses. This is the minimal
demo boundary and does not claim a second OS-level sandbox for the child process.

The compatibility backend runs every attempt in a new Docker container. In that mode, the control plane,
`metaclaw-egress` proxy and attempt containers share the Docker-internal
`metaclaw-control` network. Only the proxy also joins a non-internal outbound
network. Attempt containers never receive the Docker socket, host networking,
host namespaces, devices or privileged mode.

The control plane may run on the host or in a container. Docker attempts must
reach it from `metaclaw-control` as the DNS name configured by
`METACLAW_CONTROL_HOST` (default `metaclaw-control`). In-place attempts do not
need the Docker Engine endpoint.
Containerized Docker compatibility deployments should use a restricted Docker
socket proxy or a remote Engine endpoint through `DOCKER_HOST`; do not mount
the Engine socket into attempt containers or native Executor processes.

When the control plane sees container-local paths but the Docker Engine resolves host paths, configure `METACLAW_DOCKER_HOST_PATH_MAP` as JSON from container prefix to Engine-host prefix. Runtime rejects unmapped bind sources instead of guessing. Provider API keys stay in the trusted control plane: every attempt receives only a random scoped bearer token and the internal URL of its short-lived model gateway.

Native installation stores static configuration only in immutable
`~/.metawork/accounts/local-default/config/revisions/<revision-id>`
directories selected by the account `config/active` pointer. Provider
credentials are referenced through the account SecretStore:
macOS defaults to Keychain and non-macOS native use requires the explicit
`METAWORK_SECRET_STORE=file` fallback. The managed launcher points only at
`~/.metawork/app/current`, captures the user's current directory for Planner
read-only inspection, and never reads personal Codex or Pi homes. Native
update/rollback refuses to mutate pointers while the daemon is running; online
admission closure and drain are not inferred from a PID file.

Docker compatibility topology:

```bash
docker network create --internal metaclaw-control
docker network create metaclaw-egress-public
docker build -f docker/Dockerfile.egress-proxy -t metaclaw-egress:phase5 .
docker run -d --name metaclaw-egress --network metaclaw-control --restart unless-stopped metaclaw-egress:phase5
docker network connect metaclaw-egress-public metaclaw-egress
```

The Squid policy permits only public HTTP/HTTPS destinations and rejects loopback, link-local, RFC1918, carrier-grade NAT and IPv6 unique-local ranges after DNS resolution. No proxy port is published to the host. `workspace-engineering` and `restricted-custom` attempts do not receive proxy variables and remain on the internal network only.

## Canonical Docker compatibility images

Build both immutable attempt images after building the application bundles:

```bash
./scripts/build-attempt-images.sh
```

On PowerShell:

```powershell
.\scripts\build-attempt-images.ps1
```

In Docker compatibility mode, MetaWork resolves each canonical image tag to a
Docker image ID. Custom AgentClasses are configured through Settings activation with an image reference,
its current immutable `sha256:` image ID, a valid permission profile, and the
command/arguments inside the image. The native in-place mode is restricted to the two canonical built-ins and does not
add a custom registration path. A changed
Docker tag fails closed until the class is explicitly updated.

The command surface exposes inspection and health diagnostics only; see the [current slash-command reference](commands.md).

Historical custom classes without the Docker image/profile triplet remain visible
for audit but cannot execute. In-place execution is an explicit trusted backend,
not a host-process fallback for arbitrary custom classes.

Executor availability uses a structured `probe()` rather than a boolean command
check. For Docker classes, the recovery probe verifies the local Engine,
immutable image, `metaclaw-control` network, runtime command, and configuration
in layers. For native in-place classes, it verifies the trusted runtime/profile and provider
configuration without an Engine or Docker-network probe.
Authentication/provider-network failures may add the Adapter's minimal remote
validation. A successful recovery check may only move that checked class from
`error` to `healthy`. Healthy/unverified classes are not periodically polled,
disabled classes never auto-recover, and a shared infrastructure result is not
projected onto classes that were not checked.

## Mount and persistence contract

- Native write attempts start with `cwd` set to the Kernel-authorized Conversation Workspace path. Read-only attempts start in Runtime scratch and receive only a read-only source boundary. The adapter validates containment before launch; no task-owned Git worktree or candidate directory is created.
- Native in-place execution does not jail the Executor to a copied `/workspace`: ordinary user-space files outside the authorized Workspace may be read or written only according to the active permission profile. Docker compatibility mode exposes `/workspace` as the only writable bind-mounted tree; `/source`, `/inputs` and `/handoffs` are read-only mounts, with a read-only root filesystem, UID/GID 1000, dropped Linux capabilities and `no-new-privileges`.
- Canonical Codex Docker attempts also run their own `workspace-write` sandbox with fail-closed non-interactive approval. Only the pinned canonical Codex image receives `seccomp=unconfined` so that nested user namespaces work; every other Docker restriction remains active, and custom images cannot request this exception.
- The user Workspace remains the durable source of in-place changes. Runtime scratch, attempt homes and evidence services are disposable; change records and receipts remain durable in SQLite/CAS.
- Checkpoints are immutable manifests. File bodies live in the SHA-256 CAS; SQLite stores URI, hash, size and reference metadata.
- Cancelled or archived Task workspaces receive a seven-day cleanup deadline. CAS objects are removed only after the last checkpoint reference disappears. Files explicitly exported outside the managed workspace/CAS roots are not removed.

## Runtime permission and audit flow

Default profile operations do not request permission. In Native in-place mode,
ordinary Workspace and user-space file operations are part of normal Executor
work rather than capability escalation. An Executor calls `request_capability`
only for a concrete controlled operation such as system-control access,
credential use, privilege changes, device or Docker control-plane access, or a
high-impact external effect. Runtime canonicalizes and persists the request,
pauses the attempt, checkpoints the now-quiescent workspace, and submits
`permission_requested` to the durable Kernel workflow. The Kernel returns
grant, deny-to-Executor, or deny-and-escalate-to-Planner. Grants are
attempt-bound and budgeted; user authorization is a durable fact from
`/permission approve|deny <requestId>`, a gateway action, or a precise Planner
interpretation.

The Runtime supplies `permission-profile-v1` rules to both the live attempt and authorization-recovery workflows. Exact Task-registered partitions may receive `additional_read_resource` grants when a controlled resource claim is required. Only `public-web-research` may receive a `network_target` grant after the target is normalized as credential-free public HTTP(S). Docker compatibility attempts use the egress proxy; native in-place attempts use the Runtime's normal network namespace. No profile rule permits secrets, privilege changes, system-control resources, Docker/host control sockets, devices, host namespaces, external mutation or repository promotion.

A granted response includes a `grantId`, but neither the request nor grant changes sandbox authority. `use_capability` accepts the operation payload, measures its UTF-8 bytes and atomically consumes attempt identity, expiry, call count and byte count. Read/network grants retain the 100-call/100-MiB audit budget; one-shot sensitive and logical requests allow one control payload up to 1 MiB. Budget rejection fails closed.

This initial model is a sandbox profile plus an authorization/audit budget. It does not provide a universal operation broker and does not claim fine-grained enforcement over every native file, network or external operation. A consumed grant proves budgeted authorization was recorded, not that an arbitrary native tool call was mediated. Native user-space file authority is intentionally broad and follows the MetaWork process identity. Requests for privileged mode, Docker/host sockets, devices, host namespaces, policy mutation, credential probing, cross-Task data or proxy bypass are always denied by the profile boundary. Future external-mutation or repository-promotion support requires a separately implemented and tested provider adapter/outbox; a grant never exposes raw host credentials or host write access to the attempt container.

## Verification

```bash
npm run lint
npm run build
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
# Run the Docker integration test from a control container with the Engine
# socket and an explicit host-path map.
# The default live smoke verifies two turns in one persisted AnyFusion-Pi Planner session.
npm run smoke:metawork
# The explicit artifact gate exercises Planner -> Kernel -> attempt -> publication.
npm run smoke:metawork -- --scenario artifact
# Provider-independent Gateway/replay/composition gate.
npm run smoke:gateway
```

Both live smokes run as native host processes by default, using the MetaWork
configuration installed under `METAWORK_CONFIG_HOME` (default
`~/.config/metawork`) and the in-place Executor backend; Docker is not
required. `--mode docker` instead builds the unified runtime image and runs
the same scenarios inside a control container against a trusted local Docker
Engine, requiring the `docker/*.env` provider files. The artifact
smoke verifies Planner → Kernel → disposable Executor attempt → direct Workspace
change/artifact delivery. The default smoke instead verifies native
Planner-thread continuity and does not prove the Executor artifact path.

In-place validation requires the trusted Codex/Pi CLIs and verifies child-process
start, authorized Workspace containment, loopback capability/evidence services,
cancellation, checkpoint/delta capture and live Workspace delivery. Docker
integration remains compatibility coverage.
