import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  requiredLegacyRuntimeSources,
  runtimeDataBoundaryInventory,
} from "./fixtures/runtime-data-boundary-inventory";

const WEB_DIR = resolve(__dirname, "../../..");
const SOURCE_ROOTS = ["app", "lib"] as const;
const FS_IMPORT = /node:fs(?:\/promises)?/;
const RUNTIME_PATH_CONSTRUCTOR =
  /runtimeRoot\(|runDirPath\(|eventsLogPath|costPath|sessionLogPath|\.maister.*runs/;

function sourceFiles(root: string): readonly string[] {
  const absoluteRoot = resolve(WEB_DIR, root);
  const files: string[] = [];
  const pending = [absoluteRoot];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) throw new Error("source scan directory unexpectedly absent");

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") pending.push(path);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".integration.test.ts")
      ) {
        files.push(path.slice(WEB_DIR.length + 1));
      }
    }
  }

  return files.sort();
}

function directFilesystemSources(): readonly string[] {
  return SOURCE_ROOTS.flatMap(sourceFiles).filter((source) =>
    FS_IMPORT.test(readFileSync(resolve(WEB_DIR, source), "utf8")),
  );
}

function runtimePathConstructorSources(): readonly string[] {
  return SOURCE_ROOTS.flatMap(sourceFiles).filter((source) =>
    RUNTIME_PATH_CONSTRUCTOR.test(readFileSync(resolve(WEB_DIR, source), "utf8")),
  );
}

describe("Stage B runtime-data boundary inventory", () => {
  it("classifies every scanned source exactly once", () => {
    const classifiedSources = runtimeDataBoundaryInventory.map(
      ({ source }) => source,
    );

    expect(classifiedSources).toEqual([...new Set(classifiedSources)]);
  });

  it("classifies every direct production filesystem access exactly once", () => {
    const classifiedSources = runtimeDataBoundaryInventory
      .filter(({ observation }) => observation === "direct-filesystem-access")
      .map(({ source }) => source);

    expect(classifiedSources).toEqual([...new Set(classifiedSources)]);
    expect(classifiedSources.slice().sort()).toEqual(directFilesystemSources());
  });

  it("classifies every production execution-runtime path constructor", () => {
    const classifiedSources = new Set(
      runtimeDataBoundaryInventory.map(({ source }) => source),
    );

    expect(runtimePathConstructorSources().every((source) => classifiedSources.has(source))).toBe(
      true,
    );
  });

  it("keeps every legacy host-runtime reader on the Stage B removal path", () => {
    const legacySources = runtimeDataBoundaryInventory
      .filter(({ classification }) => classification === "host-runtime-legacy")
      .map(({ source }) => source)
      .sort();

    expect(requiredLegacyRuntimeSources.slice().sort()).toEqual(legacySources);
    for (const entry of runtimeDataBoundaryInventory) {
      if (entry.classification === "host-runtime-legacy") {
        expect(entry.disposition).toBe("stage-b-remove");
        expect(entry.removalTask).toMatch(/^T[1-4]\./);
      }
    }
  });
});
