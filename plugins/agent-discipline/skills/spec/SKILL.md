---
name: spec
description: Turn a feature idea into a written spec with small, verifiable slices before any code is written, then build it one slice at a time. Use for any feature or refactor bigger than ~1 file, or when the user says "let's build X".
argument-hint: "[feature idea]"
---

# Spec-first feature work

The spec stays the source of truth even after this conversation's context is gone. Feature idea: $ARGUMENTS

## Phase 1: Understand (no code)
1. Read `CLAUDE.md`, `docs/DECISIONS.md`, and any `docs/specs/*` that touch the same area.
2. Look at the code this feature will touch (use an `Explore` subagent if it spans many folders). Find existing patterns to reuse, so you don't invent new ones.
3. Ask the user **at most 4** questions, all in one message, and only ones where a wrong guess is expensive (data model, scope edges, UX flow). Propose a default answer for each.

## Phase 2: Write the spec
- Next number: count files in `docs/specs/` → `docs/specs/NNN-kebab-name.md`, based on `docs/specs/_template.md` (or `${CLAUDE_PLUGIN_ROOT}/skills/bootstrap/templates/spec-template.md`).
- **Non-goals are mandatory.** They are what stops scope creep.
- **Slices:** order them so each one leaves the app working. A typical order is data/schema → domain logic + tests → API → UI → polish. Each slice has a "verify by" line, and each diff should be about 300 lines or less. Split any slice that's bigger.
- "Where the code goes" lists the folders that may change. Anything outside that list is a red flag during the build.
- If the spec introduces a new architectural choice (new library, new pattern, new boundary), also draft an ADR with `/agent-discipline:decision`.
- Set status `draft`, show the user a 5-line summary plus the slice list, and **stop for approval**.

## Phase 3: Build, one slice at a time
For each slice after approval:
1. Implement only that slice. Stay inside "Where the code goes". If the spec turns out to be wrong, stop, update the spec, and tell the user. Don't silently diverge.
2. Write or extend tests for domain logic in the same slice.
3. Run the slice's "verify by" step.
4. Run `/agent-discipline:checkpoint`.
5. Tick the slice in the spec. Then ask whether to continue to the next slice, or continue directly if the user said "do all slices".

When all slices are done, set status `done` and update the "Current focus" line in CLAUDE.md.
