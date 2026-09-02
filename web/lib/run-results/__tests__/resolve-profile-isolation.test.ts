import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ADR-165 AC-21 / spec C-5.5. `resolveResultProfile` is called from all THREE
// child-creation edges. A launcher import would make that structurally
// impossible without a cycle — and the pressure to avoid the cycle is exactly
// what produces a second, edge-local copy of the resolution rule, which is how
// one edge quietly stops enforcing the allow-list.
//
// Asserted on the SOURCE rather than by importing the module: an import-graph
// check that ran the module would pass on a lazily-`await import`ed launcher,
// which is the same defect wearing a disguise.

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, "../resolve-profile.ts"), "utf8");

const FORBIDDEN = [
  "@/lib/services/runs",
  "@/lib/agents/launch",
  "@/lib/flows/runner",
  "@/lib/scheduler",
];

describe("resolve-profile module isolation (AC-21)", () => {
  it.each(FORBIDDEN)("imports nothing from %s, statically or lazily", (mod) => {
    expect(SOURCE).not.toContain(mod);
  });

  it("the guard is real: it would catch an added launcher import", () => {
    const mutated = `${SOURCE}\nimport { launchRun } from "@/lib/services/runs";`;

    expect(FORBIDDEN.some((m) => mutated.includes(m))).toBe(true);
  });

  it("does import the things it legitimately needs", () => {
    expect(SOURCE).toContain("@/lib/run-results/contract");
    expect(SOURCE).toContain("@/lib/db/schema");
  });
});
