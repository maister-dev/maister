import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DURABLE_WORKER_SLOT_KEYS,
  durableWorkersHealth,
  readDurableWorkerSlot,
  writeDurableWorkerSlot,
} from "../health";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..", "..", "..");
// The health module exists to give a consumer a CYCLE-FREE import target: the
// composition root imports it, never the reverse. If a domain module ever
// reaches this graph, every importer of the health surface inherits the flow
// runner — and a cycle through `lib/execution-host` fails mocked suites as
// SKIPS rather than as errors, which is the failure mode nobody notices.
const FORBIDDEN_PREFIXES = [
  "lib/flows",
  "lib/agents",
  "lib/scratch-runs",
  "lib/runs",
  "lib/services",
  "lib/execution-host",
  "lib/db",
];

async function resolveImportGraph(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const relative = queue.pop() as string;

    if (seen.has(relative)) continue;
    seen.add(relative);
    const source = await readFile(path.join(WEB_DIR, relative), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );

    for (const specifier of specifiers) {
      if (specifier === "server-only" || !/^[.@]/.test(specifier)) continue;
      const target = specifier.startsWith("@/")
        ? specifier.slice(2)
        : path.posix.join(path.posix.dirname(relative), specifier);

      queue.push(target.endsWith(".ts") ? target : `${target}.ts`);
    }
  }

  return seen;
}

describe("durable worker health surface", () => {
  it("resolves no domain module in its import graph", async () => {
    const graph = await resolveImportGraph("lib/workers/health.ts");
    const offenders = [...graph].filter((file) =>
      FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );

    expect(offenders).toEqual([]);
    expect(graph).toEqual(new Set(["lib/workers/health.ts"]));
  });

  it("reports an empty slot as stopped and a filled one from its own health()", () => {
    const previous = readDurableWorkerSlot("flowContinuation");

    try {
      writeDurableWorkerSlot("flowContinuation", undefined);
      expect(durableWorkersHealth().flowContinuation).toEqual({
        state: "stopped",
        reason: null,
      });
      writeDurableWorkerSlot("flowContinuation", {
        stop: async () => {},
        health: () => ({ state: "degraded", reason: "SPAWN" }),
      });
      expect(durableWorkersHealth().flowContinuation).toEqual({
        state: "degraded",
        reason: "SPAWN",
      });
    } finally {
      writeDurableWorkerSlot("flowContinuation", previous);
    }
  });

  it("degrades rather than throwing when a worker's health() throws", () => {
    const previous = readDurableWorkerSlot("agentContinuation");

    try {
      writeDurableWorkerSlot("agentContinuation", {
        stop: async () => {},
        health: () => {
          throw new Error("health read failed");
        },
      });
      expect(durableWorkersHealth().agentContinuation).toEqual({
        state: "degraded",
        reason: "health read failed",
      });
    } finally {
      writeDurableWorkerSlot("agentContinuation", previous);
    }
  });

  it("keys the slots by interned symbols so separate bundles share them", () => {
    expect(DURABLE_WORKER_SLOT_KEYS.promptOwner).toBe(
      Symbol.for("maister.durable-workers.promptOwner.v1"),
    );
    expect(DURABLE_WORKER_SLOT_KEYS.flowContinuation).toBe(
      Symbol.for("maister.durable-workers.flowContinuation.v1"),
    );
    expect(DURABLE_WORKER_SLOT_KEYS.agentContinuation).toBe(
      Symbol.for("maister.durable-workers.agentContinuation.v1"),
    );
  });
});
