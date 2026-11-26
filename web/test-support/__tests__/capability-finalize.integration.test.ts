import type { StartedPostgresTestDb } from "../pg-container";
import type { RealWeb } from "../real-web";

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { poll } from "../durable-workers-ledger";
import { seedAdmin, WORKER_ADMIN } from "../durable-workers-seed";
import {
  buildProductionWeb,
  signInWithCredentials,
  startRealWeb,
} from "../real-web";
import { startMainAndBrainPostgresTestDb } from "../pg-container";
import { mkdtempReal } from "../worktree-test-root";

import { capabilityImports } from "@/lib/db/schema";
import { localDirectoryContentDigest } from "@/lib/flows";

let root: string;
let database: StartedPostgresTestDb;
let web: RealWeb;
let cookie: string;

beforeAll(async () => {
  root = await mkdtempReal("capability-finalize-");
  await buildProductionWeb(path.join(root, "next-build.log"));
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "capability_finalize",
  });
  await seedAdmin(database.db);
  const runtimeRoot = path.join(root, "runtime");
  const worktreesRoot = path.join(root, "worktrees");

  await Promise.all([runtimeRoot, worktreesRoot].map((dir) => mkdir(dir)));
  web = await startRealWeb({
    databaseUrl: database.container.getConnectionUri(),
    supervisorUrl: "http://127.0.0.1:1",
    runtimeRoot,
    worktreesRoot,
    env: { MAISTER_REPOS_ROOT: root, HOME: root },
  });
  cookie = await signInWithCredentials(web.url, WORKER_ADMIN);
}, 900_000);

afterAll(async () => {
  await web?.kill();
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

it("persists both capability digests through production registration", async () => {
  const pack = path.join(root, "core");
  const member = path.join(pack, "capability");
  const standalone = path.join(root, "local-capability");
  const project = path.join(root, "finalize-smoke");

  await Promise.all(
    [member, standalone, project].map((dir) => mkdir(dir, { recursive: true })),
  );
  await writeFile(path.join(member, "README.md"), "package member\n");
  await writeFile(path.join(standalone, "README.md"), "standalone\n");
  await writeFile(
    path.join(pack, "maister-package.yaml"),
    "schemaVersion: 1\nname: core\ncapabilities:\n  - { id: core-bundle, path: capability }\n",
  );
  await writeFile(
    path.join(project, "maister.yaml"),
    JSON.stringify({
      schemaVersion: 2,
      project: {
        name: "Finalize smoke",
        main_branch: "main",
        branch_prefix: "maister/",
      },
      flows: [],
      packages: [{ id: "core", source: pack, version: "core/v1.0.1" }],
      capability_imports: [
        { id: "local-bundle", source: standalone, version: "v1" },
      ],
    }),
  );
  const response = await fetch(web.url + "/api/projects", {
    method: "POST",
    headers: { cookie, origin: web.url, "content-type": "application/json" },
    body: JSON.stringify({ mode: "existing", target: project }),
  });
  const body = await response.text();

  expect(response.status, body).toBe(201);
  const { projectId } = JSON.parse(body) as { projectId: string };
  const rows = await poll(
    async () => {
      const imports = await database.db
        .select()
        .from(capabilityImports)
        .where(eq(capabilityImports.projectId, projectId));

      return imports.length === 2 &&
        imports.every((row) => row.packageStatus === "Installed")
        ? imports
        : null;
    },
    120_000,
    "two installed capability revisions",
  );
  const revisions: Record<string, string> = {
    "core-bundle": (await localDirectoryContentDigest(pack)).slice(0, 40),
    "local-bundle": createHash("sha256")
      .update(standalone)
      .digest("hex")
      .slice(0, 40),
  };

  for (const [ref, revision] of Object.entries(revisions)) {
    expect(rows.find((row) => row.capabilityRefId === ref)).toMatchObject({
      resolvedRevision: revision,
      manifestDigest: createHash("sha256").update(revision).digest("hex"),
      setupStatus: "not_required",
    });
  }
}, 180_000);
