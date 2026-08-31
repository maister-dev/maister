#!/usr/bin/env node
// Validates that each indexed docs directory's README lists every .md file it
// contains. The per-directory READMEs are the CANONICAL file indexes
// (docs/CLAUDE.md holds pointers, not duplicate tables — R7); this gate is
// what keeps them complete, killing the "three rival indexes" drift class.
// Always full-scan (cheap). Exit 2 on failure so a Claude Stop hook can block.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const docsRoot = join(repoRoot, "docs");

// dir (under docs/), recursive?
const INDEXED = [
  ["system-analytics", false],
  ["db", false],
  ["screens", true],
  ["plans", false],
];

function walkMd(dir, recursive) {
  const out = [];
  for (const ent of readdirSync(dir)) {
    if (ent.startsWith(".")) continue;
    const full = join(dir, ent);
    if (statSync(full).isDirectory()) {
      if (recursive) out.push(...walkMd(full, true));
    } else if (ent.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

const failures = [];
let checked = 0;

for (const [dirName, recursive] of INDEXED) {
  const dir = join(docsRoot, dirName);
  const readmePath = join(dir, "README.md");
  let readme;
  try {
    readme = readFileSync(readmePath, "utf8");
  } catch {
    failures.push(`${relative(repoRoot, readmePath)} is missing`);
    continue;
  }
  for (const file of walkMd(dir, recursive)) {
    const rel = relative(dir, file);
    if (rel === "README.md" || rel.endsWith("/README.md")) continue;
    checked += 1;
    if (!readme.includes(`](${rel})`)) {
      failures.push(
        `${relative(repoRoot, file)} is not linked from ${relative(repoRoot, readmePath)}`,
      );
    }
  }
}

if (failures.length === 0) {
  console.log(
    `validate-docs-indexes: ${checked} file(s) indexed across ${INDEXED.length} canonical README(s)`,
  );
  process.exit(0);
}

console.error(`validate-docs-indexes: ${failures.length} unindexed file(s):`);
for (const f of failures) console.error(`  ${f}`);
console.error(
  `\nAdd a row for each file above to its directory README (the canonical index) and re-run \`pnpm validate:docs\`.`,
);
process.exit(2);
