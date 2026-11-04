# agent-discipline

Install this plugin once, and every project you open gets the same workflow: spec-first slices, a decision log, guardrail hooks, a non-generic design system and scored project audits. Installation is covered in the [repo README](../../README.md).

## Use

| When | Run |
|---|---|
| New or existing repo, once | `/agent-discipline:bootstrap` |
| Project has a UI, once | `/agent-discipline:design-system` |
| Every feature | `/agent-discipline:spec <idea>` → it builds slice by slice |
| End of every slice | `/agent-discipline:checkpoint` |
| After UI changes | `/agent-discipline:ui-review /route` |
| Made a tech choice | `/agent-discipline:decision <topic>` |
| Health-check an existing project | `/agent-discipline:audit` (or `quick`, `security`, `--since-last`) |
| Fix what the audit found | `/agent-discipline:fix-findings batch-0` |

Daily loop: **spec → slice → checkpoint → /clear → next slice.**
Monthly (or before a release): **audit → fix-findings batch-0 → audit --since-last.**

## Audits
`/agent-discipline:audit` never edits code. It works in four steps:
1. **Collects evidence with real tools** (`collect.mjs`): typecheck, ESLint, circular deps and boundaries, knip (dead code and unused deps), jscpd (duplication), npm audit and outdated packages, a built-in secret and risky-pattern scan, churn hotspots, and tests when asked. It also uses semgrep, gitleaks and osv-scanner if they're installed (`brew install semgrep gitleaks`).
2. **Maps the system**: entry points, trust boundaries and critical flows.
3. **Runs 5 specialist auditors in parallel**: security, reliability, performance, maintainability and reuse, and tooling (which includes your CLAUDE.md, agents and skills). Your project's own agents, such as a `security-review` agent, run alongside them.
4. **Verifies, scores and tracks.** A skeptical verifier tries to disprove every high and critical finding. Scores follow a fixed rubric (`rubric.md`) with hard caps. Outputs go to `docs/audits/<date>.md`, `latest.json`, `history.csv` and `backlog.md`, and the next audit shows what was fixed, what's new and what's still open.

CI gate: `node scripts/audit/collect.mjs . --gate` fails on type errors, high/critical vulnerable deps, leaked keys, secrets in git history, a tracked `.env` or `.env.local` (or another `.env.*` file holding a secret), failing tests, or any of those checks failing to finish. The workflow template is in `skills/audit/templates/audit-ci.yml`.

To accept a secret finding, such as a fake key in a fixture, commit an `.audit-exceptions.json`. Each entry needs a reason and an expiry date, and an entry the gate can't read fails it:

```json
{ "exceptions": [
  { "rule": "provider-key", "path": "tests/fixtures/**", "reason": "Example key from the AWS docs", "expires": "2027-06-30" }
] }
```

`rule` is `provider-key`, `hardcoded-secret` or `env-file`. Project tests only run with `--tests`, `--gate` or in CI, because a local run can touch a real dev database.

## What runs automatically (hooks)
- **After every file edit:** ESLint on that file, and the design guard on new UI code if `DESIGN.md` exists. Problems are sent back to Claude to fix.
- **Before the first edit of a session:** a typecheck and boundary check, to record which problems already exist. This can make that first edit slow on a large project.
- **Before Claude says "done":** a typecheck if this session edited `.ts` files or a `tsconfig`, and a boundary check if it edited code and the project has a `.dependency-cruiser` config. New problems send Claude back, up to three times. After that you get a warning listing what's still broken.
- Problems that were there before the session don't block Claude. You get a one-line note instead.
- If a tool crashes, times out or isn't installed, you get a warning. Claude isn't sent to fix it, and it doesn't count as a pass.
- Edits made through Bash, such as `sed` or a code generator, aren't tracked. If a turn only made edits that way, the "done" checks don't run.
- The hooks do nothing in projects without Node, ESLint, tsconfig, a dependency-cruiser config or DESIGN.md.
- The hooks and scripts need a POSIX shell. They're tested on macOS and Linux, not on Windows.
- To turn them off for one project, run `mkdir -p .claude && touch .claude/guards-off`.

### Design guard exceptions
- To silence it on one line, add a comment containing `design-guard-ignore`. The audit counts these.
- To allow a rule across the project, add a comment to `DESIGN.md`: `<!-- design-guard: allow gradient, inter -->`.
- The rules are `hex`, `color-function`, `arbitrary-value`, `palette`, `gradient`, `soft-card`, `inter`, `emoji`, `animation` and `transition-all`.

## What's inside
```
plugins/agent-discipline/
  skills/bootstrap/       CLAUDE.md, DECISIONS.md, spec and dependency-cruiser templates
  skills/spec/            spec-first, sliced feature building
  skills/checkpoint/      checks, independent review, doc sync, commit
  skills/decision/        ADR log
  skills/design-system/   direction → DESIGN.md → tokens → primitives; banned-defaults list; motion tokens
  skills/ui-review/       Playwright screenshot loop (screenshot.mjs)
  skills/audit/           collect.mjs, rubric.md, report template, CI template
  skills/fix-findings/    test-first fixes, batch by batch
  agents/code-reviewer    reviews diffs against your rules without seeing the chat
  agents/*-auditor        security, reliability, performance, maintainability, tooling
  agents/audit-verifier   tries to disprove findings before they reach the report
  agents/design-critic    reviews screenshots against DESIGN.md without seeing the code
  hooks/ + scripts/       pre-edit baseline; post-edit lint and design guard; stop-time typecheck and boundary check
```

## Make it yours
Edit the templates as you learn. When an agent makes the same mistake twice, add a line to the relevant template or to `banned.md`, bump the version, and push. Every project picks it up.
