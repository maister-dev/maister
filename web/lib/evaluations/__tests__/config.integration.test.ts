import type { EvaluationPanelPolicy } from "@/lib/evaluations/types";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  clearProjectOverride,
  createPanel,
  createProfile,
  deletePanel,
  deleteProfile,
  patchPanel,
  patchProfile,
  putProjectOverride,
} from "@/lib/evaluations/config";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId: string;
let methodRevisionId: string;

const POLICY: EvaluationPanelPolicy = {
  attempts: 3,
  maxParallelAttempts: 2,
  quorum: 2,
  timeoutMs: 60_000,
  maxRetries: 1,
  blindLabels: true,
  randomizeOrder: true,
  allowedMcps: [],
};

async function makePanel(): Promise<string> {
  const panel = await createPanel(
    {
      name: `panel-${randomUUID().slice(0, 6)}`,
      roleBindings: [{ role: "judge", agentId: "core:judge" }],
      policy: POLICY,
    },
    db,
  );

  return panel.id as string;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_config_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  const installId = randomUUID();

  await db.insert(schema.packageInstalls).values({
    id: installId,
    sourceUrl: "github.com/x/core",
    name: "core",
    versionLabel: "v1.1.0",
    resolvedRevision: "deadbeef",
    manifest: { schemaVersion: 1, name: "core" },
    manifestDigest: "d",
    installedPath: "/tmp/core",
    packageStatus: "Installed",
    trustStatus: "trusted",
  });
  methodRevisionId = randomUUID();
  await db.insert(schema.evaluationMethodRevisions).values({
    id: methodRevisionId,
    packageInstallId: installId,
    methodId: "sdd-quality",
    qualifiedId: "core:sdd-quality",
    packageName: "core",
    versionLabel: "v1.1.0",
    schemaVersion: 1,
    normalizedDefinition: {},
    definitionDigest: "dd",
    promptDigest: "pd",
    schemaDigest: "sd",
    compat: { engineMin: "3.2.0" },
    activation: "enabled",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("judge panels", () => {
  it("patches on a matching revision and rejects a stale one", async () => {
    const panelId = await makePanel();

    const patched = await patchPanel(
      { panelId, expectedRevision: 1, name: "renamed" },
      db,
    );

    expect(patched.name).toBe("renamed");
    expect(patched.revision).toBe(2);

    await expect(
      patchPanel({ panelId, expectedRevision: 1, name: "stale" }, db),
    ).rejects.toThrow(/revision mismatch/);
  });

  it("refuses to delete a panel referenced by a profile", async () => {
    const panelId = await makePanel();

    await createProfile({ name: "p", methodRevisionId, panelId }, db);

    await expect(deletePanel({ panelId }, db)).rejects.toThrow(
      /referenced by a profile/,
    );
  });

  it("hard-deletes an unreferenced panel", async () => {
    const panelId = await makePanel();

    await deletePanel({ panelId }, db);
    const rows = await db
      .select({ id: schema.evaluationJudgePanels.id })
      .from(schema.evaluationJudgePanels)
      .where(eq(schema.evaluationJudgePanels.id, panelId));

    expect(rows).toHaveLength(0);
  });
});

describe("profiles", () => {
  it("rejects a profile referencing a missing method revision", async () => {
    const panelId = await makePanel();

    await expect(
      createProfile(
        { name: "bad", methodRevisionId: randomUUID(), panelId },
        db,
      ),
    ).rejects.toThrow(/method revision not found/);
  });

  it("patches on a matching revision and is usage-guarded on delete", async () => {
    const panelId = await makePanel();
    const profile = await createProfile(
      { name: "prof", methodRevisionId, panelId },
      db,
    );

    const patched = await patchProfile(
      { profileId: profile.id as string, expectedRevision: 1, enabled: false },
      db,
    );

    expect(patched.enabled).toBe(false);
    expect(patched.revision).toBe(2);

    await putProjectOverride(
      { projectId, profileId: profile.id as string, overrides: { x: 1 } },
      db,
    );

    await expect(
      deleteProfile({ profileId: profile.id as string }, db),
    ).rejects.toThrow(/project overrides/);
  });
});

describe("project overrides (SET / CLEAR / re-set symmetry)", () => {
  it("sets, clears, and re-sets an override with no stale value", async () => {
    const panelId = await makePanel();
    const profile = await createProfile(
      { name: "prof2", methodRevisionId, panelId },
      db,
    );
    const profileId = profile.id as string;

    const set1 = await putProjectOverride(
      { projectId, profileId, overrides: { attempts: 5 } },
      db,
    );

    expect(set1.overrides).toEqual({ attempts: 5 });

    // Re-SET updates in place (UNIQUE) and bumps revision.
    const set2 = await putProjectOverride(
      { projectId, profileId, overrides: { attempts: 7 } },
      db,
    );

    expect(set2.overrides).toEqual({ attempts: 7 });
    expect(set2.revision).toBe(2);

    // CLEAR removes the row entirely (absent = inherit).
    const cleared = await clearProjectOverride({ projectId, profileId }, db);

    expect(cleared.cleared).toBe(true);
    const afterClear = await db
      .select({ id: schema.evaluationProjectProfileOverrides.id })
      .from(schema.evaluationProjectProfileOverrides)
      .where(eq(schema.evaluationProjectProfileOverrides.profileId, profileId));

    expect(afterClear).toHaveLength(0);

    // Clearing an absent override is an idempotent no-op.
    const clearedAgain = await clearProjectOverride(
      { projectId, profileId },
      db,
    );

    expect(clearedAgain.cleared).toBe(false);

    // Re-SET after CLEAR starts a fresh row.
    const set3 = await putProjectOverride(
      { projectId, profileId, overrides: { attempts: 9 } },
      db,
    );

    expect(set3.overrides).toEqual({ attempts: 9 });
  });
});
