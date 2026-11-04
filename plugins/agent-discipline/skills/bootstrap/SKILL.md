---
name: bootstrap
description: Set up (or retrofit) a repo for disciplined agentic development — CLAUDE.md map, docs/specs, decision log, strict TypeScript, architectural boundary rules and a single `npm run check`. Use when starting a new project, adopting the kit in an existing one, or when the user says the codebase is getting messy.
---

# Bootstrap a project

Goal: after this runs, any fresh agent session can understand the project in under a minute and is mechanically prevented from breaking its structure. Works for new and existing repos.

Templates live in `${CLAUDE_PLUGIN_ROOT}/skills/bootstrap/templates/`.

## 0. Safety
- If this is a git repo with uncommitted changes, stop and ask the user to commit or stash first.
- Work on a branch: `git checkout -b chore/agent-bootstrap` (init git first if there is no repo).
- Never delete or rewrite existing docs. Merge into them.

## 1. Understand what exists
- Read `package.json`(s), `tsconfig*.json`, lint config, and the top two levels of folders. Detect: framework (Next/Vite/Remix/Expo/Nest/Express…), monorepo tool, test runner, ORM, styling (Tailwind v3/v4, CSS modules…).
- For an existing codebase over ~30 source files, send an `Explore` subagent to report the *actual* layering and conventions in use (where data access lives, how routes call business logic, naming, error handling). Describe what is there, not what should be there.
- New project: ask the user in ONE message for the stack and the 3–5 main domain areas (e.g. orders, menu, payments). Suggest a default layered layout if they have none:
  ```
  src/
    app/ or routes/     # HTTP/UI entry points only — thin
    features/<domain>/  # domain logic, one folder per domain, public API via index.ts
    lib/                # framework-free shared utilities
    db/                 # schema, migrations, repositories
  ```

## 2. Write the map files
1. **`CLAUDE.md`** (root) from `templates/CLAUDE.md`. Fill every section with real facts from step 1. Hard limit ~150 lines — it is a map, not documentation. If an existing CLAUDE.md is present, restructure it into this shape, keeping its content.
2. **Nested `CLAUDE.md`** only in top-level modules that have rules of their own (e.g. `src/db/CLAUDE.md`: "migrations are append-only"). Skip if there's nothing specific to say.
3. **`docs/DECISIONS.md`** from `templates/DECISIONS.md`. Add `ADR-001: Baseline architecture` describing the layering from step 1 as the current decision.
4. **`docs/specs/`** with `templates/spec-template.md` copied to `docs/specs/_template.md`.

## 3. Install guardrails (JS/TS projects)
Show the user the plan in a short list, then do it:
- **Strict TypeScript.** Target: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. On an existing codebase, first run `tsc --noEmit` with the flags on and report the error count. If it's above ~50, enable only `strict` now and record the rest as a follow-up in DECISIONS.md rather than starting a huge fix-up.
- **Package manager.** Use the one the project already uses (check `packageManager` in `package.json`, then the lockfile). The npm commands below are examples: translate them.
- **Boundary rules** with dependency-cruiser: `npm i -D dependency-cruiser`, copy `templates/dependency-cruiser.cjs` to `.dependency-cruiser.cjs`, and adapt the `from`/`to` paths to the real folders from step 1. Rules must encode the layering written in CLAUDE.md: no route → db shortcuts, features import each other only via `index.ts`, no circular deps.
- **One check command.** Add to `package.json` scripts (keep any that already exist):
  - `"typecheck": "tsc --noEmit"` (if `tsconfig.json` only has `references`, this checks nothing: use the project's build check, such as `tsc -b`)
  - `"lint": "eslint ."` (set up ESLint flat config with typescript-eslint if missing)
  - `"deps": "depcruise src --config .dependency-cruiser.cjs"`
  - `"check": "npm run typecheck && npm run lint && npm run deps && npm test --if-present"`
- Run `npm run check` and fix only what the setup itself broke. Report pre-existing failures and don't fix them unasked.

The plugin's hooks are already active: ESLint runs on every edited file, and `tsc` and the boundary rules run before each "done" on turns that edited code. They need no per-project setup.

## 4. Frontend?
If the project has a UI and no `DESIGN.md`, tell the user: "Run `/agent-discipline:design-system` next. Until it exists, UI work will drift back to generic defaults."

## 5. Finish
- Commit: `chore: bootstrap agent workflow (CLAUDE.md, specs, ADRs, guardrails)`.
- Reply with: files created, guardrails enabled, pre-existing problems found, and the daily loop:
  `spec → build one slice → checkpoint → repeat`.
