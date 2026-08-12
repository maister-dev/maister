#!/usr/bin/env bash
# Builds the RU user manual into a single PDF (ADR-158).
# Requires: pandoc 3.x + Google Chrome. Override the browser binary with
#   CHROME=/path/to/chromium ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR=build
HTML="$OUT_DIR/manual.html"
PDF="$OUT_DIR/maister-manual-ru.pdf"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

command -v pandoc >/dev/null || { echo "pandoc not found" >&2; exit 1; }
[ -x "$CHROME" ] || { echo "Chrome not found at: $CHROME (set CHROME=...)" >&2; exit 1; }

mkdir -p "$OUT_DIR"

pandoc \
  --standalone \
  --embed-resources \
  --toc --toc-depth=2 \
  --metadata title="MAIster" \
  --metadata subtitle="Руководство пользователя" \
  --metadata date="$(date +%Y-%m-%d)" \
  --metadata lang=ru \
  --metadata toc-title="Содержание" \
  --css style.css \
  -o "$HTML" \
  [0-9][0-9]-*.md

"$CHROME" --headless --disable-gpu \
  --no-pdf-header-footer \
  --print-to-pdf="$PWD/$PDF" \
  "file://$PWD/$HTML" 2>/dev/null

echo "OK: $PDF"
