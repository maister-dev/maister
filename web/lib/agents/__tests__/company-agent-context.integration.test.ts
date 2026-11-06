import type { SessionUser } from "@/lib/authz";
import type { Db } from "@/lib/execution-host/db";
import type { OperationalWorkspaceContext } from "../operational-context";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { CompanyAgentExecutionSnapshot } from "../company-agent-execution-types";
import type { PreparedSpecialistAssignment } from "@/lib/specialist-assignments/types";

import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { join, resolve, sep } from "node:path";

import { parse } from "yaml";
import Ajv from "ajv";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  prepareCompanyAgentContext,
  captureCompanyAgentExecution,
} from "../company-agent-context";
import { detachCompanySpecialistBinding } from "../company-binding-mutations";
import { createCompanySpecialistBinding } from "../company-bindings";
import { resolveInstalledAgentDefinition } from "../effective";
import {
  agentDefinitionSha256,
  buildAgentActivitySnapshot,
} from "../activity-snapshot";
import {
  issueCompanyAgentRunToken,
  revokeAgentRunTokensForRun,
} from "../tokens";
import { buildOperationalContract } from "../launch-contract";
import {
  operationalWorkspace,
  operationalReferenceEvidence,
  inspectOperationalWorkspace,
} from "../operational-context";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
} from "../operational-integrity";
import {
  prepareAgentRunFinalization,
  prepareUndispatchedAgentFailure,
} from "../finalization";
import { reserveCompanyAgentRun } from "../company-agent-launch";
import { startAgentSession } from "../launch";
import { getCompanyAgentRunHistory } from "../activity-queries";

import { readTranscriptPage } from "@/lib/runs/transcript-page";
import { authorizePeekRun } from "@/lib/runs/peek-read-model";
import { requireActiveUserById } from "@/lib/authz";
import { GET as companyHistoryGet } from "@/app/api/specialists/[specialistId]/runs/route";
import { GET as streamGet } from "@/app/api/runs/[runId]/stream/route";
import {
  getRuntimeObjectForRun,
  publishRuntimeObject,
} from "@/lib/execution-host/runtime-objects";
import { authorizeRuntimeObjectContentActor } from "@/lib/execution-host/runtime-object-access";
import {
  runs,
  platformAcpRunners,
  platformRuntimeSettings,
} from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
  scriptAgentTurn,
} from "@/test-support/fake-execution-host";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import {
  tryStartRun,
  promoteNextPending,
  countLiveRuns,
} from "@/lib/scheduler";
import { disposeOperationalRun } from "@/lib/gc/operational-disposition";
import { operationalSuccessFixture } from "@/test-support/operational-agent";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import {
  knowledgeSourceReadPolicy,
  knowledgeReadPolicyCte,
} from "@/lib/brain/knowledge-query-policy";
import { assertNativeRunKnowledgeInputs } from "@/lib/brain/knowledge-execution-access";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { searchKnowledge } from "@/lib/brain/knowledge-search";
import {
  createKnowledgeProposal,
  reviewKnowledgeProposal,
} from "@/lib/brain/knowledge-proposals";
import { verifyToken, actorUserIdForToken } from "@/lib/tokens/verify";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import {
  createSpecialistAssignment,
  cancelSpecialistAssignment,
  linkSpecialistAssignmentRunInTransaction,
} from "@/lib/specialist-assignments/store";
import {
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { git, initRepo } from "@/test-support/git-fixture";

const browserSession = vi.hoisted(() => ({ user: null as SessionUser | null }));
let database: StartedPostgresTestDb;
let root: string;
let assignmentInput: PreparedSpecialistAssignment;
let grantId: string;
let request: {
  companyId: string;
  assignmentId: string;
  assignmentRevision: number;
  inputRevision: number;
  bindingId: string;
  bindingRevision: number;
  triggerSource: "manual";
};
const administratorId = randomUUID();
const userId = randomUUID();
const agentId = "rah:evidence-researcher";

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => {
    if (!browserSession.user)
      throw new Error("The company read fixture has no authenticated session");

    return browserSession.user;
  },
}));

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", "company-agent-knowledge-cursor-fixture");
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "company_agent_context",
  });
  root = await realpath(
    await mkdtemp(join(os.tmpdir(), "company-agent-context-")),
  );
  vi.stubEnv("MAISTER_WORKTREES_ROOT", join(root, "worktrees"));
  vi.spyOn(os, "homedir").mockReturnValue(root);
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active'),($3,$4,'member','active')",
    [
      administratorId,
      `${administratorId}@example.test`,
      userId,
      `${userId}@example.test`,
    ],
  );
  const grants = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: [
      "specialists:manage",
      "specialists:read",
      "assignments:read",
      "assignments:submit",
      "assignments:update",
      "assignments:cancel",
    ],
    idempotencyKey: randomUUID(),
  });

  grantId = (
    await database.pool.query(
      "SELECT id FROM company_grants WHERE principal_id=$1 AND action='assignments:update'",
      [userId],
    )
  ).rows[0]!.id;
  const source = join(root, "source");

  await cp(resolve("test-fixtures/rah-native"), source, {
    recursive: true,
    filter: (path) => !path.split(sep).includes(".git"),
  });
  await writeFile(
    join(source, "maister-agents/evidence-researcher.md"),
    "---\nname: Operations observer\ndescription: Diagnose authorized stand state\nkind: operational\ncompletion: {contract: operational_v1}\nspecialist:\n  responsibilities: [Inspect authorized stand state]\n  targetClasses: [stand]\nmode: session\nworkspace: none\ntriggers: [manual, cron]\nrisk_tier: read_only\nconfig:\n  - key: label\n    type: string\n    default: base\n---\nInspect the authorized target. Preserve missing evidence.\n",
  );
  const primarySource = await readFile(
    join(source, "maister-agents/evidence-researcher.md"),
    "utf8",
  );

  await writeFile(
    join(source, "maister-agents/repo-observer.md"),
    primarySource.replace("workspace: none", "workspace: repo_read"),
  );
  await writeFile(
    join(source, "maister-agents/flow-coordinator.md"),
    primarySource
      .replace(
        "kind: operational\ncompletion: {contract: operational_v1}\n",
        "",
      )
      .replace("workspace: none", "flow: rah-control\nworkspace: none"),
  );
  await writeFile(
    join(source, "maister-agents/disabled-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/runner-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/memory-observer.md"),
    primarySource.replace(
      "workspace: none",
      "memory: enabled\nworkspace: none",
    ),
  );
  await writeFile(
    join(source, "maister-agents/wire-observer.md"),
    primarySource +
      "fixture-output:" +
      JSON.stringify({
        bytes: 0,
        text:
          "```json maister:output\n" +
          JSON.stringify(operationalSuccessFixture()) +
          "\n```",
      }) +
      "\n",
  );
  await initRepo(source);
  await git(
    source,
    "tag",
    "-a",
    "rah/company-agent-context",
    "-m",
    "Synthetic company agent admission fixture",
  );
  const installed = await installPackageRevision({
    db: database.db,
    source,
    version: "rah/company-agent-context",
  });

  await trustPackageRevision({
    db: database.db,
    packageInstallId: installed.id,
  });
  const definition = await resolveInstalledAgentDefinition(database.db, {
    agentId,
    packageInstallId: installed.id,
  });
  const binding = await createCompanySpecialistBinding(
    database.db,
    userId,
    agentId,
    {
      owner: { kind: "company", companyId: grants.page.companyId },
      packageInstallId: installed.id,
      packageRevision: definition.resolvedRevision!,
      definitionSha256: agentDefinitionSha256(definition.parsed),
      enabled: true,
      configuration: {},
      grantActions: ["knowledge:read", "knowledge:propose"],
      idempotencyKey: randomUUID(),
    },
  );
  const result = buildOperationalContract(definition);

  assignmentInput = {
    owner: binding.specialist.owner,
    specialistBindingId: binding.specialist.bindingId,
    responsibleAgentId: agentId,
    standingDefinition: {
      schemaVersion: 1,
      agentId,
      packageInstallId: installed.id,
      packageName: definition.packageName,
      packageRevision: definition.resolvedRevision!,
      definitionSha256: agentDefinitionSha256(definition.parsed),
      definition: definition.parsed,
      configuration: {},
    },
    objectiveInput: {
      objective: "Diagnose the configured stand",
      expectedOutcome: "Typed diagnostic outcome",
      input: "No restart authorized",
      targetIds: [],
      inputRefs: [],
      constraints: ["Read only"],
      expectedResult: {
        schemaRef: result.schemaRef,
        schemaVersion: result.schemaVersion,
        sha256: result.sha256,
        required: true,
      },
      verification: [],
    },
    scheduledRequest: null,
    sourceRestrictions: [],
    executionPolicy: { preset: "supervised" },
    origin: { kind: "manual", interactionId: randomUUID() },
    destination: { kind: "inbox", userId },
  };
  const assignment = await createSpecialistAssignment(
    database.db,
    userId,
    assignmentInput,
  );

  request = {
    companyId: grants.page.companyId,
    assignmentId: assignment.id,
    assignmentRevision: 1,
    inputRevision: 1,
    bindingId: binding.specialist.bindingId,
    bindingRevision: 1,
    triggerSource: "manual",
  };
}, 180000);

afterAll(async () => {
  try {
    await database?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it("CBS-02 preflights a real pinned company specialist and exact assignment input without a project or admission effects", async () => {
  const context = await database.db.transaction((tx) =>
    prepareCompanyAgentContext(tx, userId, request),
  );

  expect(context).toMatchObject({
    owner: assignmentInput.owner,
    assignment: { id: request.assignmentId, revision: 1, inputRevision: 1 },
    binding: { bindingId: request.bindingId, revision: 1 },
    effective: {
      parsed: { id: agentId, kind: "operational", workspace: "none" },
    },
    input: {
      revision: 1,
      snapshot: { objectiveInput: assignmentInput.objectiveInput },
    },
    authority: { actor: { kind: "user", id: userId } },
  });
  expect(
    (
      await database.pool.query(
        "SELECT (SELECT count(*)::int FROM projects) AS projects,(SELECT count(*)::int FROM runs) AS runs,(SELECT count(*)::int FROM project_tokens) AS tokens",
      )
    ).rows[0],
  ).toEqual({ projects: 0, runs: 0, tokens: 0 });
});

it("CBS-02 adopts the server-resolved company directory through the real supervisor wire and retains its owner", async () => {
  const db: Db = database.db;
  const supervisor = await startRealSupervisor({
    runtimeRoot: join(root, "adoption-host"),
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);

  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    const { runId } = await reserveCompanyFixtureRun();
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    const owner = await operationalWorkspace(db, run);

    await mkdir(owner.cwd, { recursive: true });
    const hosts = createExecutionHosts({
      db,
      transport: createLocalDirectTransport(),
    });
    const client = await hosts.forRun(runId, { reason: "launch" });
    const handle = await client.ensureWorkspace();
    const record = await hosts.local().getWorkspace(handle);

    expect(record).toMatchObject({
      runId,
      owner: { kind: "company", companyId: request.companyId },
      projectSlug: "_company",
      kind: "directory",
      releasedAt: null,
    });
    expect(await client.ensureWorkspace()).toBe(handle);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='workspace.adopt'",
          [runId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(
      (
        await database.pool.query("SELECT project_id FROM runs WHERE id=$1", [
          runId,
        ])
      ).rows[0],
    ).toEqual({ project_id: null });
    const prepared = await prepareUndispatchedAgentFailure(runId, {
      db,
      reason: "fixture_adoption_probe_complete",
    });
    const finalized = await db.transaction((tx) => prepared.apply(tx));

    expect(finalized.finalized).toBe(true);
  } finally {
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    resetRegistrarStateForTests();
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
}, 120000);

it("CBS-02 completes a company assignment Run through the real supervisor and ACP process with physical quiescence", async () => {
  const db: Db = database.db;
  const supervisor = await startRealSupervisor({
    runtimeRoot: join(root, "company-driver-host"),
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const worker = startProjectionWorker({ db, projectors: canonicalProjectors });
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", "100");
  try {
    const roleId = "rah:wire-observer";
    const effective = await resolveInstalledAgentDefinition(db, {
      agentId: roleId,
      packageInstallId: assignmentInput.standingDefinition.packageInstallId,
    });
    const runnerId = randomUUID();

    await db.insert(platformAcpRunners).values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "company-wire-fixture",
      provider: { kind: "anthropic" },
      readinessStatus: "Ready",
    });
    const binding = await createCompanySpecialistBinding(db, userId, roleId, {
      owner: { kind: "company", companyId: request.companyId },
      packageInstallId: effective.packageInstallId,
      packageRevision: effective.resolvedRevision!,
      definitionSha256: agentDefinitionSha256(effective.parsed),
      enabled: true,
      configuration: {},
      grantActions: ["knowledge:read", "knowledge:propose"],
      runnerId,
      idempotencyKey: randomUUID(),
    });
    const contract = buildOperationalContract(effective);
    const assignment = await createSpecialistAssignment(db, userId, {
      ...assignmentInput,
      specialistBindingId: binding.specialist.bindingId,
      responsibleAgentId: roleId,
      standingDefinition: {
        ...assignmentInput.standingDefinition,
        agentId: roleId,
        definition: effective.parsed,
        definitionSha256: agentDefinitionSha256(effective.parsed),
      },
      objectiveInput: {
        ...assignmentInput.objectiveInput,
        expectedResult: {
          schemaRef: contract.schemaRef,
          schemaVersion: contract.schemaVersion,
          sha256: contract.sha256,
          required: true,
        },
      },
    });
    const hosts = createExecutionHosts({
      db,
      transport: createLocalDirectTransport(),
    });
    const beforeUnconfigured = (
      await database.pool.query(
        "SELECT (SELECT count(*) FROM runs) AS runs,(SELECT count(*) FROM run_sessions) AS sessions,(SELECT count(*) FROM specialist_run_links) AS links",
      )
    ).rows[0];

    await expect(
      reserveCompanyAgentRun(db, userId, request, hosts),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
    expect(
      (
        await database.pool.query(
          "SELECT (SELECT count(*) FROM runs) AS runs,(SELECT count(*) FROM run_sessions) AS sessions,(SELECT count(*) FROM specialist_run_links) AS links",
        )
      ).rows[0],
    ).toEqual(beforeUnconfigured);
    const receipt = await reserveCompanyAgentRun(
      db,
      userId,
      {
        ...request,
        assignmentId: assignment.id,
        bindingId: binding.specialist.bindingId,
      },
      hosts,
    );

    expect(await tryStartRun(receipt.runId, { db })).toMatchObject({
      started: true,
    });
    await startAgentSession(receipt.runId, { db, executionHosts: hosts });
    await startAgentSession(receipt.runId, { db, executionHosts: hosts });
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, receipt.runId));

    expect(run).toMatchObject({
      status: "Done",
      projectId: null,
      companyId: request.companyId,
      operationalTerminal: { effectiveOutcome: "success" },
    });
    const commands = await database.pool.query(
      "SELECT kind,state FROM execution_commands WHERE run_id=$1 ORDER BY created_at,id",
      [receipt.runId],
    );

    expect(
      commands.rows.filter((command) => command.kind === "session.create"),
    ).toHaveLength(1);
    expect(
      commands.rows.filter((command) => command.kind === "session.prompt"),
    ).toHaveLength(1);
    expect(
      commands.rows.some((command) => command.kind === "workspace.adopt"),
    ).toBe(true);
    const sessions = await hosts.local().listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: "exited" });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM run_results WHERE run_id=$1 AND validity='valid'",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM project_tokens WHERE company_run_id=$1 AND revoked_at IS NULL",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    expect(
      (
        await database.pool.query(
          "SELECT status,revision FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ status: "active", revision: 3 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_assignments WHERE run_id=$1 AND state='active'",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    await expect(
      authorizePeekRun(userId, receipt.runId),
    ).resolves.toMatchObject({ canReadTranscript: true });
    const transcript = await readTranscriptPage(userId, receipt.runId, {
      limit: "20",
    });

    expect(JSON.stringify(transcript.messages)).toContain("maister:output");
  } finally {
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
    await worker.stop();
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    resetRegistrarStateForTests();
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
}, 90000);

it("CBS-02 shares the existing bounded agent pool across project and company work and promotes a queued company run once", async () => {
  const db: Db = database.db;
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", "1");
  try {
    const project = await seedProjectRow(database.db);
    const projectRunId = randomUUID();

    await database.pool.query(
      "INSERT INTO runs(id,run_kind,project_id,agent_id,agent_workspace,flow_version,flow_revision,status) VALUES($1,'agent',$2,$3,'none','agent','manual','Pending')",
      [projectRunId, project.id, agentId],
    );
    const first = await reserveCompanyFixtureRun();
    const second = await reserveCompanyFixtureRun();

    expect(await tryStartRun(projectRunId, { db })).toMatchObject({
      started: true,
    });
    expect(await tryStartRun(first.runId, { db })).toMatchObject({
      started: false,
    });
    expect(await tryStartRun(second.runId, { db })).toMatchObject({
      started: false,
    });
    expect(await countLiveRuns(db, "agent")).toBe(1);
    const projectFailure = await prepareUndispatchedAgentFailure(projectRunId, {
      db,
      reason: "fixture_before_dispatch",
    });

    await db.transaction((tx) => projectFailure.apply(tx));
    const contenders = [first.runId, second.runId];
    const outcomes = await Promise.all(
      contenders.map((runId) => tryStartRun(runId, { db })),
    );

    expect(outcomes.filter((outcome) => outcome.started)).toHaveLength(1);
    expect(await countLiveRuns(db, "agent")).toBe(1);
    const winner = contenders[outcomes.findIndex((outcome) => outcome.started)];
    const queued =
      contenders[outcomes.findIndex((outcome) => !outcome.started)];
    const undispatched = await prepareUndispatchedAgentFailure(winner, {
      db,
      reason: "fixture_before_dispatch",
    });

    await db.transaction((tx) => undispatched.apply(tx));
    expect(await countLiveRuns(db, "agent")).toBe(0);
    const dispatched: string[] = [];
    const promoted = await promoteNextPending({
      db,
      pool: "agent",
      startAgentRun: (id) => {
        dispatched.push(id);
      },
    });

    expect(promoted).toMatchObject({ promotedRunId: queued });
    expect(dispatched).toEqual([queued]);
    expect(await countLiveRuns(db, "agent")).toBe(1);
    await promoteNextPending({
      db,
      pool: "agent",
      startAgentRun: (id) => {
        dispatched.push(id);
      },
    });
    expect(dispatched).toEqual([queued]);
    expect(
      (
        await database.pool.query(
          "SELECT run_id,project_id FROM webhook_events WHERE run_id=ANY($1::text[]) AND type='run.started'",
          [[projectRunId, ...contenders]],
        )
      ).rows,
    ).toEqual([{ run_id: projectRunId, project_id: project.id }]);
    const last = await prepareUndispatchedAgentFailure(queued, {
      db,
      reason: "fixture_before_dispatch",
    });

    await db.transaction((tx) => last.apply(tx));
  } finally {
    vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", previousCap);
  }
});

it("CBS-02 atomically reserves one company execution with frozen session and placement under concurrent admission", async () => {
  const db: Db = database.db;
  const { hosts, hostId } = await fakeExecutionHosts(db);
  const runnerId = randomUUID();

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "fixture",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  await db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });
  const assignment = await createSpecialistAssignment(
    db,
    userId,
    assignmentInput,
  );
  const admission = { ...request, assignmentId: assignment.id };

  try {
    const outcomes = await Promise.allSettled([
      reserveCompanyAgentRun(db, userId, admission, hosts),
      reserveCompanyAgentRun(db, userId, admission, hosts),
    ]);
    const accepted = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const refused = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(outcomes, "one native reservation must commit").toContainEqual(
      expect.objectContaining({ status: "fulfilled" }),
    );
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reason: { code: "CONFLICT" } });
    if (accepted[0]?.status !== "fulfilled")
      throw new Error("Company admission did not reserve its execution");
    const receipt = accepted[0].value;

    expect(receipt).toMatchObject({
      assignmentId: assignment.id,
      assignmentRevision: 3,
      status: "Pending",
    });
    const stored = (
      await database.pool.query(
        "SELECT execution.project_id,execution.company_id,execution.agent_config,execution.execution_policy,execution.status,execution.knowledge_access,session.runner_id,session.runner_resolution_tier,placement.execution_host_id,placement.epoch,assignment.status AS assignment_status,link.input_revision FROM runs execution JOIN run_sessions session ON session.run_id=execution.id JOIN execution_assignments placement ON placement.run_id=execution.id JOIN specialist_run_links link ON link.run_id=execution.id JOIN specialist_assignments assignment ON assignment.id=link.assignment_id WHERE execution.id=$1",
        [receipt.runId],
      )
    ).rows;

    expect(stored).toEqual([
      expect.objectContaining({
        project_id: null,
        company_id: request.companyId,
        agent_config: { label: "base" },
        execution_policy: { preset: "supervised" },
        status: "Pending",
        runner_id: runnerId,
        runner_resolution_tier: "platformDefault",
        execution_host_id: hostId,
        epoch: 1,
        assignment_status: "active",
        input_revision: 1,
      }),
    ]);
    expect(stored[0].knowledge_access).toMatchObject({
      state: "complete",
      restrictions: [
        {
          kind: "assignment_input",
          assignmentId: assignment.id,
          inputRevision: 1,
        },
      ],
    });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM project_tokens WHERE company_run_id=$1",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    const source = await seedProjectRow(database.db);

    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
      [randomUUID(), source.id, userId],
    );
    const restricted = await createSpecialistAssignment(db, userId, {
      ...assignmentInput,
      sourceRestrictions: [{ kind: "project_context", projectId: source.id }],
    });
    const before = (
      await database.pool.query(
        "SELECT (SELECT count(*) FROM runs) AS runs,(SELECT count(*) FROM run_sessions) AS sessions,(SELECT count(*) FROM execution_assignments) AS placements,(SELECT count(*) FROM specialist_run_links) AS links,(SELECT count(*) FROM domain_events) AS events",
      )
    ).rows[0];

    await expect(
      reserveCompanyAgentRun(
        db,
        userId,
        { ...request, assignmentId: restricted.id },
        hosts,
      ),
    ).rejects.toMatchObject({
      details: { reason: "knowledge_reference_unavailable" },
    });
    expect(
      (
        await database.pool.query(
          "SELECT (SELECT count(*) FROM runs) AS runs,(SELECT count(*) FROM run_sessions) AS sessions,(SELECT count(*) FROM execution_assignments) AS placements,(SELECT count(*) FROM specialist_run_links) AS links,(SELECT count(*) FROM domain_events) AS events",
        )
      ).rows[0],
    ).toEqual(before);
    expect(
      (
        await database.pool.query(
          "SELECT status,revision FROM specialist_assignments WHERE id=$1",
          [restricted.id],
        )
      ).rows[0],
    ).toEqual({ status: "queued", revision: 1 });
    await database.pool.query("DELETE FROM projects WHERE id=$1", [source.id]);
  } finally {
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
});

it("CBS-02 uses the exact company binding runner and refuses its kill switch instead of choosing a ready platform default", async () => {
  const db: Db = database.db;
  const { hosts } = await fakeExecutionHosts(db);
  const runnerId = randomUUID();
  const roleId = "rah:runner-observer";
  const effective = await resolveInstalledAgentDefinition(db, {
    agentId: roleId,
    packageInstallId: assignmentInput.standingDefinition.packageInstallId,
  });

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "binding-fixture",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  const binding = await createCompanySpecialistBinding(db, userId, roleId, {
    owner: { kind: "company", companyId: request.companyId },
    packageInstallId: effective.packageInstallId,
    packageRevision: effective.resolvedRevision!,
    definitionSha256: agentDefinitionSha256(effective.parsed),
    enabled: true,
    configuration: {},
    grantActions: [],
    runnerId,
    idempotencyKey: randomUUID(),
  });
  const assignment = await createSpecialistAssignment(db, userId, {
    ...assignmentInput,
    specialistBindingId: binding.specialist.bindingId,
    responsibleAgentId: roleId,
    standingDefinition: {
      ...assignmentInput.standingDefinition,
      agentId: roleId,
      definition: effective.parsed,
      definitionSha256: agentDefinitionSha256(effective.parsed),
    },
  });
  const admission = {
    ...request,
    assignmentId: assignment.id,
    bindingId: binding.specialist.bindingId,
  };

  try {
    await db
      .update(platformAcpRunners)
      .set({ enabled: false })
      .where(eq(platformAcpRunners.id, runnerId));
    await expect(
      reserveCompanyAgentRun(db, userId, admission, hosts),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
    expect(
      (
        await database.pool.query(
          "SELECT status,revision FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ status: "queued", revision: 1 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM specialist_run_links WHERE assignment_id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    await db
      .update(platformAcpRunners)
      .set({ enabled: true })
      .where(eq(platformAcpRunners.id, runnerId));
    const receipt = await reserveCompanyAgentRun(db, userId, admission, hosts);

    expect(
      (
        await database.pool.query(
          "SELECT runner_id,runner_resolution_tier,runner_snapshot->>'model' AS model FROM run_sessions WHERE run_id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([
      {
        runner_id: runnerId,
        runner_resolution_tier: "binding",
        model: "binding-fixture",
      },
    ]);
  } finally {
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
});

it("CBS-02 dispatches a company assignment through the existing owned agent driver and verifies its operational result", async () => {
  const db: Db = database.db;
  const fake = createFakeExecutionHost();
  const { prompts } = scriptAgentTurn(fake, {
    text:
      "```json maister:output\n" +
      JSON.stringify(operationalSuccessFixture()) +
      "\n```",
    onPrompt: ({ sessionId }) => {
      const session = fake.sessions.get(sessionId);

      if (!session)
        throw new Error("The scripted operational session was not created");
      fake.sessions.set(sessionId, {
        ...session,
        status: "exited",
        exitCode: 0,
        exitedAt: new Date().toISOString(),
      });

      return { stopReason: "end_turn", meta: null };
    },
  });
  const { hosts } = await fakeExecutionHosts(db, { fake });
  const runnerId = randomUUID();
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "company-driver-fixture",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  await db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });
  const assignment = await createSpecialistAssignment(
    db,
    userId,
    assignmentInput,
  );
  const receipt = await reserveCompanyAgentRun(
    db,
    userId,
    { ...request, assignmentId: assignment.id },
    hosts,
  );

  vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", "100");
  try {
    expect(await tryStartRun(receipt.runId, { db })).toMatchObject({
      started: true,
    });
    await publishRuntimeObject({
      client: await hosts.forRun(receipt.runId),
      kind: "generated_artifact",
      logicalName: "diagnosis.txt",
      mimeType: "text/plain",
      retentionClass: "run",
      bytes: new TextEncoder().encode("Bounded company diagnostic evidence"),
    });
    await fake.waitForCanonicalEvents();
    await startAgentSession(receipt.runId, { db, executionHosts: hosts });
    expect(fake.callsOf("createSession")).toHaveLength(1);
    expect(fake.callsOf("createSession")[0].envelope?.payload).toMatchObject({
      readOnlySession: true,
      agentKind: "operational",
      reapOnEndTurn: true,
      autoApprovePermissions: false,
    });
    expect(fake.callsOf("adoptWorkspace")[0].envelope?.payload).toMatchObject({
      projectSlug: "_company",
      owner: { kind: "company", companyId: request.companyId },
      kind: "directory",
    });
    expect(fake.callsOf("listSessions").length).toBeGreaterThan(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(assignmentInput.objectiveInput.objective);
    expect(prompts[0]).toContain(assignmentInput.objectiveInput.input);
    expect(prompts[0]).toContain(assignment.id);
    expect(prompts[0]).toContain("base");
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, receipt.runId));

    expect(run).toMatchObject({
      status: "Done",
      projectId: null,
      operationalIntegrityBaseline: {
        owner: {
          kind: "company",
          companyId: request.companyId,
          runId: receipt.runId,
        },
      },
    });
    const detail = await authorizePeekRun(userId, receipt.runId);

    expect(detail).toMatchObject({
      run: { id: receipt.runId, projectId: null, companyId: request.companyId },
      canReadTranscript: true,
    });
    const objects = await database.pool.query(
      "SELECT id FROM execution_runtime_objects WHERE run_id=$1 ORDER BY id",
      [receipt.runId],
    );

    expect(objects.rows.length).toBeGreaterThan(0);
    const object = await getRuntimeObjectForRun({
      db,
      runId: receipt.runId,
      objectId: objects.rows[0].id,
    });

    if (!object)
      throw new Error(
        "The completed company Run has no retained evidence object",
      );
    await expect(
      authorizeRuntimeObjectContentActor(object, userId),
    ).resolves.toBeUndefined();
    await expect(
      authorizeRuntimeObjectContentActor(object, administratorId),
    ).rejects.toMatchObject({
      details: { reason: "runtime_object_not_found" },
    });
    browserSession.user = await requireActiveUserById(userId);
    const stream = await streamGet(
      new NextRequest(`http://localhost/api/runs/${receipt.runId}/stream`),
      { params: Promise.resolve({ runId: receipt.runId }) },
    );

    expect(stream.status).toBe(200);
    expect(await stream.text()).toContain("session.command");
    browserSession.user = await requireActiveUserById(administratorId);
    const denied = await streamGet(
      new NextRequest(`http://localhost/api/runs/${receipt.runId}/stream`),
      { params: Promise.resolve({ runId: receipt.runId }) },
    );

    expect(denied.status).toBe(404);
    browserSession.user = null;
    expect(
      (
        await database.pool.query(
          "SELECT status,revision FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ status: "active", revision: 3 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM run_results WHERE run_id=$1 AND validity='valid'",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM project_tokens WHERE company_run_id=$1 AND revoked_at IS NULL",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  } finally {
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
    await fake.waitForCanonicalEvents();
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
}, 60000);

it("CBS-02 refuses revoked current assignment authority after reservation before workspace or session effects", async () => {
  const db: Db = database.db;
  const { hosts, fake } = await fakeExecutionHosts(db);
  const initiatorId = randomUUID();
  const runnerId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [initiatorId, `${initiatorId}@example.test`],
  );
  await createCompanyGrants(db, administratorId, {
    principalKind: "user",
    principalId: initiatorId,
    actions: ["assignments:read", "assignments:update"],
    idempotencyKey: randomUUID(),
  });
  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "authority-fixture",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  await db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });
  const assignment = await createSpecialistAssignment(
    db,
    userId,
    assignmentInput,
  );
  const receipt = await reserveCompanyAgentRun(
    db,
    initiatorId,
    { ...request, assignmentId: assignment.id },
    hosts,
  );
  const updateGrant = (
    await database.pool.query(
      "SELECT id FROM company_grants WHERE principal_id=$1 AND action='assignments:update' AND revoked_at IS NULL",
      [initiatorId],
    )
  ).rows[0];

  await revokeCompanyGrant(db, administratorId, updateGrant.id, {
    expectedRevision: 1,
    reason: "Withdraw execution authority before dispatch",
    idempotencyKey: randomUUID(),
  });
  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    receipt.runId,
  ]);
  try {
    await startAgentSession(receipt.runId, { db, executionHosts: hosts });
    expect(fake.callsOf("createSession")).toHaveLength(0);
    expect(fake.callsOf("adoptWorkspace")).toHaveLength(0);
    expect(fake.callsOf("sendPrompt")).toHaveLength(0);
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, receipt.runId));
    const workspace = await operationalWorkspace(db, run);

    expect(run.status).toBe("Failed");
    await expect(lstat(workspace.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (
        await database.pool.query(
          "SELECT input_revision,status FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ input_revision: 1, status: "active" });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM project_tokens WHERE company_run_id=$1",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  } finally {
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
});

it("CBS-02 refuses a frozen runner disabled after reservation and preserves the requested work", async () => {
  const db: Db = database.db;
  const { hosts, fake } = await fakeExecutionHosts(db);
  const runnerId = randomUUID();

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "disabled-after-reservation",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  await db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });
  const assignment = await createSpecialistAssignment(
    db,
    userId,
    assignmentInput,
  );
  const receipt = await reserveCompanyAgentRun(
    db,
    userId,
    { ...request, assignmentId: assignment.id },
    hosts,
  );

  await db
    .update(platformAcpRunners)
    .set({ enabled: false })
    .where(eq(platformAcpRunners.id, runnerId));
  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    receipt.runId,
  ]);
  try {
    await startAgentSession(receipt.runId, { db, executionHosts: hosts });
    expect(fake.callsOf("createSession")).toHaveLength(0);
    expect(fake.callsOf("adoptWorkspace")).toHaveLength(0);
    expect(
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          receipt.runId,
        ])
      ).rows[0],
    ).toEqual({ status: "Failed" });
    expect(
      (
        await database.pool.query(
          "SELECT status,input_revision FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ status: "active", input_revision: 1 });
  } finally {
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
});

it("refuses stale business/input/binding revisions and forged launch fields without allocating work", async () => {
  for (const change of [
    { assignmentRevision: 2 },
    { inputRevision: 2 },
    { bindingRevision: 2 },
  ]) {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, { ...request, ...change }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  }
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        actor: { kind: "user", id: administratorId },
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        triggerSource: "webhook",
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFIG" });
});

it("rechecks actual package trust and the catalog kill switch on every preflight", async () => {
  const pin = assignmentInput.standingDefinition.packageInstallId;

  await database.pool.query(
    "UPDATE package_installs SET trust_status='untrusted' WHERE id=$1",
    [pin],
  );
  try {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, request),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  } finally {
    await database.pool.query(
      "UPDATE package_installs SET trust_status='trusted' WHERE id=$1",
      [pin],
    );
  }
  await database.pool.query("UPDATE agents SET enabled=false WHERE id=$1", [
    agentId,
  ]);
  try {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, request),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  } finally {
    await database.pool.query("UPDATE agents SET enabled=true WHERE id=$1", [
      agentId,
    ]);
  }
});

it("rejects a changed installed definition witness and an assignment with a different required result", async () => {
  const context = await database.db.transaction((tx) =>
    prepareCompanyAgentContext(tx, userId, request),
  );
  const original = await readFile(context.effective.sourcePath, "utf8");

  await writeFile(
    context.effective.sourcePath,
    original + "Changed provider bytes.\n",
  );
  try {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, request),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "company_agent_pin_changed" },
    });
  } finally {
    await writeFile(context.effective.sourcePath, original);
  }
  const changed = await createSpecialistAssignment(database.db, userId, {
    ...assignmentInput,
    objectiveInput: {
      ...assignmentInput.objectiveInput,
      expectedResult: {
        ...assignmentInput.objectiveInput.expectedResult,
        sha256: "0".repeat(64),
      },
    },
  });

  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        assignmentId: changed.id,
      }),
    ),
  ).rejects.toMatchObject({
    code: "CONFIG",
    details: { reason: "company_assignment_result_mismatch" },
  });
});

it("CBS-02 refuses assignment authority that differs from the reviewed specialist policy and accepts equivalent normalized policy", async () => {
  for (const executionPolicy of [
    { preset: "unattended" as const },
    {
      preset: "supervised" as const,
      overrides: { permissions: "auto_approve" as const },
    },
  ]) {
    const assignment = await createSpecialistAssignment(database.db, userId, {
      ...assignmentInput,
      executionPolicy,
    });

    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, {
          ...request,
          assignmentId: assignment.id,
        }),
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "company_assignment_policy_mismatch" },
    });
  }
  const assignment = await createSpecialistAssignment(database.db, userId, {
    ...assignmentInput,
    executionPolicy: { preset: "supervised", overrides: {} },
  });

  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        assignmentId: assignment.id,
      }),
    ),
  ).resolves.toMatchObject({ assignment: { id: assignment.id } });
});

it.each([
  ["rah:repo-observer", "company_agent_workspace_unsupported"],
  ["rah:flow-coordinator", "company_coordinator_required"],
  ["rah:memory-observer", "company_agent_project_capability_unsupported"],
] as const)(
  "refuses %s on standalone company admission instead of changing its declared execution model",
  async (roleId, reason) => {
    const effective = await resolveInstalledAgentDefinition(database.db, {
      agentId: roleId,
      packageInstallId: assignmentInput.standingDefinition.packageInstallId,
    });
    const binding = await createCompanySpecialistBinding(
      database.db,
      userId,
      roleId,
      {
        owner: { kind: "company", companyId: request.companyId },
        packageInstallId: effective.packageInstallId,
        packageRevision: effective.resolvedRevision!,
        definitionSha256: agentDefinitionSha256(effective.parsed),
        enabled: true,
        configuration: {},
        grantActions: [],
        idempotencyKey: randomUUID(),
      },
    );
    const assignment = await createSpecialistAssignment(database.db, userId, {
      ...assignmentInput,
      specialistBindingId: binding.specialist.bindingId,
      responsibleAgentId: roleId,
      standingDefinition: {
        ...assignmentInput.standingDefinition,
        agentId: roleId,
        definition: effective.parsed,
        definitionSha256: agentDefinitionSha256(effective.parsed),
      },
    });

    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, {
          ...request,
          assignmentId: assignment.id,
          bindingId: binding.specialist.bindingId,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG", details: { reason } });
  },
);

it("refuses cancelled work and hides foreign project assignment identity before checking its revision", async () => {
  const cancelled = await createSpecialistAssignment(
    database.db,
    userId,
    assignmentInput,
  );

  await cancelSpecialistAssignment(
    database.db,
    userId,
    cancelled.id,
    1,
    "Cancelled before admission",
  );
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        assignmentId: cancelled.id,
        assignmentRevision: 2,
      }),
    ),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "company_assignment_changed" },
  });
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), project.id, userId],
  );
  const foreign = await createSpecialistAssignment(database.db, userId, {
    ...assignmentInput,
    owner: { kind: "project", projectId: project.id },
    specialistBindingId: randomUUID(),
  });
  const failures: { code: unknown; message: string; details: unknown }[] = [];

  for (const assignmentId of [randomUUID(), foreign.id]) {
    try {
      await database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, {
          ...request,
          assignmentId,
          assignmentRevision: 2,
        }),
      );
      throw new Error("Foreign or absent assignment was admitted");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !("details" in error)
      )
        throw error;
      failures.push({
        code: error.code,
        message: error.message,
        details: error.details,
      });
    }
  }
  expect(failures[0]).toEqual(failures[1]);
  expect(failures[0]).toMatchObject({
    code: "PRECONDITION",
    details: { reason: "assignment_reference_unavailable" },
  });
});

it("refuses disabled and retired configuration, and standing input that changes effective role configuration", async () => {
  const roleId = "rah:disabled-observer";
  const effective = await resolveInstalledAgentDefinition(database.db, {
    agentId: roleId,
    packageInstallId: assignmentInput.standingDefinition.packageInstallId,
  });
  const binding = await createCompanySpecialistBinding(
    database.db,
    userId,
    roleId,
    {
      owner: { kind: "company", companyId: request.companyId },
      packageInstallId: effective.packageInstallId,
      packageRevision: effective.resolvedRevision!,
      definitionSha256: agentDefinitionSha256(effective.parsed),
      configuration: {},
      grantActions: [],
      idempotencyKey: randomUUID(),
    },
  );
  const assignment = await createSpecialistAssignment(database.db, userId, {
    ...assignmentInput,
    specialistBindingId: binding.specialist.bindingId,
    responsibleAgentId: roleId,
    standingDefinition: {
      ...assignmentInput.standingDefinition,
      agentId: roleId,
      definition: effective.parsed,
      definitionSha256: agentDefinitionSha256(effective.parsed),
    },
  });
  const disabled = {
    ...request,
    assignmentId: assignment.id,
    bindingId: binding.specialist.bindingId,
  };

  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, disabled),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "company_binding_disabled" },
  });
  await detachCompanySpecialistBinding(
    database.db,
    userId,
    roleId,
    binding.specialist.bindingId,
    {
      expectedRevision: 1,
      reason: "Retired before admission",
      idempotencyKey: randomUUID(),
    },
  );
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...disabled,
        bindingRevision: 2,
      }),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "company_binding_disabled" },
  });
  const changed = await createSpecialistAssignment(database.db, userId, {
    ...assignmentInput,
    standingDefinition: {
      ...assignmentInput.standingDefinition,
      configuration: { label: "different-input" },
    },
  });

  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        assignmentId: changed.id,
      }),
    ),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "company_assignment_standing_changed" },
  });
});

async function reserveCompanyFixtureRun(
  input: PreparedSpecialistAssignment = assignmentInput,
): Promise<
  Readonly<{
    runId: string;
    assignmentId: string;
    snapshot: CompanyAgentExecutionSnapshot;
  }>
> {
  const assignment = await createSpecialistAssignment(
    database.db,
    userId,
    input,
  );
  const runId = randomUUID();
  const prepared = await database.db.transaction(async (tx) => {
    const context = await prepareCompanyAgentContext(tx, userId, {
      ...request,
      assignmentId: assignment.id,
    });
    const snapshot = captureCompanyAgentExecution(context);
    const result = buildOperationalContract(context.effective);

    await tx.execute(sql`INSERT INTO runs(id,run_kind,company_id,company_execution_snapshot,agent_id,source_agent_id,agent_kind,agent_workspace,flow_version,flow_revision,status,result_contract,created_by_user_id,launched_at,activity_sort_at,activity_timestamp_provenance,agent_config,execution_policy,agent_activity_snapshot)
      VALUES(${runId},'agent',${request.companyId},${JSON.stringify(snapshot)}::jsonb,${agentId},${agentId},'operational','none','agent','manual','Pending',${JSON.stringify(result)}::jsonb,${userId},now(),now(),'launch',${JSON.stringify(context.binding.snapshot.effectiveConfiguration)}::jsonb,${JSON.stringify(context.binding.snapshot.executionPolicy)}::jsonb,${JSON.stringify(buildAgentActivitySnapshot(agentId, context.effective))}::jsonb)`);
    await linkSpecialistAssignmentRunInTransaction(tx, userId, assignment.id, {
      expectedRevision: 1,
      inputRevision: 1,
      runId,
      role: "specialist",
      work: null,
    });

    return snapshot;
  });

  return { runId, assignmentId: assignment.id, snapshot: prepared };
}

it("reserves company run ownership and its exact immutable assignment input link in the existing run ledger", async () => {
  const {
    runId,
    assignmentId,
    snapshot: prepared,
  } = await reserveCompanyFixtureRun();

  expect(
    (
      await database.pool.query(
        "SELECT company_id,project_id,task_id,flow_id,company_execution_snapshot FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0],
  ).toEqual({
    company_id: request.companyId,
    project_id: null,
    task_id: null,
    flow_id: null,
    company_execution_snapshot: prepared,
  });
  expect(
    (
      await database.pool.query(
        "SELECT assignment_id,input_revision,role FROM specialist_run_links WHERE run_id=$1",
        [runId],
      )
    ).rows[0],
  ).toEqual({
    assignment_id: assignmentId,
    input_revision: 1,
    role: "specialist",
  });
  await expect(
    database.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(
        sql`INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs,to_jsonb(r)||jsonb_build_object('id',${randomUUID()}::text,'agent_kind',NULL,'result_contract',NULL))).* FROM runs r WHERE id=${runId}`,
      );
    }),
  ).rejects.toMatchObject({
    cause: { code: "23514", constraint: "runs_company_agent_shape_check" },
  });
  const unlinked = await database.db.transaction((tx) =>
    prepareCompanyAgentContext(tx, userId, request),
  );

  await expect(
    database.db.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs,to_jsonb(r)||jsonb_build_object('id',${randomUUID()}::text,'company_execution_snapshot',${JSON.stringify(captureCompanyAgentExecution(unlinked))}::jsonb))).* FROM runs r WHERE id=${runId}`,
      );
    }),
  ).rejects.toMatchObject({
    cause: { code: "23514", constraint: "runs_company_execution_link_check" },
  });
  await expect(
    database.pool.query(
      "UPDATE runs SET company_execution_snapshot=jsonb_set(company_execution_snapshot,'{assignment,inputSha256}',to_jsonb($2::text)) WHERE id=$1",
      [runId, "0".repeat(64)],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("rotates exact company run credentials with current grants, scope limits and transactional refusal recovery", async () => {
  const { runId } = await reserveCompanyFixtureRun();

  await expect(
    issueCompanyAgentRunToken({ db: database.db, runId }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    runId,
  ]);
  const first = await issueCompanyAgentRunToken({ db: database.db, runId });
  const actor = await verifyToken(first.secret, database.db);

  expect(actor).toMatchObject({
    companyId: request.companyId,
    projectId: null,
    tokenKind: "agent",
    agentId,
    ownerUserId: userId,
    boundRunId: runId,
    scopes: ["knowledge:read", "knowledge:propose"],
  });
  expect(actorUserIdForToken(actor)).toBeNull();
  const replacement = await issueCompanyAgentRunToken({
    db: database.db,
    runId,
  });

  await expect(verifyToken(first.secret, database.db)).rejects.toMatchObject({
    kind: "revoked",
  });
  const concurrent = await Promise.all([
    issueCompanyAgentRunToken({ db: database.db, runId }),
    issueCompanyAgentRunToken({ db: database.db, runId }),
  ]);
  const live = (
    await database.pool.query(
      "SELECT id FROM project_tokens WHERE company_run_id=$1 AND revoked_at IS NULL",
      [runId],
    )
  ).rows;

  expect(live).toHaveLength(1);
  const currentToken = concurrent.find(
    (token) => token.tokenId === live[0]!.id,
  );

  if (!currentToken)
    throw new Error("Current company credential has no issuance receipt");
  await expect(
    verifyToken(replacement.secret, database.db),
  ).rejects.toMatchObject({ kind: "revoked" });
  for (const change of [
    {
      disable:
        "UPDATE package_installs SET trust_status='untrusted' WHERE id=$1",
      restore: "UPDATE package_installs SET trust_status='trusted' WHERE id=$1",
      id: assignmentInput.standingDefinition.packageInstallId,
    },
    {
      disable: "UPDATE agents SET enabled=false WHERE id=$1",
      restore: "UPDATE agents SET enabled=true WHERE id=$1",
      id: agentId,
    },
  ]) {
    await database.pool.query(change.disable, [change.id]);
    try {
      await expect(
        verifyToken(currentToken.secret, database.db),
      ).rejects.toMatchObject({ kind: "owner-unavailable" });
    } finally {
      await database.pool.query(change.restore, [change.id]);
    }
  }
  const readGrant = (
    await database.pool.query(
      "SELECT id,revision FROM company_grants WHERE principal_id=$1 AND action='assignments:read' AND revoked_at IS NULL",
      [userId],
    )
  ).rows[0]!;

  await revokeCompanyGrant(database.db, administratorId, readGrant.id, {
    expectedRevision: readGrant.revision,
    reason: "Content access revoked",
    idempotencyKey: randomUUID(),
  });
  await expect(
    verifyToken(currentToken.secret, database.db),
  ).rejects.toMatchObject({ kind: "owner-unavailable" });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["assignments:read"],
    idempotencyKey: randomUUID(),
  });
  expect((await verifyToken(currentToken.secret, database.db)).boundRunId).toBe(
    runId,
  );
  await database.pool.query(
    "UPDATE users SET account_status='disabled' WHERE id=$1",
    [userId],
  );
  try {
    await expect(
      verifyToken(currentToken.secret, database.db),
    ).rejects.toMatchObject({ kind: "owner-unavailable" });
  } finally {
    await database.pool.query(
      "UPDATE users SET account_status='active' WHERE id=$1",
      [userId],
    );
  }
  await database.pool.query(
    "CREATE FUNCTION fail_company_token_issue_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owned fixture issuance refusal' USING ERRCODE='23514',CONSTRAINT='company_token_issue_fixture'; END $$",
  );
  await database.pool.query(
    "CREATE TRIGGER company_token_issue_fixture BEFORE INSERT ON project_tokens FOR EACH ROW WHEN (NEW.company_id IS NOT NULL) EXECUTE FUNCTION fail_company_token_issue_fixture()",
  );
  try {
    await expect(
      issueCompanyAgentRunToken({ db: database.db, runId }),
    ).rejects.toMatchObject({
      code: "CRASH",
      message: "Database operation failed",
      details: { sqlState: "23514", constraint: "company_token_issue_fixture" },
    });
  } finally {
    await database.pool.query(
      "DROP TRIGGER company_token_issue_fixture ON project_tokens",
    );
    await database.pool.query(
      "DROP FUNCTION fail_company_token_issue_fixture()",
    );
  }
  expect((await verifyToken(currentToken.secret, database.db)).tokenId).toBe(
    currentToken.tokenId,
  );
  await expect(
    database.pool.query(
      "UPDATE project_tokens SET scopes='[\"*\"]'::jsonb WHERE id=$1",
      [currentToken.tokenId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await revokeAgentRunTokensForRun(runId, database.db);
  await expect(
    verifyToken(currentToken.secret, database.db),
  ).rejects.toMatchObject({ kind: "revoked" });
});

it("CBS-02 authorizes only the executing specialist's exact assignment input without implying Company Brain read access", async () => {
  const { runId, snapshot } = await reserveCompanyFixtureRun();
  const reference = {
    kind: "assignment_input" as const,
    assignmentId: snapshot.assignment.id,
    inputRevision: snapshot.assignment.inputRevision,
    inputSha256: snapshot.assignment.inputSha256,
  };

  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [reference],
      }),
    ],
  );
  await expect(
    assertNativeRunKnowledgeInputs(database.db, runId),
  ).resolves.toBeUndefined();
  await expect(
    authorizeSourceRestrictions(
      database.db,
      { kind: "execution", runId, nodeAttemptId: null },
      [{ kind: "company", companyId: request.companyId }],
    ),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  const other = await reserveCompanyFixtureRun();

  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      other.runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [reference],
      }),
    ],
  );
  await expect(
    assertNativeRunKnowledgeInputs(database.db, other.runId),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  for (const changed of [
    { ...reference, inputRevision: 2 },
    { ...reference, inputSha256: "0".repeat(64) },
  ]) {
    await expect(
      authorizeSourceRestrictions(database.db, { kind: "user", userId }, [
        changed,
      ]),
    ).rejects.toMatchObject({
      details: { reason: "knowledge_reference_unavailable" },
    });
  }
});

it("CBS-02 reads retained company execution content under current explicit reader authority independently of specialist availability", async () => {
  const { runId, snapshot } = await reserveCompanyFixtureRun();
  const unavailable = { details: { reason: "run_unavailable" } };

  // Historical rows without a complete source capture cannot release content.
  await expect(authorizePeekRun(userId, runId)).rejects.toMatchObject(
    unavailable,
  );
  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId: snapshot.assignment.id,
            inputRevision: snapshot.assignment.inputRevision,
            inputSha256: snapshot.assignment.inputSha256,
          },
        ],
      }),
    ],
  );
  await expect(authorizePeekRun(userId, runId)).resolves.toMatchObject({
    run: { id: runId, companyId: request.companyId, projectId: null },
    canReadTranscript: true,
  });
  await expect(authorizePeekRun(administratorId, runId)).rejects.toMatchObject(
    unavailable,
  );
  await expect(authorizePeekRun(userId, randomUUID())).rejects.toMatchObject(
    unavailable,
  );
  await database.pool.query("UPDATE agents SET enabled=false WHERE id=$1", [
    agentId,
  ]);
  try {
    await expect(authorizePeekRun(userId, runId)).resolves.toMatchObject({
      canReadTranscript: true,
    });
  } finally {
    await database.pool.query("UPDATE agents SET enabled=true WHERE id=$1", [
      agentId,
    ]);
  }
  const readerId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [readerId, `${readerId}@example.test`],
  );
  await expect(authorizePeekRun(readerId, runId)).rejects.toMatchObject(
    unavailable,
  );
  const grants = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: readerId,
    actions: ["assignments:read"],
    idempotencyKey: randomUUID(),
  });

  await expect(authorizePeekRun(readerId, runId)).resolves.toMatchObject({
    canReadTranscript: true,
  });
  browserSession.user = await requireActiveUserById(readerId);
  const stream = await streamGet(
    new NextRequest(`http://localhost/api/runs/${runId}/stream?replay=false`, {
      signal: AbortSignal.timeout(10000),
    }),
    { params: Promise.resolve({ runId }) },
  );

  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();

  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "session.stream_ready",
  );
  await revokeCompanyGrant(
    database.db,
    administratorId,
    grants.page.items[0].id,
    {
      expectedRevision: grants.page.items[0].revision,
      reason: "Withdraw historical Run access",
      idempotencyKey: randomUUID(),
    },
  );
  await expect(authorizePeekRun(readerId, runId)).rejects.toMatchObject(
    unavailable,
  );
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  reader.releaseLock();
  browserSession.user = null;
});

it("CBS-02 pages company history under current source authority before LIMIT and binds the existing cursor to its reader", async () => {
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), project.id, userId],
  );
  const first = await reserveCompanyFixtureRun();
  const second = await reserveCompanyFixtureRun();
  const hidden = await reserveCompanyFixtureRun({
    ...assignmentInput,
    sourceRestrictions: [{ kind: "project_context", projectId: project.id }],
  });

  for (const fixture of [first, second, hidden]) {
    await database.pool.query(
      "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
      [
        fixture.runId,
        JSON.stringify({
          schemaVersion: 1,
          state: "complete",
          generation: 1,
          restrictions: [
            {
              kind: "assignment_input",
              assignmentId: fixture.snapshot.assignment.id,
              inputRevision: fixture.snapshot.assignment.inputRevision,
              inputSha256: fixture.snapshot.assignment.inputSha256,
            },
          ],
        }),
      ],
    );
  }
  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [project.id, userId],
  );
  const page = await getCompanyAgentRunHistory(database.db, userId, {
    agentId,
    limit: 2,
  });

  expect(page.items.map((item) => item.runId)).toEqual([
    second.runId,
    first.runId,
  ]);
  expect(page.nextCursor).not.toBeNull();
  const later = await reserveCompanyFixtureRun();

  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      later.runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId: later.snapshot.assignment.id,
            inputRevision: later.snapshot.assignment.inputRevision,
            inputSha256: later.snapshot.assignment.inputSha256,
          },
        ],
      }),
    ],
  );
  const next = await getCompanyAgentRunHistory(database.db, userId, {
    agentId,
    limit: 2,
    cursor: page.nextCursor!,
  });

  expect(next.asOf).toBe(page.asOf);
  expect(
    next.items.every(
      (item) =>
        ![first.runId, second.runId, hidden.runId, later.runId].includes(
          item.runId,
        ),
    ),
  ).toBe(true);
  await expect(
    getCompanyAgentRunHistory(database.db, administratorId, { agentId }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    getCompanyAgentRunHistory(database.db, userId, {
      agentId,
      status: "Done",
      cursor: page.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    getCompanyAgentRunHistory(database.db, userId, { agentId: "absent:role" }),
  ).resolves.toMatchObject({ items: [], nextCursor: null });
  browserSession.user = await requireActiveUserById(userId);
  const response = await companyHistoryGet(
    new NextRequest(`http://localhost/api/specialists/${agentId}/runs?limit=2`),
    { params: Promise.resolve({ specialistId: agentId }) },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body: unknown = await response.json();
  const document: {
    components: { schemas: Record<string, object> };
    paths: Record<
      string,
      {
        get: {
          responses: Record<
            string,
            { content: Record<string, { schema: object }> }
          >;
        };
      }
    >;
  } = parse(await readFile(resolve("../docs/api/web.openapi.yaml"), "utf8"));
  const validate = new Ajv({ strict: false, validateFormats: false }).compile({
    components: document.components,
    ...document.paths["/api/specialists/{specialistId}/runs"].get.responses[
      "200"
    ].content["application/json"].schema,
  });

  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(JSON.stringify(body)).not.toContain(hidden.runId);
  for (const query of [
    "limit=1&limit=2",
    "limit=101",
    "status=invalid",
    "companyId=forged",
    "userId=forged",
    "projectId=forged",
  ]) {
    const refused = await companyHistoryGet(
      new NextRequest(
        `http://localhost/api/specialists/${agentId}/runs?${query}`,
      ),
      { params: Promise.resolve({ specialistId: agentId }) },
    );

    expect(refused.status).toBe(400);
  }
  browserSession.user = await requireActiveUserById(administratorId);
  expect(
    (
      await companyHistoryGet(
        new NextRequest(`http://localhost/api/specialists/${agentId}/runs`),
        { params: Promise.resolve({ specialistId: agentId }) },
      )
    ).status,
  ).toBe(403);
  browserSession.user = null;
  const readerId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [readerId, `${readerId}@example.test`],
  );
  const granted = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: readerId,
    actions: ["assignments:read"],
    idempotencyKey: randomUUID(),
  });

  await expect(
    getCompanyAgentRunHistory(database.db, readerId, {
      agentId,
      cursor: page.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  const readerPage = await getCompanyAgentRunHistory(database.db, readerId, {
    agentId,
    limit: 1,
  });

  expect(readerPage.nextCursor).not.toBeNull();
  await revokeCompanyGrant(
    database.db,
    administratorId,
    granted.page.items[0].id,
    {
      expectedRevision: 1,
      reason: "Withdraw history access",
      idempotencyKey: randomUUID(),
    },
  );
  await expect(
    getCompanyAgentRunHistory(database.db, readerId, {
      agentId,
      cursor: readerPage.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: readerId,
    actions: ["assignments:read"],
    idempotencyKey: randomUUID(),
  });
  await expect(
    getCompanyAgentRunHistory(database.db, readerId, {
      agentId,
      cursor: readerPage.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await database.pool.query("UPDATE agents SET enabled=false WHERE id=$1", [
    agentId,
  ]);
  try {
    await expect(
      getCompanyAgentRunHistory(database.db, userId, { agentId, limit: 1 }),
    ).resolves.toMatchObject({ items: [{ runId: later.runId }] });
  } finally {
    await database.pool.query("UPDATE agents SET enabled=true WHERE id=$1", [
      agentId,
    ]);
  }
});

it("CBS-02 preserves nested assignment source restrictions and lets the source project be deleted without Brain blocking it", async () => {
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), project.id, userId],
  );
  const { runId, snapshot } = await reserveCompanyFixtureRun({
    ...assignmentInput,
    sourceRestrictions: [{ kind: "project_context", projectId: project.id }],
  });
  const reference = {
    kind: "assignment_input" as const,
    assignmentId: snapshot.assignment.id,
    inputRevision: snapshot.assignment.inputRevision,
    inputSha256: snapshot.assignment.inputSha256,
  };
  const human = { kind: "user" as const, userId };

  await expect(
    authorizeSourceRestrictions(database.db, human, [reference]),
  ).resolves.toMatchObject({
    visited: expect.arrayContaining([
      expect.stringContaining("project_context:"),
    ]),
  });
  const humanCanRead = async (): Promise<boolean> =>
    database.db.transaction(async (tx) => {
      const identity = await resolveKnowledgePrincipal(
        tx,
        human,
        "knowledge:read",
      );

      return z
        .boolean()
        .parse(
          (
            await tx.execute(
              sql`SELECT ${knowledgeSourceReadPolicy(identity, sql`${JSON.stringify(reference)}::jsonb`)} AS readable`,
            )
          ).rows[0].readable,
        );
    });

  expect(await humanCanRead()).toBe(true);
  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [reference],
      }),
    ],
  );
  await expect(authorizePeekRun(userId, runId)).resolves.toMatchObject({
    canReadTranscript: true,
  });
  await expect(
    assertNativeRunKnowledgeInputs(database.db, runId),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [project.id, userId],
  );
  expect(await humanCanRead()).toBe(false);
  await expect(authorizePeekRun(userId, runId)).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  await expect(
    authorizeSourceRestrictions(database.db, human, [reference]),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  await database.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  expect(await humanCanRead()).toBe(false);
  expect(
    (
      await database.pool.query(
        "SELECT input_revision FROM specialist_assignments WHERE id=$1",
        [snapshot.assignment.id],
      )
    ).rows[0],
  ).toEqual({ input_revision: 1 });
});

it("uses company Brain through current user and agent authority while retaining professional proposal attribution", async () => {
  const { runId, snapshot: prepared } = await reserveCompanyFixtureRun();

  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    runId,
  ]);
  const replacement = await issueCompanyAgentRunToken({
    db: database.db,
    runId,
  });

  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId: prepared.assignment.id,
            inputRevision: prepared.assignment.inputRevision,
            inputSha256: prepared.assignment.inputSha256,
          },
        ],
      }),
    ],
  );
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["knowledge:read", "knowledge:propose", "knowledge:review"],
    idempotencyKey: randomUUID(),
  });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "agent",
    principalId: agentId,
    actions: ["knowledge:read", "knowledge:propose"],
    idempotencyKey: randomUUID(),
  });
  const humanPrincipal = { kind: "user" as const, userId };
  const nativePrincipal = {
    kind: "token" as const,
    tokenId: replacement.tokenId,
  };
  const draft = {
    title: "Company inspection procedure",
    kind: "procedure" as const,
    assertion: "Inspect the configured health probe before taking action.",
    basis: "unknown" as const,
    evidence: [],
    missingEvidence: [
      {
        state: "absent" as const,
        reason: "No external observation is being claimed.",
      },
    ],
    limitations: ["This is an unconfirmed procedure."],
  };
  const humanProposal = await createKnowledgeProposal(database.db, {
    kind: "knowledge_add",
    owner: { kind: "company", companyId: request.companyId },
    principal: humanPrincipal,
    idempotencyKey: `company-procedure:${runId}`,
    draft,
  });
  const accepted = await reviewKnowledgeProposal(database.db, {
    proposalId: humanProposal.id,
    principal: humanPrincipal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Retain the explicit procedure without confirming it",
    idempotencyKey: `company-procedure-review:${runId}`,
  });

  if (!accepted.acceptedRecordId)
    throw new Error("Accepted procedure has no record identity");
  const recordId = accepted.acceptedRecordId;

  expect(
    await getKnowledgeRecord(database.db, nativePrincipal, { recordId }),
  ).toMatchObject({
    id: recordId,
    owner: { kind: "company", companyId: request.companyId },
    confirmation: { state: "unconfirmed" },
  });
  const { GET: knowledgeHttpGet } =
    await import("@/app/api/v1/ext/knowledge/[recordId]/route");
  const readableHttp = await knowledgeHttpGet(
    new NextRequest(`http://localhost/api/v1/ext/knowledge/${recordId}`, {
      headers: { Authorization: `Bearer ${replacement.secret}` },
    }),
    { params: Promise.resolve({ recordId }) },
  );

  expect(readableHttp.status).toBe(200);
  expect(readableHttp.headers.get("Cache-Control")).toBe("private, no-store");
  expect(readableHttp.headers.get("Vary")).toContain("Authorization");
  const readableBody: unknown = await readableHttp.json();

  expect(readableBody).toMatchObject({
    id: recordId,
    owner: { kind: "company", companyId: request.companyId },
  });
  expect(
    (
      await searchKnowledge(database.db, nativePrincipal, {
        q: "inspection",
        limit: 10,
      })
    ).items.map((item) => item.id),
  ).toContain(recordId);
  const agentProposal = await createKnowledgeProposal(database.db, {
    kind: "knowledge_add",
    owner: { kind: "company", companyId: request.companyId },
    principal: nativePrincipal,
    idempotencyKey: `company-agent-proposal:${runId}`,
    draft: { ...draft, title: "Proposed reusable diagnostic limitation" },
  });

  expect(
    (
      await database.pool.query(
        "SELECT knowledge_attribution,authority_snapshot FROM brain_proposals WHERE id=$1",
        [agentProposal.id],
      )
    ).rows[0],
  ).toMatchObject({
    knowledge_attribution: {
      kind: "agent",
      id: agentId,
      runId,
      attemptId: null,
    },
    authority_snapshot: {
      submit: {
        version: 2,
        initiator: { actor: { kind: "user", id: userId } },
        execution: {
          runId,
          launchSnapshot: { specialistBinding: prepared.specialistBinding },
        },
      },
    },
  });
  await expect(
    reviewKnowledgeProposal(database.db, {
      proposalId: agentProposal.id,
      principal: nativePrincipal,
      expectedRevision: 1,
      decision: "accept",
      reason: "An agent cannot grant its own acceptance authority",
      idempotencyKey: `forged-review:${runId}`,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await database.pool.query(
    "INSERT INTO brain_record_grants(record_id,principal_type,principal_id,action,created_by) VALUES($1,'agent',$2,'knowledge:read',$3::jsonb)",
    [
      recordId,
      agentId,
      JSON.stringify({
        kind: "user",
        id: userId,
        runId: null,
        attemptId: null,
      }),
    ],
  );
  await expect(
    getKnowledgeRecord(database.db, nativePrincipal, { recordId }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  const hiddenBodies: unknown[] = [];

  for (const selected of [recordId, randomUUID()]) {
    const hiddenHttp = await knowledgeHttpGet(
      new NextRequest(`http://localhost/api/v1/ext/knowledge/${selected}`, {
        headers: { Authorization: `Bearer ${replacement.secret}` },
      }),
      { params: Promise.resolve({ recordId: selected }) },
    );

    expect(hiddenHttp.status).toBe(404);
    hiddenBodies.push(await hiddenHttp.json());
  }
  expect(hiddenBodies[0]).toEqual(hiddenBodies[1]);
  expect(
    (
      await searchKnowledge(database.db, nativePrincipal, {
        q: "inspection",
        limit: 10,
      })
    ).items,
  ).toEqual([]);
  await database.pool.query(
    "INSERT INTO brain_record_grants(record_id,principal_type,principal_id,action,created_by) VALUES($1,'user',$2,'knowledge:read',$3::jsonb)",
    [
      recordId,
      userId,
      JSON.stringify({
        kind: "user",
        id: userId,
        runId: null,
        attemptId: null,
      }),
    ],
  );
  expect(
    (await getKnowledgeRecord(database.db, nativePrincipal, { recordId })).id,
  ).toBe(recordId);
  const acceptedAgent = await reviewKnowledgeProposal(database.db, {
    proposalId: agentProposal.id,
    principal: humanPrincipal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Retain the limitation with its original professional attribution",
    idempotencyKey: `company-agent-review:${runId}`,
  });

  if (!acceptedAgent.acceptedRecordId)
    throw new Error("Accepted agent limitation has no record identity");
  expect(
    await getKnowledgeRecord(database.db, nativePrincipal, {
      recordId: acceptedAgent.acceptedRecordId,
    }),
  ).toMatchObject({
    attribution: { kind: "agent", id: agentId, runId },
    confirmation: { state: "unconfirmed" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT source_restrictions FROM brain_items WHERE id=$1",
        [acceptedAgent.acceptedRecordId],
      )
    ).rows[0].source_restrictions,
  ).toEqual(
    expect.arrayContaining([
      {
        kind: "assignment_input",
        assignmentId: prepared.assignment.id,
        inputRevision: prepared.assignment.inputRevision,
        inputSha256: prepared.assignment.inputSha256,
      },
    ]),
  );
  expect(
    (
      await searchKnowledge(database.db, nativePrincipal, { q: "", limit: 10 })
    ).items.map((item) => item.id),
  ).toContain(acceptedAgent.acceptedRecordId);
  const queryPlan = await database.db.transaction(async (tx) => {
    const identity = await resolveKnowledgePrincipal(
      tx,
      nativePrincipal,
      "knowledge:read",
    );
    const result = await tx.execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${knowledgeReadPolicyCte(identity, sql`true`)} SELECT id FROM knowledge_readable_records LIMIT 10`,
    );

    return z
      .array(
        z.object({
          JIT: z.unknown().optional(),
          "Execution Time": z.number(),
          "Planning Time": z.number(),
        }),
      )
      .min(1)
      .parse(result.rows[0]["QUERY PLAN"])[0];
  });

  expect(queryPlan["Execution Time"] + queryPlan["Planning Time"]).toBeLessThan(
    500,
  );
  const foreign = await reserveCompanyFixtureRun();

  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      foreign.runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId: foreign.snapshot.assignment.id,
            inputRevision: foreign.snapshot.assignment.inputRevision,
            inputSha256: foreign.snapshot.assignment.inputSha256,
          },
        ],
      }),
    ],
  );
  await assertNativeRunKnowledgeInputs(database.db, foreign.runId);
  await expect(
    getKnowledgeRecord(
      database.db,
      { kind: "execution", runId: foreign.runId, nodeAttemptId: null },
      { recordId: acceptedAgent.acceptedRecordId },
    ),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  expect(
    (
      await searchKnowledge(
        database.db,
        { kind: "execution", runId: foreign.runId, nodeAttemptId: null },
        { q: "", limit: 10 },
      )
    ).items.map((item) => item.id),
  ).not.toContain(acceptedAgent.acceptedRecordId);
  const firstPage = await searchKnowledge(database.db, nativePrincipal, {
    q: "",
    limit: 1,
  });

  expect(firstPage.nextCursor).not.toBeNull();
  const userReadGrant = (
    await database.pool.query(
      "SELECT id,revision FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND action='knowledge:read' AND revoked_at IS NULL",
      [userId],
    )
  ).rows[0]!;

  await revokeCompanyGrant(database.db, administratorId, userReadGrant.id, {
    expectedRevision: userReadGrant.revision,
    reason: "Knowledge access revoked independently of assignment access",
    idempotencyKey: randomUUID(),
  });
  await expect(
    getKnowledgeRecord(database.db, nativePrincipal, { recordId }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  expect(
    (await searchKnowledge(database.db, nativePrincipal, { q: "", limit: 10 }))
      .items,
  ).toEqual([]);
  await expect(
    searchKnowledge(database.db, nativePrincipal, {
      q: "",
      limit: 1,
      cursor: firstPage.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["knowledge:read"],
    idempotencyKey: randomUUID(),
  });
  const agentReadGrant = (
    await database.pool.query(
      "SELECT id,revision FROM company_grants WHERE principal_type='agent' AND principal_id=$1 AND action='knowledge:read' AND revoked_at IS NULL",
      [agentId],
    )
  ).rows[0]!;

  await revokeCompanyGrant(database.db, administratorId, agentReadGrant.id, {
    expectedRevision: agentReadGrant.revision,
    reason: "Professional source access revoked",
    idempotencyKey: randomUUID(),
  });
  await expect(
    getKnowledgeRecord(database.db, nativePrincipal, { recordId }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  expect(
    (await searchKnowledge(database.db, nativePrincipal, { q: "", limit: 10 }))
      .items,
  ).toEqual([]);
  await expect(
    createKnowledgeProposal(database.db, {
      kind: "knowledge_add",
      owner: { kind: "company", companyId: request.companyId },
      principal: nativePrincipal,
      idempotencyKey: `revoked-source-proposal:${runId}`,
      draft,
    }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "agent",
    principalId: agentId,
    actions: ["knowledge:read"],
    idempotencyKey: randomUUID(),
  });

  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id=$1",
    [project.id],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'owner')",
    [randomUUID(), project.id, userId],
  );
  const privateRecordId = (
    await database.pool.query(
      "INSERT INTO brain_items(id,project_id,kind,title,content,confidence,content_hash) VALUES($1,$2,'assertion','Project-private knowledge','A project-owned private observation',0.3,$3) RETURNING id",
      [randomUUID(), project.id, randomUUID()],
    )
  ).rows[0]!.id;

  expect(
    (
      await getKnowledgeRecord(database.db, humanPrincipal, {
        recordId: privateRecordId,
      })
    ).owner,
  ).toEqual({ kind: "project", projectId: project.id });
  await expect(
    getKnowledgeRecord(database.db, nativePrincipal, {
      recordId: privateRecordId,
    }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  const derived = await createKnowledgeProposal(database.db, {
    kind: "knowledge_add",
    owner: { kind: "company", companyId: request.companyId },
    principal: humanPrincipal,
    idempotencyKey: `project-source-company:${runId}`,
    draft: {
      ...draft,
      title: "Derived project-private summary",
      evidence: [
        {
          relation: "references",
          reference: { kind: "knowledge", id: privateRecordId, revision: 1 },
        },
      ],
    },
  });
  const acceptedDerived = await reviewKnowledgeProposal(database.db, {
    proposalId: derived.id,
    principal: humanPrincipal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Retain its project source restriction",
    idempotencyKey: `project-source-company-review:${runId}`,
  });

  if (!acceptedDerived.acceptedRecordId)
    throw new Error("Derived source has no retained record identity");
  await expect(
    getKnowledgeRecord(database.db, nativePrincipal, {
      recordId: acceptedDerived.acceptedRecordId,
    }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  expect(
    (
      await searchKnowledge(database.db, nativePrincipal, {
        q: "Derived project-private",
        limit: 10,
      })
    ).items,
  ).toEqual([]);

  await database.pool.query(
    "INSERT INTO brain_record_grants(record_id,principal_type,principal_id,action,created_by) VALUES($1,'agent',$2,'knowledge:propose',$3::jsonb)",
    [
      recordId,
      agentId,
      JSON.stringify({
        kind: "user",
        id: userId,
        runId: null,
        attemptId: null,
      }),
    ],
  );
  const correction = {
    kind: "knowledge_correct" as const,
    owner: { kind: "company" as const, companyId: request.companyId },
    principal: nativePrincipal,
    targetRecordId: recordId,
    expectedRecordRevision: 1,
    idempotencyKey: `company-correction:${runId}`,
    draft: {
      ...draft,
      assertion: "Inspection requires independent post-action verification.",
    },
  };

  await expect(
    createKnowledgeProposal(database.db, correction),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await database.pool.query(
    "INSERT INTO brain_record_grants(record_id,principal_type,principal_id,action,created_by) VALUES($1,'user',$2,'knowledge:propose',$3::jsonb)",
    [
      recordId,
      userId,
      JSON.stringify({
        kind: "user",
        id: userId,
        runId: null,
        attemptId: null,
      }),
    ],
  );
  expect(await createKnowledgeProposal(database.db, correction)).toMatchObject({
    status: "pending",
  });
  expect(
    (await getKnowledgeRecord(database.db, humanPrincipal, { recordId }))
      .revision,
  ).toBe(1);
});

it("CBS-02 resolves and inspects an owned company plain directory without a project and rejects retargeted baseline paths", async () => {
  const { runId } = await reserveCompanyFixtureRun();
  const [run] = await database.db.select().from(runs).where(eq(runs.id, runId));
  const context = await operationalWorkspace(database.db, run);

  expect(context).toMatchObject({
    ownerKind: "company",
    companyId: request.companyId,
    resourceKind: "plain_directory",
    repoPath: null,
    projectSlug: null,
  });
  expect(context.cwd.startsWith(join(root, "worktrees") + sep)).toBe(true);
  expect(context.runtimePath).not.toBe(context.cwd);
  expect(await operationalReferenceEvidence(database.db, run)).toEqual([]);
  await mkdir(context.cwd, { recursive: true });
  await writeFile(
    join(context.cwd, "observations.txt"),
    "Bounded company evidence.",
  );
  const baseline = await captureOperationalGeneration(
    context.cwd,
    await captureOperationalBaseline(context.cwd, "plain_directory"),
    [],
  );
  const owner = {
    kind: "company" as const,
    companyId: request.companyId,
    runId,
    cwd: context.cwd,
    runtimePath: context.runtimePath,
  };
  const retained = {
    ...run,
    operationalIntegrityBaseline: { ...baseline, owner },
  };

  await database.db
    .update(runs)
    .set({
      operationalIntegrityBaseline: retained.operationalIntegrityBaseline,
    })
    .where(eq(runs.id, runId));
  expect(await operationalWorkspace(database.db, retained)).toEqual(context);
  expect(
    await inspectOperationalWorkspace(database.db, retained),
  ).toMatchObject({ verdict: "clean" });
  await writeFile(join(context.cwd, "observations.txt"), "Changed source.");
  expect(
    await inspectOperationalWorkspace(database.db, retained),
  ).toMatchObject({ verdict: "changed" });
  await expect(
    operationalWorkspace(database.db, {
      ...retained,
      operationalIntegrityBaseline: {
        ...baseline,
        owner: { ...owner, cwd: root },
      },
    }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "company_workspace_owner_mismatch" },
  });
  await expect(
    operationalWorkspace(database.db, { ...run, agentWorkspace: "repo_read" }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    operationalWorkspace(database.db, {
      ...run,
      companyExecutionSnapshot: null,
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await expect(
    operationalWorkspace(database.db, {
      ...run,
      companyId: null,
      companyExecutionSnapshot: null,
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
});

async function seedCompanyOperationalTerminal(): Promise<
  Readonly<{
    runId: string;
    assignmentId: string;
    context: Extract<OperationalWorkspaceContext, { ownerKind: "company" }>;
  }>
> {
  const { runId, assignmentId } = await reserveCompanyFixtureRun();
  const [run] = await database.db.select().from(runs).where(eq(runs.id, runId));
  const context = await operationalWorkspace(database.db, run);

  if (context.ownerKind !== "company")
    throw new Error("Expected a company workspace fixture");
  await mkdir(context.cwd, { recursive: true });
  await mkdir(context.runtimePath, { recursive: true });
  await writeFile(join(context.runtimePath, "cache"), "Adapter state");
  await writeFile(
    join(context.cwd, "diagnosis.txt"),
    "Retained company diagnostic input",
  );
  const baseline = await captureOperationalGeneration(
    context.cwd,
    await captureOperationalBaseline(context.cwd, "plain_directory"),
    [],
  );

  await database.db
    .update(runs)
    .set({
      status: "Running",
      operationalIntegrityBaseline: {
        ...baseline,
        contextMounts: [],
        owner: {
          kind: "company",
          companyId: request.companyId,
          runId,
          cwd: context.cwd,
          runtimePath: context.runtimePath,
        },
      },
    })
    .where(eq(runs.id, runId));

  return { runId, assignmentId, context };
}

it("CBS-02 atomically finalizes company result evidence, revokes credentials and releases plain materialization without completing the assignment", async () => {
  const db: Db = database.db;
  const { runId, assignmentId, context } =
    await seedCompanyOperationalTerminal();
  const credential = await issueCompanyAgentRunToken({
    db: database.db,
    runId,
  });
  const prepared = await prepareAgentRunFinalization(runId, "Done", {
    db: database.db,
    finalText:
      "```json maister:output\n" +
      JSON.stringify(operationalSuccessFixture()) +
      "\n```",
  });
  const project = await seedProjectRow(database.db);
  const projectRunId = randomUUID();

  await database.pool.query(
    "INSERT INTO runs(id,run_kind,project_id,agent_id,agent_workspace,flow_version,flow_revision,status) VALUES($1,'agent',$2,$3,'none','agent','manual','Pending')",
    [projectRunId, project.id, agentId],
  );
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,company_id,run_id,payload,occurred_at) VALUES('run.done',$1,$2,'{}'::jsonb,now())",
      [request.companyId, projectRunId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_run_reference_check",
  });
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,company_id,run_id,payload,occurred_at) VALUES('task.created',$1,$2,'{}'::jsonb,now())",
      [request.companyId, runId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_kind_check",
  });
  const originalEvents = (
    await database.pool.query(
      "SELECT count(*)::int AS count FROM domain_events WHERE run_id=$1",
      [runId],
    )
  ).rows[0].count;

  await expect(
    db.transaction(async (tx) => {
      await prepared.apply(tx);
      throw new Error("Roll back terminal fixture application");
    }),
  ).rejects.toThrow("Roll back terminal fixture application");
  expect(
    (await database.pool.query("SELECT status FROM runs WHERE id=$1", [runId]))
      .rows[0].status,
  ).toBe("Running");
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM run_results WHERE run_id=$1",
        [runId],
      )
    ).rows[0].count,
  ).toBe(0);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM domain_events WHERE run_id=$1",
        [runId],
      )
    ).rows[0].count,
  ).toBe(originalEvents);
  await expect(
    verifyToken(credential.secret, database.db),
  ).resolves.toMatchObject({ companyId: request.companyId });

  await expect(
    db.transaction((tx) => prepared.apply(tx)),
  ).resolves.toMatchObject({ finalized: true, status: "Done" });
  await expect(
    verifyToken(credential.secret, database.db),
  ).rejects.toMatchObject({ kind: "revoked" });
  expect(
    (
      await database.pool.query(
        "SELECT status,operational_terminal,operational_cleanup FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0],
  ).toMatchObject({
    status: "Done",
    operational_terminal: {
      successful: true,
      integrity: "clean",
      resultRevision: 1,
    },
    operational_cleanup: { state: "armed" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT company_id,project_id,task_id,kind,payload FROM domain_events WHERE run_id=$1 AND kind='run.done'",
        [runId],
      )
    ).rows,
  ).toMatchObject([
    {
      company_id: request.companyId,
      project_id: null,
      task_id: null,
      kind: "run.done",
      payload: { parentRunId: null, resultStatus: "valid" },
    },
  ]);
  await expect(
    db.transaction((tx) => prepared.apply(tx)),
  ).resolves.toMatchObject({ finalized: false });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM run_results WHERE run_id=$1",
        [runId],
      )
    ).rows[0].count,
  ).toBe(1);
  await expect(
    database.pool.query(
      "UPDATE domain_events SET company_id=NULL,project_id=$2 WHERE run_id=$1 AND kind='run.done'",
      [runId, project.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_identity_check",
  });
  expect(await disposeOperationalRun(runId, { db: database.db })).toBe(
    "released",
  );
  await expect(lstat(context.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(context.runtimePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (
      await database.pool.query(
        "SELECT operational_cleanup FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0].operational_cleanup,
  ).toMatchObject({ state: "released", attempts: 1 });
  expect(
    (
      await database.pool.query(
        "SELECT status FROM specialist_assignments WHERE id=$1",
        [assignmentId],
      )
    ).rows[0].status,
  ).toBe("queued");
  expect(await disposeOperationalRun(runId, { db: database.db })).toBe(
    "skipped",
  );
});

it("CBS-02 refuses company completion without its required result and retains failed source bytes for evidence recovery", async () => {
  const db: Db = database.db;
  const { runId, assignmentId, context } =
    await seedCompanyOperationalTerminal();
  const prepared = await prepareAgentRunFinalization(runId, "Done", {
    db: database.db,
  });

  await expect(
    db.transaction((tx) => prepared.apply(tx)),
  ).resolves.toMatchObject({ finalized: true, status: "Failed" });
  expect(
    (
      await database.pool.query(
        "SELECT operational_terminal FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0].operational_terminal,
  ).toMatchObject({ successful: false, validation: "invalid" });
  expect(
    (
      await database.pool.query(
        "SELECT kind,payload FROM domain_events WHERE run_id=$1 AND kind='run.failed'",
        [runId],
      )
    ).rows,
  ).toMatchObject([
    {
      kind: "run.failed",
      payload: {
        resultStatus: "unavailable",
        cause: { code: "CONFIG", reason: "result_missing" },
      },
    },
  ]);
  expect(await disposeOperationalRun(runId, { db: database.db })).toBe(
    "deferred",
  );
  expect(await readFile(join(context.cwd, "diagnosis.txt"), "utf8")).toBe(
    "Retained company diagnostic input",
  );
  expect(
    (
      await database.pool.query(
        "SELECT operational_cleanup FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0].operational_cleanup,
  ).toMatchObject({
    state: "retry",
    attempts: 1,
    errorCode: "operational_evidence_host_missing",
  });
  expect(
    (
      await database.pool.query(
        "SELECT status FROM specialist_assignments WHERE id=$1",
        [assignmentId],
      )
    ).rows[0].status,
  ).toBe("queued");
});

it("CBS-02 quarantines a company specialist source violation and preserves failed bytes instead of accepting a valid-looking result", async () => {
  const db: Db = database.db;
  const { runId, context } = await seedCompanyOperationalTerminal();
  const credential = await issueCompanyAgentRunToken({ db, runId });

  await writeFile(
    join(context.cwd, "diagnosis.txt"),
    "Unapproved source mutation",
  );
  const prepared = await prepareAgentRunFinalization(runId, "Done", {
    db,
    finalText:
      "```json maister:output\n" +
      JSON.stringify(operationalSuccessFixture()) +
      "\n```",
  });

  await expect(
    db.transaction((tx) => prepared.apply(tx)),
  ).resolves.toMatchObject({ finalized: true, status: "Failed" });
  expect(
    (
      await database.pool.query(
        "SELECT operational_terminal FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0].operational_terminal,
  ).toMatchObject({ integrity: "changed", successful: false });
  expect(
    (
      await database.pool.query(
        "SELECT quarantined_at,quarantine_reason FROM agents WHERE id=$1",
        [agentId],
      )
    ).rows[0],
  ).toMatchObject({
    quarantined_at: expect.any(Date),
    quarantine_reason: "operational_source_contract_violation",
  });
  await expect(verifyToken(credential.secret, db)).rejects.toMatchObject({
    kind: "revoked",
  });
  expect(await disposeOperationalRun(runId, { db })).toBe("deferred");
  expect(await readFile(join(context.cwd, "diagnosis.txt"), "utf8")).toBe(
    "Unapproved source mutation",
  );
});

it("requires current explicit company admission authority even for an administrator and after an earlier successful preflight", async () => {
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, administratorId, request),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await revokeCompanyGrant(database.db, administratorId, grantId, {
    expectedRevision: 1,
    reason: "Admission revoked",
    idempotencyKey: randomUUID(),
  });
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, request),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
