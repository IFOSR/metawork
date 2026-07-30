# Executor Probe Diagnostics And Docker Shell Fix

- Status: completed
- Plan date: 2026-07-29
- Completion date: 2026-07-29
- Implementation commit: `fix: expose executor probe diagnostics`

## Scope

- Mount the host Docker socket into the trusted `metaclaw-shell` runtime container.
- Recreate an existing shell container when it predates that mount contract.
- Preserve the concrete executor probe error in durable WorkUnit events.
- Expose bounded probe failures through an explicit read-only Planner MCP query, used only when the user asks for diagnostic explanation.

## Non-goals

- Docker daemon startup preflight.
- Automatic executor image builds.
- Production deployment hardening.
- Changes to AgentClass preference or Kernel capacity policy.

## Validation

- `npm run lint`
- `docker build -f Dockerfile.test -t metaclaw-test .`
- `docker run --rm metaclaw-test` — 693 passed, 15 skipped
- `docker exec -e METACLAW_PLANNER_SESSION_ID=sess_planner_mcp_smoke metaclaw-shell node /app/scripts/smoke-planner-mcp.mjs`
- `npm run smoke:metaclaw`
- Rebuilt `metaclaw-shell`; verified `/var/run/docker.sock` is mounted, `docker info` succeeds inside the container, and the Codex executor image resolves to a `sha256:` ID.
