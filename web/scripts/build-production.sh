#!/bin/sh
set -eu
case "${MAISTER_BUILD_PROFILE-default}" in
  default|cold|cold-no-maps) ;;
  *) echo "MAISTER_BUILD_PROFILE must be default, cold, or cold-no-maps" >&2; exit 2 ;;
esac
pnpm --filter @maister/mcp --fail-if-no-match build
pnpm clean
if [ "${MAISTER_BUILD_PROFILE-default}" = default ]; then
  exec next build "$@"
fi

# Next emits the production route validators before the separate compiler starts.
MAISTER_SEPARATE_BUILD_TYPECHECK=1 next build "$@"
exec tsc -p tsconfig.build.json --noEmit
