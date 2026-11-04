import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { CompanyFlowBindingCreate } from "../company-flow-binding-types";

import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve, sep } from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { agentDefinitionSha256 } from "../activity-snapshot";
import { parseAgentDefinition } from "../definition";
import { detachCompanySpecialistBinding } from "../company-binding-mutations";
import { createCompanySpecialistBinding } from "../company-bindings";
import {
  createCompanyFlowBinding,
  getCompanyFlowBinding,
  getCompanyFlowBindingRevision,
} from "../company-flow-bindings";
import {
  updateCompanyFlowBinding,
  detachCompanyFlowBinding,
} from "../company-flow-binding-mutations";
import { createCompanyCronSchedule } from "../company-schedules";
import {
  claimCronAgentAttempt,
  reconcileAgentTriggerAttempts,
  settleAgentTriggerAttempt,
} from "../trigger-attempts";
import { dispatchDueAgentSchedules } from "../triggers";
import { parseScheduledRequestSnapshot } from "../scheduled-request";

import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import {
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import { git, initRepo } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDbUpTo,
  applyMainMigration,
} from "@/test-support/pg-container";
import { removeRevision } from "@/lib/flows/lifecycle";
import { runRevisionGcSweep } from "@/lib/gc/revision-gc";

let database: StartedPostgresTestDb;
let root: string;
let input: CompanyFlowBindingCreate;
let retainedRoleBeforeUpgrade: readonly Readonly<{
  kind: string;
  value: Record<string, unknown>;
}>[];
const administratorId = randomUUID();
const requesterId = randomUUID();
const reviewerId = `reviewer-${randomUUID()}`.padEnd(192, "r");

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    {
      databaseName: "company_flow_bindings",
    },
    "0236_company_specialist_bindings",
  );
  root = await mkdtemp(join(os.tmpdir(), "company-flow-binding-"));
  vi.spyOn(os, "homedir").mockReturnValue(root);
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active'),($3,$4,'member','active'),($5,$6,'member','active')",
    [
      administratorId,
      `${administratorId}@example.test`,
      requesterId,
      `${requesterId}@example.test`,
      reviewerId,
      `${randomUUID()}@example.test`,
    ],
  );
  const authority = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: requesterId,
    actions: ["specialists:read", "specialists:manage"],
    idempotencyKey: randomUUID(),
  });

  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: reviewerId,
    actions: ["assignments:answer"],
    idempotencyKey: randomUUID(),
  });
  const source = join(root, "source");

  await cp(resolve("test-fixtures/rah-native"), source, {
    recursive: true,
    filter: (path) => !path.split(sep).includes(".git"),
  });
  const rolePath = join(source, "maister-agents/evidence-researcher.md");

  await writeFile(
    rolePath,
    (await readFile(rolePath, "utf8")).replace(
      "workspace: none",
      "specialist:\n  responsibilities: [Coordinate authorized evidence review]\n  targetClasses: [stand]\nflow: rah-control\nworkspace: none",
    ),
  );
  const flowPath = join(source, "flows/rah-control/flow.yaml");

  await writeFile(
    flowPath,
    (await readFile(flowPath, "utf8")).replace(
      "      success: done",
      "      success: review",
    ) +
      "\n  - id: review\n    type: human\n    settings:\n      roles: [maintainer]\n      decisions: [approve]\n    transitions:\n      approve: done\n",
  );
  await initRepo(source);
  await git(
    source,
    "tag",
    "-a",
    "rah/company-flow-binding-v1",
    "-m",
    "Synthetic company Flow binding qualification",
  );
  const installed = await installPackageRevision({
    source,
    version: "rah/company-flow-binding-v1",
    db: database.db,
  });

  await trustPackageRevision({
    packageInstallId: installed.id,
    db: database.db,
  });
  const pin = (
    await database.pool.query<{
      installed_path: string;
      resolved_revision: string;
    }>(
      "SELECT installed_path,resolved_revision FROM package_installs WHERE id=$1",
      [installed.id],
    )
  ).rows[0]!;
  const role = parseAgentDefinition(
    "rah:evidence-researcher",
    await readFile(
      join(pin.installed_path, "maister-agents/evidence-researcher.md"),
      "utf8",
    ),
  );
  const flow = (
    await database.pool.query<{ id: string; manifest_digest: string }>(
      "SELECT id,manifest_digest FROM flow_revisions WHERE flow_ref_id='rah-control' AND resolved_revision=$1",
      [pin.resolved_revision],
    )
  ).rows[0]!;
  const specialist = await createCompanySpecialistBinding(
    database.db,
    requesterId,
    role.id,
    {
      owner: { kind: "company", companyId: authority.page.companyId },
      packageInstallId: installed.id,
      packageRevision: pin.resolved_revision,
      definitionSha256: agentDefinitionSha256(role),
      coordinatorFlowRevisionId: flow.id,
      configuration: {},
      grantActions: [],
      idempotencyKey: randomUUID(),
    },
  );

  retainedRoleBeforeUpgrade = (
    await database.pool.query<{ kind: string; value: Record<string, unknown> }>(
      "SELECT 'head' AS kind,to_jsonb(b) AS value FROM company_specialist_bindings b UNION ALL SELECT 'revision' AS kind,to_jsonb(r) AS value FROM company_specialist_binding_revisions r ORDER BY kind",
    )
  ).rows;
  const journal = JSON.parse(
    await readFile("./lib/db/migrations/meta/_journal.json", "utf8"),
  ) as { entries: { tag: string }[] };
  const baseline = journal.entries.findIndex(
    (entry) => entry.tag === "0236_company_specialist_bindings",
  );

  if (baseline < 0)
    throw new Error(
      "The populated company binding upgrade baseline is missing",
    );
  for (const entry of journal.entries.slice(baseline + 1))
    await applyMainMigration(database.db, entry.tag);

  input = {
    owner: specialist.specialist.owner,
    specialistBindingId: specialist.specialist.bindingId,
    specialistRevision: specialist.specialist.configRevision,
    flowRevisionId: flow.id,
    manifestSha256: flow.manifest_digest,
    execution: { workspace: "none", completion: "result" },
    roleMappings: { maintainer: [reviewerId] },
    idempotencyKey: randomUUID(),
  };
}, 180000);

afterAll(async () => {
  try {
    await database?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  } finally {
    vi.restoreAllMocks();
  }
});

it("retains an exact reviewed company coordinator configuration without a project or runtime admission", async () => {
  expect(
    (
      await database.pool.query(
        "SELECT 'head' AS kind,to_jsonb(b) AS value FROM company_specialist_bindings b UNION ALL SELECT 'revision' AS kind,to_jsonb(r) AS value FROM company_specialist_binding_revisions r ORDER BY kind",
      )
    ).rows,
  ).toEqual(retainedRoleBeforeUpgrade);
  const result = await createCompanyFlowBinding(
    database.db,
    requesterId,
    input,
  );

  expect(result).toMatchObject({
    duplicate: false,
    binding: {
      revision: 1,
      owner: input.owner,
      configuration: {
        schemaVersion: 1,
        companyId: input.owner.companyId,
        flowRefId: "rah-control",
        flowRevisionId: input.flowRevisionId,
        manifestSha256: input.manifestSha256,
        specialistBindingId: input.specialistBindingId,
        specialistRevision: 1,
        execution: { workspace: "none", completion: "result" },
        enabled: false,
        detachedAt: null,
        roleMappings: { maintainer: [reviewerId] },
        specialist: {
          agentId: "rah:evidence-researcher",
          coordinatorFlowRevisionId: input.flowRevisionId,
        },
      },
    },
  });
  expect(
    await getCompanyFlowBinding(database.db, requesterId, result.binding.id),
  ).toEqual(result.binding);
  expect(
    await createCompanyFlowBinding(database.db, requesterId, input),
  ).toEqual({ ...result, duplicate: true });
  await expect(
    createCompanyFlowBinding(database.db, requesterId, {
      ...input,
      roleMappings: {},
      idempotencyKey: input.idempotencyKey,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    createCompanyFlowBinding(database.db, requesterId, {
      ...input,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await database.pool.query("SELECT id FROM projects")).rows).toEqual(
    [],
  );
  expect((await database.pool.query("SELECT id FROM flows")).rows).toEqual([]);
  expect((await database.pool.query("SELECT id FROM runs")).rows).toEqual([]);
  const revision = (
    await database.pool.query(
      "SELECT authority_snapshot,snapshot FROM company_flow_binding_revisions WHERE binding_id=$1 AND revision=1",
      [result.binding.id],
    )
  ).rows[0]!;

  expect(revision.authority_snapshot).toMatchObject({
    schemaVersion: 1,
    actor: { kind: "user", id: requesterId },
    witness: { owner: input.owner, action: "specialists:manage" },
  });
  expect(revision.snapshot.manifest.nodes.at(-1)).toMatchObject({
    type: "human",
    settings: { roles: ["maintainer"] },
  });
  await expect(
    database.pool.query(
      "UPDATE company_flow_binding_revisions SET request_digest=repeat('0',64) WHERE binding_id=$1",
      [result.binding.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("retains immutable replacement/routing authority history, arbitrates CAS races and retires with original-key replay", async () => {
  const original = await createCompanyFlowBinding(
    database.db,
    requesterId,
    input,
  );

  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: requesterId,
    actions: ["assignments:answer"],
    idempotencyKey: randomUUID(),
  });
  const replacement = {
    ...input,
    enabled: false,
    roleMappings: { maintainer: [requesterId] },
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  };
  const changed = await updateCompanyFlowBinding(
    database.db,
    requesterId,
    original.binding.id,
    replacement,
  );

  expect(changed).toMatchObject({
    duplicate: false,
    binding: {
      revision: 2,
      configuration: {
        roleMappings: { maintainer: [requesterId] },
        routingAuthority: [
          {
            userId: requesterId,
            witness: { action: "assignments:answer", owner: input.owner },
          },
        ],
      },
    },
  });
  expect(
    await createCompanyFlowBinding(database.db, requesterId, input),
  ).toEqual({ ...original, duplicate: true });
  expect(
    await updateCompanyFlowBinding(
      database.db,
      requesterId,
      original.binding.id,
      replacement,
    ),
  ).toEqual({ ...changed, duplicate: true });
  await expect(
    updateCompanyFlowBinding(database.db, requesterId, original.binding.id, {
      ...replacement,
      roleMappings: input.roleMappings,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const raced = await Promise.allSettled(
    [reviewerId, requesterId].map((userId) =>
      updateCompanyFlowBinding(database.db, requesterId, original.binding.id, {
        ...replacement,
        roleMappings: { maintainer: [userId] },
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
      }),
    ),
  );

  expect(raced.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(raced.filter((item) => item.status === "rejected")).toMatchObject([
    { reason: { code: "CONFLICT" } },
  ]);
  expect(
    (
      await getCompanyFlowBindingRevision(
        database.db,
        requesterId,
        original.binding.id,
        1,
      )
    ).snapshot.roleMappings,
  ).toEqual({ maintainer: [reviewerId] });
  const reviewerGrant = (
    await database.pool.query(
      "SELECT id,revision FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND action='assignments:answer' AND revoked_at IS NULL",
      [reviewerId],
    )
  ).rows[0]!;

  await revokeCompanyGrant(database.db, administratorId, reviewerGrant.id, {
    expectedRevision: reviewerGrant.revision,
    reason: "Revoke coordinator answer routing",
    idempotencyKey: randomUUID(),
  });
  await expect(
    updateCompanyFlowBinding(database.db, requesterId, original.binding.id, {
      ...replacement,
      roleMappings: input.roleMappings,
      expectedRevision: 3,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(
    (
      await getCompanyFlowBindingRevision(
        database.db,
        requesterId,
        original.binding.id,
        1,
      )
    ).snapshot.routingAuthority,
  ).toMatchObject([
    {
      userId: reviewerId,
      witness: { authorityId: reviewerGrant.id, revision: 1 },
    },
  ]);
  expect(
    (await getCompanyFlowBinding(database.db, requesterId, original.binding.id))
      .revision,
  ).toBe(3);
  const retirement = {
    expectedRevision: 3,
    reason: "Retire reviewed company Flow configuration",
    idempotencyKey: randomUUID(),
  };
  const detached = await detachCompanyFlowBinding(
    database.db,
    requesterId,
    original.binding.id,
    retirement,
  );

  expect(detached).toEqual({
    id: original.binding.id,
    revision: 4,
    status: "detached",
    duplicate: false,
  });
  expect(
    await detachCompanyFlowBinding(
      database.db,
      requesterId,
      original.binding.id,
      retirement,
    ),
  ).toEqual({ ...detached, duplicate: true });
  expect(
    (
      await database.pool.query(
        "SELECT flow_revision_id,package_install_id,specialist_binding_id,enabled FROM company_flow_bindings WHERE id=$1",
        [original.binding.id],
      )
    ).rows[0],
  ).toEqual({
    flow_revision_id: null,
    package_install_id: null,
    specialist_binding_id: null,
    enabled: false,
  });
  await expect(
    updateCompanyFlowBinding(database.db, requesterId, original.binding.id, {
      ...replacement,
      expectedRevision: 4,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: reviewerId,
    actions: ["assignments:answer"],
    idempotencyKey: randomUUID(),
  });
});

it("refuses stale pins, unmapped or unauthorized human recipients and unsupported execution before storing reviewed configuration", async () => {
  const count = async (): Promise<number> =>
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM company_flow_bindings",
      )
    ).rows[0]!.count;
  const before = await count();
  const candidate = { ...input, idempotencyKey: randomUUID() };

  await expect(
    createCompanyFlowBinding(database.db, requesterId, {
      ...candidate,
      specialistRevision: 2,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    createCompanyFlowBinding(database.db, requesterId, {
      ...candidate,
      manifestSha256: "0".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    createCompanyFlowBinding(database.db, requesterId, {
      ...candidate,
      roleMappings: {},
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    createCompanyFlowBinding(database.db, requesterId, {
      ...candidate,
      roleMappings: { maintainer: [reviewerId], undeclared: [reviewerId] },
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    createCompanyFlowBinding(database.db, requesterId, {
      ...candidate,
      roleMappings: { maintainer: [administratorId] },
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    createCompanyFlowBinding(database.db, administratorId, candidate),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    createCompanyFlowBinding(database.db, requesterId, {
      ...candidate,
      enabled: true,
    }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: {
      reason: "company_execution_contract_unavailable",
      engineMin: "3.12.0",
    },
  });
  await database.pool.query(
    "UPDATE users SET must_change_password=true WHERE id=$1",
    [reviewerId],
  );
  try {
    await expect(
      createCompanyFlowBinding(database.db, requesterId, candidate),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  } finally {
    await database.pool.query(
      "UPDATE users SET must_change_password=false WHERE id=$1",
      [reviewerId],
    );
  }
  expect(await count()).toBe(before);
});

it("retains company cron sources and one existing invocation reservation per fire without changing the v1 scheduled request or dispatching through a project", async () => {
  const coordinator = await createCompanyFlowBinding(database.db, requesterId, {
    ...input,
    idempotencyKey: randomUUID(),
  });

  try {
    const source = {
      owner: input.owner,
      specialistBindingId: input.specialistBindingId,
      coordinatorFlowBindingId: coordinator.binding.id,
      cronExpr: "*/5 * * * *",
      timezone: "UTC",
      requestAtLaunch:
        "  Inspect company stand\r\nKeep this recurring request separate.  ",
      idempotencyKey: randomUUID(),
    };

    await expect(
      createCompanyCronSchedule(database.db, administratorId, source),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      createCompanyCronSchedule(database.db, requesterId, {
        ...source,
        enabled: true,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "company_scheduler_contract_unavailable" },
    });
    await expect(
      createCompanyCronSchedule(database.db, requesterId, {
        ...source,
        cronExpr: "not a valid cron",
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    const created = await createCompanyCronSchedule(
      database.db,
      requesterId,
      source,
    );

    expect(created).toMatchObject({
      owner: input.owner,
      configRevision: 1,
      duplicate: false,
    });
    expect(
      await createCompanyCronSchedule(database.db, requesterId, source),
    ).toEqual({ ...created, duplicate: true });
    await expect(
      createCompanyCronSchedule(database.db, requesterId, {
        ...source,
        requestAtLaunch: "Changed recurring input",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const separate = await createCompanyCronSchedule(database.db, requesterId, {
      ...source,
      idempotencyKey: randomUUID(),
    });

    expect(separate.scheduleId).not.toBe(created.scheduleId);
    // Activate only this owned storage fixture; production company dispatch/enablement is qualified in T22.1.
    const now = new Date(Date.now() + 1000);

    await database.pool.query(
      "UPDATE agent_schedules SET enabled=true,company_config_revision=2,next_fire_at=$2 WHERE id=$1",
      [created.scheduleId, new Date(now.getTime() - 1000)],
    );
    const claims = await Promise.all([
      claimCronAgentAttempt(
        database.db,
        created.scheduleId,
        now,
        new Date(now.getTime() + 300000),
      ),
      claimCronAgentAttempt(
        database.db,
        created.scheduleId,
        now,
        new Date(now.getTime() + 300000),
      ),
    ]);
    const claimed = claims.find((claim) => claim !== null)!;

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claimed).toMatchObject({
      projectId: null,
      companyId: input.owner.companyId,
      sourceAgentId: "rah:evidence-researcher",
      fence: 1,
      deliveryKey: "cron:1",
      bindingSnapshot: {
        version: 2,
        owner: input.owner,
        sourceRevision: 2,
        specialistBinding: {
          id: input.specialistBindingId,
          revision: 1,
          snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        coordinatorFlowBinding: {
          id: coordinator.binding.id,
          revision: 1,
          snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(
      parseScheduledRequestSnapshot(claimed.scheduledRequestSnapshot),
    ).toEqual({
      version: 1,
      scheduleId: created.scheduleId,
      triggerAttemptId: claimed.id,
      requestAtLaunch:
        "Inspect company stand\nKeep this recurring request separate.",
    });
    await expect(
      database.pool.query(
        "UPDATE agent_trigger_attempts SET company_id=NULL,project_id=$2 WHERE id=$1",
        [claimed.id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await database.pool.query(
      "UPDATE agent_schedules SET request_at_launch='Updated future request',company_config_revision=3 WHERE id=$1",
      [created.scheduleId],
    );
    expect(
      (
        await database.pool.query(
          "SELECT scheduled_request_snapshot FROM agent_trigger_attempts WHERE id=$1",
          [claimed.id],
        )
      ).rows[0]!.scheduled_request_snapshot,
    ).toEqual(claimed.scheduledRequestSnapshot);
    await expect(
      settleAgentTriggerAttempt(database.db, claimed, {
        outcome: "unknown",
        runId: null,
        reasonCode: "not_dispatched",
        now,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "company_trigger_runtime_unavailable" },
    });
    expect(
      await reconcileAgentTriggerAttempts(
        database.db,
        new Date(now.getTime() + 600000),
      ),
    ).toEqual({ adopted: 0, unknown: 0 });
    const rejectedAttemptId = randomUUID();
    const forgedBinding = {
      ...claimed.bindingSnapshot,
      sourceRevision: 3,
      specialistBinding: {
        id: input.specialistBindingId,
        revision: 1,
        snapshotSha256: "0".repeat(64),
      },
    };
    const client = await database.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE agent_schedules SET last_attempt_fence=2 WHERE id=$1",
        [created.scheduleId],
      );
      await expect(
        client.query(
          "INSERT INTO agent_trigger_attempts(id,project_id,company_id,source_agent_id,schedule_id,binding_snapshot,scheduled_request_snapshot,fence,delivery_key,trigger_source,reserved_run_id,claimed_at,due_at) VALUES($1,NULL,$2,'rah:evidence-researcher',$3,$4::jsonb,$5::jsonb,2,'cron:2','cron',$6,$7,$8)",
          [
            rejectedAttemptId,
            input.owner.companyId,
            created.scheduleId,
            JSON.stringify(forgedBinding),
            JSON.stringify({
              version: 1,
              scheduleId: created.scheduleId,
              triggerAttemptId: rejectedAttemptId,
              requestAtLaunch: "Updated future request",
            }),
            randomUUID(),
            now,
            new Date(now.getTime() + 300000),
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(
      await dispatchDueAgentSchedules({
        db: database.db,
        now: new Date(now.getTime() + 600000),
      }),
    ).toMatchObject({ due: 0, claimed: 0, launched: 0 });
    expect((await database.pool.query("SELECT id FROM projects")).rows).toEqual(
      [],
    );
    expect((await database.pool.query("SELECT id FROM runs")).rows).toEqual([]);
    await expect(
      database.pool.query(
        "UPDATE agent_schedules SET request_at_launch='Unversioned change' WHERE id=$1",
        [created.scheduleId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.pool.query("DELETE FROM agent_schedules WHERE id=$1", [
        created.scheduleId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    const catalog = (
      await database.pool.query(
        "SELECT to_jsonb(a) AS value FROM agents a WHERE id='rah:evidence-researcher'",
      )
    ).rows[0]!.value;

    await database.pool.query(
      "DELETE FROM agents WHERE id='rah:evidence-researcher'",
    );
    try {
      expect(
        (
          await database.pool.query(
            "SELECT id FROM agent_schedules WHERE id=ANY($1::text[])",
            [[created.scheduleId, separate.scheduleId]],
          )
        ).rows,
      ).toHaveLength(2);
      expect(
        await createCompanyCronSchedule(database.db, requesterId, source),
      ).toEqual({ ...created, duplicate: true });
    } finally {
      await database.pool.query(
        "INSERT INTO agents SELECT (jsonb_populate_record(NULL::agents,$1::jsonb)).*",
        [JSON.stringify(catalog)],
      );
    }
  } finally {
    await detachCompanyFlowBinding(
      database.db,
      requesterId,
      coordinator.binding.id,
      {
        expectedRevision: 1,
        reason: "Retire source qualification coordinator",
        idempotencyKey: randomUUID(),
      },
    );
  }
});

it("protects its own current Flow pin after specialist retirement and releases only current references on explicit Flow retirement", async () => {
  const candidate = { ...input, idempotencyKey: randomUUID() };
  const created = await createCompanyFlowBinding(
    database.db,
    requesterId,
    candidate,
  );
  const flow = (
    await database.pool.query<{ source: string }>(
      "SELECT source FROM flow_revisions WHERE id=$1",
      [input.flowRevisionId],
    )
  ).rows[0]!;

  await detachCompanySpecialistBinding(
    database.db,
    requesterId,
    "rah:evidence-researcher",
    input.specialistBindingId,
    {
      expectedRevision: 1,
      reason: "Retire responsible specialist independently",
      idempotencyKey: randomUUID(),
    },
  );
  await expect(
    removeRevision({
      flowRefId: "rah-control",
      revisionId: input.flowRevisionId,
      expectedSource: flow.source,
      db: database.db,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await database.pool.query(
    "UPDATE flow_revisions SET package_status='Removed',installed_at=now()-interval '90 days' WHERE id=$1",
    [input.flowRevisionId],
  );
  expect(await runRevisionGcSweep({ db: database.db })).toMatchObject({
    scanned: 1,
    deleted: 0,
    skippedReferenced: 1,
    failed: 0,
  });
  await detachCompanyFlowBinding(database.db, requesterId, created.binding.id, {
    expectedRevision: 1,
    reason: "Release coordinator provider pin",
    idempotencyKey: randomUUID(),
  });
  expect(await runRevisionGcSweep({ db: database.db })).toMatchObject({
    scanned: 1,
    deleted: 1,
    skippedReferenced: 0,
    failed: 0,
  });
  expect(
    (
      await getCompanyFlowBindingRevision(
        database.db,
        requesterId,
        created.binding.id,
        1,
      )
    ).snapshot.specialist.coordinatorFlowRevisionId,
  ).toBe(input.flowRevisionId);
  expect(
    await createCompanyFlowBinding(database.db, requesterId, candidate),
  ).toEqual({ ...created, duplicate: true });
});
