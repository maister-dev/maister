import { execFile } from "node:child_process";
import { lstat, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";

import {
  captureOperationalBaseline,
  captureOperationalGeneration,
  verifyOperationalIntegrity,
} from "@/lib/agents/operational-integrity";
import type { Db } from "@/lib/execution-host/db";
import { workspaceIntegrityFields } from "@/lib/workspace-integrity/settings-schema";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { seedWorkspaceIntegritySettings } from "@/test-support/workspace-integrity-settings";

const revision = "cd9e37f071f7d29e6fbc03d36e1e83c8a0ffdb5f";
const exec = promisify(execFile);
let db: Db;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireGlobalRole: async () => ({ id: "qualification" }),
}));

it("WI-08 refuses the historic threshold and verifies the pinned checkout with built-ins", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "maister-integrity-qualification-"),
  );
  const tree = join(root, "source");
  const database = await startMainPostgresTestDb({
    databaseName: "workspace_integrity_qualification",
  });

  try {
    await seedWorkspaceIntegritySettings(database);
    for (const { env } of Object.values(workspaceIntegrityFields))
      vi.stubEnv(env, undefined);
    db = database.db;
    const route =
      await import("@/app/api/admin/platform/workspace-integrity/route");
    const setSize = async (value: number | null): Promise<void> => {
      const response = await route.PATCH(
        new NextRequest(
          "http://localhost/api/admin/platform/workspace-integrity",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ maxSizeMiB: value }),
          },
        ),
      );
      expect(response.status).toBe(200);
    };
    await exec("git", ["cat-file", "-e", revision + "^{commit}"]);
    await exec("git", [
      "clone",
      "--local",
      "--shared",
      "--no-checkout",
      "..",
      tree,
    ]);
    await exec("git", [
      "-C",
      tree,
      "-c",
      "core.hooksPath=/dev/null",
      "checkout",
      "--detach",
      revision,
    ]);
    const status = async (): Promise<string> =>
      (
        await exec("git", [
          "-C",
          tree,
          "status",
          "--porcelain",
          "--ignored=matching",
        ])
      ).stdout;
    expect(await status()).toBe("");

    await setSize(256);
    const refusedAt = performance.now();
    await expect(
      captureOperationalBaseline(db, tree, "ephemeral_checkout"),
    ).rejects.toMatchObject({
      details: {
        integrityLimit: {
          limitAxis: "bytes",
          observed: 268737798,
          maximum: 268435456,
        },
      },
    });
    const refusalMs = Math.ceil(performance.now() - refusedAt);

    await setSize(null);
    expect(await (await route.GET()).json()).toEqual({
      maxSizeMiB: { value: 1024, source: "default" },
      maxDurationSeconds: { value: 120, source: "default" },
      maxEntries: { value: 100000, source: "default" },
    });
    const start = performance.now();
    const baseline = await captureOperationalBaseline(
      db,
      tree,
      "ephemeral_checkout",
    );
    const captured = performance.now();
    const generation = await captureOperationalGeneration(
      db,
      tree,
      baseline,
      [],
    );
    const materialized = performance.now();
    const verdict = await verifyOperationalIntegrity(db, tree, generation);
    const verified = performance.now();
    expect(
      Math.max(
        captured - start,
        materialized - captured,
        verified - materialized,
      ),
    ).toBeLessThan(120000);
    expect(verdict).toEqual({
      verdict: "clean",
      reasonCodes: [],
      changedPaths: [],
    });
    expect(baseline.head).toBe(revision);
    expect(generation.generation).toBe(1);
    expect(generation.platform).toEqual([]);
    let bytes = 0;
    for (const entry of baseline.source) {
      const path = join(tree, entry.path);
      if (entry.type === "file") bytes += (await lstat(path)).size;
      if (entry.type === "symlink")
        bytes += Buffer.byteLength(await readlink(path));
    }
    expect(bytes).toBe(482517365);
    expect(baseline.source).toHaveLength(11749);
    expect(await status()).toBe("");
    process.stdout.write(
      JSON.stringify({
        revision,
        bytes,
        entries: baseline.source.length,
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        refusalMs,
        captureMs: Math.ceil(captured - start),
        materializationMs: Math.ceil(materialized - captured),
        verificationMs: Math.ceil(verified - materialized),
      }) + "\n",
    );
  } finally {
    vi.unstubAllEnvs();
    await database.stop();
    await rm(root, { recursive: true, force: true });
  }
});
