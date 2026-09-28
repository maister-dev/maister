// ADR-183 D-M4: every admission reads the ONE fenced cap, `effectivePoolCap`.
// A bare `capForPool(` anywhere else is an admission the host-pressure fence
// cannot see — the pattern of the `supervisor-client` lint fence: the helper
// is the only door.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WEB_DIR = resolve(__dirname, "../..");
const ROOTS = ["lib", "app", "components", "scripts"];

function sources(dir: string): string[] {
  const found: string[] = [];

  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const path = join(dir, name);

    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
      found.push(path);
  }

  return found;
}

describe("pool cap fence (ADR-183 D-M4)", () => {
  it("no admission reads capForPool outside effectivePoolCap", () => {
    const offenders: string[] = [];

    for (const root of ROOTS) {
      for (const file of sources(join(WEB_DIR, root))) {
        const text = readFileSync(file, "utf8");

        const rel = relative(WEB_DIR, file);
        const helperStart = text.indexOf(
          "export async function effectivePoolCap(",
        );
        const helperEnd =
          helperStart === -1 ? -1 : text.indexOf("\n}\n", helperStart);

        for (const match of text.matchAll(/\bcapForPool\(/g)) {
          const at = match.index ?? 0;
          const isDefinition = text
            .slice(Math.max(0, at - 16), at)
            .endsWith("export function ");
          const insideHelper =
            helperStart !== -1 && at > helperStart && at < helperEnd;

          if (!isDefinition && !insideHelper)
            offenders.push(`${rel}:${text.slice(0, at).split("\n").length}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // ADR-183 D9 (amended 2026-09-28, review R3): the unfenced readers of the
  // raw caps are an explicit, reasoned list. A new reader is an admission the
  // fence cannot see until it is either fenced or added here with its reason.
  it("the raw-cap readers are exactly D9's unfenced list", () => {
    const EXEMPT: Record<string, string> = {
      "lib/scheduler.ts": "the definitions and capForPool itself",
      "lib/scratch-runs/idle-resume.ts":
        "the package-assistant budget; the host's own refusal parks it",
      "lib/run-schedules/dispatch.ts":
        "schedule dispatch; its launch meets the host's refusal",
      "lib/runs/recover.ts":
        "crash recover; its create meets the host's refusal",
      "lib/flows/graph/consensus/capacity.ts":
        "a running flow node's own verify/synthesize sessions, in process",
      "lib/orchestrator/bounds-store.ts": "orchestrator bounds, not admission",
      "app/api/runs/[runId]/rework-claim/claim/route.ts":
        "the ADR-160 rework claim; refused inside the claim transaction",
    };
    const readers = new Set<string>();

    for (const root of ROOTS) {
      for (const file of sources(join(WEB_DIR, root))) {
        const text = readFileSync(file, "utf8");

        if (/\bmaxConcurrent(Runs|AgentRuns|AssistantRuns)Cap\(\)/.test(text))
          readers.add(relative(WEB_DIR, file));
      }
    }

    expect([...readers].sort()).toEqual(Object.keys(EXEMPT).sort());
  });

  it("the guard sees a bare read (falsifiable)", () => {
    const text = "const cap = capForPool(pool);";

    expect([...text.matchAll(/\bcapForPool\(/g)]).toHaveLength(1);
  });
});
