// CMSG-02 / CMSG-03 / CMSG-04 / CMSG-05 (ADR-225, docs/system-analytics/client-messages.md)
// — enforces that `CLIENT_NAMESPACES` equals the exact minimal cover of every
// client-reachable `useTranslations` literal in the repository, that no
// forbidden client i18n hooks or stray providers exist, and that every path
// resolves in `web/messages/en.json` (RU parity is covered by i18n-parity.test.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CLIENT_NAMESPACES } from "@/i18n/client-namespaces";
import en from "@/messages/en.json";
import {
  minimalCover,
  scanClientNamespaces,
} from "@/test-support/client-namespace-scanner";

const WEB_ROOT = path.resolve(__dirname, "../..");
const SCAN_ROOTS = [
  "app",
  "components",
  "lib",
  "config",
  "hooks",
  "i18n",
  "types",
] as const;
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "coverage",
  "__tests__",
]);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u;

function collectFileMap(): Record<string, string> {
  const fileMap: Record<string, string> = {};

  function walk(dir: string): void {
    let entries: string[];

    try {
      entries = readdirSync(dir);
    } catch (err) {
      // Only an absent optional root (such as `hooks/`) may be skipped silently.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;

      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);

      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) {
        const rel = path.relative(WEB_ROOT, full).replaceAll("\\", "/");

        fileMap[rel] = readFileSync(full, "utf8");
      }
    }
  }

  for (const root of SCAN_ROOTS) walk(path.join(WEB_ROOT, root));

  return fileMap;
}

function pathExistsInCatalog(
  catalog: Record<string, unknown>,
  dotted: string,
): boolean {
  let node: unknown = catalog;

  for (const part of dotted.split(".")) {
    if (
      typeof node !== "object" ||
      node === null ||
      !(part in (node as Record<string, unknown>))
    ) {
      return false;
    }
    node = (node as Record<string, unknown>)[part];
  }

  return node !== undefined;
}

describe("root client i18n namespaces (CMSG-01..05)", () => {
  const scan = scanClientNamespaces(collectFileMap());
  const expected = minimalCover([...scan.literals.keys()]);

  it("CMSG-01 the root layout feeds every NextIntlClientProvider with pickMessages(..., CLIENT_NAMESPACES)", () => {
    expect(scan.rootProviders.length).toBeGreaterThan(0);

    for (const provider of scan.rootProviders) {
      expect(provider).toEqual({
        pickerSource: "@/i18n/pick-messages",
        listSource: "@/i18n/client-namespaces",
      });
    }
  });

  it("CMSG-02 CLIENT_NAMESPACES equals minimalCover(literals) sorted (complete and minimal)", () => {
    const actual: string[] = [...CLIENT_NAMESPACES];
    const actualSet = new Set<string>(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((p) => !actualSet.has(p));
    const extra = actual.filter((p) => !expectedSet.has(p));

    const missingDetails = missing.map((p) => {
      const chain = scan.literals.get(p)?.join(" -> ") ?? "<unknown>";

      return `  + "${p}" (via ${chain})`;
    });
    const extraDetails = extra.map((p) => `  - "${p}"`);
    const message = [
      "CLIENT_NAMESPACES drifted from client-reachable useTranslations literals.",
      ...(missingDetails.length > 0 ? ["Missing:", ...missingDetails] : []),
      ...(extraDetails.length > 0 ? ["Extra:", ...extraDetails] : []),
      "Expected CLIENT_NAMESPACES:",
      JSON.stringify(expected, null, 2),
    ].join("\n");

    expect(actual, message).toEqual(expected);
  });

  it("CMSG-03 and CMSG-05 no forbidden client i18n hooks, indirect imports or stray NextIntlClientProvider", () => {
    expect(scan.violations).toEqual([]);
  });

  it("CMSG-04 every CLIENT_NAMESPACES path resolves in messages/en.json", () => {
    const unresolved = CLIENT_NAMESPACES.filter(
      (p) => !pathExistsInCatalog(en as Record<string, unknown>, p),
    );

    expect(unresolved).toEqual([]);
  });
});
