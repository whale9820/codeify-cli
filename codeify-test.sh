#!/usr/bin/env bash
set -euo pipefail

CODEIFY_SOURCE_DIR="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)"
if [[ "${CODEIFY_USE_SOURCE:-}" == "1" ]]; then
	exec "$CODEIFY_SOURCE_DIR/node_modules/.bin/tsx" --tsconfig "$CODEIFY_SOURCE_DIR/tsconfig.json" "$CODEIFY_SOURCE_DIR/packages/coding-agent/src/cli.ts" "$@"
fi
exec node "$CODEIFY_SOURCE_DIR/packages/coding-agent/dist/cli.js" "$@"
