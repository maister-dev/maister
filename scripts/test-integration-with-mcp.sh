#!/bin/sh
set -eu
pnpm --filter @maister/mcp --fail-if-no-match build
exec vitest run --project integration "$@"
