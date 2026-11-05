---
name: checkpoint
description: Close out a unit of agent work — run all checks, get an independent review of the diff, update the project map and decision log, and commit. Use at the end of every slice of a spec, or when the user says "checkpoint".
---

# Checkpoint

This keeps the codebase and its documentation in sync, so the next session starts clean.

1. **UI changed?** If `.tsx/.css/.vue/.svelte` files changed and DESIGN.md exists, run `/agent-discipline:ui-review` for the affected routes first. It changes code, and everything below has to see those changes.
2. **Checks.** Run `npm run check` (or the project's equivalent from CLAUDE.md). Fix failures this task caused. If something was already failing before the task, say so explicitly and don't hide it.
3. **Scope check.** List what really changed with `git status --porcelain --untracked-files=all` and `git diff HEAD --stat`, which together cover staged, unstaged and new files. Flag any changed file that is outside the active spec's "Where the code goes", along with diffs over ~400 lines, new dependencies, and deleted tests.
4. **Independent review.** Launch the `agent-discipline:code-reviewer` agent on the same set of changes (`git diff HEAD` plus untracked files). Fix anything it marks **must-fix**, then re-run step 2 if you changed code. List the **should-fix** items for the user and don't silently expand the scope.
5. **Update the map.**
   - New folder, convention, command or gotcha → update `CLAUDE.md` and keep it under ~150 lines. Prune lines that are no longer true.
   - Architectural choice made → `/agent-discipline:decision`.
   - Tick the slice in `docs/specs/NNN-*.md`.
6. **Commit** with a conventional message (`feat(orders): …`, `fix: …`, `refactor: …`). The body says what changed and why, and references the spec number. Push only if the user asked.
7. **Report** in at most 5 lines: what shipped, checks status, review notes deferred, next slice.

Suggest `/clear` before the next slice. The spec and CLAUDE.md carry the context forward, so a fresh session loses nothing and avoids drift.
