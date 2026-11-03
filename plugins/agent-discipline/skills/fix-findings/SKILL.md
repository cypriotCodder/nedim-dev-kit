---
name: fix-findings
description: Fix findings from a project audit safely, batch by batch — regression test first, minimal fix, checks, independent review, then mark the findings fixed. Use after /agent-discipline:audit, or when the user says "fix the audit findings", "fix SEC-003", "do batch 0".
argument-hint: "[batch-0 | batch-N | ID ID ... | top N | category]"
---

# Fix audit findings

Target: $ARGUMENTS (default `batch-0`).

Read `docs/audits/backlog.md` and `docs/audits/latest.json`. If they don't exist, tell the user to run `/agent-discipline:audit` first.

## Plan
1. Resolve the target into a list of finding ids. Show each id with its title and effort, plus the files that will change. A batch with more than ~6 findings or any L-effort item becomes a spec via `/agent-discipline:spec`, with one slice per theme.
2. Re-open each finding's location. If the code changed since the audit and the finding no longer applies, mark it `stale` and skip it.
3. Branch: `fix/audit-<date>-<batch>`.

## For each finding (or tightly related group)
1. **Reproduce first.** Write a failing test that demonstrates the problem. Examples: a request as user A for B's resource returns 403; a slow provider makes the call time out within N ms; two concurrent submits create one record; the list endpoint caps at the page size. If a test is impractical (config, headers, tooling), write down exactly how you'll verify the fix instead.
2. **Fix minimally**, following the finding's `fix` and the project's patterns. Prefer one structural fix over many local patches. For example, add tenant-scoping middleware once rather than editing 12 queries, and route the call sites through it.
3. The test now passes, and `npm run check` passes.
4. **Security fixes:** have `agent-discipline:security-auditor` re-check just the changed code and look for bypasses of the new protection.
5. Update `latest.json` for the finding: set `"status": "fixed"`, `"fixedIn": "<commit>"` and `"test": "<test file>"`.

## Close the batch
- Run `/agent-discipline:checkpoint` (review, doc sync, commit). Use one commit per finding or group, with messages like `fix(security): scope request queries to tenant (SEC-003, SEC-004)`.
- If a fix established a new rule (e.g. "all routes use `withTenant()`"), record it with `/agent-discipline:decision`, add it to CLAUDE.md, and enforce it mechanically where possible (an ESLint rule, a dependency-cruiser rule or a test).
- Tick the batch in `backlog.md`. Report what was fixed, which ones were stale, and what's next.

Don't fix findings outside the target, even if they're nearby. Add them to the backlog instead.
