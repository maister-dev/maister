import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { PreparedSpecialistAssignment } from "../types";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { recoverInterruptedProjectIntakes } from "../project-source-recovery";
import { resumeQualifiedProjectAssignments } from "../project-source-resume";
import { loadProjectCoordinatorProvider } from "../project-flow-provider";
import { intakeSpecialistAssignmentInTransaction } from "../intake";
import { cancelSpecialistAssignment } from "../store";
import {
  advanceProjectRecoveryCursor,
  readProjectRecoveryCursor,
} from "../project-recovery-cursor";

import { parseAgentDefinition } from "@/lib/agents/definition";
import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { flowRevisions, flows } from "@/lib/db/schema";
import { contentDigest } from "@/lib/evaluations/digest";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { effectivePoolCap } from "@/lib/scheduler";
import { qualificationFixture } from "@/test-support/task-qualification";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import { mkdtempReal } from "@/test-support/worktree-test-root";

let database: StartedPostgresTestDb;
let root: string;
let fixture: Awaited<ReturnType<typeof seedTaskLaunchFixture>>;
let prepared: PreparedSpecialistAssignment;
const agentId = "recovery:coordinator";

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "project_source_recovery",
  });
  root = await mkdtempReal("project-source-recovery-");
  fixture = await seedTaskLaunchFixture(database, root);
  const installedPath = join(root, "package");
  const sourcePath = join(installedPath, "maister-agents/coordinator.md");

  await mkdir(join(installedPath, "maister-agents"), { recursive: true });
  await writeFile(
    sourcePath,
    `---\nname: Recovery coordinator\ndescription: Retain bounded project work\nflow: ${fixture.flowId}\nworkspace: none\nmode: session\ntriggers: [manual]\nrisk_tier: read_only\nspecialist:\n  responsibilities: [Inspect project evidence]\n  targetClasses: [project]\n---\nReturn the required diagnostic result.\n`,
  );
  const definition = parseAgentDefinition(
    agentId,
    await readFile(sourcePath, "utf8"),
  );
  const manifest = {
    schemaVersion: 1,
    name: "Recovery coordinator",
    compat: { engine_min: "3.7.0" },
    result: {
      export: {
        schema: "./schemas/result.v1.json",
        from: ["check"],
        required: true,
      },
    },
    nodes: [
      {
        id: "check",
        type: "cli",
        action: { command: "true" },
        output: {
          result: { schema: "./schemas/result.v1.json", required: true },
        },
        transitions: { success: "done" },
      },
    ],
  };
  const [revision] = await database.db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.flowRefId, fixture.flowId));

  await mkdir(join(revision.installedPath, "schemas"), { recursive: true });
  await writeFile(
    join(revision.installedPath, "schemas/result.v1.json"),
    JSON.stringify({
      schemaVersion: 1,
      fields: [{ name: "ok", type: "boolean", required: true }],
    }),
  );
  await database.db
    .update(flowRevisions)
    .set({ manifest, resolvedRevision: "recovery-pin" });
  await database.db.update(flows).set({ manifest });
  const packageInstallId = randomUUID();
  const attachmentId = randomUUID();

  await database.pool.query(
    "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status) VALUES($1,'local','recovery','v1','recovery-pin','{}',$2,$3,'Installed','trusted')",
    [packageInstallId, contentDigest({}), installedPath],
  );
  await database.pool.query(
    "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES($1,$2,$3,'recovery')",
    [randomUUID(), fixture.projectId, packageInstallId],
  );
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path,enabled,flow_ref) VALUES($1,'recovery','v1','authored','Recovery coordinator','Retain bounded project work','none','session','[\"manual\"]','read_only',$2,true,$3)",
    [agentId, sourcePath, fixture.flowId],
  );
  await database.pool.query(
    "INSERT INTO agent_project_links(id,project_id,agent_id,enabled,runner_override_id) VALUES($1,$2,$3,true,$4)",
    [attachmentId, fixture.projectId, agentId, fixture.runnerId],
  );
  const provider = await database.db.transaction((tx) =>
    loadProjectCoordinatorProvider(tx, fixture.projectId, fixture.flowId),
  );

  prepared = {
    owner: { kind: "project", projectId: fixture.projectId },
    specialistBindingId: attachmentId,
    responsibleAgentId: agentId,
    objectiveInput: {
      objective: "Recover bounded diagnostic work",
      expectedOutcome: "A required diagnostic result",
      input: "No service mutation is authorized.",
      targetIds: [],
      inputRefs: [],
      constraints: ["Research only"],
      expectedResult: {
        schemaRef: provider.resultContract.schemaRef,
        schemaVersion: provider.resultContract.schemaVersion,
        sha256: provider.resultContract.sha256,
        required: true,
      },
      verification: [],
    },
    standingDefinition: {
      schemaVersion: 2,
      agentId,
      packageInstallId,
      packageName: "recovery",
      packageRevision: "recovery-pin",
      definitionSha256: agentDefinitionSha256(definition),
      definition,
      configuration: null,
      coordinatorFlow: provider.snapshot,
    },
    scheduledRequest: null,
    sourceRestrictions: [],
    executionPolicy: { preset: "supervised" },
    origin: { kind: "manual", interactionId: randomUUID() },
    destination: { kind: "inbox", userId: fixture.userId },
  };
}, 180000);

afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function retainAssignment(userId: string): Promise<string> {
  const input = {
    ...prepared,
    origin: { kind: "manual" as const, interactionId: randomUUID() },
    destination: { kind: "inbox" as const, userId },
  };
  const { expectedResult: _result, ...objective } = input.objectiveInput;
  const receipt = await database.db.transaction((tx) =>
    intakeSpecialistAssignmentInTransaction(
      tx,
      userId,
      input.origin,
      {
        ...objective,
        owner: input.owner,
        specialistBindingId: input.specialistBindingId,
      },
      async () => input,
    ),
  );

  return receipt.assignment.id;
}

async function qualifyCarrier(taskId: string): Promise<void> {
  const carrier = (
    await database.pool.query<{
      qualification_input_revision: number;
      current_qualification_revision: number | null;
    }>(
      "SELECT qualification_input_revision,current_qualification_revision FROM tasks WHERE id=$1",
      [taskId],
    )
  ).rows[0];
  const qualification = await prepareTaskQualification(database.db, {
    projectId: fixture.projectId,
    taskId,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: carrier.qualification_input_revision,
      expectedQualificationRevision: carrier.current_qualification_revision,
      qualification: qualificationFixture(),
      enqueue: false,
    },
  });

  await database.db.transaction(qualification.apply);
}

it("recovers authorized project intake and qualified work beyond 100 currently revoked assignments without changing their retained input", async () => {
  const assignments: Array<{ id: string; userId: string }> = [];

  for (let index = 0; index < 101; index++) {
    const userId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES($1,$2,'member','active',false)",
      [userId, `${userId}@example.test`],
    );
    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
      [randomUUID(), fixture.projectId, userId],
    );
    assignments.push({ id: await retainAssignment(userId), userId });
  }
  const healthy = assignments[100];
  const refusedUsers = assignments.slice(0, 100).map((entry) => entry.userId);
  const before = (
    await database.pool.query(
      "SELECT assignment_id,digest FROM specialist_input_revisions ORDER BY assignment_id",
    )
  ).rows;

  await database.pool.query(
    "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=ANY($2::text[])",
    [fixture.projectId, refusedUsers],
  );
  expect(await recoverInterruptedProjectIntakes(database.db)).toBe(0);
  const lateIntakeId = await retainAssignment(healthy.userId);

  expect(await recoverInterruptedProjectIntakes(database.db)).toBe(1);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM specialist_assignments WHERE project_id=$1 AND project_task_id IS NOT NULL",
        [fixture.projectId],
      )
    ).rows,
  ).toEqual([{ id: healthy.id }]);
  await cancelSpecialistAssignment(
    database.db,
    healthy.userId,
    lateIntakeId,
    1,
    "Withdraw the request which arrived after this recovery cycle started",
  );

  await database.pool.query(
    "UPDATE project_members SET role='member' WHERE project_id=$1",
    [fixture.projectId],
  );
  expect(await recoverInterruptedProjectIntakes(database.db)).toBe(100);
  const carriers = (
    await database.pool.query<{
      id: string;
      project_task_id: string;
      qualification_input_revision: number;
      current_qualification_revision: number | null;
    }>(
      "SELECT head.id,head.project_task_id,carrier.qualification_input_revision,carrier.current_qualification_revision FROM specialist_assignments head JOIN tasks carrier ON carrier.id=head.project_task_id WHERE head.project_id=$1 ORDER BY head.created_at,head.id",
      [fixture.projectId],
    )
  ).rows;

  for (const carrier of carriers) await qualifyCarrier(carrier.project_task_id);
  await database.pool.query(
    "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=ANY($2::text[])",
    [fixture.projectId, refusedUsers],
  );
  const { cap } = await effectivePoolCap(database.db, "flow");

  await database.pool.query(
    "INSERT INTO runs(id,project_id,run_kind,flow_version,status) SELECT gen_random_uuid()::text,$1,'flow','capacity-fixture','Running' FROM generate_series(1,$2::integer)",
    [fixture.projectId, cap],
  );
  expect(await resumeQualifiedProjectAssignments(database.db)).toBe(0);
  const lateResumeId = await retainAssignment(healthy.userId);

  expect(await recoverInterruptedProjectIntakes(database.db)).toBe(0);
  expect(await recoverInterruptedProjectIntakes(database.db)).toBe(1);
  const lateResumeTaskId = (
    await database.pool.query<{ project_task_id: string }>(
      "SELECT project_task_id FROM specialist_assignments WHERE id=$1",
      [lateResumeId],
    )
  ).rows[0].project_task_id;

  await qualifyCarrier(lateResumeTaskId);
  const jobTarget = async (): Promise<unknown> =>
    (
      await database.pool.query(
        "SELECT target FROM scheduler_jobs WHERE id='auto_launch_triaged.default'",
      )
    ).rows[0].target;
  const beforeTargeted = await jobTarget();
  const targeted = assignments[0];
  const targetedCarrier = carriers.find((entry) => entry.id === targeted.id)!;

  await database.pool.query(
    "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
    [fixture.projectId, targeted.userId],
  );
  expect(
    await resumeQualifiedProjectAssignments(
      database.db,
      fixture.projectId,
      targetedCarrier.project_task_id,
    ),
  ).toBe(1);
  expect(await jobTarget()).toEqual(beforeTargeted);
  expect(await resumeQualifiedProjectAssignments(database.db)).toBe(1);
  expect(await resumeQualifiedProjectAssignments(database.db)).toBe(1);
  expect(
    (
      await database.pool.query(
        "SELECT head.id FROM specialist_assignments head JOIN task_launch_intents intent ON intent.task_id=head.project_task_id WHERE head.project_id=$1 ORDER BY head.id",
        [fixture.projectId],
      )
    ).rows,
  ).toEqual(
    [{ id: targeted.id }, { id: healthy.id }, { id: lateResumeId }].sort(
      (left, right) => left.id.localeCompare(right.id),
    ),
  );
  expect(
    (
      await database.pool.query(
        "SELECT state,run_id FROM task_launch_intents WHERE project_id=$1",
        [fixture.projectId],
      )
    ).rows,
  ).toEqual([
    { state: "queued", run_id: null },
    { state: "queued", run_id: null },
    { state: "queued", run_id: null },
  ]);
  expect(
    (
      await database.pool.query(
        "SELECT assignment_id,digest FROM specialist_input_revisions WHERE assignment_id=ANY($1::text[]) ORDER BY assignment_id",
        [assignments.map((entry) => entry.id)],
      )
    ).rows,
  ).toEqual(before);
}, 180000);

it("serializes independent recovery cursor revisions across overlapping scans and wraparound without replacing scheduler target fields", async () => {
  const initial = await readProjectRecoveryCursor(
    database.db,
    "projectIntakeRecoveryCursor",
  );
  const sibling = await readProjectRecoveryCursor(
    database.db,
    "projectQualifiedResumeCursor",
  );

  await database.pool.query(
    "UPDATE scheduler_jobs SET target=target||'{\"operatorMetadata\":\"preserved\"}'::jsonb WHERE id='auto_launch_triaged.default'",
  );
  const first = {
    id: randomUUID(),
    createdAt: "2026-11-09T10:00:00.000123Z",
  };
  const second = {
    id: randomUUID(),
    createdAt: "2026-11-09T10:00:00.000124Z",
  };
  const raced = await Promise.all([
    advanceProjectRecoveryCursor(database.db, initial, first),
    advanceProjectRecoveryCursor(database.db, initial, second),
  ]);

  expect(raced.filter(Boolean)).toHaveLength(1);
  const current = await readProjectRecoveryCursor(database.db, initial.key);

  expect(current.value?.after).toEqual(raced[0] ? first : second);
  expect(await advanceProjectRecoveryCursor(database.db, current, null)).toBe(
    true,
  );
  expect(await advanceProjectRecoveryCursor(database.db, initial, first)).toBe(
    false,
  );
  expect(await readProjectRecoveryCursor(database.db, sibling.key)).toEqual(
    sibling,
  );
  expect(
    (
      await database.pool.query(
        "SELECT target->>'operatorMetadata' AS metadata FROM scheduler_jobs WHERE id='auto_launch_triaged.default'",
      )
    ).rows[0],
  ).toEqual({ metadata: "preserved" });
  const snapshot = (
    await database.pool.query(
      "SELECT target FROM scheduler_jobs WHERE id='auto_launch_triaged.default'",
    )
  ).rows[0].target;

  try {
    await database.pool.query(
      "UPDATE scheduler_jobs SET target=jsonb_set(target,'{projectIntakeRecoveryCursor}','{\"revision\":-1,\"after\":null}'::jsonb) WHERE id='auto_launch_triaged.default'",
    );
    await expect(
      readProjectRecoveryCursor(database.db, initial.key),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "project_recovery_cursor_invalid" },
    });
  } finally {
    await database.pool.query(
      "UPDATE scheduler_jobs SET target=$1::jsonb WHERE id='auto_launch_triaged.default'",
      [JSON.stringify(snapshot)],
    );
  }
});
