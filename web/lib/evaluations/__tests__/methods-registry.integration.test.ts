import type { EvaluationPanelPolicy } from "@/lib/evaluations/types";

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  createPanel,
  createProfile,
  putProjectOverride,
} from "@/lib/evaluations/config";
import {
  deriveMethodHealth,
  listMethodologies,
  registerPackageMethods,
  setMethodActivation,
} from "@/lib/evaluations/methods-registry";
import { resolveEffectiveProfile } from "@/lib/evaluations/resolution";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CORE_PKG = join(FIXTURES, "release-pkg", "packages", "core");

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId: string;

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

const METHOD_ENTRIES = [
  { id: "sdd-quality", path: "evaluation-methods/sdd-quality" },
];

async function insertInstall(opts: {
  trustStatus: "trusted" | "untrusted";
  installedPath: string;
  methodEntries?: Array<{ id: string; path: string }>;
}): Promise<string> {
  const installId = randomUUID();

  await db.insert(schema.packageInstalls).values({
    id: installId,
    sourceUrl: "github.com/x/core",
    name: `core-${installId.slice(0, 6)}`,
    versionLabel: "v1.1.0",
    resolvedRevision: "deadbeef",
    manifest: {
      spec: {
        name: "core",
        evaluationMethods: opts.methodEntries ?? METHOD_ENTRIES,
      },
    },
    manifestDigest: "d",
    installedPath: opts.installedPath,
    packageStatus: "Installed",
    trustStatus: opts.trustStatus,
  });

  return installId;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_methods_test",
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
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("methodology projection", () => {
  it("projects a trusted compatible method as ready and disabled by default", async () => {
    const installId = await insertInstall({
      trustStatus: "trusted",
      installedPath: CORE_PKG,
    });

    const summary = await registerPackageMethods(installId, db);

    expect(summary.projected).toContain(
      `core-${installId.slice(0, 6)}:sdd-quality`,
    );
    expect(summary.invalid).toHaveLength(0);

    const rows = await db
      .select()
      .from(schema.evaluationMethodRevisions)
      .where(eq(schema.evaluationMethodRevisions.packageInstallId, installId));

    expect(rows).toHaveLength(1);
    expect(rows[0].activation).toBe("disabled");
    expect(rows[0].validationErrors).toBeNull();
    expect(
      deriveMethodHealth(
        { validationErrors: rows[0].validationErrors, compat: rows[0].compat },
        "trusted",
      ),
    ).toBe("ready");
  });

  it("re-projection is idempotent (upsert on install+method)", async () => {
    const installId = await insertInstall({
      trustStatus: "trusted",
      installedPath: CORE_PKG,
    });

    await registerPackageMethods(installId, db);
    await registerPackageMethods(installId, db);

    const rows = await db
      .select({ id: schema.evaluationMethodRevisions.id })
      .from(schema.evaluationMethodRevisions)
      .where(eq(schema.evaluationMethodRevisions.packageInstallId, installId));

    expect(rows).toHaveLength(1);
  });

  it("projects an unreadable method as report-only (never selectable)", async () => {
    const installId = await insertInstall({
      trustStatus: "trusted",
      installedPath: CORE_PKG,
      methodEntries: [
        { id: "sdd-quality", path: "evaluation-methods/missing" },
      ],
    });

    const summary = await registerPackageMethods(installId, db);

    expect(summary.projected).toHaveLength(0);
    expect(summary.invalid).toHaveLength(1);

    const [row] = await db
      .select()
      .from(schema.evaluationMethodRevisions)
      .where(eq(schema.evaluationMethodRevisions.packageInstallId, installId));

    expect(row.validationErrors?.length).toBeGreaterThan(0);
    expect(
      deriveMethodHealth(
        { validationErrors: row.validationErrors, compat: row.compat },
        "trusted",
      ),
    ).toBe("incompatible");
  });

  it("refuses to enable a degraded (untrusted) or incompatible method", async () => {
    const untrusted = await insertInstall({
      trustStatus: "untrusted",
      installedPath: CORE_PKG,
    });

    await registerPackageMethods(untrusted, db);
    const [row] = await db
      .select({ id: schema.evaluationMethodRevisions.id })
      .from(schema.evaluationMethodRevisions)
      .where(eq(schema.evaluationMethodRevisions.packageInstallId, untrusted));

    await expect(
      setMethodActivation(
        { methodRevisionId: row.id, activation: "enabled" },
        db,
      ),
    ).rejects.toThrow(/degraded/);
  });

  it("enables a ready method and lists it via listMethodologies", async () => {
    const installId = await insertInstall({
      trustStatus: "trusted",
      installedPath: CORE_PKG,
    });

    await registerPackageMethods(installId, db);
    const [row] = await db
      .select({ id: schema.evaluationMethodRevisions.id })
      .from(schema.evaluationMethodRevisions)
      .where(eq(schema.evaluationMethodRevisions.packageInstallId, installId));

    const res = await setMethodActivation(
      { methodRevisionId: row.id, activation: "enabled" },
      db,
    );

    expect(res.activation).toBe("enabled");
    expect(res.health).toBe("ready");

    const list = await listMethodologies(db);
    const item = list.find((m) => m.id === row.id);

    expect(item?.activation).toBe("enabled");
    expect(item?.health).toBe("ready");
  });
});

describe("effective profile resolution", () => {
  async function enabledMethodRevisionId(): Promise<string> {
    const installId = await insertInstall({
      trustStatus: "trusted",
      installedPath: CORE_PKG,
    });

    await registerPackageMethods(installId, db);
    const [row] = await db
      .select({ id: schema.evaluationMethodRevisions.id })
      .from(schema.evaluationMethodRevisions)
      .where(eq(schema.evaluationMethodRevisions.packageInstallId, installId));

    await setMethodActivation(
      { methodRevisionId: row.id, activation: "enabled" },
      db,
    );

    return row.id;
  }

  async function makeProfile(
    methodRevisionId: string,
    allowedOverrides: Record<string, unknown>,
    hardLimits: Record<string, unknown> = {},
  ): Promise<string> {
    const panel = await createPanel(
      {
        name: `panel-${randomUUID().slice(0, 6)}`,
        roleBindings: [{ role: "judge", agentId: "core:judge" }],
        policy: POLICY,
      },
      db,
    );
    const profile = await createProfile(
      {
        name: `prof-${randomUUID().slice(0, 6)}`,
        methodRevisionId,
        panelId: panel.id as string,
        allowedOverrides,
        hardLimits,
      },
      db,
    );

    return profile.id as string;
  }

  it("resolves the panel base policy when there are no overrides", async () => {
    const methodRevisionId = await enabledMethodRevisionId();
    const profileId = await makeProfile(methodRevisionId, {});

    const eff = await resolveEffectiveProfile({ profileId, projectId }, db);

    expect(eff.policy.attempts).toBe(3);
    expect(eff.policy.quorum).toBe(2);
    expect(eff.appliedOverrides).toHaveLength(0);
    expect(eff.methodQualifiedId).toMatch(/:sdd-quality$/);
  });

  it("applies project then study override with study winning (precedence)", async () => {
    const methodRevisionId = await enabledMethodRevisionId();
    const profileId = await makeProfile(methodRevisionId, {
      attempts: { min: 2, max: 9 },
    });

    await putProjectOverride(
      { projectId, profileId, overrides: { attempts: 5 } },
      db,
    );

    const eff = await resolveEffectiveProfile(
      { profileId, projectId, studyOverrides: { attempts: 7 } },
      db,
    );

    expect(eff.policy.attempts).toBe(7);
    expect(eff.appliedOverrides).toEqual([
      { source: "project", field: "attempts", value: 5 },
      { source: "study", field: "attempts", value: 7 },
    ]);
  });

  it("refuses an override not in the profile allow-list", async () => {
    const methodRevisionId = await enabledMethodRevisionId();
    const profileId = await makeProfile(methodRevisionId, {
      attempts: { min: 1, max: 9 },
    });

    await expect(
      resolveEffectiveProfile(
        { profileId, projectId, studyOverrides: { timeoutMs: 1000 } },
        db,
      ),
    ).rejects.toThrow(/not in the profile's allowed overrides/);
  });

  it("enforces a profile hard limit that survives the override", async () => {
    const methodRevisionId = await enabledMethodRevisionId();
    const profileId = await makeProfile(
      methodRevisionId,
      { attempts: { min: 1, max: 20 } },
      { attempts: { min: 1, max: 6 } },
    );

    await expect(
      resolveEffectiveProfile(
        { profileId, projectId, studyOverrides: { attempts: 8 } },
        db,
      ),
    ).rejects.toThrow(/exceeds the allowed maximum 6/);
  });

  it("rejects a resolved policy that violates a hard structural constraint", async () => {
    const methodRevisionId = await enabledMethodRevisionId();
    // quorum > attempts must fail even when both are individually in-bounds.
    const profileId = await makeProfile(methodRevisionId, {
      quorum: { min: 1, max: 9 },
    });

    await expect(
      resolveEffectiveProfile(
        { profileId, projectId, studyOverrides: { quorum: 5 } },
        db,
      ),
    ).rejects.toThrow(/quorum 5 must be within/);
  });
});
