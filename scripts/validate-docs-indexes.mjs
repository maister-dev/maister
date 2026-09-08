#!/usr/bin/env node
// Validates canonical documentation indexes and the Stage B execution-data
// specifications. Requirement IDs, expectation caps, linked artifacts, and
// primary test ownership are documentation contracts, not optional prose.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");
export const docsRoot = join(repoRoot, "docs");

const INDEXED = [
  ["system-analytics", false],
  ["db", false],
  ["screens", true],
  ["plans", false],
];

const STAGE_B_DOCUMENTS = [
  "execution-event-plane.md",
  "execution-prompt-lifecycle.md",
  "execution-runtime-objects.md",
  "execution-data-cutover.md",
];

const R5_SECTIONS = [
  "Purpose",
  "Domain entities",
  "State machine",
  "Process flows",
  "Expectations",
  "Edge cases",
  "Linked artifacts",
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

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markdownSection(content, title) {
  const match = content.match(
    new RegExp(
      `^## ${escapedRegex(title)}[ \\t]*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
      "m",
    ),
  );
  return match?.[1] ?? null;
}

function requirementIds(section) {
  return [...section.matchAll(/^[ \t]*- \*\*((?:EVT|PRM|OBJ|CUT)-\d{2}):\*\*/gm)].map(
    (match) => match[1],
  );
}

function edgeIds(section) {
  return [...section.matchAll(/\*\*(EDGE-(?:EVT|PRM|OBJ|CUT)-\d{2}):\*\*/g)].map(
    (match) => match[1],
  );
}

function linkedArtifacts(content, file) {
  const linked = markdownSection(content, "Linked artifacts");
  if (linked === null) return [`${file}: missing Linked artifacts section`];

  const failures = [];
  for (const match of linked.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (!existsSync(resolve(dirname(file), target))) {
      failures.push(`${file}: broken linked artifact ${target}`);
    }
  }
  return failures;
}

export function validateStageBAnalytics(analyticsRoot) {
  const failures = [];
  const allRequirementIds = [];
  const allEdgeIds = [];

  for (const name of STAGE_B_DOCUMENTS) {
    const file = join(analyticsRoot, name);
    if (!existsSync(file)) {
      failures.push(`${file}: missing Stage B analytics document`);
      continue;
    }

    const content = readFileSync(file, "utf8");
    for (const section of R5_SECTIONS) {
      if (markdownSection(content, section) === null) {
        failures.push(`${file}: missing R5 section ${section}`);
      }
    }

    const expectations = markdownSection(content, "Expectations");
    if (expectations !== null) {
      const count = expectations.match(/^[ \t]*- /gm)?.length ?? 0;
      if (count > 12) {
        failures.push(`${file}: Expectations has ${count} bullets; maximum is 12`);
      }
      allRequirementIds.push(...requirementIds(expectations));
    }

    const edgeCases = markdownSection(content, "Edge cases");
    if (edgeCases !== null) allEdgeIds.push(...edgeIds(edgeCases));
    failures.push(...linkedArtifacts(content, file));
  }

  const allIds = [...allRequirementIds, ...allEdgeIds];
  for (const id of allIds) {
    if (allIds.filter((candidate) => candidate === id).length > 1) {
      failures.push(`duplicate Stage B requirement ID ${id}`);
    }
  }

  const traceabilityPath = join(analyticsRoot, "execution-data-cutover.md");
  const traceability = existsSync(traceabilityPath)
    ? readFileSync(traceabilityPath, "utf8")
    : "";
  for (const id of allIds) {
    const row = new RegExp(
      `^\\|\\s*${escapedRegex(id)}\\s*\\|[^|]+\\|[^|]+\\|([^|]+)\\|[^|]+\\|\\s*$`,
      "m",
    ).exec(traceability);
    if (!row || row[1].trim().length === 0) {
      failures.push(`${id}: missing traceability row with primary test`);
    }
  }

  return failures;
}

export function validateDocsIndexes(root = docsRoot) {
  const failures = [];
  let checked = 0;

  for (const [dirName, recursive] of INDEXED) {
    const dir = join(root, dirName);
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

  failures.push(...validateStageBAnalytics(join(root, "system-analytics")));
  return { checked, failures };
}

function main() {
  const { checked, failures } = validateDocsIndexes();
  if (failures.length === 0) {
    console.log(
      `validate-docs-indexes: ${checked} file(s) indexed across ${INDEXED.length} canonical README(s)`,
    );
    return 0;
  }

  console.error(`validate-docs-indexes: ${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
