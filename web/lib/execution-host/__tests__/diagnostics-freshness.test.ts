// DIAG-11 (ADR-224, docs/system-analytics/host-diagnostics.md) — static
// enforcement of web diagnostics freshness classes. Every call site in `app/`,
// `lib/`, and `components/` MUST be declared in `FRESHNESS_CLASSES` below:
// `fresh` callers MUST pass `{ refresh: true }` (or call
// `getFreshPlatformDiagnostics`), and `snapshot` callers MUST NOT. Any new
// call site fails this test until its freshness class is explicitly chosen.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

type FreshnessClass = "fresh" | "snapshot";

const WEB_ROOT = resolve(process.cwd());
const SCAN_ROOTS = ["app", "lib", "components"] as const;

// Canonical freshness table matching D1 / host-diagnostics.md.
// Wrapper, type and transport files are infrastructure, not callers: they
// define or forward `diagnostics` without choosing a freshness class.
const INFRA_FILES = new Set([
  "lib/execution-host/platform-status.ts",
  "lib/execution-host/contracts.ts",
  "lib/execution-host/index.ts",
  "lib/execution-host/transports/local-direct.ts",
  "lib/supervisor-client.ts",
]);

const FRESHNESS_CLASSES: Record<string, FreshnessClass> = {
  "app/(app)/layout.tsx": "snapshot",
  "lib/mcp/readiness-host.ts": "snapshot",
  "app/(app)/settings/page.tsx": "fresh",
  "app/api/admin/acp-runners/route.ts": "fresh",
  "app/api/admin/acp-runners/[runnerId]/route.ts": "fresh",
  "lib/agents/company-agent-launch.ts": "fresh",
  "lib/agents/company-flow-launch.ts": "fresh",
  "lib/agents/launch.ts": "fresh",
  "lib/execution-host/client.ts": "fresh",
  "lib/execution-host/owned-session-create.ts": "fresh",
  "lib/flows/graph/runner-graph.ts": "fresh",
  "lib/services/runs.ts": "fresh",
};

// Calls that forward a caller's options instead of choosing a class themselves.
const FORWARDING_CALLS = new Set([
  "lib/execution-host/client.ts:.diagnostics(opts)",
]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "__tests__" ||
      entry.name === ".next"
    ) {
      continue;
    }
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }

  return out;
}

type CallSite = {
  file: string;
  calls: string[];
};

const CALL_PATTERN =
  /(?:\.diagnostics\([^)]*\)|checkSupervisorDiagnostics\([^)]*\)|get(?:Fresh)?PlatformDiagnostics\([^)]*\))/g;

const isFreshCall = (call: string): boolean =>
  call.startsWith("getFreshPlatformDiagnostics(") ||
  /refresh\s*:\s*true/.test(call);

function scanDiagnosticsCalls(): CallSite[] {
  const sites: CallSite[] = [];

  for (const root of SCAN_ROOTS) {
    for (const filePath of walkTsFiles(join(WEB_ROOT, root))) {
      const rel = relative(WEB_ROOT, filePath).replaceAll("\\", "/");

      if (INFRA_FILES.has(rel)) continue;
      const content = readFileSync(filePath, "utf8");
      const matches = [...content.matchAll(CALL_PATTERN)].map((m) => m[0]);

      if (matches.length > 0) {
        sites.push({ file: rel, calls: matches });
      }
    }
  }

  return sites.sort((a, b) => a.file.localeCompare(b.file));
}

describe("diagnostics freshness classes (DIAG-11)", () => {
  it("DIAG-11 every production diagnostics caller is classified and obeys its freshness class", () => {
    const sites = scanDiagnosticsCalls();
    const foundFiles = sites.map((s) => s.file);
    const expectedFiles = Object.keys(FRESHNESS_CLASSES).sort();

    // Exact bijection: no unlisted caller, no stale entry.
    expect(foundFiles).toEqual(expectedFiles);

    for (const site of sites) {
      const cls = FRESHNESS_CLASSES[site.file];

      for (const call of site.calls) {
        if (FORWARDING_CALLS.has(`${site.file}:${call}`)) continue;

        expect(
          isFreshCall(call),
          `${site.file} is ${cls}-class but called "${call}" ${
            cls === "fresh" ? "without" : "with"
          } refresh: true`,
        ).toBe(cls === "fresh");
      }
    }
  });
});
