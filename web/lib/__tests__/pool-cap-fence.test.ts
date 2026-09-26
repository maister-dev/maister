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

  it("the guard sees a bare read (falsifiable)", () => {
    const text = "const cap = capForPool(pool);";

    expect([...text.matchAll(/\bcapForPool\(/g)]).toHaveLength(1);
  });
});
