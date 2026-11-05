# Health audit: <project> · <YYYY-MM-DD>

Scope: <path / apps> · Commit: <short sha, plus "with N uncommitted files" if any> · Mode: <full|quick|…> · Rubric: <version> · Previous: <date, "first audit", or "not comparable: rubric changed">

## Scorecard
| Category | Score | Δ | Grade-limiting factor |
|---|---|---|---|
| Security | x/10 | +/- | <cap fired or top finding id> |
| Reliability | | | |
| Performance | | | |
| Maintainability & reuse | | | |
| Tooling & agent setup | | | |
<!-- A category with status not-applicable or not-assessed shows that word instead of a score. -->
| **Overall** | **x.x (<grade>)**, <`coverageGaps`> coverage gaps | | |

Findings: <n> critical · <n> high · <n> medium · <n> low  ·  Accepted: <n>  ·  Fixed since last: <n>  ·  New: <n>  ·  Reopened: <n>

## Top risks
1. **<ID> <title>** — <impact in one plain sentence>. Fix: <one line>. Effort <S/M/L>.
2. …(up to 5)

## Findings
### Security
| ID | Sev | Location | Finding | Fix | Effort |
|---|---|---|---|---|---|
<one row per finding; evidence and impact go in the details block below the table>

<details><summary>Evidence</summary>

**SEC-001** — `path:line`
```
<evidence>
```
Impact: <scenario>
</details>

### Reliability
…
### Performance
…
### Maintainability & reuse
…
### Tooling & agent setup
…

## Reuse opportunities
<Duplication clusters and inconsistent patterns turned into proposals: "Extract `src/lib/money.ts` — replaces 4 copies (MNT-002, MNT-005)". Max 5.>

## What's working well
<2–4 bullets from `strengths`, specific. These tell future agents which patterns to copy.>

## Accepted risks
<Accepted findings with their reason and expiry, and any expired entries (`expiredRisks`) that count again.>

## Metrics
| Metric | Value | Prev |
|---|---|---|
| Type errors | | |
| Lint errors / warnings | | |
| Duplication % | | |
| Circular deps / boundary violations | | |
| Unused files / exports / deps | | |
| Vulnerable deps (crit/high/mod) | | |
| Test files : source files | | |
| Tests pass | | |
| Files > 800 lines | | |

## Coverage gaps
<Each category's `gaps` from `score.json`, plus areas not reviewed (e.g. "mobile app not audited"). Name any cap applied as `not-ruled-out`: the tool broke, so the score is limited until it runs.>

## Appendix: unconfirmed leads
<'possible' findings, for a human to look at. Mark the ones in `comparison.downgraded`: they counted last time, and aren't fixed.>
