import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ADR-163 REQ-05: trust resolution is PHYSICALLY separate from launch. The
// order is locate -> establish trust -> execute, and `delegatable-flow.ts` owns
// only the middle step: it answers "may this project launch this flow?" and
// cannot start anything.
//
// "Separate" is asserted as a property of the module's import list rather than
// trusted as a convention, because the failure mode is silent: a later edit that
// reaches for `launchRun` to "just do the launch here too" would compile, pass
// every behavioural test, and quietly delete the guarantee that a refused
// delegation writes no rows.
const here = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(here, "../delegatable-flow.ts");

// Module specifiers whose import would mean this module can start a run.
const FORBIDDEN_IMPORTS = [
  "@/lib/services/runs",
  "@/lib/agents/launch",
  "@/lib/flows/runner",
  "@/lib/flows/graph/runner-graph",
  "@/lib/flows/graph/runner-core",
  "@/lib/scheduler",
];

function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const staticImport = /^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm;
  const bareImport = /^\s*import\s+["']([^"']+)["']/gm;
  const dynamicImport = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

  for (const re of [staticImport, bareImport, dynamicImport]) {
    let m: RegExpExecArray | null;

    while ((m = re.exec(source)) !== null) out.push(m[1]);
  }

  return out;
}

describe("delegatable-flow module isolation (ADR-163 REQ-05)", () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  const specifiers = importSpecifiers(source);

  it.each(FORBIDDEN_IMPORTS)("does not import %s", (forbidden) => {
    expect(specifiers).not.toContain(forbidden);
  });

  // A re-export wrapper (`@/lib/services/anything`) would dodge the exact list
  // above; whole launcher-owning subtrees are forbidden by prefix.
  it.each(["@/lib/services/", "@/lib/agents/"])(
    "imports nothing under %s",
    (prefix) => {
      expect(specifiers.filter((s) => s.startsWith(prefix))).toEqual([]);
    },
  );

  it("imports something (the scan is reading a real module, not an empty file)", () => {
    expect(specifiers.length).toBeGreaterThan(0);
  });
});
