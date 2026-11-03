# nedim-dev-kit

A Claude Code plugin marketplace holding one plugin, **agent-discipline**. Install it once, and every project you open gets the same workflow.

## Install

1. Push this folder to a GitHub repo (private is fine), e.g. `nedimhuray/nedim-dev-kit`.
2. In Claude Code:
   ```
   /plugin marketplace add nedimhuray/nedim-dev-kit
   /plugin install agent-discipline@nedim-dev-kit
   ```
   Or, without GitHub: `claude plugin marketplace add ./nedim-dev-kit`
3. Update later with `/plugin marketplace update nedim-dev-kit` (bump `version` in `plugin.json` when you change things).

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
1. **Collects evidence with real tools** (`collect.mjs`): typecheck, ESLint, circular deps and boundaries, knip (dead code and unused deps), jscpd (duplication), npm audit and outdated packages, a built-in secret and risky-pattern scan, churn hotspots, and tests. It also uses semgrep, gitleaks and osv-scanner if they're installed (`brew install semgrep gitleaks`).
2. **Maps the system**: entry points, trust boundaries and critical flows.
3. **Runs 5 specialist auditors in parallel**: security, reliability, performance, maintainability and reuse, and tooling (which includes your CLAUDE.md, agents and skills). Your project's own agents, such as a `security-review` agent, run alongside them.
4. **Verifies, scores and tracks.** A skeptical verifier tries to disprove every high and critical finding. Scores follow a fixed rubric (`rubric.md`) with hard caps. Outputs go to `docs/audits/<date>.md`, `latest.json`, `history.csv` and `backlog.md`, and the next audit shows what was fixed, what's new and what's still open.

CI gate: `node scripts/audit/collect.mjs . --gate` fails on type errors, high/critical vulnerable deps, leaked keys, tracked `.env` files or failing tests. The workflow template is in `skills/audit/templates/audit-ci.yml`.

## What runs automatically (hooks)
- **After every file edit:** ESLint on that file, and the design guard on new UI code if `DESIGN.md` exists. Problems are sent back to Claude to fix.
- **Before Claude says "done":** a typecheck if `.ts` files changed. Errors send it back once to fix them.
- Both hooks do nothing in projects without Node, ESLint, tsconfig or DESIGN.md.
- To turn them off for one project, run `mkdir -p .claude && touch .claude/guards-off`.
- To silence the design guard on one line, add a comment containing `design-guard-ignore`.

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
  hooks/ + scripts/       post-edit lint and design guard; stop-time typecheck
```

## Make it yours
Edit the templates as you learn. When an agent makes the same mistake twice, add a line to the relevant template or to `banned.md`, bump the version, and push. Every project picks it up.
