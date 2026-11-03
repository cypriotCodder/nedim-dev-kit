#!/usr/bin/env sh
# Runs a hook script with Node if Node exists; otherwise does nothing.
# Keeps the plugin harmless in non-JS projects.
command -v node >/dev/null 2>&1 || exit 0
exec node "$@"
