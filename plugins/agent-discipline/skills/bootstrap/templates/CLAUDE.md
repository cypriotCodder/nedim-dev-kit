# <Project name>

<One sentence: what this product does and for whom.>

## Stack
- Runtime / framework: <e.g. Node 22, Next.js 15 App Router>
- Data: <e.g. PostgreSQL via Drizzle; migrations in src/db/migrations>
- UI: <e.g. React 19, Tailwind v4, tokens in src/styles/tokens.css — see DESIGN.md>
- Tests: <e.g. Vitest unit, Playwright e2e>

## Commands
- `npm run dev` — <what it starts, port>
- `npm run check` — typecheck + lint + boundaries + tests. **Must pass before a task is done.**
- <seed / migrate / e2e commands>

## Architecture (the rules that keep this codebase sane)
```
<folder tree, 2 levels, each line with a 5–10 word purpose>
```
- Dependency direction: `app → features → lib/db`. Never the reverse. Enforced by `.dependency-cruiser.cjs`.
- A feature's public API is its `index.ts`. Other features import only from there.
- <Where validation happens, where auth is checked, how errors are returned>
- <State management rule for the frontend>

## Conventions
- Naming: <files kebab-case, components PascalCase, …>
- <Error handling pattern, logging, env var access via src/lib/env.ts …>
- Don't add a dependency without saying why in the PR/commit message.

## How work happens here
1. Non-trivial work starts with a spec in `docs/specs/NNN-name.md` (use `/agent-discipline:spec`).
2. Build **one slice at a time**. Keep each diff small enough for a human to review.
3. End each slice with `/agent-discipline:checkpoint`.
4. Architectural choices go in `docs/DECISIONS.md` (`/agent-discipline:decision`).
5. UI work follows `DESIGN.md` exactly. No values outside the tokens.

## Current focus
<1–3 lines; update when it changes. Link the active spec.>

## Gotchas
- <Things that surprised past sessions. Add to this list when something bites you.>
