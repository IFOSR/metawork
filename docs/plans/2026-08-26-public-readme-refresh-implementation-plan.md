# AnyFusion Public README Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** In Progress

**Plan date:** 2026-08-26

**Goal:** Publish accurate, synchronized English and Chinese AnyFusion READMEs
and push the documentation update to `origin/main`.

**Architecture:** The READMEs remain public summaries. Runtime details are
projected from existing code and accepted architecture contracts; no production
behavior changes are included.

**Tech Stack:** Markdown, Node.js 22.19+, TypeScript ESM, Git.

---

## Task 1: Refresh the English README

**Files:**

- Modify: `README.md`

**Steps:**

1. Replace the MetaWork public brand with AnyFusion.
2. Rewrite the product introduction around durable governed work, the unified
   Gateway, and the Planner/Kernel/Runtime/Executor boundary.
3. Replace the Pareto-routing claim with revision-pinned, explainable
   Provider/Model/AgentClass/Harness selection.
4. Correct installation platforms, Executor detection, launcher behavior, and
   runtime paths.
5. Update the current contract table to SQLite schema v33.

## Task 2: Synchronize the Chinese README

**Files:**

- Modify: `README.zh-CN.md`

**Steps:**

1. Mirror the English information architecture and technical claims.
2. Use AnyFusion as the public product name while retaining required internal
   compatibility names only in technical notes.
3. Keep commands, paths, version numbers, and limitations identical to the
   English README.

## Task 3: Validate the documentation

**Commands:**

```bash
rg -n "MetaWork|schema v32|Pareto|compatibility aliases|兼容别名" README.md README.zh-CN.md
git diff --check
npm run lint
```

**Expected:**

- No stale public-brand, schema, Pareto, or alias claims remain.
- Markdown changes contain no whitespace errors.
- TypeScript lint passes.

## Task 4: Commit and publish

**Commands:**

```bash
git add README.md README.zh-CN.md \
  docs/plans/2026-08-26-public-readme-refresh-design.md \
  docs/plans/2026-08-26-public-readme-refresh-implementation-plan.md
git commit -m "docs: refresh AnyFusion readme"
git push origin main
```

**Expected:**

- One documentation commit is created on `main`.
- `origin/main` advances to the new commit without force-push.

