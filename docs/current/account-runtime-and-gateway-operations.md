# MetaWork Account Runtime And Gateway Operations

ADR-0031 and ADR-0034 define the MetaWork production composition. One persistent
Server process owns a `RuntimeRegistry`, one loaded `AccountRuntime` for
`local-default`, a `ConversationRegistry`, and one transport-neutral
`ClientGateway`. Server startup is Workspace-neutral and independent of every
Client lifecycle.

## Runtime Commands

Start or manage the persistent Server:

```bash
metawork server start
metawork server status
metawork server doctor
metawork server restart
metawork server stop
```

Launch independent Clients after Server is ready:

```bash
metawork
metawork tui
metawork tui --conversation <id>
metawork web
metawork web --conversation <id>
```

Bare `metawork` is exactly `metawork tui`. Client commands read and validate the
Server endpoint manifest; they do not acquire `runtime.lock`, construct
Runtime, or start a Server child. Closing the TUI or browser leaves Server,
Conversation, Planner, Task, and Executor work running.

Removed forms such as `gateway run`, `--connect`, foreground Web, `feishu run`,
and script mode fail closed and point to the canonical commands above.

## Conversation Workspace

Existing Conversations restore their durable Workspace during attach and
replay. A new local TUI or Web Conversation uses the directory where that
Client command started as an untrusted initialization hint. The Server applies
the hint through the same Workspace mutation used by the explicit command:

```text
/workspace /absolute/path/to/project
```

Server resolves and canonicalizes the path, verifies an accessible directory,
authorizes the Principal, and atomically persists it on the Conversation.
The Client hint never overwrites an attached Conversation. Missing or rejected
Workspace initialization returns `workspace_required`; an active Turn or Task
returns `workspace_busy`. `/workspace <path>` remains the explicit override on
TUI, Web Composer, and Feishu. Different Conversations may use different
Workspaces on the same Server.

`metawork web` transfers its startup hint through a short-lived, single-use
bootstrap context. The Browser URL contains only an opaque token fragment, not
the Workspace path. The Server-confirmed canonical Workspace is visible in
each Client and `workspace_changed` updates every attachment.

## Account Data

The default account root is:

```text
~/.metawork/accounts/local-default/
├── account.json
├── config/
├── secrets/
├── generated/
│   ├── agent-runtime/
│   └── current
├── data/
│   ├── anyfusion.db
│   ├── database-revisions/
│   └── backups/
├── planner/sessions/
├── conversations/
├── workspace-store/
├── attempts/
└── gateway/
    ├── conversation-bindings.json
    ├── command-admissions/
    └── events/
```

Installation-global releases, logs, upgrade journals, `runtime.lock`, endpoint
manifest, and Unix Gateway socket remain outside the account root. The manifest
contains safe process/version/protocol/socket/Web-origin readiness facts and
never a user Workspace. Clean install writes the
database, immutable configuration revisions, SecretStore files and generated
runtime directly into `local-default`. Existing legacy state is copied once
before update/rollback; later transactions switch only account-scoped pointers.
Runtime code must not write the legacy installation-global database,
Planner-session, configuration, generated-runtime, workspace or attempt paths
after account-layout activation.

## Compatibility

`anyfusion` and `metaclaw` remain CLI aliases. A legacy `~/.anyfusion` root is
migrated transactionally before update or rollback; it is not a second runtime
authority after activation.

Use Web settings or the account administration commands to change
configuration. The authoritative pointer is
`accounts/local-default/config/active`; activation never mutates an immutable
revision in place and requires a Server restart before the new revision becomes
the running binding.

## Connection And Replay

Clients submit versioned commands with a request ID and idempotency key.
`ClientGateway` authenticates the transport, resolves the Account and
Conversation, durably reserves command admission, and then hands the command to
the Conversation mailbox.

Attachments subscribe before replay. Reconnect supplies the last observed
event sequence; the Server replays missing snapshot/delta events and then
continues with live events without duplicating event IDs. A disconnect does not
destroy the Conversation, Planner history, AccountRuntime, Task, or Executor
work.

If the cursor predates retained history, the Server returns a new bounded
Conversation/Task/terminal snapshot and only the deltas after that snapshot.
It does not return a truncated middle of the old stream. Historical oversized
answers remain replayable as a bounded tail marked `truncated`.

The public event stream may contain:

- Conversation snapshots and turn-start facts;
- redacted Planner/Kernel/Executor trace deltas;
- Task and execution projections;
- permission requests and artifact references;
- final answers, terminal errors, and delivery status.

It must not contain hidden model reasoning, raw prompts, credentials, raw
stdout/stderr, or unrestricted tool payloads.

Every persisted event payload is recursively sanitized and limited to 64 KiB.
Secret-like keys and common token/API-key values are removed before append and
again during historical replay. Cyclic or excessively nested payloads fail
closed instead of entering the journal.

The Runtime and native updater contend on the same `data/runtime.lock`.
Migration copies SQLite through the online backup API so committed WAL content
is preserved, verifies a staged tree manifest before activation, and moves the
legacy layout under `legacy-account-layout/local-default/`.

## Recovery And Diagnostics

Account activation completes durable startup recovery before command admission.
Gateway admission records remain `pending`, `submitted`, `terminal`, or
`uncertain`. After restart, a command with a durable terminal event replays its
receipt; a command that started execution without a recorded terminal outcome
fails closed as `command_execution_uncertain` and is not run again.

Use:

```bash
metawork server status
metawork server doctor
```

For a stuck client, verify the manifest state and protocol, Server PID and
health, Unix socket, loopback Web endpoint, active configuration revision,
Conversation Workspace, account database, Gateway event journal, and
command-admission record before retrying. Reuse the original idempotency key
when retrying an uncertain transport submission.

Provider-independent release validation:

```bash
npm run smoke:gateway
```

The live semantic Planner gate remains `npm run smoke:metawork` and requires a
valid configured Provider credential.

## Future App Contract

A future App is another Gateway transport adapter. It must:

1. authenticate a Principal and let the Server derive Account authority;
2. submit the existing versioned command envelope;
3. attach to a stable Conversation and persist its replay cursor;
4. render only bounded Gateway events;
5. send permission decisions and cancellation through versioned command kinds;
6. avoid importing Planner, Kernel, storage, ConversationSession, or Executor
   implementations.
