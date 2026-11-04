---
name: audit
description: Systematic health audit of an existing project — security, reliability, performance, maintainability/reusability and dev/agent tooling. Combines deterministic scanners with specialist auditor agents, verifies every finding, scores the project against a fixed rubric, tracks the trend between audits and produces a prioritised fix backlog. Use when the user asks to audit, review or health-check a codebase, or asks "how good/secure/reliable is this project".
argument-hint: "[full | quick | security | reliability | performance | maintainability | tooling] [path]"
---

# Project audit

Mode and scope: $ARGUMENTS (default `full` on the repo root). An `--since-last` argument means only re-check what changed since the previous audit, plus all of its open findings.

**This skill never changes source code.** It produces evidence, a report, a scorecard and a backlog. Fixing is a separate step (`/agent-discipline:fix-findings`), so the audit stays honest.

Files used here: `${CLAUDE_PLUGIN_ROOT}/skills/audit/collect.mjs`, `rubric.md` and `report-template.md` in the same folder.

## 0. Prepare
- Add `.audit/` to `.gitignore` if it's missing. Known secret formats are redacted, but raw evidence still quotes source code, so it must never be committed.
- Note the date: `D=$(date +%F)`. Reports go in `docs/audits/`.
- Monorepo (has `workspaces`, `apps/`, `packages/`)? List the packages and audit each deployable app as its own scope. Score the apps separately and add one combined line.
- Read `CLAUDE.md`, `docs/DECISIONS.md` and any previous `docs/audits/latest.json`.
- **Project-specific agents:** list `.claude/agents/*.md`. If the project already has auditors (for example a `security-review` agent), plan to run them **alongside** the matching built-in auditor in step 3, then merge and dedupe. The tooling auditor will also judge whether they're complete.

## 1. Collect evidence (deterministic tools)
```
node ${CLAUDE_PLUGIN_ROOT}/skills/audit/collect.mjs . --out .audit/raw
```
It runs typecheck, ESLint, boundaries/circular deps, knip (dead code, unused deps), jscpd (duplication), npm/pnpm audit plus outdated packages, optional semgrep, gitleaks and osv-scanner, a built-in pattern scan, and size and churn hotspots. Project tests don't run by default, because they can hit a real dev database: add `--tests` once the user confirms they're safe to run here, and otherwise list them under "Coverage gaps". If `semgrep` or `gitleaks` aren't installed, say so once in the report under "Coverage gaps" (`brew install semgrep gitleaks`). Don't install them unasked.

Read `.audit/raw/summary.json`. Pattern hits are **leads, not findings**: they need a human-level read before they count.

Every entry in `tools` has a `status`. `failed` or `timed-out` means that tool says nothing about the code, so a missing metric is not a clean result. List each one under "Coverage gaps" as not assessed, and don't let it raise a score. `metrics.exceptions` lists secret findings the project has accepted in `.audit-exceptions.json`. Read each reason and flag any that doesn't hold up.

## 2. Build the system map (5–10 minutes, not more)
Write `.audit/map.md`, about 60 lines at most:
- **Entry points:** HTTP routes and their files, background jobs, webhooks, websockets, CLI commands, mobile and web clients.
- **Trust boundaries:** where untrusted input enters, where authentication happens, where authorization and tenant scoping happen (critical for multi-tenant apps such as a municipalities platform), file uploads, payments, and outbound calls to third parties.
- **Data:** the database(s), the ORM, where the schema and migrations live, caches and queues.
- **Critical flows:** the 3–6 flows whose failure would hurt users most (e.g. citizen submits a request → staff processes it → notification is sent). Auditors trace these end to end.
- **Hotspots:** the top 5 from `summary.metrics.hotspots`, where bugs concentrate.

Use an `Explore` subagent for large repos.

## 3. Specialist audits (in parallel)
Launch these agents **in one message** so they run concurrently. Give each one: the scope path, `.audit/map.md`, `.audit/raw/` (tell it which raw files matter to it), CLAUDE.md, and the findings schema below. `quick` mode runs only security and reliability, limited to the critical flows. A single-category mode runs only that agent.

| Agent | Looks at |
|---|---|
| `agent-discipline:security-auditor` | authn/authz/tenant isolation, injection, XSS/SSRF, secrets, sessions/JWT, CORS/CSRF, uploads, rate limits, dependency CVEs, data exposure |
| `agent-discipline:reliability-auditor` | error handling, timeouts/retries, idempotency, transactions, races, config validation, observability, migrations, test coverage of critical flows |
| `agent-discipline:performance-auditor` | N+1, indexes, unbounded queries, caching, request-path blocking, payload size, frontend bundle/rendering, leaks, pooling |
| `agent-discipline:maintainability-auditor` | architecture vs CLAUDE.md, boundaries, duplication → reuse opportunities, inconsistent patterns, god files, dead code, type safety, test quality |
| `agent-discipline:tooling-auditor` | scripts, CI, lint/format, lockfile, env handling, Docker, dependency hygiene, and the project's Claude setup: CLAUDE.md accuracy, agents, skills, hooks |
| project's own agents (if any) | whatever they're defined for. Pass them the same map and scope |

**Findings schema** (each agent returns a JSON array and nothing else):
```json
{ "category": "security|reliability|performance|maintainability|tooling",
  "severity": "critical|high|medium|low",
  "confidence": "confirmed|likely|possible",
  "title": "short, specific",
  "location": "path/file.ts:123",
  "evidence": "≤3 lines of code or tool output proving it",
  "impact": "concrete failure scenario: who does what → what goes wrong",
  "fix": "specific change, naming the file/function/pattern to use",
  "effort": "S|M|L",
  "rule": "kebab-case id, e.g. missing-tenant-check" }
```
Severity guide: **critical** means it's exploitable or causes data loss now. **high** means likely user-facing failure or a security weakness with a plausible path. **medium** means a real defect or debt with limited blast radius. **low** covers hygiene.

## 4. Verify
- Merge all arrays and dedupe by `rule + location` (keep the richer one).
- Launch `agent-discipline:audit-verifier` with every **critical and high** finding, plus a random third of the mediums. It tries to *disprove* each one: it checks reachability, mitigations elsewhere (middleware, validation layer, framework defaults) and whether the code is test-only. Apply its verdicts: drop, downgrade or keep.
- Findings that are still `possible` after verification go in an appendix and don't affect scores.
- Assign stable ids: `SEC-001`, `REL-001`, `PERF-001`, `MNT-001`, `TOOL-001`. If a finding matches one in the previous `latest.json` (same rule and file), **reuse its id**. That way you can see which findings persist.

## 5. Score
Apply `rubric.md` exactly. Score each category 0–10, applying the hard caps, and combine them into the overall score with the stated weights. Give a one-sentence justification per score that references finding ids. When a previous audit exists, show the delta per category and list the findings that are **fixed**, **new** and **still open**.

## 6. Write the outputs
- `docs/audits/$D.md` from `report-template.md`: scorecard, top 5 risks, findings by category, reuse opportunities, coverage gaps, trend.
- `docs/audits/latest.json`: `{ date, scores, findings: [...] }`. This is the baseline for the next audit.
- Append one line to `docs/audits/history.csv`: `date,overall,security,reliability,performance,maintainability,tooling,critical,high,medium,low`.
- `docs/audits/backlog.md`: open findings grouped into **fix batches**. Batch 0 holds every critical and any S-effort high (do these now). Later batches are themed, e.g. "add tenant scoping middleware" fixes SEC-003/004/007 together. Each batch lists its ids, the effort, and a "verify by" line.
- Commit only `docs/audits/*` (`chore(audit): <date> health audit`). Never commit `.audit/`.

## 7. Report to the user
In at most 10 lines: overall score and the per-category scores (with deltas), how many critical/high findings there are, the top 3 risks in plain words, and the recommended first batch. Then offer `/agent-discipline:fix-findings batch-0`. If they want audits to run regularly, offer a weekly scheduled `--since-last` audit and the CI gate. To install the gate, copy `${CLAUDE_PLUGIN_ROOT}/skills/audit/collect.mjs` and the `lib/` folder beside it to `scripts/audit/`, and `${CLAUDE_PLUGIN_ROOT}/skills/audit/templates/audit-ci.yml` to `.github/workflows/audit.yml`. Change the workflow's install step and cache to the project's package manager. Make sure `.nvmrc` exists, or switch the workflow to `node-version: 22`.
