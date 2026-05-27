#!/usr/bin/env bash
set -euo pipefail

if [ -n "${MAISTER_FLOW_SKIP_SETUP:-}" ]; then
  echo "[aif setup] MAISTER_FLOW_SKIP_SETUP set — skipping" >&2
  exit 0
fi

if [ ! -t 0 ]; then
  echo "[aif setup] non-interactive shell (stdin not a TTY) — skipping ai-factory init" >&2
  exit 0
fi

if command -v ai-factory >/dev/null 2>&1; then
  ai-factory init
else
  echo "[aif setup] ai-factory CLI not found on PATH — skipping init (plugin will still load)" >&2
fi
