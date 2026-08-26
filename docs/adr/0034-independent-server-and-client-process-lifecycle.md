# ADR-0034: Independent Server And Client Process Lifecycle

- **Status:** Accepted
- **Date:** 2026-08-26
- **Scope:** Server process lifecycle, independent Client launch, endpoint
  discovery, Conversation Workspace admission, and Server-owned Feishu
  transport lifecycle
- **Amends:** ADR-0031
- **Preserves:** ADR-0011, ADR-0015, ADR-0020, ADR-0022, ADR-0023, ADR-0024,
  ADR-0025, ADR-0026, ADR-0027, ADR-0028, ADR-0029, ADR-0030, ADR-0032,
  ADR-0033
- **Related design:**
  `docs/plans/2026-08-26-independent-server-client-and-tui-experience-design.md`
- **Implementation plan:**
  `docs/plans/2026-08-26-independent-server-client-and-tui-experience-implementation-plan.md`
- **Governed by:** ADR-0020

## Context

ADR-0031 established one `AccountRuntime`, one Conversation model, and one
transport-neutral Gateway for all user surfaces. Its first implementation still
coupled process lifetime to a selected foreground surface: the composition root
started Runtime and Gateway, launched TUI or Web, and shut the Server down when
that surface exited. Script mode and `gateway run` also remained alternate
lifecycle entry points.

That topology makes a Client appear to own Runtime lifetime. It prevents users
from independently opening and closing TUI and Web clients against one
long-lived Server, and it leaves process `cwd` acting as an implicit user
Workspace authority.

## Decision

### 1. Server Is The Only Runtime Owner

`metawork server start` starts one persistent user-level Server process. The
Server owns `RuntimeRegistry`, `AccountRuntime`, Conversation runtime, Planner
Host, Kernel, Execution, storage, recovery, timers, Gateway transports,
management projections, and the configured Feishu adapter.

Server startup never launches a TUI process or opens a browser. Client
disconnect never initiates Server shutdown. The Server remains alive until
`metawork server stop`, `metawork server restart`, an operating-system service
stop, or a fatal startup/runtime failure.

Shutdown order is:

1. close command and platform admission;
2. stop listeners and new deliveries;
3. drain accepted commands, Runtime work, and bounded delivery work;
4. stop Planner, Execution, AccountRuntime, and storage;
5. remove endpoint manifest and release the runtime lock.

### 2. Clients Have Independent Lifecycles

The canonical Client commands are:

```text
metawork
metawork tui [--conversation <id>]
metawork web [--conversation <id>]
```

Bare `metawork` is exactly the TUI Client command. TUI reads the local endpoint
manifest and connects to the Unix Gateway. Web validates the same Server
identity and opens the Server-owned loopback HTTP origin; the browser connects
through the existing HTTP/WebSocket contracts. Neither Client constructs
Runtime, storage, Planner, Kernel, Execution, or a Server child process.

Script Client, `gateway run`, `--connect`, foreground Web, and any other
surface-selected Server lifecycle are removed rather than retained as
compatibility paths.

### 3. Server Exposes Stable Local Transports

One ready Server exposes:

- a mode-`0600` local Unix Gateway for native clients;
- a loopback HTTP/WebSocket endpoint for Web, management, query, artifact, and
  health contracts;
- a Server-owned Feishu transport adapter when configuration is valid.

The Web HTTP/WebSocket/query projections remain a semantic and field superset
of the current Web Client requirements. Existing fields are not removed,
renamed, narrowed, or assigned a different meaning as part of lifecycle
separation. Generic Gateway events may be additive but may not replace richer
Web Application-Shell projections.

### 4. Endpoint Discovery Is Server-Owned

After recovery and all required listeners are ready, Server atomically writes a
mode-restricted endpoint manifest beneath the installation runtime directory.
The manifest contains only safe connection facts:

```text
manifestVersion
serverVersion
gatewayProtocolVersion
pid
startedAt
state: ready | draining
unixSocketPath
webOrigin
```

It never contains a user Workspace, account database path, credential, secret,
or client authority. Clients use one shared resolver to validate manifest
version, protocol compatibility, process identity, socket/health reachability,
and ready state. A stale PID or stale endpoint is not treated as a running
Server.

One `runtime.lock` fences Server ownership. Clients never acquire that lock.
Manifest creation is the final ready transition; manifest removal is part of
shutdown and startup-failure cleanup.

### 5. Server Startup Is Workspace-Neutral

Server startup does not accept, infer, persist, or publish a user Workspace.
Process `cwd` is not an execution authority. Account-internal storage such as
`workspace-store/` remains an account runtime path and is not the
user-selected repository Workspace.

Each Conversation has one durable nullable Workspace:

```text
workspace:
  path
  selectedAt
  selectedByPrincipal
```

New Conversations start with `workspace: null`. The only mutation command on
every Client surface is:

```text
/workspace /absolute/path
```

Gateway treats the path as untrusted input. The Server resolves and canonicalizes
it with `realpath`, verifies that it is an accessible directory, applies
Principal/account authorization, fences active Turn/Task work, atomically
persists the Conversation metadata, and emits `workspace_changed`.

Relative, missing, non-directory, inaccessible, or unauthorized paths fail
closed. An active Turn or Task returns `workspace_busy`. A semantic user message
without a Workspace returns `workspace_required` before Planner startup.
Attach and replay restore the durable Workspace. Different Conversations on the
same Server may bind different Workspaces. Each admitted Turn retains the
Workspace reference fixed at admission.

### 6. Feishu Lifecycle Is Server-Owned

There is no `feishu run` command. Server composition owns the Feishu adapter.
When active configuration contains a valid robot configuration, the adapter
connects automatically and performs bounded reconnect. Configuration activation
starts, stops, or reconnects it idempotently. Missing configuration leaves the
adapter disabled without preventing Server readiness.

Feishu messages and `/workspace` commands still enter `ClientGateway`; the
adapter does not call ConversationSession, Planner, Kernel, Execution, or
storage directly.

### 7. Protocol Negotiation And Draining

Every transport negotiates a versioned public Gateway contract. A Client with
an unsupported protocol fails before attach or command submission and receives
a concrete upgrade diagnostic. During draining, existing accepted work may
finish according to Server shutdown policy, but new attachments and commands
are rejected with a structured draining state.

Gateway events contain complete, replayable, sanitized facts needed by TUI,
Web, and Feishu presentation. They may include public stage, routing,
permission, execution, verification, result, artifact, connection, and
Workspace facts. They never expose hidden reasoning, prompts, credentials,
secrets, unrestricted tool payloads, raw stdout/stderr, or internal signatures.

## Ownership And Dependency Direction

ADR-0020 remains authoritative:

```text
Client launchers and views
  -> endpoint resolver / Gateway transports
  -> Gateway and Application-Shell projections
  -> AccountRuntime ports
  -> Planning / Kernel / Execution / Storage
```

Client code may not import or construct repositories, Planner, Kernel,
Execution, `AccountRuntime`, or `ConversationSession`; it may not call Server
shutdown. Server-owned Feishu code depends on the Gateway facade, not concrete
conversation or runtime implementations.

## ADR-0031 Amendment

ADR-0031 remains authoritative for Principal, Account, AccountRuntime,
Conversation, ClientConnection, Gateway identity, account isolation, mailbox,
event routing, and runtime ownership.

This ADR supersedes only ADR-0031 implementation evidence that described:

- foreground selection after shared Gateway startup;
- native TUI or script as foreground clients of the Server composition;
- Web as a foreground Server mode;
- script as a supported Gateway Client;
- one process lock shared by foreground composition modes.

Those statements are historical evidence of the first ADR-0031 cutover, not the
target lifecycle after ADR-0034. The domain rule that Client disconnect
preserves Conversation and AccountRuntime is retained and strengthened into a
process-lifecycle guarantee.

## Consequences

- Users explicitly start one Server and independently open or close multiple
  TUI and Web clients.
- Client exit cannot interrupt accepted Runtime work.
- Workspace authority becomes explicit, durable, Conversation-scoped, and
  authorization-checked.
- Server process management requires a shared manifest, health validation,
  lock ownership, draining, and stale-state recovery.
- CLI behavior is a deliberate hard cut; removed lifecycle commands are not
  silently accepted.
- TUI presentation can evolve independently while Web keeps its current
  information architecture and richer projections.

## Rejected Alternatives

### Keep Foreground Surface Selection

Rejected because Client lifetime would continue to control Runtime lifetime.

### Auto-Start Server From A Client

Rejected because it hides process ownership, makes failures ambiguous, and
allows different clients to race to construct Runtime.

### Bind Server To Startup CWD

Rejected because one Server must serve Conversations using different
Workspaces, and process launch context is not user authorization.

### Separate Feishu Runner

Rejected because it creates another lifecycle command and risks a
transport-specific path around the unified Gateway.

