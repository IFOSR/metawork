# Executor Env File Separation Plan

Status: In progress
Plan date: 2026-07-17

## Scope

- Replace the misleading single `docker/pi.env` Docker entrypoint with three ignored files:
  `planner-codex.env`, `executor-codex.env`, and `executor-pi.env`.
- Mount those files read-only into the runtime container and pass only their paths through the
  SSH login environment.
- Make Planner Codex, Executor Codex, and Executor Pi load only their assigned file before spawn.
- Render each runtime template with the base URL from its assigned file.
- Keep direct non-Docker process-environment configuration compatible.

This is configuration separation, not a hard security boundary. All three processes still run as
the same container user, and stronger secret isolation remains deferred to process/container
partitioning work.

## Principles

- Never commit real credentials.
- Do not pass three same-key files through repeated Docker `--env-file` flags because duplicate
  variable names would overwrite each other.
- Do not persist provider credentials in `/etc/environment`; persist only the three file paths and
  non-secret runtime paths needed by SSH sessions.
- Executor-specific file values take precedence over inherited process variables for that child.
- Custom executors receive no Docker-mounted provider file implicitly.

## Acceptance

- Docker startup fails clearly when any of the three required local files is absent.
- Planner Codex, Executor Codex, and Executor Pi each receive the values from their own env file.
- Planner, Codex, and Pi configuration templates can use different base URLs.
- SSH login sessions retain the three env-file path variables but not provider API keys.
- Examples and runtime documentation use the new names.
- Focused tests, `npm run lint`, and `npm run build` pass.
