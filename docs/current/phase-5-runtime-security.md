# Phase 5 Runtime Security And AgentClass Operations

## Runtime topology

MetaClaw runs every Executor attempt in a new Docker container. The control plane, `metaclaw-egress` proxy and attempt containers share the Docker-internal `metaclaw-control` network. Only the proxy also joins a non-internal outbound network. Attempt containers never receive the Docker socket, host networking, host namespaces, devices or privileged mode.

The control plane may run on the host or in a container. It must be reachable from `metaclaw-control` as the DNS name configured by `METACLAW_CONTROL_HOST` (default `metaclaw-control`). Containerized deployments should use a restricted Docker socket proxy or a remote Engine endpoint through `DOCKER_HOST`; do not mount the Engine socket into attempt containers.

When the control plane sees container-local paths but the Docker Engine resolves host paths, configure `METACLAW_DOCKER_HOST_PATH_MAP` as JSON from container prefix to Engine-host prefix. Runtime rejects unmapped bind sources instead of guessing. Provider API keys stay in the trusted control plane: every attempt receives only a random scoped bearer token and the internal URL of its short-lived model gateway.

Create the networks and proxy:

```bash
docker network create --internal metaclaw-control
docker network create metaclaw-egress-public
docker build -f docker/Dockerfile.egress-proxy -t metaclaw-egress:phase5 .
docker run -d --name metaclaw-egress --network metaclaw-control --restart unless-stopped metaclaw-egress:phase5
docker network connect metaclaw-egress-public metaclaw-egress
```

The Squid policy permits only public HTTP/HTTPS destinations and rejects loopback, link-local, RFC1918, carrier-grade NAT and IPv6 unique-local ranges after DNS resolution. No proxy port is published to the host. `workspace-engineering` and `restricted-custom` attempts do not receive proxy variables and remain on the internal network only.

## Canonical attempt images

Build both immutable attempt images after building the application bundles:

```bash
./scripts/build-attempt-images.sh
```

On PowerShell:

```powershell
.\scripts\build-attempt-images.ps1
```

At startup MetaClaw resolves each canonical image tag to a Docker image ID. Custom AgentClasses must be registered with an image reference, its current immutable `sha256:` image ID, a valid permission profile, and the command/arguments inside the image. A changed tag fails closed until the class is explicitly updated.

Example:

```text
/executor register research-bot \
  --image registry.example/research-bot:1.2.3 \
  --image-id sha256:<64-hex-digest> \
  --permission-profile restricted-custom \
  --command research-bot --args "run --prompt {prompt}"
```

Historical custom classes without the image/profile triplet remain visible for audit but cannot execute. There is no production host-process fallback.

## Mount and persistence contract

- `/workspace` is the only bind-mounted writable tree; `/tmp` is a size-limited tmpfs.
- `/source`, `/inputs`, `/handoffs` and a Git worktree's `/workspace/.git` are read-only mounts.
- The root filesystem is read-only and the process runs as UID/GID 1000 with all Linux capabilities dropped and `no-new-privileges` enabled.
- Canonical Codex also runs its own `workspace-write` sandbox with fail-closed non-interactive approval. Only the pinned canonical Codex image receives `seccomp=unconfined` so that nested user namespaces work; every other Docker restriction remains active, and custom images cannot request this exception.
- Workspaces persist under `${METACLAW_HOME}/workspace-store/workspaces/<task>/<generation>/<subtask>`; attempt containers are disposable.
- Checkpoints are immutable manifests. File bodies live in the SHA-256 CAS; SQLite stores URI, hash, size and reference metadata.
- Cancelled or archived Task workspaces receive a seven-day cleanup deadline. CAS objects are removed only after the last checkpoint reference disappears. Files explicitly exported outside the managed workspace/CAS roots are not removed.

## Runtime permission flow

Default profile operations do not request permission. An Executor calls `request_capability` only for a concrete out-of-profile operation. Runtime canonicalizes and persists the request, checkpoints and pauses the attempt, and submits `permission_requested` to the durable Kernel workflow. The Kernel returns grant, deny-to-Executor, or deny-and-escalate-to-Planner. Grants are attempt-bound and budgeted; user authorization is a durable fact from `/permission approve|deny <requestId>`, a gateway action, or a precise Planner interpretation.

Requests for privileged mode, Docker/host sockets, devices, host namespaces, policy mutation, credential probing, cross-Task data or proxy bypass are always denied. External mutations and repository promotion require exact one-shot authorization and must be implemented by a controlled provider adapter/outbox; a grant never exposes raw host credentials or host write access to the attempt container.

## Verification

```bash
npm run lint
npm run build
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
METACLAW_RUN_DOCKER_INTEGRATION=true npx vitest run tests/integration/docker-attempt-sandbox.integration.test.ts
npm run smoke:anyfusion
```

The integration and smoke commands require the canonical attempt images and a trusted local Docker Engine. The smoke path starts a trusted control-plane container, then verifies Planner → Kernel → disposable Executor attempt → scoped model gateway → persistent workspace/artifact → container cleanup. The attempt itself never receives the Engine socket.
