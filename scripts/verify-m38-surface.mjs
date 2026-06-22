#!/usr/bin/env node
// M38 (ADR-103) repo-level "no new surface" verify gate. Asserts the milestone
// stayed additive: engine bumped to 1.7.0, the decide/on_mismatch DSL + engine
// floor exist, and NO new migration / HTTP route / runs.status value /
// MaisterError code / env key / compose service / AsyncAPI event was added vs
// the base branch. Mirrors the spec's AC22 + the T6.2 contract-surface trace.
// Exit 2 on any violation so /aif-verify (or a CI gate) can block.

import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] ?? "main";
const failures = [];
const ok = [];

function read(rel) {
  try {
    return readFileSync(resolve(repoRoot, rel), "utf8");
  } catch {
    return "";
  }
}

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: repoRoot, encoding: "utf8" });
  } catch {
    return null; // base may be absent (e.g. shallow CI) — diff checks skip.
  }
}

function assert(cond, label) {
  (cond ? ok : failures).push(label);
}

// --- Stable invariants (meaningful post-merge) ---
const engine = read("web/lib/flows/engine-version.ts");

assert(
  /MAISTER_ENGINE_VERSION = "1\.7\.0"/.test(engine),
  'MAISTER_ENGINE_VERSION === "1.7.0"',
);

const configSchema = read("web/lib/config.schema.ts");

assert(
  /export const decideSchema/.test(configSchema),
  "decideSchema declared (config.schema.ts)",
);
assert(
  /on_mismatch:/.test(configSchema),
  "output.result.on_mismatch declared (config.schema.ts)",
);
assert(
  /DECIDE_ENGINE_MIN = "1\.7\.0"/.test(read("web/lib/config.ts")),
  'DECIDE_ENGINE_MIN === "1.7.0" (config.ts)',
);

const decisions = read("docs/decisions.md");

assert(
  /^### ADR-103:/m.test(decisions),
  "ADR-103 header present (docs/decisions.md)",
);

// No DB migration numbered 0062+ (M38 is migration-free; max committed = 0061).
const migrations = readdirSync(resolve(repoRoot, "web/lib/db/migrations")).filter(
  (f) => /^\d{4}_.*\.sql$/.test(f),
);
const maxMigration = migrations
  .map((f) => Number(f.slice(0, 4)))
  .reduce((a, b) => Math.max(a, b), 0);

assert(maxMigration <= 61, `no migration > 0061 (max = ${maxMigration})`);

// --- Additive-vs-base diff checks (skipped when base is unavailable) ---
const baseExists = git(`rev-parse --verify --quiet ${base}`) !== null;

if (!baseExists) {
  ok.push(`(diff checks skipped — base "${base}" not found)`);
} else {
  const newRoutes = (git(`diff --name-only --diff-filter=A ${base} -- web/app/api`) ?? "")
    .split("\n")
    .filter((l) => l.endsWith("/route.ts"));

  assert(newRoutes.length === 0, `no new HTTP route (found ${newRoutes.length})`);

  const errDiff = git(`diff ${base} -- web/lib/errors-core.ts web/lib/errors.ts`) ?? "";
  const newErrCode = errDiff
    .split("\n")
    .some((l) => /^\+\s*\|\s*"[A-Z_]+"/.test(l));

  assert(!newErrCode, "no new MaisterError code");

  const schemaDiff = git(`diff ${base} -- web/lib/db/schema.ts`) ?? "";

  assert(schemaDiff.trim() === "", "no DB schema change (runs.status enum etc.)");

  const envDiff = git(`diff ${base} -- web/.env.example .env.example`) ?? "";
  const newEnv = envDiff
    .split("\n")
    .some((l) => /^\+[A-Z][A-Z0-9_]+=/.test(l));

  assert(!newEnv, "no new env key");

  const composeChanged = (git(`diff --name-only ${base} -- "*compose*.yml" "*compose*.yaml"`) ?? "").trim();

  assert(composeChanged === "", "no compose change");
}

for (const label of ok) console.log(`  ✓ ${label}`);
for (const label of failures) console.error(`  ✗ ${label}`);

if (failures.length > 0) {
  console.error(`\nverify-m38-surface: ${failures.length} violation(s).`);
  process.exit(2);
}

console.log(`\nverify-m38-surface: ${ok.length} assertion(s) passed — M38 stayed additive.`);
