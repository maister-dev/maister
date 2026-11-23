#!/bin/sh
# The ordinary path needs no lock directory or Python installation.
if [ "${MAISTER_MAX_CONCURRENT_HEAVY_CHECKS+x}" = x ]; then
  exec python3 "$(dirname "$0")/heavy-check.py" "$@"
fi
exec "$@"
