# Audit scoring rubric

Score each category from 0 to 10. Start from the anchor that best describes the project, adjust by up to ±1 for evidence, then apply the **hard caps**, which always win. Only verified findings with `confirmed` or `likely` confidence count.

## Anchors (all categories)
- **9–10 — Exemplary.** No high findings. The category's practices are systematic: enforced by tools or tests, not by discipline.
- **7–8 — Solid.** No criticals and at most 2 highs, all with S/M effort. The practices exist, with a few gaps.
- **5–6 — Fragile.** Several highs, or practices that are applied inconsistently. It works today, but the next change is risky.
- **3–4 — Weak.** A critical, or a systemic gap such as no authz layer, no error-handling strategy or no tests on core flows.
- **0–2 — Broken / dangerous.** Multiple criticals; actively exploitable or losing data.

## Hard caps
**Security**
- Any confirmed critical → max 3
- Missing authorization or tenant check on a data-mutating route → max 4
- Secret in the repo or in git history → max 5
- High or critical vulnerable production dependency that is reachable → max 6
- No input validation at API boundaries (no schema library or equivalent) → max 6
- No rate limiting on auth endpoints → max 7

**Reliability**
- No automated tests on any critical flow → max 4
- Tests exist but fail → max 5
- External calls without timeouts on a request path → max 6
- Multi-step writes that aren't in transactions, where partial failure corrupts state → max 5
- Environment config not validated at startup → max 7
- No structured logging or error tracking in production → max 7

**Performance**
- Confirmed N+1 or unbounded query on a hot path → max 5
- A query on a large or growing table with no supporting index → max 6
- No pagination on list endpoints → max 6

**Maintainability & reusability**
- Type errors present → max 6. `strict` off in a TypeScript project → max 7
- Circular dependencies or boundary violations > 5 → max 6
- Duplication > 8% → max 6; > 4% → max 8
- More than 3 files over 800 lines in hotspots → max 6
- Two or more competing implementations of the same concern (fetch clients, date utils, state stores) → max 7

**Tooling (developer + agent setup)**
- No lockfile → max 4
- `.env` with real values tracked in git → max 4
- No CI running typecheck/lint/tests → max 6
- No one-command check (`npm run check` or equivalent) → max 7
- CLAUDE.md missing, or contradicting the code in ≥ 2 places → max 7
- Overlapping or conflicting agents/skills, or project agents with obviously incomplete checklists → max 8

## Overall
`overall = 0.30·security + 0.25·reliability + 0.15·performance + 0.20·maintainability + 0.10·tooling`, rounded to 1 decimal.
If any category is ≤ 3, the overall is capped at 5.0, because one broken pillar sinks the project.

Grade bands: 9+ A · 8–8.9 B · 6.5–7.9 C · 5–6.4 D · < 5 F.

## Consistency rules
- Use the same rubric every time; don't grade on a curve. Trend lines are only meaningful if the scale is stable.
- A score change of ±1 or more between audits must be explained by specific finding ids that were fixed or are new.
- Wherever a cap fires, the report must name the cap.
