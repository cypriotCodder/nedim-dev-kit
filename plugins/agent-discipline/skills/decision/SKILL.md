---
name: decision
description: Record an architecture decision (ADR) in docs/DECISIONS.md — choosing a library, pattern, data model, boundary or trade-off. Use when a non-obvious technical choice is made or the user asks "why did we do X".
argument-hint: "[decision topic]"
---

# Record a decision

Topic: $ARGUMENTS

1. Open `docs/DECISIONS.md` (create it from `${CLAUDE_PLUGIN_ROOT}/skills/bootstrap/templates/DECISIONS.md` if missing). Find the highest ADR number.
2. If this decision changes an earlier one, write a new ADR and mark the old one `status: superseded by ADR-NNN`. That status line is the only edit allowed on an old entry.
3. Write the entry at the top of the list in the template format. Keep it under 15 lines and concrete: name the library, folder or table. Each rejected alternative gets one line with the real reason.
4. If the decision changes a rule an agent must follow, add or adjust the one-line rule in `CLAUDE.md` → Architecture or Conventions. If it can be enforced mechanically (an import boundary or lint rule), add it to `.dependency-cruiser.cjs` or the ESLint config too.
5. When asked "why is X like this?", answer from DECISIONS.md first.
