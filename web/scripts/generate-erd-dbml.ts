// Generates docs/db/erd.dbml — the consolidated database ERD — from the two
// Drizzle schema lineages (ADR-159). The committed file is a build artifact:
// never hand-edit it; regenerate with `pnpm --filter maister-web db:erd`.
// `--check` regenerates in memory and fails (exit 2) when the committed file
// drifted — wired into the root `pnpm validate:docs` gate.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Parser } from "@dbml/core";
import { pgGenerate } from "drizzle-dbml-generator";

import * as brainSchema from "@/lib/brain/schema";
import * as mainSchema from "@/lib/db/schema";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../docs/db/erd.dbml");
const wantCheck = process.argv.slice(2).includes("--check");

const HEADER = `// GENERATED FILE — do not edit by hand (ADR-159).
// Source of truth: web/lib/db/schema.ts (main lineage) + web/lib/brain/schema.ts (Brain lineage).
// Regenerate: pnpm --filter maister-web db:erd
// Drift gate:  pnpm --filter maister-web db:erd --check (part of pnpm validate:docs)
// View: import into https://dbdiagram.io or any DBML renderer.

`;

// Alias exports (`export const scratchMessages = runMessages`) would make
// pgGenerate emit the same table twice — keep the first export per object.
function dedupeByIdentity(
  entries: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new Set<unknown>();

  for (const [key, value] of Object.entries(entries)) {
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) continue;
      seen.add(value);
    }
    out[key] = value;
  }

  return out;
}

// A column-level `.references()` plus an explicit `foreignKey()` on the same
// columns yields two refs with identical endpoints — DBML renderers refuse
// that (@dbml/core code 5001). Keep the first ref per endpoint signature.
function dedupeRefs(dbml: string): string {
  const seen = new Set<string>();

  return dbml
    .split("\n")
    .filter((line) => {
      const match = /^ref(?:\s+\w+)?:\s*(.+?)(?:\s*\[.*\])?\s*$/i.exec(line);

      if (!match) return true;

      const signature = match[1].replaceAll(/\s+/g, "");

      if (seen.has(signature)) return false;
      seen.add(signature);

      return true;
    })
    .join("\n");
}

// Drizzle expression indexes (e.g. the ADR-151 agent-summon partial unique
// over `payload->>'…'` expressions) flatten to their base column repeated —
// `(task_id, payload, payload)` — which DBML refuses. Collapse repeats inside
// each index tuple; the exact expressions stay documented by the migrations.
function dedupeIndexColumns(dbml: string): string {
  let inIndexes = false;

  return dbml
    .split("\n")
    .map((line) => {
      if (/^\s*indexes\s*\{\s*$/.test(line)) {
        inIndexes = true;

        return line;
      }
      if (inIndexes && /^\s*\}\s*$/.test(line)) {
        inIndexes = false;

        return line;
      }
      if (!inIndexes) return line;

      const match = /^(\s*)\(([^)]*)\)(.*)$/.exec(line);

      if (!match) return line;

      const cols = [...new Set(match[2].split(",").map((col) => col.trim()))];

      return `${match[1]}(${cols.join(", ")})${match[3]}`;
    })
    .join("\n");
}

function generate(): string {
  const overlap = Object.keys(mainSchema).filter(
    (key) => key in (brainSchema as Record<string, unknown>),
  );

  if (overlap.length > 0) {
    throw new Error(
      `main/brain schema export collision (rename before merging): ${overlap.join(", ")}`,
    );
  }

  const dbml = dedupeIndexColumns(
    dedupeRefs(
      pgGenerate({
        schema: dedupeByIdentity({ ...mainSchema, ...brainSchema }),
      }),
    ),
  );

  // Refuse to emit DBML that renderers cannot parse — the exact failure mode
  // the old hand-maintained mermaid ERD died of. On failure, dump the raw
  // output next to the target so the offending line numbers are inspectable.
  try {
    Parser.parse(dbml, "dbmlv2");
  } catch (err) {
    const dumpPath = `${outPath}.rejected`;

    writeFileSync(dumpPath, dbml);
    console.error(
      `generate-erd-dbml: generated DBML failed to parse; raw output dumped to ${dumpPath}`,
    );
    throw err;
  }

  return HEADER + dbml.trimEnd() + "\n";
}

function main(): void {
  const next = generate();
  const tableCount = (next.match(/^table /gm) ?? []).length;

  if (wantCheck) {
    let current: string;

    try {
      current = readFileSync(outPath, "utf8");
    } catch {
      console.error(
        `generate-erd-dbml --check: ${outPath} is missing. Run \`pnpm --filter maister-web db:erd\` and commit the result.`,
      );
      process.exit(2);
    }

    if (current !== next) {
      console.error(
        `generate-erd-dbml --check: docs/db/erd.dbml drifted from the Drizzle schemas ` +
          `(${tableCount} tables expected). Run \`pnpm --filter maister-web db:erd\` and commit the result.`,
      );
      process.exit(2);
    }

    console.log(
      `generate-erd-dbml --check: docs/db/erd.dbml is current (${tableCount} tables)`,
    );

    return;
  }

  writeFileSync(outPath, next);
  console.log(`generate-erd-dbml: wrote ${outPath} (${tableCount} tables)`);
}

main();
