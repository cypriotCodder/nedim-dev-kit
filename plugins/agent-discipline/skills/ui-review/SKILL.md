---
name: ui-review
description: Screenshot-driven UI review loop — render the real pages at desktop and mobile widths, look at them, critique against DESIGN.md, fix the worst issues, and repeat. Use from checkpoint after a UI change in a project with a DESIGN.md, or when the user asks for a screenshot review.
argument-hint: "[route or URL, e.g. /orders]"
---

# UI review loop

Without screenshots, the agent is designing blind. This loop lets it see its own output.

Target: $ARGUMENTS (default: the routes touched in the current diff).

## Setup (once per project)
- Check for `playwright` in devDependencies. If it's missing, install it as a dev dependency with the project's package manager (`npm i -D playwright` on npm), then run `npx playwright install chromium`.
- Add `.ui-review/` to `.gitignore`.

## Loop (at most 3 rounds)
1. Make sure the dev server is running (start it in the background if needed, using the command in CLAUDE.md). Build full URLs such as `http://localhost:3000/orders`.
2. Capture the screenshots:
   `node ${CLAUDE_PLUGIN_ROOT}/skills/ui-review/screenshot.mjs <url...>`
   Add `--dark` as well if DESIGN.md defines a dark theme. If the theme is class-based (Tailwind `dark:` with a class, for example), use `--dark-class dark` instead, with the class it uses.
   For a route behind a login, pass `--auth <file>` with a Playwright storage state. That file holds a live session, so keep it out of git, and ask the user to create it rather than asking for their password.
   The script also prints overflow, small hit targets (32px on desktop, 44px on mobile), font families, console errors and, if the project has `axe-core`, accessibility violations. Treat each of those as a finding. If it says `REDIRECTED`, those screenshots aren't of the page you asked for, so fix that before judging them.
   Tall pages are saved as `.part1.png`, `.part2.png` and so on. Look at every part.
3. Look at every PNG with the Read tool. Actually examine the images. Don't judge the UI from the code.
4. Launch the `agent-discipline:design-critic` agent with the screenshot paths and the DESIGN.md path. It hasn't seen the code, so it judges only what a user sees.
5. Fix the **top 3** findings by impact. Usually these are hierarchy, then spacing rhythm, then states. Don't try to fix everything in one round.
6. Re-screenshot and compare before and after. Stop when the critic's verdict is "ship", or after round 3.

## Also check states
For each reviewed screen, render (via a query param, a story, or by temporarily mocking data) the **empty, loading (skeleton), error and long-content** states. A screen isn't done until all four look intentional.

## Report
Give the user the final screenshot paths (send the key ones as files), what changed in each round, and anything that needs their taste call. Ask taste questions as 2 concrete options, not "what do you think?".
