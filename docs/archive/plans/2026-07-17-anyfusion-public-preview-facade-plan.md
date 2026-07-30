# AnyFusion Public Preview Facade Plan

**Status:** Implementation and production dependency remediation complete; GitHub publication pending

**Plan date:** 2026-07-17

**Implementation completion date:** 2026-07-17

**Dependency remediation date:** 2026-07-18

**Target release:** `v1.2.0-preview.0`

## Objective

Present AnyFusion as a company-backed strategic open-source initiative without overstating maintenance or deployment maturity. Public-facing materials must consistently use the AnyFusion brand, while the existing internal MetaClaw TypeScript naming, storage paths, and implementation vocabulary remain unchanged.

## Confirmed positioning

- AnyFusion is backed by AnyInt and MetaFusion.
- Core development is led by AnyInt.
- MetaAny is the neutral open-source hosting brand.
- Current status is Developer Preview with limited internal pilot deployment.
- The public CLI command is `anyfusion`.
- The legacy `metaclaw` CLI remains available only as a compatibility alias and is not promoted in public-facing documentation.
- No demo GIF will be published in this iteration.

## Scope

1. Restructure English and Chinese README first screens as product pages.
2. Add the approved backing and internal-pilot statements.
3. Add Developer Preview, Internal Pilot, CI, and Apache 2.0 badges.
4. Add deterministic GitHub Actions CI for lint, tests, and build.
5. Align package metadata and public CLI entrypoint with `1.2.0-preview.0` and `anyfusion`, retaining the legacy CLI alias.
6. Add `CHANGELOG.md` and release notes for `v1.2.0-preview.0`.
7. Create a reusable social-preview image using the authorized AnyInt and MetaFusion brand assets.
8. Update public documentation titles and prose from MetaClaw to AnyFusion while preserving literal internal identifiers where technically necessary.
9. Add an `anyfusion.sh` public wrapper while retaining `metaclaw.sh` as the compatibility implementation.
10. Record repository Description, Topics, Social Preview, tag, and release steps that require GitHub repository access.

## Out of scope

- Renaming TypeScript classes, functions, modules, database files, environment variables, storage directories, or other internal implementation identifiers.
- Removing the legacy `metaclaw` command or runtime helper.
- Publishing an npm package.
- Adding a simulated or placeholder demo GIF.
- Running live-model or credential-dependent smoke tests in public CI.

## Validation

- `npm run lint`
- `npm run build`
- Docker test suite when a Docker engine is available; otherwise GitHub Actions is the authoritative Linux test run.
- YAML syntax and workflow inspection.
- Link/path review for README and release assets.
- Public-facing MetaClaw reference audit, distinguishing accidental branding from required internal identifiers.
- Visual inspection of the generated social-preview image.

## GitHub publication handoff

Apply these repository-level settings after the facade commit reaches the
default branch and the public CI workflow passes:

- **Description:** `A company-backed AI Task OS for durable, policy-governed agent workflows. Backed by AnyInt × MetaFusion.`
- **Topics:** `ai-agent`, `agent-orchestration`, `task-os`, `llm-planning`,
  `policy-engine`, `multi-agent`, `typescript`
- **Social Preview:** `docs/assets/social-preview.png`
- **Tag:** `v1.2.0-preview.0`
- **Release title:** `AnyFusion v1.2.0 Preview`
- **Release body:** `docs/releases/v1.2.0-preview.0.md`

Do not create the tag or release before the CI badge has a real successful run
and the production dependency audit findings have been remediated or explicitly
accepted.

## Completion record

Delivered on 2026-07-17:

- Product-oriented English and Chinese README hero sections with the approved
  backing, development-lead, neutral-hosting, and internal-pilot statements.
- Four focused status badges and direct Quick Start, Architecture, Roadmap, and
  language navigation without a placeholder demo.
- Public package identity `anyfusion@1.2.0-preview.0`, documented `anyfusion`
  command, and an undocumented `metaclaw` compatibility alias.
- Public `anyfusion.sh` runtime wrapper with legacy implementation retained.
- GitHub Actions CI for lint, tests, and build.
- Changelog, preview release notes, and 1280×640 social-preview PNG/SVG assets.
- Active public documentation product prose and command examples aligned to
  AnyFusion while literal internal paths and implementation identifiers remain
  unchanged.

Validation performed:

- `npm run lint` — passed in the Linux Docker validation environment.
- `npm run build` — passed in Docker and generated the PlanningAgentPlan v4
  schema.
- `npm install --package-lock-only --ignore-scripts --offline` — passed; lockfile
  is consistent. The offline audit result was not treated as authoritative.
- CI workflow YAML parse — passed.
- `bash -n setup.sh`, `bash -n anyfusion.sh`, and `bash -n metaclaw.sh` — passed.
- `git diff --check` — passed.
- Relative Markdown target audit — passed for changed public documents.
- Social-preview inspection — passed at 1280×640 and 277,658 bytes.
- Docker image rebuild — passed with
  `docker build -f Dockerfile.test -t metaclaw-test .` after dependency updates.
- Production dependency audit — passed in Docker with
  `npm audit --omit=dev`: 0 vulnerabilities.
- Production dependency remediation — upgraded `@larksuiteoapi/node-sdk` to
  `1.71.1` and `js-yaml` to `4.3.0`; the resolved production graph now includes
  patched `axios`, `form-data`, `protobufjs`, `@protobufjs/utf8`, and `ws`
  versions.
- Full Docker Vitest suite — passed after remediation: 182 test files passed,
  2 skipped; 772 tests passed, 4 skipped.
- Full dependency audit — 6 development-only findings remain: 1 critical,
  1 high, and 4 moderate in the Vitest/Vite/esbuild/PostCSS toolchain. Per the
  agreed scope, development dependency upgrades are deferred because they do
  not ship in the production dependency graph.
- Credential-dependent live smoke — intentionally not run.

Implementation commit: `b5af218` (`feat: prepare AnyFusion public preview`).
