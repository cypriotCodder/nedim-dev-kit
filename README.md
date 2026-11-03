# nedim-dev-kit

A Claude Code plugin marketplace holding one plugin, [**agent-discipline**](plugins/agent-discipline/README.md). Install it once, and every project you open gets the same workflow.

## Install

In Claude Code:
```
/plugin marketplace add cypriotCodder/nedim-dev-kit
/plugin install agent-discipline@nedim-dev-kit
```
Or from a local clone: `claude plugin marketplace add ./nedim-dev-kit`

Update later with `/plugin marketplace update nedim-dev-kit`.

## Use

See the [plugin README](plugins/agent-discipline/README.md) for commands, audits and hooks.

## Develop

`npm test` runs the test suite. It needs Node 22 or later and has no dependencies.

Conventions are in [CLAUDE.md](CLAUDE.md), and the reasoning behind them is in [docs/DECISIONS.md](docs/DECISIONS.md).

## License

[MIT](LICENSE)
