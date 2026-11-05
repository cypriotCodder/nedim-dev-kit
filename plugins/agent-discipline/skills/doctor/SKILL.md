---
name: doctor
description: Show which agent-discipline guards really work in this project — hooks, typecheck, ESLint, boundary check, design guard, CI gate copy, exceptions and audit baseline. Use when the user asks whether the guards are working, why a hook didn't fire, or runs doctor.
---

# Doctor

Run this and show the user its table:
```
node ${CLAUDE_PLUGIN_ROOT}/skills/doctor/doctor.mjs .
```
It runs a real typecheck and boundary check, so it can take as long as those do. It changes nothing in the project.

- `active`: it runs and works.
- `off`: it doesn't apply here, and the reason says why. This is fine unless the user expected that guard.
- `broken`: it should run but can't, so it isn't protecting anything. The script exits 1 when any guard is broken.
- `outdated`: it's a different version from this plugin, or nothing uses it yet, such as a CI gate copy with no workflow to run it. The detail says what to do.

It finds typecheck and ESLint per file like the hooks, so each package in a monorepo gets checked. A package with its own ESLint is checked with its own config. A single hoisted ESLint checks each `.eslintrc` too, but ESLint 9's flat config is found from the working folder, so a broken `eslint.config.js` in a package below a hoisted ESLint isn't seen. It leaves out fixtures, templates and examples unless the project's `workspaces` or `pnpm-workspace.yaml` declares them as packages, and names what it left out on the `Typecheck` and `ESLint on edit` lines, so check that list if a package seems to be missing. It also leaves out the folders audits ignore, such as `build/` and `vendor/`, without naming them, so a package in one of those can be missing from an `active` line or show as `off`. A CI gate copy is compared with the plugin's files without being run, and an edited copy counts as `broken`, because its version stamp no longer describes it. That includes a copy reformatted by a project-wide formatter.

Lead with anything `broken`, then give one specific fix for each `broken` or `outdated` line. Don't apply fixes unless the user asks. "Reports type errors right now" means the guard works: those errors are the project's, not a doctor problem.

It can't see whether Claude Code loaded the hooks in this session. If a hook seems not to fire, ask the user to check `/hooks`.
