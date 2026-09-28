#!/usr/bin/env node
// Bidirectional coverage gate for a requirement group (generalized from the M51
// gate, plan T0.14 of the librarian release).
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
// A row whose Status is `Implemented` must also cite primary tests that resolve
// to real test titles in the suite. A `Planned` row names the test the owning
// phase will write; resolving it before that phase lands would make the gate red
// by construction during the specification phase.
//
// Usage: node scripts/validate-requirement-coverage.mjs --group m51|librarian
// Exit 2 on failure so a Stop hook can block.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");
const analyticsRoot = join(repoRoot, "docs", "system-analytics");

export const COVERAGE_GROUPS = {
  m51: {
    label: "M51",
    planPath: ".ai-factory/plans/feature-m51-see-everything.md",
    documents: [
      "work-stages.md",
      "attention.md",
      "home-navigation.md",
      "notifications.md",
    ],
    prefixes: ["STG", "ATN", "NAV", "NTF"],
    matrixPath: "docs/system-analytics/m51-traceability.md",
    // Phases 1-7 build things. Phase 0 writes the specifications the
    // requirements live in, and phase 8 reconciles them.
    implementationPhases: /^T[1-7]\./,
    testRoots: ["web"],
  },
  librarian: {
    label: "Librarian",
    planPath: ".ai-factory/plans/claude-peaceful-lamport-84s9c3.md",
    documents: [
      "librarian-conversation.md",
      "librarian-authority.md",
      "librarian-operations.md",
      "task-statements.md",
      "task-clarifications.md",
      "librarian-memory.md",
      "librarian-surface.md",
    ],
    prefixes: ["LCV", "LAU", "LOP", "TST", "CLR", "LMM", "LUI"],
    matrixPath: "docs/system-analytics/librarian-traceability.md",
    // Phase 0 writes the specifications and phase 7 qualifies them.
    implementationPhases: /^T[1-6]\./,
    testRoots: ["web", "supervisor", "mcp"],
  },
};

function markdownSection(content, title) {
  const match = content.match(
    new RegExp(`^## ${title}[ \\t]*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"),
  );
  return match?.[1] ?? null;
}

export function declaredIds(documentSources, prefixes) {
  const ids = [];
  const group = prefixes.join("|");

  for (const content of documentSources) {
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
  return ids;
}

export function matrixRows(src, prefixes) {
  const rows = new Map();
  const rowRe = new RegExp(
    `^\\|\\s*((?:EDGE-)?(?:${prefixes.join("|")})-\\d{2})\\s*\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|\\s*$`,
    "gm",
  );

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

// Tier-agnostic on purpose: UT / IT / E2E / CT / QL and their `-EDGE`
// variants, so a tier this pattern did not anticipate is caught rather than
// silently skipped.
export function testIdPattern(prefixes) {
  return new RegExp(
    `[A-Z][A-Z0-9]*(?:-EDGE)?-(?:${prefixes.join("|")})-\\d{2}`,
    "g",
  );
}

// A test id mentioned in a header COMMENT is not a test — scan only the TITLES
// of `describe` / `it` / `test`, which is what "resolves to a real test" means.
const TEST_TITLE_RE =
  /\b(?:describe|it|test)(?:\.\w+)?\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

export function testIdsInSource(src, prefixes) {
  const found = new Set();
  const idRe = testIdPattern(prefixes);

  for (const title of src.matchAll(TEST_TITLE_RE)) {
    for (const id of title[2].matchAll(idRe)) found.add(id[0]);
  }
  return found;
}

function suiteTestIds(roots, prefixes) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".next" ||
        entry.name === "dist"
      ) {
        continue;
      }
      const full = join(dir, entry.name);

      if (entry.isDirectory()) walk(full);
      else if (/\.(test|spec)\.(m?[jt]sx?)$/.test(entry.name)) {
        for (const id of testIdsInSource(readFileSync(full, "utf8"), prefixes)) {
          found.add(id);
        }
      }
    }
  };
  for (const root of roots) {
    const dir = join(repoRoot, root);
    if (existsSync(dir)) walk(dir);
  }
  return found;
}

export function planTaskIds(src) {
  // Task definitions only — the bold header that opens a task body. Prose
  // cross-references elsewhere in the plan must not be mistaken for one.
  return [...src.matchAll(/\*\*(T\d+\.\d+)\s*\[[ x]\]\s*—/g)].map((m) => m[1]);
}

// Pure: every input is supplied, so fixtures exercise it without the repo.
export function evaluateCoverage({
  ids,
  rows,
  tasks,
  suiteIds,
  prefixes,
  implementationPhases,
}) {
  const failures = [];
  const idRe = testIdPattern(prefixes);

  for (const id of ids) {
    const row = rows.get(id);
    if (!row) {
      failures.push(
        `${id}: declared in a requirement document but absent from the matrix`,
      );
      continue;
    }
    if (row.tasks.length === 0) {
      failures.push(`${id}: matrix row names no enforcing task`);
    }
    if (row.primaryTest.length === 0) {
      failures.push(`${id}: matrix row names no primary test`);
    }
    if (row.status === "Implemented") {
      for (const cited of row.primaryTest.match(idRe) ?? []) {
        if (!suiteIds.has(cited)) {
          failures.push(
            `${id}: primary test ${cited} resolves to no test in the suite — ` +
              `rename the test to carry the id, or cite the id the suite actually has`,
          );
        }
      }
    }
  }

  const declared = new Set(ids);
  for (const id of rows.keys()) {
    if (!declared.has(id)) {
      failures.push(`${id}: matrix row for an id no requirement document declares`);
    }
  }

  const named = new Set([...rows.values()].flatMap((row) => row.tasks));
  for (const task of tasks) {
    if (implementationPhases.test(task) && !named.has(task)) {
      failures.push(`${task}: implementation task named by no requirement row`);
    }
  }
  const defined = new Set(tasks);
  for (const [id, row] of rows) {
    for (const task of row.tasks) {
      if (!defined.has(task)) {
        failures.push(`${id}: names task ${task}, which the plan does not define`);
      }
    }
  }

  return failures;
}

export function checkGroupCoverage(group) {
  const failures = [];
  const sources = [];

  for (const name of group.documents) {
    const file = join(analyticsRoot, name);
    if (!existsSync(file)) {
      failures.push(`docs/system-analytics/${name}: missing owning document`);
      continue;
    }
    sources.push(readFileSync(file, "utf8"));
  }
  const ids = declaredIds(sources, group.prefixes);

  const matrixFile = join(repoRoot, group.matrixPath);
  if (!existsSync(matrixFile)) {
    failures.push(`${group.matrixPath}: missing matrix`);
    return { failures, ids, rows: new Map(), tasks: [], suiteIds: new Set() };
  }
  const rows = matrixRows(readFileSync(matrixFile, "utf8"), group.prefixes);

  const planFile = join(repoRoot, group.planPath);
  if (!existsSync(planFile)) {
    failures.push(
      `${group.planPath}: missing plan file — the backward direction is unprovable`,
    );
    return { failures, ids, rows, tasks: [], suiteIds: new Set() };
  }
  const tasks = planTaskIds(readFileSync(planFile, "utf8"));
  const suiteIds = suiteTestIds(group.testRoots, group.prefixes);

  failures.push(
    ...evaluateCoverage({
      ids,
      rows,
      tasks,
      suiteIds,
      prefixes: group.prefixes,
      implementationPhases: group.implementationPhases,
    }),
  );
  return { failures, ids, rows, tasks, suiteIds };
}

function main(argv) {
  const index = argv.indexOf("--group");
  const name = index === -1 ? undefined : argv[index + 1];
  const group = name ? COVERAGE_GROUPS[name] : undefined;

  if (!group) {
    console.error(
      `validate-requirement-coverage: --group must be one of ${Object.keys(COVERAGE_GROUPS).join(", ")}`,
    );
    return 2;
  }

  const { failures, ids, rows, tasks, suiteIds } = checkGroupCoverage(group);
  if (failures.length > 0) {
    console.error(
      `validate-requirement-coverage [${group.label}]: ${failures.length} coverage failure(s):`,
    );
    for (const f of failures) console.error(`  ${f}`);
    return 2;
  }

  console.log(
    `validate-requirement-coverage [${group.label}]: ${ids.length} requirement id(s) across ` +
      `${group.documents.length} document(s); ${rows.size} matrix row(s); ` +
      `${tasks.filter((t) => group.implementationPhases.test(t)).length} implementation task(s); ` +
      `${suiteIds.size} test id(s) in the suite — bidirectional coverage holds and every ` +
      `implemented primary test resolves`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
