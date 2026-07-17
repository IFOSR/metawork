# Executor Env File Separation Plan

Status: Completed
Plan date: 2026-07-17
Completion date: 2026-07-17
Implementation commit: `65aaa27` (`feat: separate planner and executor provider env files`)

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

## Delivered behavior

- Replaced the single local `docker/pi.env` entrypoint with three ignored files:
  `docker/planner-codex.env`, `docker/executor-codex.env`, and
  `docker/executor-pi.env`.
- Added matching tracked example files and updated the Docker shell launcher to mount each real
  file read-only under `/run/metaclaw/env/`.
- Added `METACLAW_PLANNER_ENV_FILE`, `METACLAW_CODEX_EXECUTOR_ENV_FILE`, and
  `METACLAW_PI_EXECUTOR_ENV_FILE`; each built-in process loads only its assigned provider file.
- Rendered Planner Codex, Executor Codex, and Executor Pi runtime configuration independently so
  each can use a different `OPENAI_BASE_URL`.
- Limited `/etc/environment` persistence to non-secret runtime paths and env-file locations.
- Preserved direct process-environment configuration when the configured env file is absent.
- Left custom executors unchanged; they do not receive one of the built-in env files implicitly.

## Validation performed

- `npm run lint`
- `npm run build`
- Focused Docker tests: 4 files passed, 27 tests passed.
- Full Docker test suite: 182 files passed, 2 skipped; 772 tests passed, 4 skipped.
- Runtime image build:
  `docker build -f docker/Dockerfile.runtime -t metaclaw-runtime-env-separation .`
- Final runtime isolation probe with three distinct dummy base URLs verified separate Planner,
  Executor Codex, and Executor Pi configuration, and verified that `/etc/environment` contains
  env-file paths but not `OPENAI_API_KEY`.
- `git diff --check`, ignored-file checks, and a tracked-diff credential scan passed; the only
  key-like values in tracked changes are explicit test fixtures.
