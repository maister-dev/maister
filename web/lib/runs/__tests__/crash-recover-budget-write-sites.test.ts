import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CRASH_RECOVER_BUDGET_RESET } from "../crash-recover";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..", "..", "..");

// ADR-176 D4 — the budget is INTENT-scoped, and that property lives entirely in
// where the reset is applied. `resume_started_at` has three write sites and five
// release sites; two of the release sites are reparks, so chasing releases
// cannot make a fresh intent start from zero while resetting at the WRITE can.
//
// A behavioural test cannot see a FOURTH write site someone adds later — it
// would simply not be covered. This one reads the source, so a new stamp of the
// marker without the reset fails here rather than silently shortening some
// future run's budget.
const WRITE_SITES = ["lib/runs/recover.ts", "lib/scheduler.ts"] as const;

// A STAMP writes a live value into the marker: `resumeStartedAt: at,`. It is
// not a release (`: null`), a type declaration (`: Date | null;`) or a select
// projection (`: runs.resumeStartedAt,`).
const STAMP =
  /resumeStartedAt:\s*(?!null\b)(?!Date\b)(?!runs\.)[A-Za-z_$][\w$]*\s*,/g;

/** The `.set({ ... })` object literal a stamp sits inside. */
function setObjectAfter(source: string, index: number): string {
  const close = source.indexOf("})", index);

  return close === -1 ? source.slice(index) : source.slice(index, close);
}

describe("crash-recover budget reset at every claim-marker write site", () => {
  it("resets both columns", () => {
    expect(CRASH_RECOVER_BUDGET_RESET).toEqual({
      crashRecoverAttempts: 0,
      crashRecoverNextRetryAt: null,
    });
  });

  it.each(WRITE_SITES)(
    "%s stamps the marker only alongside the reset",
    async (file) => {
      const source = await readFile(path.join(WEB_DIR, file), "utf8");
      const stamps = [...source.matchAll(STAMP)];

      expect(
        stamps.length,
        `${file} should still contain claim-marker write sites`,
      ).toBeGreaterThan(0);

      for (const stamp of stamps) {
        // The reset is a spread inside the SAME `.set({...})` object — that
        // is the invariant, not proximity in lines.
        const window = setObjectAfter(source, stamp.index ?? 0);

        expect(
          window,
          `${file}: a \`resumeStartedAt\` stamp near offset ${stamp.index} does not spread CRASH_RECOVER_BUDGET_RESET — ` +
            "a fresh recover intent would inherit the previous intent's spent budget",
        ).toContain("CRASH_RECOVER_BUDGET_RESET");
      }
    },
  );

  it("covers exactly the three write sites the marker contract enumerates", async () => {
    const counted = await Promise.all(
      WRITE_SITES.map(async (file) => {
        const source = await readFile(path.join(WEB_DIR, file), "utf8");

        return [...source.matchAll(STAMP)].length;
      }),
    );

    // `recover.ts` x2 (the queued and the running arms of the recover claim)
    // plus `scheduler.ts` x1 (the Pending -> Running resume promotion).
    expect(counted).toEqual([2, 1]);
  });
});
