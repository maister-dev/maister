#!/usr/bin/env node
// Bidirectional coverage gate for the M51 requirement set (plan task T0.12).
//
// The docs validator already proves every declared requirement has a traceability
// row with a primary test. That is one direction. This script closes the other:
//
//   forward  — every requirement/edge id names at least one enforcing task;
//   backward — every implementation task defined by the plan is named by at
//              least one requirement row.
//
// An orphan on either side is a planning defect: a requirement nothing builds,
// or a task that answers to no contract.
//
// Exit 2 on failure so a Stop hook can block.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const analyticsRoot = join(repoRoot, "docs", "system-analytics");
const matrixPath = join(analyticsRoot, "m51-traceability.md");
const planPath = join(
  repoRoot,
  ".ai-factory",
  "plans",
  "feature-m51-see-everything.md",
);

const DOCUMENTS = [
  "work-stages.md",
  "attention.md",
  "home-navigation.md",
  "notifications.md",
];
const PREFIXES = ["STG", "ATN", "NAV", "NTF"];

// Phases 1-7 build things. Phase 0 writes the specifications the requirements
// live in, and phase 8 reconciles them, so neither owns a requirement row.
const IMPLEMENTATION_PHASES = /^T[1-7]\./;

function markdownSection(content, title) {
  const match = content.match(
    new RegExp(`^## ${title}[ \\t]*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"),
  );
  return match?.[1] ?? null;
}

function declaredIds() {
  const ids = [];
  const failures = [];
  const group = PREFIXES.join("|");

  for (const name of DOCUMENTS) {
    const file = join(analyticsRoot, name);
    if (!existsSync(file)) {
      failures.push(`docs/system-analytics/${name}: missing owning document`);
      continue;
    }
    const content = readFileSync(file, "utf8");
    const expectations = markdownSection(content, "Expectations") ?? "";
    const edges = markdownSection(content, "Edge cases") ?? "";

    for (const m of expectations.matchAll(
      new RegExp(`^[ \\t]*- \\*\\*((?:${group})-\\d{2}):\\*\\*`, "gm"),
    )) {
      ids.push(m[1]);
    }
    for (const m of edges.matchAll(
      new RegExp(`\\*\\*(EDGE-(?:${group})-\\d{2}):\\*\\*`, "g"),
    )) {
      ids.push(m[1]);
    }
  }
  return { ids, failures };
}

function matrixRows() {
  if (!existsSync(matrixPath)) return null;
  const rows = new Map();
  const src = readFileSync(matrixPath, "utf8");
  const rowRe = /^\|\s*((?:EDGE-)?(?:STG|ATN|NAV|NTF)-\d{2})\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/gm;

  for (const m of src.matchAll(rowRe)) {
    rows.set(m[1], {
      contract: m[2].trim(),
      tasks: [...m[3].matchAll(/T\d+\.\d+/g)].map((t) => t[0]),
      primaryTest: m[4].trim(),
      status: m[5].trim(),
    });
  }
  return rows;
}

function planTaskIds() {
  if (!existsSync(planPath)) return null;
  const src = readFileSync(planPath, "utf8");
  // Task definitions only — the bold header that opens a task body. Prose
  // cross-references elsewhere in the plan must not be mistaken for one.
  return [...src.matchAll(/\*\*(T\d+\.\d+)\s*\[[ x]\]\s*—/g)].map((m) => m[1]);
}

const failures = [];
const { ids, failures: docFailures } = declaredIds();
failures.push(...docFailures);

const rows = matrixRows();
if (rows === null) {
  failures.push("docs/system-analytics/m51-traceability.md: missing matrix");
}

const tasks = planTaskIds();
if (tasks === null) {
  failures.push(`${planPath}: missing plan file — the backward direction is unprovable`);
}

if (rows !== null) {
  // Forward: a requirement nothing builds.
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) {
      failures.push(`${id}: declared in a requirement document but absent from the matrix`);
      continue;
    }
    if (row.tasks.length === 0) {
      failures.push(`${id}: matrix row names no enforcing task`);
    }
    if (row.primaryTest.length === 0) {
      failures.push(`${id}: matrix row names no primary test`);
    }
  }

  // A matrix row for an id no document declares is equally an orphan.
  const declared = new Set(ids);
  for (const id of rows.keys()) {
    if (!declared.has(id)) {
      failures.push(`${id}: matrix row for an id no requirement document declares`);
    }
  }

  // Backward: a task that answers to no contract.
  if (tasks !== null) {
    const named = new Set([...rows.values()].flatMap((row) => row.tasks));
    for (const task of tasks) {
      if (IMPLEMENTATION_PHASES.test(task) && !named.has(task)) {
        failures.push(`${task}: implementation task named by no requirement row`);
      }
    }
    // A matrix cell naming a task the plan does not define is a stale reference.
    const defined = new Set(tasks);
    for (const [id, row] of rows) {
      for (const task of row.tasks) {
        if (!defined.has(task)) {
          failures.push(`${id}: names task ${task}, which the plan does not define`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`validate-m51-coverage: ${failures.length} coverage failure(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(2);
}

console.log(
  `validate-m51-coverage: ${ids.length} requirement id(s) across ${DOCUMENTS.length} document(s); ` +
    `${rows.size} matrix row(s); ${tasks.filter((t) => IMPLEMENTATION_PHASES.test(t)).length} ` +
    `implementation task(s) — bidirectional coverage holds`,
);
