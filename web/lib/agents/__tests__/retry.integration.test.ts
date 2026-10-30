import { randomUUID } from "node:crypto";
import { rm, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  getAgentRetryOptions,
  acceptAgentRetry,
  runAgentRetryAdmissionSweep,
  getAgentRetryReceipt,
} from "@/lib/agents/retry";
import { prepareUndispatchedAgentFailure } from "@/lib/agents/finalization";
import { runs, runSessions, platformAcpRunners } from "@/lib/db/schema";
import { allocateAgentRetryWorktree } from "@/lib/agents/retry-allocation";
import { agentWorkdirPath } from "@/lib/agents/workspace-paths";
import { agentWorktreeBranchName } from "@/lib/agents/launch";
import { git } from "@/test-support/git-fixture";
import { rearmAgentRetryCleanup } from "@/lib/agents/retry";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/lib/scheduler", async (original) => ({
  ...(await original<typeof import("@/lib/scheduler")>()),
  tryStartRun: async () => ({ started: false, queuePosition: 1 }),
}));
let database: StartedPostgresTestDb;
let sessionUserId: string | null = null;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: sessionUserId, role: "member" }),
}));
let root: string;
const previousRoot = process.env.MAISTER_WORKTREES_ROOT;

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "agent_retry" });
  root = await mkdtempReal("agent-retry-");
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  await fakeExecutionHosts(database.db);
}, 180_000);

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = previousRoot;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture(workspace: "none" | "worktree" = "none"): Promise<{
  runId: string;
  userId: string;
  projectId: string;
  runnerId: string;
}> {
  const runId = await seedAgentRun(database.db, {
    runtimeRoot: root,
    definition: `---\nname: Researcher\ndescription: inspect\nmode: session\nworkspace: ${workspace}\ntriggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n---\nInspect the task.`,
    workspace,
    resultContract: null,
  });
  const [run] = await database.db.select().from(runs).where(eq(runs.id, runId));
  const [session] = await database.db
    .select()
    .from(runSessions)
    .where(eq(runSessions.runId, runId));
  const userId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES ($1,$2,'member','active',false)",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'member')",
    [randomUUID(), run.projectId, userId],
  );
  await database.pool.query(
    "INSERT INTO platform_runtime_settings(id,default_runner_id) VALUES ('singleton',$1) ON CONFLICT(id) DO UPDATE SET default_runner_id=excluded.default_runner_id",
    [session.runnerId],
  );
  const prepared = await prepareUndispatchedAgentFailure(runId, {
    db: database.db,
    reason: "agent_dispatch_failed",
  });

  await database.db.transaction(prepared.apply);

  return {
    runId,
    userId,
    projectId: run.projectId!,
    runnerId: session.runnerId!,
  };
}

it("IT-UX-14 accepts one immutable retry of a proven pre-work failure, converges replay and concurrent admission, and leaves a capacity-queued child visible", async () => {
  const fixtureData = await fixture();
  const alternativeId = randomUUID();
  const alternative = testRunnerSnapshot(alternativeId, "codex");

  await database.db.insert(platformAcpRunners).values({
    id: alternativeId,
    adapter: "codex",
    capabilityAgent: "codex",
    model: alternative.model,
    provider: { kind: "openai" },
    permissionPolicy: "default",
    readinessStatus: "Ready",
    readinessReasons: [],
    enabled: true,
  });
  const options = await getAgentRetryOptions(
    database.db,
    fixtureData.runId,
    fixtureData.userId,
  );

  expect(options).toMatchObject({ eligible: true, reason: null });
  const request = {
    runnerId: alternativeId,
    requestKey: randomUUID(),
    previewFingerprint: options.previewFingerprint,
  };
  const first = await acceptAgentRetry(
    database.db,
    fixtureData.runId,
    fixtureData.userId,
    request,
  );

  expect(first).toMatchObject({ intentState: "accepted", runId: null });
  expect(
    await acceptAgentRetry(
      database.db,
      fixtureData.runId,
      fixtureData.userId,
      request,
    ),
  ).toEqual(first);
  await expect(
    acceptAgentRetry(database.db, fixtureData.runId, fixtureData.userId, {
      ...request,
      requestKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await Promise.all([
    runAgentRetryAdmissionSweep(database.db),
    runAgentRetryAdmissionSweep(database.db),
  ]);
  const receipt = await getAgentRetryReceipt(
    database.db,
    fixtureData.runId,
    first.retryIntentId,
    fixtureData.userId,
  );

  expect(receipt).toMatchObject({
    intentState: "launched",
    runStatus: "Pending",
  });
  const children = (
    await database.pool.query(
      "SELECT retry_of_run_id,trigger_source,trigger_event_id,agent_config,status FROM runs WHERE retry_of_run_id=$1",
      [fixtureData.runId],
    )
  ).rows;

  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({
    retry_of_run_id: fixtureData.runId,
    trigger_source: "manual",
    trigger_event_id: null,
    status: "Pending",
  });
  expect(
    (
      await database.pool.query(
        "SELECT state,recipe FROM agent_retry_intents WHERE id=$1",
        [first.retryIntentId],
      )
    ).rows[0].recipe.runner.id,
  ).toBe(alternativeId);
  expect(
    (
      await database.pool.query(
        "SELECT runner_id FROM run_sessions WHERE run_id=$1",
        [receipt.runId],
      )
    ).rows[0].runner_id,
  ).toBe(alternativeId);
  expect(
    (
      await database.pool.query(
        "SELECT runner_id FROM run_sessions WHERE run_id=$1",
        [fixtureData.runId],
      )
    ).rows[0].runner_id,
  ).toBe(fixtureData.runnerId);
  expect(
    (
      await database.pool.query(
        "SELECT runner_override_id FROM agent_project_links WHERE project_id=$1",
        [fixtureData.projectId],
      )
    ).rows[0].runner_override_id,
  ).toBeNull();
});

it("IT-UX-15 refuses unknown work and stale previews, and revokes delayed execution when the accepting actor loses access", async () => {
  const source = await fixture();
  const options = await getAgentRetryOptions(
    database.db,
    source.runId,
    source.userId,
  );

  await expect(
    acceptAgentRetry(database.db, source.runId, source.userId, {
      runnerId: source.runnerId,
      requestKey: randomUUID(),
      previewFingerprint: "0".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const receipt = await acceptAgentRetry(
    database.db,
    source.runId,
    source.userId,
    {
      runnerId: source.runnerId,
      requestKey: randomUUID(),
      previewFingerprint: options.previewFingerprint,
    },
  );

  await database.pool.query("DELETE FROM project_members WHERE user_id=$1", [
    source.userId,
  ]);
  await runAgentRetryAdmissionSweep(database.db);
  expect(
    (
      await database.pool.query(
        "SELECT state,refusal_reason FROM agent_retry_intents WHERE id=$1",
        [receipt.retryIntentId],
      )
    ).rows[0],
  ).toEqual({ state: "refused", refusal_reason: "retry_authority_revoked" });
  expect(
    (
      await database.pool.query(
        "SELECT id FROM runs WHERE retry_of_run_id=$1",
        [source.runId],
      )
    ).rows,
  ).toEqual([]);
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'member')",
    [randomUUID(), source.projectId, source.userId],
  );
  await database.pool.query(
    "UPDATE run_sessions SET acp_session_id='unresolved-source' WHERE run_id=$1",
    [source.runId],
  );
  expect(
    await getAgentRetryOptions(database.db, source.runId, source.userId),
  ).toMatchObject({ eligible: false, reason: "reconciliation_required" });
});

async function abandonedAllocation(
  source: Awaited<ReturnType<typeof fixture>>,
): Promise<{
  intentId: string;
  successorId: string;
  worktree: string;
  repo: string;
  claim: { intentId: string; owner: string; fence: number };
}> {
  const options = await getAgentRetryOptions(
    database.db,
    source.runId,
    source.userId,
  );
  const accepted = await acceptAgentRetry(
    database.db,
    source.runId,
    source.userId,
    {
      runnerId: source.runnerId,
      requestKey: randomUUID(),
      previewFingerprint: options.previewFingerprint,
    },
  );
  const intent = (
    await database.pool.query(
      "UPDATE agent_retry_intents SET lease_owner='crash-fixture',lease_fence=lease_fence+1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1 RETURNING *",
      [accepted.retryIntentId],
    )
  ).rows[0];
  const project = (
    await database.pool.query("SELECT * FROM projects WHERE id=$1", [
      source.projectId,
    ])
  ).rows[0];
  const run = (
    await database.pool.query("SELECT agent_id FROM runs WHERE id=$1", [
      source.runId,
    ])
  ).rows[0];
  const worktree = agentWorkdirPath(project.slug, intent.successor_run_id);
  const branch = agentWorktreeBranchName({
    prefix: project.branch_prefix,
    agentId: run.agent_id,
    runId: intent.successor_run_id,
  });
  const claim = {
    intentId: intent.id,
    owner: "crash-fixture",
    fence: intent.lease_fence,
  };

  await allocateAgentRetryWorktree(database.db, claim, {
    runId: intent.successor_run_id,
    projectId: source.projectId,
    repositoryPath: project.repo_path,
    path: worktree,
    branch,
    baseCommit: (await git(project.repo_path, "rev-parse", "main")).trim(),
  });
  await database.pool.query(
    "UPDATE agent_retry_intents SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [intent.id],
  );

  return {
    intentId: intent.id,
    successorId: intent.successor_run_id,
    worktree,
    repo: project.repo_path,
    claim,
  };
}

it("IT-UX-15 adopts only the exact preallocated worktree after a dead owner, fences stale insertion, and preserves foreign bytes through cleanup failure and explicit rearm", async () => {
  const clean = await fixture("worktree");
  const abandoned = await abandonedAllocation(clean);

  await runAgentRetryAdmissionSweep(database.db);
  expect(
    await getAgentRetryReceipt(
      database.db,
      clean.runId,
      abandoned.intentId,
      clean.userId,
    ),
  ).toMatchObject({
    intentState: "launched",
    runId: abandoned.successorId,
    runStatus: "Pending",
    cleanup: { state: "released" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int total FROM runs WHERE retry_of_run_id=$1",
        [clean.runId],
      )
    ).rows[0].total,
  ).toBe(1);
  await expect(
    allocateAgentRetryWorktree(database.db, abandoned.claim, {
      runId: abandoned.successorId,
      projectId: clean.projectId,
      repositoryPath: abandoned.repo,
      path: abandoned.worktree,
      branch: "foreign",
      baseCommit: "a".repeat(40),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const dirty = await fixture("worktree");
  const interrupted = await abandonedAllocation(dirty);

  await writeFile(
    path.join(interrupted.worktree, "unexpected.txt"),
    "preserve this diagnosis",
  );
  const index = (
    await git(interrupted.worktree, "rev-parse", "--git-path", "index")
  ).trim();
  const lock = path.isAbsolute(index)
    ? `${index}.lock`
    : path.join(interrupted.worktree, `${index}.lock`);

  await writeFile(lock, "");
  await database.pool.query(
    "UPDATE agent_retry_intents SET allocation=jsonb_set(allocation,'{attempts}','4') WHERE id=$1",
    [interrupted.intentId],
  );
  await runAgentRetryAdmissionSweep(database.db);
  const refused = await getAgentRetryReceipt(
    database.db,
    dirty.runId,
    interrupted.intentId,
    dirty.userId,
  );

  expect(refused).toMatchObject({
    intentState: "refused",
    runId: null,
    cleanup: { state: "exhausted" },
  });
  expect(
    await readFile(path.join(interrupted.worktree, "unexpected.txt"), "utf8"),
  ).toBe("preserve this diagnosis");
  const request = {
    requestKey: randomUUID(),
    expectedDispositionRevision: refused.cleanup!.revision,
  };

  await expect(
    rearmAgentRetryCleanup(
      database.db,
      dirty.runId,
      interrupted.intentId,
      dirty.userId,
      { ...request, expectedDispositionRevision: 1 },
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const rearmed = await rearmAgentRetryCleanup(
    database.db,
    dirty.runId,
    interrupted.intentId,
    dirty.userId,
    request,
  );

  expect(
    await rearmAgentRetryCleanup(
      database.db,
      dirty.runId,
      interrupted.intentId,
      dirty.userId,
      request,
    ),
  ).toEqual(rearmed);
  await rm(lock);
  await runAgentRetryAdmissionSweep(database.db);
  const settled = await getAgentRetryReceipt(
    database.db,
    dirty.runId,
    interrupted.intentId,
    dirty.userId,
  );

  expect(settled).toMatchObject({
    intentState: "refused",
    runId: null,
    cleanup: { state: "released" },
  });
  await expect(access(interrupted.worktree)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (
      await git(
        interrupted.repo,
        "show",
        `maister/archive/${interrupted.successorId}:unexpected.txt`,
      )
    ).trim(),
  ).toBe("preserve this diagnosis");
  expect(
    (
      await database.pool.query(
        "SELECT id FROM runs WHERE retry_of_run_id=$1",
        [dirty.runId],
      )
    ).rows,
  ).toEqual([]);
});

it("IT-UX-14 enforces the actual retry HTTP boundary, excludes protected recipes and rejects untrusted body locators and revoked grants", async () => {
  const { GET } = await import("@/app/api/runs/[runId]/retry-options/route");
  const { POST } = await import("@/app/api/runs/[runId]/retry/route");
  const source = await fixture();
  const params = { params: Promise.resolve({ runId: source.runId }) };

  sessionUserId = source.userId;
  const optionsResponse = await GET(
    new Request("http://test/retry-options"),
    params,
  );
  const options = await optionsResponse.json();

  expect(optionsResponse.status).toBe(200);
  expect(options).toMatchObject({ eligible: true, existingIntentId: null });
  expect(JSON.stringify(options)).not.toMatch(
    /installedPath|sourcePath|permissionPolicy|authToken|apiKey/,
  );
  const request = {
    runnerId: source.runnerId,
    requestKey: randomUUID(),
    previewFingerprint: options.previewFingerprint,
  };

  expect(
    (
      await POST(
        new Request("http://test/retry", {
          method: "POST",
          body: JSON.stringify({ ...request, projectId: source.projectId }),
        }),
        params,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await POST(
        new Request("http://test/retry", { method: "POST", body: "{" }),
        params,
      )
    ).status,
  ).toBe(400);
  await database.pool.query(
    "UPDATE project_members SET role='viewer' WHERE user_id=$1",
    [source.userId],
  );
  expect(
    (await GET(new Request("http://test/retry-options"), params)).status,
  ).toBe(403);
  await database.pool.query(
    "UPDATE project_members SET role='member' WHERE user_id=$1",
    [source.userId],
  );
  const receipt = await acceptAgentRetry(
    database.db,
    source.runId,
    source.userId,
    request,
  );

  expect(
    await getAgentRetryOptions(database.db, source.runId, source.userId),
  ).toMatchObject({
    eligible: false,
    reason: "retry_successor_already_owned",
    existingIntentId: receipt.retryIntentId,
  });
  await database.pool.query(
    "UPDATE agent_project_links SET enabled=false WHERE project_id=$1",
    [source.projectId],
  );
  await runAgentRetryAdmissionSweep(database.db);
  expect(
    await getAgentRetryReceipt(
      database.db,
      source.runId,
      receipt.retryIntentId,
      source.userId,
    ),
  ).toMatchObject({ intentState: "refused", runId: null });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int total FROM runs WHERE retry_of_run_id=$1",
        [source.runId],
      )
    ).rows[0].total,
  ).toBe(0);
});
