import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ADR-121 INV-5: `triage_confidence` is advisory — it MUST NEVER be read by any
// admission / launch / scheduler / routing path. This static guard fails the
// moment a future edit threads confidence into the gate (a behavioral no-effect
// test lives with the admission-selector suite).
const ADMISSION_PATHS = [
  "lib/scheduler.ts",
  "lib/scheduler/handlers/auto-launch-triaged.ts",
  "lib/tasks/admission-selector.ts",
  "lib/runs/launchability.ts",
  "lib/runs/resume.ts",
  "lib/services/hitl.ts",
];

describe("INV-5: triage_confidence is advisory (never read by admission/launch)", () => {
  it("no admission/launch/scheduler module references triage_confidence", () => {
    const scanned: string[] = [];

    for (const rel of ADMISSION_PATHS) {
      const path = resolve(process.cwd(), rel);

      if (!existsSync(path)) continue;
      scanned.push(rel);

      const src = readFileSync(path, "utf8");

      expect(
        /triage_confidence|triageConfidence/.test(src),
        `${rel} must not reference triage_confidence (INV-5)`,
      ).toBe(false);
    }

    // Guard against the list silently going empty (e.g. a path rename).
    expect(scanned.length).toBeGreaterThan(0);
  });
});
