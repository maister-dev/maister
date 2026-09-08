import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  filesystemOwnershipInventory,
  filesystemWrapperInventory,
  pathGenericWrappers,
  type FilesystemOwnershipEntry,
} from "./fixtures/runtime-data-boundary-inventory";

import {
  callsiteKey,
  scanFilesystemOwnership,
  type FilesystemCallsite,
  type FilesystemScan,
} from "@/test-support/filesystem-ownership";

// D10 / AB-16 (supplementary static guard): every filesystem, child-process
// and SQLite CALLSITE in the production roots — plus every call of a
// path-generic wrapper — must carry an operation-scoped ownership entry. A
// file-level exemption no longer exists, so a new host-runtime read added to
// an already classified file fails here. The real boundary proof is the
// denied-root harness in `test-support/__tests__/execution-ab-isolation`.

const WEB_DIR = resolve(__dirname, "../../..");
const SCAN_TIMEOUT_MS = 180_000;

const inventoryByKey = new Map<string, FilesystemOwnershipEntry>(
  filesystemOwnershipInventory.map((entry) => [callsiteKey(entry), entry]),
);

function scan(overrides?: ReadonlyMap<string, string>): FilesystemScan {
  return scanFilesystemOwnership({
    webDir: WEB_DIR,
    pathGenericWrappers,
    overrides,
  });
}

function describeSite(site: FilesystemCallsite): string {
  return `${site.source}:${site.line} ${site.enclosing} → ${site.callee} (${site.operation}${site.command ? ` ${site.command}` : ""})`;
}

// Callsites without an entry, rendered as the tuple a maintainer must add.
function unclassified(result: FilesystemScan): string[] {
  return result.callsites
    .filter((site) => !inventoryByKey.has(callsiteKey(site)))
    .map(describeSite)
    .sort();
}

// The injected function is appended, so its call is the LAST occurrence.
function lineOf(text: string, needle: string): number {
  const lines = text.split("\n");
  const index = lines.map((line) => line.includes(needle)).lastIndexOf(true);

  if (index < 0) throw new Error(`mutation text lacks ${needle}`);

  return index + 1;
}

let baseline: FilesystemScan | undefined;

function baselineScan(): FilesystemScan {
  baseline ??= scan();

  return baseline;
}

describe("D10 operation-scoped filesystem ownership", () => {
  it(
    "classifies every production callsite exactly once and keeps no stale entry",
    () => {
      const result = baselineScan();
      const liveKeys = new Set(result.callsites.map(callsiteKey));
      const stale = filesystemOwnershipInventory
        .map(callsiteKey)
        .filter((key) => !liveKeys.has(key))
        .sort();
      const duplicates = filesystemOwnershipInventory
        .map(callsiteKey)
        .filter((key, index, all) => all.indexOf(key) !== index);

      expect(unclassified(result)).toEqual([]);
      expect(stale).toEqual([]);
      expect(duplicates).toEqual([]);
      expect(result.callsites.length).toBeGreaterThan(300);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "lists every exported filesystem wrapper with an ownership class and a path-generic decision",
    () => {
      const result = baselineScan();
      const detected = new Set<string>();

      for (const [module, names] of result.wrappers) {
        for (const name of names) detected.add(`${module}#${name}`);
      }
      const listed = new Set(
        filesystemWrapperInventory.map((entry) => entry.wrapper),
      );

      expect(
        [...detected].filter((wrapper) => !listed.has(wrapper)).sort(),
      ).toEqual([]);
      expect(
        [...listed].filter((wrapper) => !detected.has(wrapper)).sort(),
      ).toEqual([]);
      expect(pathGenericWrappers.size).toBeGreaterThan(20);
      expect(pathGenericWrappers.has("lib/atomic.ts#atomicWriteJson")).toBe(
        true,
      );
    },
    SCAN_TIMEOUT_MS,
  );

  it("never grants the web supervisor-runtime ownership or a watch operation", () => {
    const hostRuntime = filesystemOwnershipInventory.filter(
      (entry) => entry.class === "supervisor-runtime",
    );
    const watches = baselineScan().callsites.filter(
      (site) => site.operation === "watch",
    );

    expect(hostRuntime).toEqual([]);
    expect(watches.map(describeSite)).toEqual([]);
  });

  it("requires an explicit classification for every unresolved use", () => {
    const unresolved = baselineScan().callsites.filter(
      (site) => site.operation === "unresolved",
    );

    for (const site of unresolved) {
      const entry = inventoryByKey.get(callsiteKey(site));

      expect(entry, describeSite(site)).toBeDefined();
      expect(entry?.rationale.length ?? 0).toBeGreaterThan(20);
    }
    expect(unresolved.length).toBeGreaterThan(0);
  });

  it("gives migration-only and operator-import access an explicit authority and lifetime", () => {
    const gated = filesystemOwnershipInventory.filter(
      (entry) =>
        entry.class === "migration-tooling" ||
        entry.class === "operator-import",
    );

    expect(gated.length).toBeGreaterThan(0);
    for (const entry of gated) {
      expect(entry.authority, callsiteKey(entry)).toMatch(/operator CLI/);
      expect(entry.lifetime, callsiteKey(entry)).toBeTruthy();
    }
    expect(
      gated.some(
        (entry) =>
          entry.source === "scripts/import-legacy-execution-data-plane.ts",
      ),
    ).toBe(true);
  });

  it("identifies test sources by role instead of dropping them", () => {
    const roles = baselineScan().roles;
    const production = [...roles.values()].filter(
      (role) => role === "production",
    ).length;
    const test = [...roles.values()].filter((role) => role === "test").length;

    expect(production).toBeGreaterThan(1000);
    expect(test).toBeGreaterThan(1000);
    expect(roles.get("test-support/real-supervisor.ts")).toBe("test");
    expect(
      roles.get(
        "lib/execution-host/__tests__/runtime-data-boundary-inventory.test.ts",
      ),
    ).toBe("test");
    expect(roles.get("instrumentation.ts")).toBe("production");
    expect(roles.get("../runtime/safe-download.ts")).toBe("production");
    for (const site of baselineScan().callsites) {
      expect(roles.get(site.source), site.source).toBe("production");
    }
  });

  it(
    "fails when a host-runtime read is injected into an already classified mixed file",
    () => {
      const source = "lib/services/hitl.ts";
      const original = readFileSync(resolve(WEB_DIR, source), "utf8");
      const injected =
        `import { readFile as injectedHostRead } from "node:fs/promises";\n` +
        original +
        `\nexport async function peekHostState(): Promise<Buffer> {\n` +
        `  return injectedHostRead(process.env.MAISTER_EXECUTION_HOST_STATE_DIR + "/state.sqlite");\n` +
        `}\n`;
      const line = lineOf(injected, "return injectedHostRead(");
      const result = scan(new Map([[source, injected]]));

      expect(unclassified(result)).toEqual([
        `${source}:${line} peekHostState → node:fs/promises.readFile (read)`,
      ]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "fails when a path-generic wrapper is called from a new site in a classified file",
    () => {
      const source = "lib/services/hitl.ts";
      const original = readFileSync(resolve(WEB_DIR, source), "utf8");
      const injected =
        original +
        `\nexport async function mirrorIntoHostRoot(): Promise<void> {\n` +
        `  await atomicWriteJson(process.env.MAISTER_EXECUTION_HOST_STATE_DIR + "/mirror.json", {});\n` +
        `}\n`;
      const line = lineOf(injected, "await atomicWriteJson(");
      const result = scan(new Map([[source, injected]]));

      expect(unclassified(result)).toEqual([
        `${source}:${line} mirrorIntoHostRoot → lib/atomic.ts#atomicWriteJson (wrapper)`,
      ]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "fails when a previously omitted .tsx page or script root performs filesystem access",
    () => {
      const page = "components/board/host-log-preview.tsx";
      const script = "scripts/dump-host-state.mjs";
      const result = scan(
        new Map([
          [
            page,
            `import { readFileSync } from "node:fs";\n` +
              `export function HostLogPreview({ path }: { path: string }) {\n` +
              `  return <pre>{readFileSync(path, "utf8")}</pre>;\n` +
              `}\n`,
          ],
          [
            script,
            `const fs = require("node:fs");\n` +
              `process.stdout.write(fs.readFileSync(process.argv[2]));\n`,
          ],
        ]),
      );

      expect(unclassified(result)).toEqual([
        `${page}:3 HostLogPreview → node:fs.readFileSync (read)`,
        `${script}:2 <module> → node:fs.readFileSync (read)`,
      ]);
      expect(result.roles.get(page)).toBe("production");
      expect(result.roles.get(script)).toBe("production");
    },
    SCAN_TIMEOUT_MS,
  );
});
