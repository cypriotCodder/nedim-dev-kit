---
name: audit
description: Systematic health audit of an existing project — security, reliability, performance, maintainability/reusability and dev/agent tooling. Combines deterministic scanners with specialist auditor agents, verifies every finding, scores the project against a fixed rubric, tracks the trend between audits and produces a prioritised fix backlog. Use when the user asks to audit, review or health-check a codebase, or asks "how good/secure/reliable is this project".
argument-hint: "[full | quick | security | reliability | performance | maintainability | tooling] [path]"
disable-model-invocation: true
---

# Project audit

Mode and scope: $ARGUMENTS (default `full` on the repo root). An `--since-last` argument means only re-check what changed since the last full audit, plus all of its open findings.

**Only a full audit replaces the baseline.** `quick`, single-category and `--since-last` runs write a dated report and leave `latest.json` and `history.csv` alone, because anything they didn't re-check could otherwise look fixed. `score.mjs` enforces this.

**This skill never changes source code.** It produces evidence, a report, a scorecard and a backlog. Fixing is a separate step (`/agent-discipline:fix-findings`), so the audit stays honest.

Files used here: `${CLAUDE_PLUGIN_ROOT}/skills/audit/collect.mjs`, `score.mjs`, `rules.json`, `rubric.md` and `report-template.md` in the same folder.

## 0. Prepare
- Add `.audit/` to `.gitignore` if it's missing. Known secret formats are redacted, but raw evidence still quotes source code, so it must never be committed.
- Note the date: `D=$(date +%F)`. Reports go in `docs/audits/`.
- Monorepo (has `workspaces`, `apps/`, `packages/`)? List the packages and audit each deployable app as its own scope. Score the apps separately and add one combined line. Give each app its own folder: `--baseline docs/audits/<app>/latest.json` for `collect.mjs`, and `--dir docs/audits/<app>` for `score.mjs`.
- Read `CLAUDE.md`, `docs/DECISIONS.md` and any previous `docs/audits/latest.json`.
- **Project-specific agents:** list `.claude/agents/*.md`. If the project already has auditors (for example a `security-review` agent), plan to run them **alongside** the matching built-in auditor in step 3, then merge and dedupe. The tooling auditor will also judge whether they're complete.

## 1. Collect evidence (deterministic tools)
```
node ${CLAUDE_PLUGIN_ROOT}/skills/audit/collect.mjs . --out .audit/raw
```
It runs typecheck, ESLint, boundaries/circular deps, knip (dead code, unused deps), jscpd (duplication), npm/pnpm audit plus outdated packages, optional semgrep, gitleaks and osv-scanner, a built-in pattern scan, and size and churn hotspots. Project tests don't run by default, because they can hit a real dev database: add `--tests` once the user confirms they're safe to run here, and otherwise list them under "Coverage gaps". If `semgrep` or `gitleaks` aren't installed, say so once in the report under "Coverage gaps" (`brew install semgrep gitleaks`). Don't install them unasked.

**`--since-last`:** read `tools.sinceLast` in the summary. If it isn't `ok` (no previous audit, an older baseline with no commit, or a commit no longer in the history), tell the user why and run a full audit instead. Otherwise `.audit/raw/changed-since-last.txt` lists the changed files, committed or not, and the auditors look only at those plus every open finding in `latest.json`.

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
Launch these agents **in one message** so they run concurrently. Give each one: the scope path, `.audit/map.md`, `.audit/raw/` (tell it which raw files matter to it), CLAUDE.md, the findings schema below, and its category's rule ids from `rules.json`. The auditors have no shell, so anything they need from git has to be in the evidence (`git-log.txt`, `hotspots.txt`). Their search tools may skip the git-ignored `.audit/` folder, so give exact paths to read. `quick` mode runs only security and reliability, limited to the critical flows. A single-category mode runs only that agent.

| Agent | Looks at |
|---|---|
| `agent-discipline:security-auditor` | authn/authz/tenant isolation, injection, XSS/SSRF, secrets, sessions/JWT, CORS/CSRF, uploads, rate limits, dependency CVEs, data exposure |
| `agent-discipline:reliability-auditor` | error handling, timeouts/retries, idempotency, transactions, races, config validation, observability, migrations, test coverage of critical flows |
| `agent-discipline:performance-auditor` | N+1, indexes, unbounded queries, caching, request-path blocking, payload size, frontend bundle/rendering, leaks, pooling |
| `agent-discipline:maintainability-auditor` | architecture vs CLAUDE.md, boundaries, duplication → reuse opportunities, inconsistent patterns, god files, dead code, type safety, test quality |
| `agent-discipline:tooling-auditor` | scripts, CI, lint/format, lockfile, env handling, Docker, dependency hygiene, and the project's Claude setup: CLAUDE.md accuracy, agents, skills, hooks |
| project's own agents (if any) | whatever they're defined for. Pass them the same map and scope |

**Output** (each agent returns this JSON object and nothing else): `{ "findings": [...], "strengths": [...] }`. A strength is `{ "category", "title", "location" }`: something checked and done well. Findings look like this:
```json
{ "category": "security|reliability|performance|maintainability|tooling",
  "severity": "critical|high|medium|low",
  "confidence": "confirmed|likely|possible",
  "title": "short, specific",
  "location": "project-relative path/file.ts:123, or several as path/a.ts:1, path/b.ts:9. For a route, its handler's file",
  "evidence": "≤3 lines of code or tool output proving it",
  "impact": "concrete failure scenario: who does what → what goes wrong",
  "fix": "specific change, naming the file/function/pattern to use",
  "effort": "S|M|L",
  "rule": "an id from rules.json for this category, or other-<category> if nothing fits" }
```
Severity guide: **critical** means it's exploitable or causes data loss now. **high** means likely user-facing failure or a security weakness with a plausible path. **medium** means a real defect or debt with limited blast radius. **low** covers hygiene.

## 4. Verify
- Merge all arrays and dedupe by `rule + location`, and by title too for `other-*` rules, since those cover many problems (keep the richer one). A project agent's findings need a rule from `rules.json` too, so map them.
- Launch `agent-discipline:audit-verifier` with every **critical, high and medium** finding. It tries to *disprove* each one: it checks reachability, mitigations elsewhere (middleware, validation layer, framework defaults) and whether the code is test-only. Apply its verdicts: remove dropped findings, set the final severity and confidence on the rest, and add `"verified": true`.
- Findings that are still `possible` after verification go in the appendix and don't affect scores. An auditor's own `possible` doesn't skip this step: `score.mjs` refuses any unverified critical, high or medium. Lows aren't verified, and they only inform your anchor: they fire no caps. A finding the verifier downgrades to `possible` keeps its id, and `comparison.downgraded` lists it: report it as downgraded, never as fixed.

## 5. Score
Read `rubric.md` and choose an anchor for each category. That judgment is yours; everything else is computed. Write `.audit/scoring.json`:
```json
{ "mode": "full",
  "anchors": { "security": { "score": 7, "why": "one sentence naming finding rules" },
               "performance": { "notApplicable": "a CLI with no server or database" } },
  "findings": [], "strengths": [] }
```
`mode` is `full`, `quick`, `since-last` or the category name. A full audit needs every category, each scored or not applicable. A partial one gives only the categories it looked at, at least one of them scored, and a category audit has to include its own category. Locations are made project-relative, and one outside the project is refused, so an absolute-looking route such as `/api/login` needs its handler's file instead. Then run:
```
node ${CLAUDE_PLUGIN_ROOT}/skills/audit/score.mjs --input .audit/scoring.json
```
It applies the caps and weights, assigns stable finding ids (`SEC-001`, and so on), compares with the previous audit, and writes `.audit/score.json`. For a full audit it also writes `docs/audits/latest.json` and `docs/audits/history.csv`. **Don't edit those two by hand, and don't change a number it computed.** If it refuses, it lists why: fix the input, or re-run `collect.mjs` if the evidence is out of date.

If `comparison.comparable` is false because the rubric changed, say scores aren't comparable with the last audit, and don't present a trend.

To accept a finding as a known risk, the user adds it to `risks` in `.audit-exceptions.json`, with a reason and an expiry date. Accepted findings stay in the report and stop counting toward scores until they expire. A finding with several locations is only accepted if the risks cover all of them. Each location has to be a file that exists in the project, on its own or in a comma-separated list, so a note after the path or a file that's been deleted stays open. A critical can't be accepted. Never add an entry yourself.

## 6. Write the outputs
Everything comes from `.audit/score.json`:
- `docs/audits/$D.md` from `report-template.md`: scorecard, top 5 risks, findings by category, reuse opportunities, what's working well (the strengths), coverage gaps, trend. A partial audit writes `docs/audits/$D-<mode>.md` and says what it didn't cover.
- `docs/audits/backlog.md` (full audits only): open findings grouped into **fix batches**, leaving out accepted ones. Batch 0 holds every critical and any S-effort high (do these now). Later batches are themed, e.g. "add tenant scoping middleware" fixes SEC-003/004/007 together. Each batch lists its ids, the effort, and a "verify by" line.
- **Don't commit anything yet.** Show the user what was written and ask. If they agree and you're on the default branch, create a branch first. Then commit `docs/audits/*` together with the `.gitignore` change from step 0 (`chore(audit): <date> health audit`). Never commit `.audit/`.

## 7. Report to the user
In at most 10 lines: overall score with its `coverageGaps` count, since a skipped tool doesn't lower a score, the per-category scores (with deltas), how many critical/high findings there are, the top 3 risks in plain words, and the recommended first batch. Then offer `/agent-discipline:fix-findings batch-0`. If they want audits to run regularly, offer a weekly scheduled `--since-last` audit and the CI gate. To install the gate, copy `${CLAUDE_PLUGIN_ROOT}/skills/audit/collect.mjs` and the `lib/` folder beside it to `scripts/audit/` (`/agent-discipline:doctor` spots copies that fall behind the plugin or were edited, so keep `scripts/audit/` out of the project's formatters), and `${CLAUDE_PLUGIN_ROOT}/skills/audit/templates/audit-ci.yml` to `.github/workflows/audit.yml`. Change the workflow's install step and cache to the project's package manager. Make sure `.nvmrc` exists, or switch the workflow to `node-version: 22`.
