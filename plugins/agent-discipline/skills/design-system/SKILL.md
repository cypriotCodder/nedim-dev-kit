---
name: design-system
description: Create a distinctive, non-generic design system for a project — art direction from references, DESIGN.md, design tokens, motion system, banned defaults and a set of polished primitives. Use before building UI in a project that follows this kit, or when the user asks for a DESIGN.md.
argument-hint: "[product name or vibe]"
---

# Design system that doesn't look AI-made

UI looks generic when every decision is left to the model's defaults: Inter, a slate palette, a purple gradient, `rounded-2xl shadow-lg` cards, a centered hero with three feature cards, and spinners everywhere. This skill makes every one of those decisions explicitly and writes them down, so later sessions can't drift back.

Templates are in `${CLAUDE_PLUGIN_ROOT}/skills/design-system/templates/`.

## Step 1: Direction brief (ask in ONE message)
1. Who uses it, where, and how often? (A waiter on a phone mid-shift is different from a municipal clerk at a desktop all day.)
2. Three personality adjectives, plus one thing it must **not** feel like.
3. 2–5 references the user likes: apps, sites, print, or physical objects (screenshots or URLs). For each one, ask *what specifically* to take from it: density, type, color, motion, or tone.
4. Density: compact / balanced / airy. Light, dark or both? Brand colors already fixed?

If the user has no references, propose 3 starting points drawn from outside typical SaaS, such as a transit signage system, a Swiss-style print poster, a field-notes notebook, a vintage instrument panel, or a premium editorial magazine.

## Step 2: Three directions, shown visually
Create `design-lab/directions.html`, a single self-contained page with **3 clearly different directions** side by side. For each direction show:
- its name and a 1-line idea
- a type specimen (display + text + mono, real font names from Google Fonts or Fontshare, loaded via `<link>`)
- the palette as semantic roles (bg, surface, text, muted, border, accent, danger…), not raw swatches
- one realistic component from THIS product (an order row, a form card or a stat panel, with real-ish content in the user's language), showing hover and pressed states

Rules for the directions: none of them may use Inter, Roboto, Arial or system-ui as the display face. They should differ on at least two of these axes: type, color temperature, corner radius, density, elevation (shadow vs border vs flat).

Screenshot it with `node ${CLAUDE_PLUGIN_ROOT}/skills/ui-review/screenshot.mjs file://$PWD/design-lab/directions.html` (see ui-review for setup), look at the image yourself, fix anything broken, then ask the user to pick one direction or mix them.

## Step 3: Write DESIGN.md
Fill `templates/DESIGN.md` into the project root with the chosen direction. Every value must be concrete: exact font families and weights, the type scale in rem with line-heights, color tokens in OKLCH for light (and dark), spacing scale, radius scale, elevation rules, motion tokens, icon set, and copy tone. Copy `templates/banned.md` into DESIGN.md's "Banned" section and add the user's own "must not feel like" points.

## Step 4: Tokens in code
- **Tailwind v4:** `src/styles/tokens.css` with an `@theme` block. Define semantic color names (`--color-bg`, `--color-surface`, `--color-ink`, `--color-ink-muted`, `--color-line`, `--color-accent`, `--color-accent-ink`, `--color-danger`…), font families, the type scale, radius, shadows, `--ease-*` and `--duration-*`. Where possible, **reset the default palette** with `--color-*: initial;` before defining your own, so classes like `bg-blue-500` don't exist.
- **Tailwind v3:** put the same tokens in `tailwind.config` `theme` (not `extend`) for colors, so the default palette is gone.
- **No Tailwind:** use CSS custom properties in `tokens.css`.
- Motion: copy `templates/motion.ts` to `src/lib/motion.ts` and adjust it to DESIGN.md. For React, install `motion` with the project's package manager.

## Step 5: Primitives before screens
Build these in `src/components/ui/`, using tokens only: Button (primary/secondary/ghost/danger, sizes, loading), Input/Textarea/Select with label, hint and error, Checkbox/Switch, Card/Surface, ListRow, Badge, Dialog/Sheet, Toast, Skeleton, EmptyState, and a Tabs or SegmentedControl. Headless libraries (Radix, React Aria, Base UI) are fine for behaviour, but styling is ours. Never ship shadcn defaults unchanged.

Each primitive must have every state: default, hover, active/pressed (a slight scale or translate, under 120ms), focus-visible (a designed ring, not the browser default), disabled, loading, and error where relevant. Respect `prefers-reduced-motion`.

Add a dev-only showcase route (`/dev/ui` or similar) that renders every primitive in every state. Screenshot it, run the design-critic agent on it, and fix the results.

## Step 6: Lock it in
- The plugin's design guard hook turns on automatically now that `DESIGN.md` exists. It flags raw colors, arbitrary values, palette classes, emoji, gradients and the generic soft-card look in newly written UI code.
- Add to `CLAUDE.md` → Conventions: "UI: read DESIGN.md before any UI work. Compose screens only from `src/components/ui`. No values outside tokens. Run `/agent-discipline:ui-review` after UI changes."
- Record the direction as an ADR via `/agent-discipline:decision`.
