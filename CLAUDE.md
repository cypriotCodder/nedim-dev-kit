# nedim-dev-kit

A Claude Code plugin marketplace with one plugin, `agent-discipline`: skills, agents and hooks that keep agent-built projects disciplined.

## Commands
- `npm test`: runs the suite. **Must pass before a task is done.**
- `claude plugin validate .`: validates the manifests.

## Layout
```
.claude-plugin/marketplace.json   marketplace manifest
plugins/agent-discipline/         the plugin; only this folder ships to users
  scripts/                        hook scripts (PostToolUse, Stop)
  skills/  agents/  hooks/        plugin components
tests/                            black-box tests; not shipped
docs/DECISIONS.md                 why things are the way they are
```

## Rules
- **Don't add dependencies.** Hooks run in other people's projects, so scripts use only Node built-ins.
- **Test scripts from the outside.** Run them as subprocesses and assert on exit codes, output and written files. Use `fakeBin` and `fakeLocalBin` instead of real tools.
- **A guard must never pass silently when it failed to run.** "Not applicable" and "broken" are different results.
- **Path rules use the project-relative path,** because the folder a project lives in must not change a result.
- **Known bugs are `todo` tests** naming the PR that fixes them. When you fix one, remove its `todo` flag so it becomes a hard requirement.
- **Bump `version` in `plugin.json`** with any change under `plugins/`, or installed copies won't update.

## Gotchas
- Plugin subagents ignore `hooks`, `mcpServers` and `permissionMode` in their frontmatter.
- `collect.mjs` and `skills/audit/lib/` get copied together into user projects for the CI gate, so `lib/` can't import from elsewhere in the plugin.
- `git status --porcelain` shows a new folder as `?? src/`, not its files. Fixtures need a committed file in the folder, or changes look absent.
- Tests that need real compilers are skipped until `npm run test:install-ts` has run. CI always runs it.
