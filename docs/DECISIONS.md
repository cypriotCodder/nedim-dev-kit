# Architecture decisions

Newest at the top. Each entry is short and permanent. To change a decision, add a new entry that supersedes it. Don't edit old ones.

---

## ADR-006: Design guard exceptions live in DESIGN.md  (2026-11-04, status: accepted)
**Context:** The guard told Claude a gradient was fine if `DESIGN.md` permitted it, but never read `DESIGN.md`. A brand that really uses Inter was flagged forever.
**Decision:** A comment in `DESIGN.md`, `<!-- design-guard: allow gradient, inter -->`, turns rules off by name. An unknown name warns the user once per session. The audit counts `design-guard-ignore` lines so one-line bypasses stay visible.
**Alternatives:** A separate config file (one more file, away from the decisions it records). Parsing the prose in `DESIGN.md` (unreliable).
**Consequences:** The guard stays regex heuristics. In plain `.ts` and `.js` files it only reads class helper calls that start inside the edit, so an edit inside an existing `cva()` call isn't scanned. `design-critic` and `ui-review` are the backstop.

## ADR-005: Stop checks follow session edits and compare against a baseline  (2026-11-04, status: accepted)
**Context:** Stop used `git status`, which missed work committed during the turn and files with quoted names, and sent Claude back on idle turns because of someone else's dirty files. It also told Claude it could call errors pre-existing, and never re-checked a fix.
**Decision:** `PostToolUse` records each edit in a session folder under the OS temp directory. Stop runs only for recorded edits, and blocks only on problems missing from a baseline. `PreToolUse` captures that baseline before the session first touches what a check covers. Stop re-checks after each attempt and gives up after three in a row, showing the user what's left. If the baseline couldn't be captured, every problem counts as new. This supersedes the "once per edit" consequence of ADR-004: a broken ESLint now warns once per session.
**Alternatives:** Capture at `SessionStart` (slows sessions that never edit, and a background capture can race the first edit). Capture at the first `PostToolUse` (too late: Claude's own errors would count as old). Only report errors in edited files (misses a changed export that breaks another file). Rebuild the old state from a git worktree at Stop (slow, and writes under `.git`).
**Consequences:** The first code edit of a session waits for a full typecheck. Edits made through Bash aren't recorded, so a turn with only those skips the checks; this is narrower than the old `git status` check for uncommitted work, and CI remains the backstop. Problems are matched on file, code and message without the line number, so a custom script's output in an unknown format is compared line by line and may count as new when it changes.

## ADR-004: Broken tools warn the user and don't block Claude  (2026-11-04, status: accepted)
**Context:** Hooks treated a crashed or timed-out tool as a pass. A broken tool says nothing about the code, and it's usually not something Claude caused.
**Decision:** In hooks, a tool that doesn't finish produces a `systemMessage` for the user and exit 0. In the CI gate, a required tool that doesn't finish fails the gate.
**Alternatives:** Exit 2 in hooks (sends Claude after an environment problem, on every edit). Staying silent (the original bug).
**Consequences:** A broken ESLint config warns on each edit until it's fixed. PR 3's session state could reduce that to once per session.

## ADR-003: Typecheck project references through temporary configs  (2026-11-04, status: accepted)
**Context:** On a references setup, tested on TypeScript 5.5 and 5.9: `tsc --noEmit` checks nothing, `tsc -p x --noEmit` reports TS6305 until references are built, and `tsc -b --noEmit` is rejected or reports TS6310. `tsc -b` works but writes build output, which a hook must not do.
**Decision:** For each config in the setup, generate a temporary one in `node_modules/.cache` that extends it, drops `references` and turns off `composite`, then run `tsc -p` on it. Imports resolve to source.
**Alternatives:** `tsc -b` (writes to the project). Copying the project to a temp folder (slow, and breaks `node_modules` resolution).
**Consequences:** Nothing is written outside `node_modules`, and no build is needed first. Referenced sources are compiled under the importing project's options, so projects with very different settings could see false errors. A custom `typecheck` script always wins over this, except a bare `tsc --noEmit`.

## ADR-002: Track known bugs as `todo` tests  (2026-11-04, status: accepted)
**Context:** A review flagged 25 issues, to be fixed over several PRs. Many are silent failures, where a broken guard looks the same as a passing one.
**Decision:** Write a failing test for each reproducible bug straight away. Mark it `todo` with the PR that will fix it, and remove the flag in that PR.
**Alternatives:** A written backlog (can't show that a bug is real or fixed). Leaving tests red until fixed (CI would be useless in the meantime).
**Consequences:** CI stays green while the backlog stays executable. A `todo` test doesn't fail the run when it starts passing, so each PR has to remove the flags it earns.

## ADR-001: Black-box tests with fake tools and no dependencies  (2026-11-04, status: accepted)
**Context:** The hook and audit scripts are about to be restructured, and they shell out to `tsc`, `eslint`, `semgrep` and others.
**Decision:** Use `node:test` and run scripts as subprocesses against temp projects, with small fake executables that return a chosen exit code.
**Alternatives:** Unit tests of internals (would break during the rewrite). Real tools in every test (slow, needs installs and network, and crashes are hard to trigger).
**Consequences:** Tests are fast and survive rewrites, and crashes and timeouts are easy to simulate. Fakes can drift from real tools, so each one encodes observed behaviour, and fixes that depend on a real tool also need a check against that tool.
