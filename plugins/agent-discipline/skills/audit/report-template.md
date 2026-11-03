# Health audit: <project> · <YYYY-MM-DD>

Scope: <path / apps> · Commit: <short sha> · Mode: <full|quick|…> · Previous: <date or "first audit">

## Scorecard
| Category | Score | Δ | Grade-limiting factor |
|---|---|---|---|
| Security | x/10 | +/- | <cap fired or top finding id> |
| Reliability | | | |
| Performance | | | |
| Maintainability & reuse | | | |
| Tooling & agent setup | | | |
| **Overall** | **x.x (<grade>)** | | |

Findings: <n> critical · <n> high · <n> medium · <n> low  ·  Fixed since last: <n>  ·  New: <n>

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
<2–4 bullets, specific. These tell future agents which patterns to copy.>

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
<Tools skipped and why; areas not reviewed (e.g. "mobile app not audited", "no semgrep installed").>

## Appendix: unverified leads
<'possible' findings, for a human to look at.>
