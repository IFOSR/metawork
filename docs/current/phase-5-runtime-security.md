# Runtime Security And Native Execution

Current boundary (2026-11-10, ADR-0055 D6/D12/D14): Manager and Executor use
packaged upstream Pi in isolated native processes. MetaWork is a trusted user
process with Host checks; it provides no OS sandbox, filesystem jail or network
egress isolation. The current acceptance scope is macOS arm64 + Web. Linux,
Desktop and Feishu acceptance are deferred.

## Execution and persistence

New Workspace Tasks use the Conversation Git Worktree authorized by admission,
not the retired `in_place` admission mode. The Task Runtime owns leases,
Attempt identity, change sealing, Workspace FIFO publication and cancellation.
A sealed result is not permission to publish: cancellation and delivery
eligibility are checked again before enqueue and during writeback. Read-only
source/context exposure and authorized `cwd` checks are application boundaries;
they do not prevent a native tool from accessing everything the host user can.

Manager/Executor processes receive MetaWork-owned homes, sessions and explicit
configuration instead of personal Pi/Codex homes. The shared Pi payload is
relocatable and pinned at packaging time; runtime resolution does not fall back
to a global Pi. Static configuration lives in account-scoped immutable revisions
selected by the account active pointer. Credentials resolve through the account
SecretStore (macOS Keychain by default, explicit file store where configured),
not through credentials copied from a personal agent installation.

Native process supervision and startup reconciliation remain production code.
The retained `containerId` field is a persistence identifier for native
processes, not evidence that a Docker backend is running. Cleanup must preserve
process ownership checks, Attempt receipts, checkpoint and uncertain-result
facts. An uncertain operation becomes a recovery item; it is never blindly
replayed or treated as successfully applied.

The local Docker backend, attempt/runtime images, egress proxy, Docker-only
tests and image publishing workflow have been retired. Selecting the Docker or
container backend fails explicitly. Container harness schema/catalog entries
remain a cleanup gap and do not enable a production backend. The independent
`official-server` deployment Dockerfile is retained.

## Permission ownership and limits

The Permission Service binds a normalized request to Account, Task, generation,
Subtask, Attempt, scope, profile and configuration revision. Host policy runs
before Manager judgement; hard-denied requests cannot be granted by a model or
user decision. Deny tokens such as `docker_socket`, cross-Task secrets and
permission-policy modification remain deliberate safety rules after Docker
retirement. Their presence does not expose those capabilities.

The production Manager permission seam reads intent from the authoritative Turn
Store and revalidates identity after asynchronous work. Missing/stale intent or
an invalid Manager answer cannot approve a request. Credential/external-effect
capabilities require exact user authorization. Concurrent resolutions use durable
request identity; cancellation and stale Attempt checks fence late replies.
Manager integration does not establish that every surviving static permission
policy already matches the final semantic-owner target; that remains a review
acceptance item.

Grants record expiry, call and byte budgets. Read/network grants normally allow
100 calls and 100 MiB; `once` narrows the call count to one. Other grant types
allow one control payload up to 1 MiB. `use_capability` measures UTF-8 payload
bytes and atomically checks/consumes the budget. Grant consumption proves a
recorded authorization; it does not prove that every arbitrary native tool call
was intercepted. MetaWork has no universal native file/network operation broker.

A native process retains the host user's network access and OS permissions.
Deployments requiring stronger filesystem, credential or egress isolation must
provide that boundary externally. Linux sandbox design is outside this round;
there is no in-product egress-proxy guarantee.

## Verification

```bash
npm run lint
npm run build
npm test
npx vitest run tests/resource/permission-policy.test.ts tests/execution/manager-permission-workflow.test.ts tests/execution/permission-workflow-service.test.ts tests/execution/attempt-execution-backend-reconciler.test.ts tests/executor/durable-native-process-runner.test.ts tests/e2e/read-only-workspace-boundary.test.ts
```

The opt-in actual-Pi test (`RUN_PACKAGED_PI_E2E=1`,
`tests/e2e/packaged-pi-native.test.ts`) uses a separately prepared packaging host,
isolated HOME and a local model fixture. It exercises actual Manager RPC,
permission and Executor processes without provider credentials. A complete
Manager → Router → Executor → publication → Manager summary task and signed
clean-machine installation remain separate acceptance gates.

The native credentialed smoke (`npm run smoke:metawork`, or
`-- --scenario artifact`) requires an explicit packaged Pi and a dedicated
`METAWORK_CONFIG_HOME` containing:

- `provider.env` with the key variables referenced by the fixture model files;
- `planner/models.json` and `planner/settings.json` for the Manager;
- `pi-home/.pi/agent/models.json` and `pi-home/.pi/agent/settings.json` for Executor.

These are explicit smoke inputs. `setup:native`'s active account revision is not
automatically imported by this script. The smoke uses an isolated installation
and child HOME; it must not target the user's live installation. Default smoke
checks Manager session continuity; artifact smoke additionally checks execution
and file delivery. Neither is reported as passed without actually running it.
Docker/container mode is rejected. See the [review report](../plans/2026-11-10-metawork-full-code-review-report.md)
for exact executed checks and remaining gaps.
