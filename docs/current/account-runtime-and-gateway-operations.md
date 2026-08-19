# Account Runtime And Gateway Operations

ADR-0031 is active in production composition. One Server process owns a
`RuntimeRegistry`, one loaded `AccountRuntime` for `local-default`, a
`ConversationRegistry`, and one transport-neutral `ClientGateway`.

## Runtime Commands

Start the default native Gateway-backed TUI:

```bash
anyfusion
```

Start or restart the Web foreground surface:

```bash
anyfusion web
anyfusion web restart
```

Run or manage the user-level Gateway service:

```bash
anyfusion gateway run
anyfusion gateway start
anyfusion gateway status
anyfusion gateway restart
anyfusion gateway stop
```

Attach another local terminal to a running Unix Gateway:

```bash
anyfusion --connect
```

`web restart` and `gateway restart` stop the process holding `runtime.lock`
before starting the replacement. `web restart` changes the foreground surface,
not the Runtime topology; neither command creates a second AccountRuntime.

## Account Data

The default account root is:

```text
~/.anyfusion/accounts/local-default/
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

Installation-global releases, logs, upgrade journals, `runtime.lock`, and the
Unix Gateway socket remain outside the account root. Clean install writes the
database, immutable configuration revisions, SecretStore files and generated
runtime directly into `local-default`. Existing legacy state is copied once
before update/rollback; later transactions switch only account-scoped pointers.
Runtime code must not write the legacy installation-global database,
Planner-session, configuration, generated-runtime, workspace or attempt paths
after account-layout activation.

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
anyfusion status
anyfusion doctor
anyfusion gateway status
anyfusion gateway doctor
```

For a stuck client, verify the Server process, Unix socket, active configuration
revision, account database, Gateway event journal, and command-admission record
before retrying. Reuse the original idempotency key when retrying an uncertain
transport submission.

Provider-independent release validation:

```bash
npm run smoke:gateway
```

The live semantic Planner gate remains `npm run smoke:metaclaw` and requires a
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
