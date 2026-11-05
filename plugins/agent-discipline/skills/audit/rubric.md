# Audit scoring rubric (version 2)

`score.mjs` computes the scores from your anchors. **Your only judgment is the anchor:** pick the band that best describes the category, then a number within it, adjusted by up to ±1 for evidence. The caps below always win, and you don't apply them yourself.

Only verified findings with `confirmed` or `likely` confidence count, and accepted risks don't. Every critical, high and medium finding has to be verified, whatever its confidence, or `score.mjs` refuses to score. Lows aren't verified: they're listed and inform your anchor, but they can't fire a cap.

## Anchors (all categories)
- **9–10 — Exemplary.** No high findings. The category's practices are systematic: enforced by tools or tests, not by discipline.
- **7–8 — Solid.** No criticals and at most 2 highs, all with S/M effort. The practices exist, with a few gaps.
- **5–6 — Fragile.** Several highs, or practices that are applied inconsistently. It works today, but the next change is risky.
- **3–4 — Weak.** A critical, or a systemic gap such as no authz layer, no error-handling strategy or no tests on core flows.
- **0–2 — Broken / dangerous.** Multiple criticals; actively exploitable or losing data.

**Not applicable.** A category can be marked not applicable with a reason, such as performance for a small library. Its weight is shared across the others. It can't have findings, so don't use it to hide some.

## Severity ceilings (computed, in every category)
- 2 or more criticals → max 2. One critical → max 4. A confirmed critical in security → max 3.
- 3 or more highs → max 6. 1 or 2 highs → max 8.

## Hard caps from evidence (computed from `summary.json`)
If a tool **failed or timed out**, it can't rule its caps out, so they apply. If it was **skipped**, its caps don't apply and it's listed as a coverage gap.

**Security**
- `secret-in-repo` → max 5: an open secret finding in the repo
- `secret-in-history` → max 5: gitleaks found a secret in git history

**Reliability**
- `tests-failing` → max 5: tests ran and failed

**Maintainability & reusability**
- `type-errors` → max 6: type errors present
- `strict-off` → max 7: `strict` off in a TypeScript project
- `many-cycles-or-violations` → max 6: more than 5 circular dependencies or boundary violations
- `duplication-over-8` → max 6: duplication above 8%
- `duplication-over-4` → max 8: duplication above 4%
- `many-huge-files` → max 6: more than 3 non-test source files over 800 lines

**Tooling**
- `no-lockfile` → max 4: `package.json` declares dependencies with no lockfile
- `env-file-with-secrets` → max 4: a tracked `.env` file counted as a leak
- `no-ci` → max 6: no CI configuration
- `no-claude-md` → max 7: no `CLAUDE.md` or `AGENTS.md` at the root

## Hard caps from findings (fire when a counted finding of medium severity or above uses the rule)
**Security**
- `missing-authz-on-mutation` → max 4: missing authorization or tenant check on a data-mutating route
- `hardcoded-secret` → max 5: a secret in the repo that the scanners missed
- `reachable-vulnerable-dependency` → max 6: high or critical vulnerable production dependency that is reachable
- `no-boundary-validation` → max 6: no input validation at API boundaries (no schema library or equivalent)
- `no-auth-rate-limit` → max 7: no rate limiting on auth endpoints

**Reliability**
- `no-critical-flow-tests` → max 4: no automated tests on any critical flow
- `non-transactional-writes` → max 5: multi-step writes outside transactions, where partial failure corrupts state
- `external-call-no-timeout` → max 6: external calls without timeouts on a request path
- `env-not-validated` → max 7: environment config not validated at startup
- `no-production-observability` → max 7: no structured logging or error tracking in production

**Performance**
- `n-plus-one` → max 5: confirmed N+1 on a hot path
- `unbounded-query` → max 5: unbounded query on a hot path
- `missing-index` → max 6: a query on a large or growing table with no supporting index
- `no-pagination` → max 6: no pagination on list endpoints

**Maintainability & reusability**
- `competing-implementations` → max 7: two or more implementations of one concern (fetch clients, date utils, state stores)

**Tooling**
- `ci-missing-checks` → max 6: CI exists but doesn't run typecheck, lint and tests
- `no-check-command` → max 7: no one-command check (`npm run check` or equivalent)
- `claude-md-contradicts-code` → max 7: CLAUDE.md contradicts the code in 2 or more places
- `conflicting-agent-setup` → max 8: overlapping or conflicting agents or skills, or project agents with obviously incomplete checklists

## Overall
Weights: security 30, reliability 25, performance 15, maintainability 20, tooling 10, over the categories that apply. Rounded to 1 decimal. If any category is ≤ 3, the overall is capped at 5.0, because one broken pillar sinks the project. A partial audit has no overall.

Grade bands: 9+ A · 8–8.9 B · 6.5–7.9 C · 5–6.4 D · < 5 F.

## Consistency rules
- Use the same rubric every time; don't grade on a curve. Trend lines are only meaningful if the scale is stable.
- Changing a cap, a weight or the rules means raising `rubricVersion` in `rules.json`. Scores from different versions aren't compared.
- A score change of ±1 or more between audits must be explained by specific finding ids that were fixed or are new.
- Wherever a cap limits a score, the report must name it (`limitedBy` in `score.json`).
