# Architecture decisions

Newest at the top. Each entry is short and permanent. To change a decision, add a new entry that supersedes it. Don't edit old ones.

---

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
