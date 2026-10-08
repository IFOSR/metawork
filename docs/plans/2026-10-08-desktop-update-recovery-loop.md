# Desktop update recovery loop

- Plan date: 2026-10-08
- Status: Completed locally; source correction awaits a new release
- Completion date: 2026-10-08
- Scope: Restore the laptop's Desktop and prevent repeated repair after rollback.

## Findings and local recovery

The installed v0.1.7 Desktop repeatedly offered repair while the Runtime had
returned to `0.1.5-internal-b0b537c`. Native activation journals recorded two
candidate activations followed by rollback. Desktop startup diagnostics recorded
installation-stage failures, but the packaged updater discarded its detailed
failure output; the original trigger for rollback cannot be established from
those records.

The helper started the restored Desktop before releasing `desktop-helper.lock`.
The client's normal pending-update check could therefore reject that launch,
despite a terminal rollback journal. Repair also lacked a distinct operation:
when the journal was already rolled back, it applied the old update request
again instead of returning to the recovered installation.

On this laptop, the unchanged installer/activation flow was rebuilt with local
diagnostic output and run against the existing verified request. It completed
the native backup/activation and authenticated Desktop-render gates, without
manually deleting journals, changing release pointers or bypassing health checks.
The active Runtime and Desktop now report `0.1.7-internal-edfce49b`; the activation
is committed and no helper lock remains. The user confirmed that the main UI
opened successfully. This recovery does not prove why the earlier attempts
rolled back, and is separate from the source correction below.

## Delivered correction

- Relaunch the recovered Desktop only after releasing the helper lock, including
  the path where candidate failure has already completed rollback.
- Preserve an explicit repair-only request. Repair of a committed or rolled-back
  activation reopens the installation without applying the old candidate again.
- Keep request/journal identity checks and failed-recovery gates intact. A failed
  restore retains the unfinished journal and does not reopen a mismatched client.
- Keep the candidate's authenticated-render check and native updater authority.

## Validation and closure

- 17 activation, recovery-transaction and shell-health tests passed, including
  seven new regressions; all 13 Desktop tests passed.
- Root/Desktop TypeScript checks and the Desktop build passed.
- The actual installed application reached its authenticated-render receipt;
  the user independently confirmed successful entry to the main interface.
- Published v0.1.7 artifacts are unchanged. This source correction requires a
  new release before other installations receive it.
- Closing commit: `fix(desktop): stop repeated repair after update rollback`,
  containing this record and the correction.
