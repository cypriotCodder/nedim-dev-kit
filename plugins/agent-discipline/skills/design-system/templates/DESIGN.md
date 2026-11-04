# DESIGN.md: <Product>

> Every UI decision in this project comes from this file. If something isn't covered, add it here first, then build it.

<!-- If this design deliberately uses something the design guard flags, allow it here, e.g.: design-guard: allow gradient, inter -->

## Direction
- **Idea:** <one sentence, e.g. "A calm transit-signage clarity for busy restaurant staff">
- **Personality:** <adj>, <adj>, <adj>. **Never feels:** <e.g. like a generic SaaS dashboard, playful, glossy>
- **Primary context:** <device, environment, session length>
- **References:** <name — what we take from it> (one line each)

## Typography
| Role | Family | Weight | Size / line-height | Tracking |
|---|---|---|---|---|
| Display | <e.g. "Instrument Serif"> | 400 | 2.5rem / 1.05 | -0.02em |
| Heading | <> | <> | 1.5rem / 1.2 | -0.01em |
| Body | <> | 400 | 1rem / 1.5 | 0 |
| Small / meta | <> | 500 | 0.8125rem / 1.4 | 0.01em |
| Mono / numbers | <> | 500 | 0.875rem | tabular-nums |
Rules: maximum 2 families plus mono. Numbers in tables and prices use `tabular-nums`. Body line length is 60–75ch at most.

## Color (semantic tokens, OKLCH)
| Token | Light | Dark | Use |
|---|---|---|---|
| bg | | | app background |
| surface | | | cards, sheets |
| surface-2 | | | nested / hover rows |
| ink | | | primary text |
| ink-muted | | | secondary text (≥ 4.5:1 on bg) |
| line | | | borders, dividers |
| accent | | | ONE primary action per view, focus ring |
| accent-ink | | | text on accent |
| success / warning / danger | | | status only, never decoration |
Rules: the accent covers 10% of a screen or less. Neutrals are tinted toward the accent's hue rather than pure gray. Status colors only appear next to an icon or label (never color alone).

## Space, size, shape
- Spacing scale (px): 2, 4, 8, 12, 16, 24, 32, 48, 64, 96. Nothing else.
- Hit targets: at least 44px on touch. List rows are <height>.
- Radius: <e.g. sm 4 / md 8 / lg 12 / full>. Rule: <e.g. controls md, sheets lg, never mix within one group>
- Elevation: <choose ONE primary method: hairline borders | soft shadows | tonal surfaces>. Shadows: <token list, or "none except overlays">
- Layout: <grid, max widths, how screens are composed: left-aligned and asymmetric vs centered>

## Motion
| Token | Value | Use |
|---|---|---|
| duration-fast | 120ms | press, hover, toggles |
| duration-base | 200ms | small enter/exit, popovers |
| duration-slow | 320ms | sheets, page transitions |
| ease-out | cubic-bezier(0.22, 1, 0.36, 1) | things entering |
| ease-in-out | cubic-bezier(0.65, 0, 0.35, 1) | things moving |
| spring | stiffness 400, damping 30 | drag, sheets, layout |
Rules: animate only `transform` and `opacity` (plus color on hover). Elements enter with a 4–8px offset plus a fade, never by sliding the full screen. Lists stagger at most 30ms per item and 6 items in total. Respect `prefers-reduced-motion` by swapping to fades. Use skeletons with the real layout instead of spinners. Updates are optimistic, with a rollback toast on failure.

## Iconography & imagery
- Icon set: <e.g. Phosphor, regular weight, 20px> **only**. No emoji in UI.
- Imagery: <photography style / illustration rules / none>

## Voice
- <e.g. short, direct, second person; Turkish and English; verbs on buttons ("Send order", not "Submit")>
- Empty states say what to do next, with one action.
- Errors say what happened and how to fix it. Never "Something went wrong".

## Components
Use only `src/components/ui/*`. Showcase at `/dev/ui`. When something new is needed, add a primitive first, then use it.

## Banned
<paste templates/banned.md here and add project-specific items>
