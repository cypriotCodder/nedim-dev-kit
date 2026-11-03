# Spec NNN: <feature name>

Status: draft | approved | in progress | done
Owner: <you>  ·  Created: <date>

## Problem
<Who has what problem. 2–4 sentences. No solution yet.>

## Scope
- In: <bullet list>
- **Out (non-goals):** <things that sound related but are NOT being built now>

## Design
### Data
<tables/fields/types touched; migrations needed>
### API / interfaces
<endpoints or function signatures, inputs → outputs, error cases>
### UI (if any)
<screens and their states: empty, loading, error, success, long-content. Reference DESIGN.md components.>
### Where the code goes
<which folders/modules change; nothing outside these should change>

## Slices
Each slice is independently shippable and verifiable, with a diff of about 300 lines or less.
- [ ] 1. <slice> — verify by: <test / command / screenshot>
- [ ] 2. …

## Acceptance criteria
- [ ] <observable behaviour>
- [ ] `npm run check` passes

## Open questions
- <resolve before building the slice they affect>
