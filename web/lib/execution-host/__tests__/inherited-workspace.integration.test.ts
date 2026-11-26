import type { Db } from "../db";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";

import {
  WORKSPACE_GIT_CHECKPOINT_PREFIX,
  WORKSPACE_WORKLOAD_FILE,
} from "../../../../runtime/workspace-prepare";
import {
  installLocalPullRequestProvider,
  localPullRequestUrl,
} from "../../../../supervisor/test/fixtures/local-pr-provider";

import { closeDb } from "@/lib/db/client";
import {
  artifactInstances,
  executionAssignments,
  hitlRequests,
  nodeAttempts,
  runs,
  runSyncAttempts,
  runSessions,
  workspaces,
} from "@/lib/db/schema";
import { listCommandsForRun } from "@/lib/execution-host/commands";
import { nodeWorkloadDeclarationId } from "@/lib/flows/addressed-workload-input";
import { git, initRepo } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  addProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { startRealSupervisor } from "@/test-support/real-supervisor";

import { mintPlacement } from "../placement";
import { ensureLocalExecutionHost } from "../registrar";
import { getCommand, insertCommand } from "../commands";
import { getLatestAssignment, releaseAssignmentForRun } from "../assignments";
import { createExecutionHosts } from "../client";
import { canonicalLifecycleProjector } from "../events/lifecycle-projector";
import {
  startRuntimeEventConsumer,
  stopRuntimeEventConsumers,
} from "../events/consumer";
import { projectExecutionEvents } from "../events/projector";
import { projectCanonicalRuntimeObjects } from "../events/runtime-object-projector";
import {
  startCanonicalProjectionWorker,
  stopCanonicalProjectionWorker,
} from "../events/projection-runtime";
import { createLocalDirectTransport } from "../transports/local-direct";
import { reserveWorkspaceGitOperation } from "../workspace-checkpoint";
import {
  advanceAddressedWorkspaceAdmission,
  dispatchQueuedWorkspaceCommand,
} from "../workspace-dispatch";
import { reserveHostWorkspace } from "../workspace-preparation";
import { readAddressedWorkspacePatch } from "../workspace-review";
import { reserveWorkspaceWorkload } from "../workspace-workloads";

let root: string | undefined;
let database: StartedPostgresTestDb | undefined;
let supervisor: RealSupervisor | undefined;
const session = vi.hoisted(() => ({ userId: "" }));
const drivers = vi.hoisted(() => [] as Promise<void>[]);

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: session.userId } }),
}));

vi.mock("@/lib/flows/runner", async (importOriginal) => {
  const runner = await importOriginal<typeof import("@/lib/flows/runner")>();

  return {
    ...runner,
    runFlow: (...args: Parameters<typeof runner.runFlow>) => {
      const run = runner.runFlow(...args);
      drivers.push(run);

      return run;
    },
  };
});

afterEach(async () => {
  const results = await Promise.allSettled(drivers.splice(0));
  await stopCanonicalProjectionWorker();
  await stopRuntimeEventConsumers();
  await supervisor?.kill();
  await closeDb();
  vi.unstubAllEnvs();
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
});

async function prepareWorkspaceFixture(options?: { usePullRequestProvider: true }) {
  const validation = `printf 'validation continued%s' "{{ review_comments ?? '' }}"`;
  root = await mkdtemp(join(tmpdir(), "stage-c-inherited-workspace-"));
  const repository = await initRepo(join(root, "approved-source"));
  await writeFile(join(repository, "README.md"), "captured base\n");
  await git(repository, "add", "--", "README.md");
  await git(repository, "commit", "-m", "tracked starting state");
  const base = (await git(repository, "rev-parse", "HEAD")).trim();
  const provider = options?.usePullRequestProvider
    ? await installLocalPullRequestProvider(root, repository)
    : null;
  database = await startMainPostgresTestDb({
    databaseName: "eh_inherited_workspace",
  });
  const db = database.db as unknown as Db;
  session.userId = await seedActiveUser(database.db);
  const seeded = await seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "Addressed takeover",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: {
            human: {
              role: "maintainer",
              decisions: ["approve", "takeover", "rework"],
              commentsVar: "review_comments",
            },
          },
          transitions: {
            approve: "done",
            takeover: "validate",
            rework: "validate",
          },
          rework: {
            allowedTargets: ["validate"],
            workspacePolicies: ["keep", "fresh-attempt"],
            maxLoops: 2,
            commentsVar: "review_comments",
          },
        },
        {
          id: "validate",
          type: "cli",
          action: { command: validation },
          transitions: { success: "done" },
        },
      ],
    },
    {
      repoPath: join(root, "web-has-no-repo"),
      workspace: false,
      flowRevision: true,
      run: { status: "Pending", createdByUserId: session.userId },
    },
  );
  const { projectId, runId } = seeded;
  await rm(seeded.runtimeRoot, { recursive: true, force: true });
  await rm(seeded.worktreePath, { recursive: true, force: true });
  await addProjectMember(database.db, {
    userId: session.userId,
    projectId,
    role: "member",
  });
  vi.stubEnv("DB_URL", database.databaseUrl);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", join(root, "manager-runtime"));
  supervisor = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    fixtureAdapters: ["codex"],
    env: {
      MAISTER_WORKSPACE_REPOSITORIES: JSON.stringify({
        [projectId]: provider?.source ?? repository,
      }),
      ...(provider ? { PATH: provider.path } : {}),
    },
  });
  const health = (await (await fetch(supervisor.url + "/health")).json()) as {
    host: { hostKey: string };
  };
  vi.stubEnv("MAISTER_SUPERVISOR_URL", supervisor.url);
  vi.stubEnv("MAISTER_SELECTED_EXECUTION_HOST_KEY", health.host.hostKey);
  const transport = createLocalDirectTransport();
  const registration = await ensureLocalExecutionHost({ db, transport });
  if (registration.status !== "registered")
    throw new Error("fixture supervisor did not register");
  const { host } = registration;
  startRuntimeEventConsumer({ db, transport, executionHostId: host.id });
  const initial = await db.transaction(async (tx) => {
    const assignment = await mintPlacement(tx, {
      host,
      runId,
      reason: "launch",
    });
    await reserveHostWorkspace(
      tx,
      { host, assignment },
      { projectId, branch: "fixture", baseCommit: base },
      {
        mode: "ownWorktree",
        repositoryId: projectId,
        commit: base,
        inputDigest: "a".repeat(64),
      },
      [
        {
          path: WORKSPACE_WORKLOAD_FILE,
          bytes: Buffer.from(
            JSON.stringify([
              {
                id: "fixture-edit",
                workload: "cli",
                command: "printf 'after handoff\\n' > README.md",
                timeoutMs: 5_000,
              },
              {
                id: nodeWorkloadDeclarationId("validate"),
                workload: "cli",
                command: validation,
                timeoutMs: 5_000,
              },
            ]),
          ),
        },
      ],
    );
    return assignment;
  });
  const readWorkspace = async () =>
    (await db.select().from(workspaces).where(eq(workspaces.runId, runId)))[0];
  const projectEvidence = async () => {
    await projectCanonicalRuntimeObjects({ db, runId });
    await projectExecutionEvents({
      db,
      projector: canonicalLifecycleProjector,
      runId,
    });
  };
  const settle = async (commandId: string): Promise<void> => {
    await dispatchQueuedWorkspaceCommand(db, { runId, commandId });
    await vi.waitFor(
      async () => {
        await projectEvidence();
        expect(await getCommand(db, commandId)).toMatchObject({
          state: "succeeded",
        });
      },
      { timeout: 10_000 },
    );
  };
  const patchOf = async (
    workspace: typeof workspaces.$inferSelect,
  ): Promise<string> => {
    let patch: string | undefined;
    const reading = readAddressedWorkspacePatch({
      db,
      workspace,
      range: { base },
      signal: AbortSignal.timeout(10_000),
    }).then(({ patch: observed }) => {
      patch = observed;
    });
    try {
      await vi.waitFor(
        async () => {
          await projectEvidence();
          expect(patch).toBeDefined();
        },
        { timeout: 10_000 },
      );
      if (patch === undefined)
        throw new Error("workspace evidence did not settle");
      return patch;
    } finally {
      await reading;
    }
  };
  await vi.waitFor(
    async () => {
      await advanceAddressedWorkspaceAdmission(db, runId);
      await projectEvidence();
      expect(await readWorkspace()).toMatchObject({
        worktreePath: null,
        workspaceMaterializationGeneration: 1,
      });
    },
    { timeout: 10_000 },
  );

  return {
    db,
    host,
    initial,
    base,
    projectId,
    repository,
    runId,
    readWorkspace,
    projectEvidence,
    patchOf,
    settle,
    supervisor,
  };
}

function privateCheckoutPath(
  owningHost: RealSupervisor,
  handle: string,
): string {
  const state = new DatabaseSync(join(owningHost.stateDir, "state.sqlite"), {
    readOnly: true,
  });
  try {
    const path = state
      .prepare("SELECT real_path AS path FROM workspaces WHERE id=?")
      .get(handle)?.path;
    if (typeof path !== "string")
      throw new Error("The supervisor did not retain the checkout");

    return path;
  } finally {
    state.close();
  }
}

it("C-09 rejects stale rework feedback after an addressed checkout changes and accepts its refreshed preview", async () => {
  const {
    db,
    initial,
    runId,
    readWorkspace,
    settle,
    supervisor: owningHost,
  } = await prepareWorkspaceFixture();
  await db
    .update(runs)
    .set({ status: "NeedsInput", currentStepId: "review" })
    .where(eq(runs.id, runId));
  const workspace = await readWorkspace();
  if (!workspace.executionWorkspaceId)
    throw new Error("The preview fixture has no retained handle");
  const path = privateCheckoutPath(owningHost, workspace.executionWorkspaceId);
  await writeFile(join(path, "README.md"), "pre-attempt worktree state\n");
  const checkpoint = await reserveWorkspaceGitOperation(db, {
    runId,
    assignmentId: initial.id,
    kind: "workspace.checkpoint",
    operationKey: "review-target",
  });
  await settle(checkpoint.id);
  await db.insert(nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "validate",
    nodeType: "cli",
    attempt: 1,
    status: "Succeeded",
    executionAssignmentId: initial.id,
    checkpointRef: WORKSPACE_GIT_CHECKPOINT_PREFIX + checkpoint.id,
  });
  startCanonicalProjectionWorker();
  const hitlRequestId = randomUUID();
  await db.insert(nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "review",
    nodeType: "human",
    attempt: 1,
    status: "NeedsInput",
    executionAssignmentId: initial.id,
  });
  await db.insert(hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: "review",
    kind: "human",
    prompt: "Review the change",
    schema: {
      review: true,
      allowedDecisions: ["approve", "rework"],
      transitions: { approve: "done", rework: "validate" },
      reworkTargets: ["validate"],
      workspacePolicies: ["keep", "fresh-attempt"],
      commentsVar: "review_comments",
    },
  });
  const { POST: preview } =
    await import("@/app/api/runs/[runId]/hitl/[hitlRequestId]/review-feedback-preview/route");
  const { POST: respond } =
    await import("@/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route");
  const params = { params: Promise.resolve({ runId, hitlRequestId }) };
  const response = {
    decision: "rework",
    comments: "Exercise empty input.",
    workspacePolicy: "fresh-attempt",
  };
  const request = (action: string, body: unknown) =>
    new NextRequest(
      `http://localhost/api/runs/${runId}/hitl/${hitlRequestId}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  const fingerprints = async () => {
    const reply = await preview(
      request("review-feedback-preview", { response }),
      params,
    );
    const data = await reply.json();
    expect(reply.status, JSON.stringify(data)).toBe(200);

    return {
      reviewSourceFingerprint: data.reviewSource.fingerprint,
      reviewFeedbackFingerprint: data.feedback.fingerprint,
    };
  };
  const original = await fingerprints();
  const privateState = new DatabaseSync(
    join(owningHost.stateDir, "state.sqlite"),
    { readOnly: true },
  );
  try {
    expect(
      privateState
        .prepare(
          "SELECT count(*) AS total FROM runtime_objects WHERE logical_name='workspace-review.json'",
        )
        .get()?.total,
    ).toBe(0);
  } finally {
    privateState.close();
  }
  await writeFile(
    join(path, "README.md"),
    "a new revision of the review target\n",
  );
  const rejected = await respond(
    request("respond", { response, ...original }),
    params,
  );
  expect(rejected.status, JSON.stringify(await rejected.json())).toBe(409);
  const [pending] = await db
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));
  expect(pending.response).toBeNull();
  const fresh = await fingerprints();
  expect(fresh.reviewSourceFingerprint).not.toBe(
    original.reviewSourceFingerprint,
  );
  expect(fresh.reviewFeedbackFingerprint).toBe(
    original.reviewFeedbackFingerprint,
  );
  const accepted = await respond(
    request("respond", { response, ...fresh }),
    params,
  );
  expect(accepted.status, JSON.stringify(await accepted.json())).toBe(200);
  const [stored] = await db
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));
  expect(stored).toMatchObject({ response, respondedAt: expect.any(Date) });
  await vi.waitFor(
    async () => {
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      expect(run.status).toBe("Review");
      const attempts = await db
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.runId, runId));
      expect(attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: "validate",
            status: "Succeeded",
            stdout: expect.stringContaining("Exercise empty input."),
          }),
        ]),
      );
    },
    { timeout: 15_000, interval: 100 },
  );
  expect(await readFile(join(path, "README.md"), "utf8")).toBe(
    "captured base\n",
  );
}, 60_000);

it("C-10 updates a retained worktree through the normal sync route and settles its original claim", async () => {
  const {
    db,
    supervisor: owningHost,
    base,
    runId,
    repository,
    readWorkspace,
  } = await prepareWorkspaceFixture();
  const { executionWorkspaceId: handle } = await readWorkspace();
  if (!handle) throw new Error("The sync fixture has no checkout");
  const checkout = privateCheckoutPath(owningHost, handle);
  await writeFile(join(checkout, "retained.txt"), "local commit\n");
  await git(checkout, "add", "--", "retained.txt");
  await git(checkout, "commit", "-m", "retained work");
  const local = await git(checkout, "rev-parse", "HEAD");
  const publicBranch = "test-shared-sync-branch";
  await git(checkout, "push", "origin", `HEAD:refs/heads/${publicBranch}`);
  const upstream = join(dirname(repository), "upstream");
  await git(repository, "config", "receive.denyCurrentBranch", "updateInstead");
  await git(dirname(repository), "clone", repository, upstream);
  await writeFile(join(upstream, "upstream.txt"), "approved upstream commit\n");
  await git(upstream, "add", "--", "upstream.txt");
  await git(upstream, "commit", "-m", "advance the approved target");
  await git(upstream, "push", "origin", "HEAD:refs/heads/main");
  const target = await git(upstream, "rev-parse", "HEAD");
  expect(target).not.toBe(base);
  await db.transaction(async (tx) => {
    await tx.update(workspaces).set({
      publishedBranch: publicBranch, publishedRemote: "origin", publishedAt: new Date(),
    }).where(eq(workspaces.runId, runId));
    await tx
      .update(runs)
      .set({ status: "Review", reviewEnteredAt: new Date() })
      .where(eq(runs.id, runId));
    await releaseAssignmentForRun(tx, runId, "run_terminal");
  });
  startCanonicalProjectionWorker();
  const { GET: readGitState } =
    await import("@/app/api/runs/[runId]/git-state/route");
  const actionState = await readGitState(
    new Request(`http://localhost/api/runs/${runId}/git-state`),
    { params: Promise.resolve({ runId }) },
  );
  expect(actionState.status).toBe(200);
  expect(await actionState.json()).toMatchObject({
    actions: expect.arrayContaining([
      { id: "update", enabled: true, disabledReason: null },
    ]),
  });
  const { POST } = await import("@/app/api/runs/[runId]/sync/route");
  const send = (strategy: "merge" | "rebase", push?: boolean, agent = false) =>
    POST(
      new NextRequest(`http://localhost/api/runs/${runId}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategy, agent, push }),
      }),
      { params: Promise.resolve({ runId }) },
    );
  const response = await send("merge", undefined, true);
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(result).toMatchObject({ outcome: "synced", behind: 1, pushed: true });
  const observed = await git(checkout, "rev-parse", "HEAD");
  expect(await git(checkout, "rev-list", "--parents", "-n", "1", "HEAD")).toBe(
    `${observed} ${local} ${target}`,
  );
  expect(await git(repository, "rev-parse", "main")).toBe(target);
  expect(await git(repository, "rev-parse", `refs/heads/${publicBranch}`)).toBe(observed);
  expect(await readWorkspace()).toMatchObject({
    worktreePath: null,
    lifecycleOperationState: "none",
    lifecycleOperationAttemptId: null,
  });
  const [attempt] = await db
    .select()
    .from(runSyncAttempts)
    .where(eq(runSyncAttempts.id, result.attemptId));
  expect(attempt).toMatchObject({
    phase: "succeeded",
    mode: "mechanical",
    strategy: "merge",
    pushed: true,
    headShaBefore: local,
    headShaAfter: observed,
    targetSha: target,
  });

  await writeFile(
    join(upstream, "retained.txt"),
    "incompatible upstream commit\n",
  );
  await git(upstream, "add", "--", "retained.txt");
  await git(upstream, "commit", "-m", "add conflicting upstream file");
  await git(upstream, "push", "origin", "HEAD:refs/heads/main");
  const refusal = await send("rebase", false);
  const refusedBody = await refusal.json();
  const conflictCommand = (await listCommandsForRun(db, runId)).find(
    ({ kind, payload }) => kind === "workspace.sync" && payload.strategy === "rebase",
  );
  expect(conflictCommand?.payload).toMatchObject({ onConflict: "report" });
  expect(refusal.status, JSON.stringify({ result: refusedBody, lastError: conflictCommand?.lastError })).toBe(200);
  expect(refusedBody).toMatchObject({
    outcome: "conflict",
    behind: 1,
    pushed: false,
    conflictedFiles: ["retained.txt"],
  });
  const [aborted] = await db.select().from(runSyncAttempts).where(eq(runSyncAttempts.id, refusedBody.attemptId));
  expect(aborted).toMatchObject({ phase: "aborted", conflictedFiles: ["retained.txt"] });
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(observed);
  expect(await git(checkout, "status", "--porcelain")).toBe("");
  expect(await git(checkout, "show", "HEAD:retained.txt")).toBe("local commit");
  expect(await git(repository, "rev-parse", `refs/heads/${publicBranch}`)).toBe(observed);
  expect(await readWorkspace()).toMatchObject({
    lifecycleOperationState: "none",
    lifecycleOperationAttemptId: null,
  });
}, 60_000);

it("C-10 publishes and finalizes a host-owned Run through the normal promotion route", async () => {
  const {
    db,
    host,
    runId,
    repository,
    readWorkspace,
    supervisor: owningHost,
  } = await prepareWorkspaceFixture();
  const { executionWorkspaceId: handle, id } = await readWorkspace();
  if (!handle)
    throw new Error("The promotion fixture has no retained worktree");
  const checkout = privateCheckoutPath(owningHost, handle);
  await writeFile(join(checkout, "README.md"), "reviewed publication\n");
  await git(checkout, "add", "--", "README.md");
  await git(checkout, "commit", "-m", "reviewed publication");
  const target = { remote: "origin", remoteBranch: "published-fixture" };
  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({
        status: "Review",
        reviewEnteredAt: new Date(),
        deliveryPolicySnapshot: {
          strategy: "publish_branch",
          push: "on_success",
          trigger: "manual",
          targetBranch: "main",
        },
      })
      .where(eq(runs.id, runId));
    await releaseAssignmentForRun(tx, runId, "run_terminal");
    await tx
      .update(workspaces)
      .set({ branchDelivery: { target, error: null } })
      .where(eq(workspaces.id, id));
  });
  startCanonicalProjectionWorker();
  const { POST: promote } =
    await import("@/app/api/runs/[runId]/promote/route");
  const send = (
    body: { reviewedSource?: { head: string; fingerprint: string } } = {},
  ) =>
    promote(
      new NextRequest(`http://localhost/api/runs/${runId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ runId }) },
    );
  const missingReview = await send();
  expect(missingReview.status).toBe(409);
  expect(await missingReview.json()).toMatchObject({
    code: "PRECONDITION",
    details: { reason: "review_source_required" },
  });
  const { readAddressedReviewSource } =
    await import("@/lib/runs/review-source");
  const readReview = async () =>
    readAddressedReviewSource({
      db,
      workspace: await readWorkspace(),
      signal: AbortSignal.timeout(15_000),
    });
  const firstReview = await readReview();
  const firstHead = await git(checkout, "rev-parse", "HEAD");
  await writeFile(
    join(checkout, "README.md"),
    "changed after operator review\n",
  );
  await git(checkout, "add", "--", "README.md");
  await git(checkout, "commit", "-m", "change after review");
  const reviewedHead = await git(checkout, "rev-parse", "HEAD");
  const stale = await send({
    reviewedSource: { head: firstHead, fingerprint: firstReview.fingerprint },
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    code: "CONFLICT",
    details: { reason: "review_source_changed" },
  });
  expect(await readWorkspace()).toMatchObject({ promotionState: "none" });
  expect(await git(repository, "branch", "--list", target.remoteBranch)).toBe(
    "",
  );
  const currentReview = await readReview();
  const reviewBody = {
    reviewedSource: {
      head: reviewedHead,
      fingerprint: currentReview.fingerprint,
    },
  };
  const reply = await send(reviewBody);
  const result = await reply.json();
  expect(reply.status, JSON.stringify(result)).toBe(200);
  expect(result).toMatchObject({
    commit: reviewedHead,
    mode: "publish_branch",
    publication: target,
  });
  expect(
    await git(repository, "rev-parse", `refs/heads/${target.remoteBranch}`),
  ).toBe(reviewedHead);
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  expect(run).toMatchObject({ status: "Done", promotedHeadSha: reviewedHead });
  expect(await readWorkspace()).toMatchObject({
    executionHostId: host.id,
    promotionState: "done",
    publishedRemote: target.remote,
    publishedBranch: target.remoteBranch,
  });
  const replay = await send(reviewBody);
  const replayBody = await replay.json();
  expect(replay.status, JSON.stringify(replayBody)).toBe(200);
  expect(replayBody).toEqual(result);
  expect(
    await git(
      repository,
      "reflog",
      "show",
      "--format=%H",
      `refs/heads/${target.remoteBranch}`,
    ),
  ).toBe(reviewedHead);
  await writeFile(
    join(checkout, "untracked-archive.txt"),
    "retain the operator's change\n",
  );
  const { GET: gitState } =
    await import("@/app/api/runs/[runId]/git-state/route");
  const actions = await gitState(
    new Request(`http://localhost/api/runs/${runId}/git-state`),
    {
      params: Promise.resolve({ runId }),
    },
  );
  expect(actions.status).toBe(200);
  expect(await actions.json()).toMatchObject({
    actions: expect.arrayContaining([
      { id: "archive", enabled: true, disabledReason: null },
    ]),
  });
  const { POST: archive } =
    await import("@/app/api/runs/[runId]/archive/route");
  const archiveRequest = () =>
    archive(
      new Request(`http://localhost/api/runs/${runId}/archive`, {
        method: "POST",
      }),
      { params: Promise.resolve({ runId }) },
    );
  const archived = await archiveRequest();
  const archiveResult = await archived.json();
  expect(archived.status, JSON.stringify(archiveResult)).toBe(200);
  expect(archiveResult).toMatchObject({
    runStatus: "Done",
    workspaceRemoved: true,
    preservationOutcome: "snapshot_created",
  });
  await expect(stat(checkout)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readWorkspace()).toMatchObject({
    archivedCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
    removedAt: expect.any(Date),
    removalKind: "archive",
  });
  expect(await (await archiveRequest()).json()).toMatchObject({
    workspaceRemoved: true,
    idempotent: true,
  });
}, 60_000);

it("C-10 integrates the reviewed source to the exact canonical target and replays that result", async () => {
  const { db, repository, runId, readWorkspace, supervisor: owningHost } =
    await prepareWorkspaceFixture();
  const { executionWorkspaceId: handle } = await readWorkspace();
  if (!handle) throw new Error("The integration fixture has no checkout");
  const checkout = privateCheckoutPath(owningHost, handle);
  const target = await git(repository, "rev-parse", "refs/heads/main");
  const before = await git(repository, "reflog", "show", "--format=%H", "refs/heads/main");
  await git(repository, "checkout", "--detach", target);
  await writeFile(join(checkout, "README.md"), "reviewed source\n");
  await git(checkout, "add", "--", "README.md");
  await git(checkout, "commit", "-m", "reviewed source");
  const source = await git(checkout, "rev-parse", "HEAD");
  await db.transaction(async (tx) => {
    await tx.update(runs).set({
      status: "Review",
      reviewEnteredAt: new Date(),
      deliveryPolicySnapshot: {
        strategy: "merge", push: "on_success", trigger: "manual", targetBranch: "main",
      },
    }).where(eq(runs.id, runId));
    await releaseAssignmentForRun(tx, runId, "run_terminal");
  });
  startCanonicalProjectionWorker();
  const { readAddressedReviewSource } = await import("@/lib/runs/review-source");
  const review = await readAddressedReviewSource({
    db, workspace: await readWorkspace(), signal: AbortSignal.timeout(15_000),
  });
  const { POST } = await import("@/app/api/runs/[runId]/promote/route");
  const submit = (reviewedTargetCommit: string) => POST(
    new NextRequest(`http://localhost/api/runs/${runId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reviewedSource: { head: source, fingerprint: review.fingerprint },
        reviewedTargetCommit,
      }),
    }),
    { params: Promise.resolve({ runId }) },
  );
  const stale = await submit(source);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ details: { reason: "target_drift" } });
  expect(await git(repository, "rev-parse", "refs/heads/main")).toBe(target);
  const promoted = await submit(target);
  const receipt = await promoted.json();
  if (promoted.status !== 200)
    throw new Error(`Canonical integration failed with ${JSON.stringify(receipt)}\n${await owningHost.logTail()}`);
  const observed = await git(repository, "rev-parse", "refs/heads/main");
  expect(receipt).toMatchObject({ mode: "merge", commit: observed });
  expect(await git(repository, "show", "-s", "--format=%P", observed)).toBe(`${target} ${source}`);
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(source);
  expect(await (await submit(target)).json()).toEqual(receipt);
  expect(await git(repository, "reflog", "show", "--format=%H", "refs/heads/main"))
    .toBe(`${observed}\n${before}`);
}, 60_000);

it("C-10 opens an addressed PR through Review and replays the persisted delivery", async () => {
  const { db, repository, runId, readWorkspace, supervisor: owningHost } =
    await prepareWorkspaceFixture({ usePullRequestProvider: true });
  const { executionWorkspaceId: handle } = await readWorkspace();
  if (!handle || !root) throw new Error("The PR fixture has no checkout");
  const checkout = privateCheckoutPath(owningHost, handle);
  const base = await git(repository, "rev-parse", "refs/heads/main");
  await writeFile(join(checkout, "README.md"), "reviewed PR source\n");
  await git(checkout, "commit", "-am", "reviewed PR source");
  const head = await git(checkout, "rev-parse", "HEAD");
  await db.transaction(async (tx) => {
    await tx.update(runs).set({
      status: "Review",
      reviewEnteredAt: new Date(),
      deliveryPolicySnapshot: {
        strategy: "pull_request", push: "on_success", trigger: "manual", targetBranch: "main",
      },
    }).where(eq(runs.id, runId));
    await releaseAssignmentForRun(tx, runId, "run_terminal");
  });
  startCanonicalProjectionWorker();
  const { readAddressedReviewSource } = await import("@/lib/runs/review-source");
  const review = await readAddressedReviewSource({
    db, workspace: await readWorkspace(), signal: AbortSignal.timeout(15_000),
  });
  const { POST } = await import("@/app/api/runs/[runId]/promote/route");
  const submit = (reviewedTargetCommit: string) => POST(
    new NextRequest(`http://localhost/api/runs/${runId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reviewedSource: { head, fingerprint: review.fingerprint },
        reviewedTargetCommit,
      }),
    }),
    { params: Promise.resolve({ runId }) },
  );
  const stale = await submit(head);
  expect(await stale.json()).toMatchObject({ details: { reason: "target_drift" } });
  await expect(stat(join(root, "pr-created"))).rejects.toMatchObject({ code: "ENOENT" });
  const response = await submit(base);
  const receipt = await response.json();
  if (response.status !== 200)
    throw new Error(`Addressed PR failed with ${JSON.stringify(receipt)}\n${await owningHost.logTail()}`);
  expect(receipt).toMatchObject({ mode: "pull_request", pullRequestUrl: localPullRequestUrl, prNumber: 7 });
  const published = await readWorkspace();
  expect(published).toMatchObject({ promotionState: "done", prUrl: localPullRequestUrl, prNumber: 7 });
  expect(published.publishedBranch).toEqual(expect.any(String));
  expect(await git(repository, "rev-parse", `refs/heads/${published.publishedBranch}`)).toBe(head);
  expect(await git(repository, "rev-parse", "refs/heads/main")).toBe(base);
  expect(await (await submit(base)).json()).toEqual(receipt);
  expect(await readFile(join(root, "pr-created"), "utf8")).toBe("created\n");
}, 60_000);

it("C-10 finalizes a parked addressed Run only at the provider's current PR head", async () => {
  const { db, base, runId, readWorkspace, supervisor: owningHost } =
    await prepareWorkspaceFixture({ usePullRequestProvider: true });
  const { executionWorkspaceId: handle } = await readWorkspace();
  if (!handle || !root) throw new Error("The PR finalization fixture has no checkout");
  const checkout = privateCheckoutPath(owningHost, handle);
  await writeFile(join(checkout, "README.md"), "ready for PR finalization\n");
  await git(checkout, "commit", "-am", "finish addressed PR work");
  const head = await git(checkout, "rev-parse", "HEAD");
  await db.transaction(async (tx) => {
    await tx.update(runs).set({ status: "Crashed" }).where(eq(runs.id, runId));
    await tx.update(workspaces).set({
      targetBranch: "main", prUrl: localPullRequestUrl, prNumber: 7, prState: "open",
    }).where(eq(workspaces.runId, runId));
    await releaseAssignmentForRun(tx, runId, "run_terminal");
  });
  const statusFile = join(root, "pr-state.json");
  const { GET: gitState } = await import("@/app/api/runs/[runId]/git-state/route");
  const available = await gitState(new Request(`http://localhost/api/runs/${runId}/git-state`), {
    params: Promise.resolve({ runId }),
  });
  expect(available.status).toBe(200);
  expect(await available.json()).toMatchObject({
    actions: expect.arrayContaining([{ id: "finalizePr", enabled: true, disabledReason: null }]),
  });
  const { POST } = await import("@/app/api/runs/[runId]/pr/finalize/route");
  const finalize = () => POST(
    new NextRequest(`http://localhost/api/runs/${runId}/pr/finalize`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }),
    { params: Promise.resolve({ runId }) },
  );
  await writeFile(statusFile, JSON.stringify({ state: "OPEN", headRefOid: base, baseRefName: "main" }));
  const stale = await finalize();
  const staleBody = await stale.json();
  expect(stale.status, JSON.stringify(staleBody)).toBe(409);
  expect(staleBody).toMatchObject({ details: { reason: "publish_stale" } });
  expect(await readWorkspace()).toMatchObject({ promotionState: "none" });
  await writeFile(statusFile, JSON.stringify({ state: "CLOSED", headRefOid: head, baseRefName: "main" }));
  expect(await (await finalize()).json()).toMatchObject({ details: { reason: "pr_closed" } });
  await writeFile(statusFile, JSON.stringify({ state: "OPEN", headRefOid: head, baseRefName: "main" }));
  const finalized = await finalize();
  const result = await finalized.json();
  expect(finalized.status, JSON.stringify(result)).toBe(200);
  expect(result).toMatchObject({ mode: "pull_request", pullRequestUrl: localPullRequestUrl, prNumber: 7 });
  const [observed] = await db.select().from(runs).where(eq(runs.id, runId));
  expect(observed).toMatchObject({ status: "Done", promotedHeadSha: head, mergeCommitSha: null });
  expect(await readWorkspace()).toMatchObject({ promotionState: "done", prState: "open", worktreePath: null });
}, 60_000);

it("C-10 retention GC preserves an overdue addressed worktree on its owning host", async () => {
  const {
    db,
    runId,
    readWorkspace,
    supervisor: owningHost,
  } = await prepareWorkspaceFixture();
  const { id, executionWorkspaceId: handle } = await readWorkspace();
  if (!handle) throw new Error("The GC fixture has no retained checkout");
  const checkout = privateCheckoutPath(owningHost, handle);
  const repository = await git(
    checkout,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  await writeFile(
    join(checkout, "overdue-untracked.txt"),
    "retain before GC\n",
  );
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ status: "Done", endedAt: now })
      .where(eq(runs.id, runId));
    await releaseAssignmentForRun(tx, runId, "run_terminal");
    await tx
      .update(workspaces)
      .set({ scheduledRemovalAt: new Date(now.getTime() + 60_000) })
      .where(eq(workspaces.id, id));
  });
  startCanonicalProjectionWorker();
  const { runWorkspaceGcSweep } = await import("@/lib/gc/workspace-gc");
  const { runWorkspaceReconciliationSweep } =
    await import("@/lib/gc/workspace-reconciler");
  const webRoot = join(dirname(repository), "web-reconciliation");
  await mkdir(webRoot);
  expect(
    await runWorkspaceReconciliationSweep({ database: db, root: webRoot }),
  ).toMatchObject({
    scanned: 0,
    removed: 0,
  });
  const sweep = () =>
    runWorkspaceGcSweep({
      db,
      now: () => now,
      worktreeExists: async () => {
        throw new Error("GC probed an addressed path from Web");
      },
    });
  expect(await sweep()).toMatchObject({ scanned: 0, pruned: 0 });
  await db
    .update(workspaces)
    .set({ scheduledRemovalAt: new Date(now.getTime() - 60_000) })
    .where(eq(workspaces.id, id));
  await expect(
    db
      .update(workspaces)
      .set({
        removedAt: now,
        removalKind: "retention_gc",
        preservationOutcome: "not_needed",
      })
      .where(eq(workspaces.id, id)),
  ).rejects.toMatchObject({
    cause: {
      code: "23514",
      constraint: "addressed_workspace_disposal_receipt",
    },
  });
  expect(await sweep()).toMatchObject({
    scanned: 1,
    preserved: 1,
    pruned: 1,
    failed: 0,
  });
  const archived = await readWorkspace();
  expect(archived).toMatchObject({
    removalKind: "retention_gc",
    removedAt: expect.any(Date),
    preservationOutcome: "snapshot_created",
    archivedCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
  });
  expect(
    await git(
      repository,
      "show",
      `${archived.archivedCommit}:overdue-untracked.txt`,
    ),
  ).toBe("retain before GC");
  await expect(stat(checkout)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await sweep()).toMatchObject({ scanned: 0, pruned: 0 });
}, 60_000);

it("C-10 Drop preserves dirty retained work before abandoning the Run", async () => {
  const { db, runId, readWorkspace, supervisor: owningHost } = await prepareWorkspaceFixture();
  const { id, executionWorkspaceId: handle } = await readWorkspace();
  if (!handle) throw new Error("The Drop fixture has no retained checkout");
  const checkout = privateCheckoutPath(owningHost, handle);
  const repository = await git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir");
  await writeFile(join(checkout, "draft.txt"), "preserve this draft\n");
  await db.transaction(async (tx) => {
    await tx.update(runs).set({ status: "Review", reviewEnteredAt: new Date() }).where(eq(runs.id, runId));
    await releaseAssignmentForRun(tx, runId, "run_terminal");
  });
  startCanonicalProjectionWorker();
  const { GET: readGitState } = await import("@/app/api/runs/[runId]/git-state/route");
  const params = { params: Promise.resolve({ runId }) };
  const actions = await readGitState(new Request(`http://localhost/api/runs/${runId}/git-state`), params);
  expect(await actions.json()).toMatchObject({ actions: expect.arrayContaining([{ id: "drop", enabled: true, disabledReason: null }]) });
  await expect(db.transaction(async (tx) => {
    await tx.update(workspaces).set({ removedAt: new Date(), removalKind: "drop", preservationOutcome: "not_needed" })
      .where(eq(workspaces.id, id));
    tx.rollback();
  })).rejects.toMatchObject({ cause: { code: "23514", constraint: "addressed_workspace_disposal_receipt" } });
  const { POST: drop } = await import("@/app/api/runs/[runId]/drop/route");
  const send = () => drop(new NextRequest(`http://localhost/api/runs/${runId}/drop`, { method: "POST" }), params);
  const response = await send();
  const outcome = await response.json();
  expect(response.status, JSON.stringify(outcome)).toBe(200);
  expect(outcome).toMatchObject({ operation: "drop", runStatus: "Abandoned", preservationOutcome: "snapshot_created", idempotent: false });
  const archived = await readWorkspace();
  expect(archived).toMatchObject({ removalKind: "drop", removedAt: expect.any(Date) });
  expect(await git(repository, "show", `${archived.archivedCommit}:draft.txt`)).toBe("preserve this draft");
  await expect(stat(checkout)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await (await send()).json()).toMatchObject({ idempotent: true, runStatus: "Abandoned" });
  const commands = await listCommandsForRun(db, runId);
  expect(commands.filter(({ kind }) => kind === "workspace.release")).toHaveLength(1);
}, 60_000);

it.each([
  { operation: "stop-drop", disposition: "drop", runStatus: "Abandoned" },
  { operation: "stop-archive", disposition: "archive", runStatus: "Review" },
] as const)("C-10 $operation retires the addressed assignment before preserving its checkout", async ({ operation, disposition, runStatus }) => {
  const { db, runId, readWorkspace, supervisor: owningHost } = await prepareWorkspaceFixture();
  const { executionWorkspaceId: handle } = await readWorkspace();
  if (!handle) throw new Error("The Stop and Drop fixture has no checkout");
  const checkout = privateCheckoutPath(owningHost, handle);
  await writeFile(join(checkout, "stop-draft.txt"), "retained during stop\n");
  await db.update(runs).set({ status: "Running" }).where(eq(runs.id, runId));
  startCanonicalProjectionWorker();
  const { POST } = operation === "stop-drop"
    ? await import("@/app/api/runs/[runId]/stop-drop/route")
    : await import("@/app/api/runs/[runId]/stop-archive/route");
  const send = () => POST(
    new NextRequest(`http://localhost/api/runs/${runId}/${operation}`, { method: "POST" }),
    { params: Promise.resolve({ runId }) },
  );
  const response = await send();
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(result).toMatchObject({ operation: disposition, runStatus, workspaceRemoved: true });
  const commands = await listCommandsForRun(db, runId);
  const preserved = commands.find(({ kind }) => kind === "workspace.preserve");
  const released = commands.find(({ kind }) => kind === "workspace.release");
  const assignment = await getLatestAssignment(db, runId);
  expect(assignment).toMatchObject({ state: "released", addressedStopRequestedBy: session.userId });
  expect(preserved).toMatchObject({ state: "succeeded", executionAssignmentId: assignment?.id });
  expect(released).toMatchObject({
    state: "succeeded", executionAssignmentId: assignment?.id, payload: { dispositionId: preserved?.id },
  });
  const replay = await send();
  const replayed = await replay.json();
  expect(replay.status, JSON.stringify(replayed)).toBe(200);
  expect(replayed).toMatchObject({ idempotent: true, runStatus });
}, 60_000);

it("C-10 projects a publication from the historical owner and holds removal until the outcome is verified", async () => {
  const {
    db,
    host,
    initial,
    projectId,
    repository,
    base,
    runId,
    readWorkspace,
    settle,
    supervisor: owningHost,
  } = await prepareWorkspaceFixture();
  const {
    executionWorkspaceId: handle,
    workspaceGeneration: generation,
    id,
  } = await readWorkspace();
  if (!handle || !generation)
    throw new Error("The publication fixture has no retained worktree");
  const privateCheckout = privateCheckoutPath(owningHost, handle);
  await git(repository, "config", "receive.denyCurrentBranch", "updateInstead");
  const targetRef = await git(repository, "symbolic-ref", "HEAD");
  await git(
    privateCheckout,
    "commit",
    "--allow-empty",
    "-m",
    "reviewed publication",
  );
  const head = await git(privateCheckout, "rev-parse", "HEAD");
  const claimId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.update(runs).set({ status: "Review" }).where(eq(runs.id, runId));
    await releaseAssignmentForRun(tx, runId, "run_terminal");
    await tx
      .update(workspaces)
      .set({
        promotionState: "claiming",
        promotionAttemptId: claimId,
        promotionClaimedAt: new Date(),
      })
      .where(eq(workspaces.id, id));
  });
  const pending = {
    kind: "workspace.publish" as const,
    runId,
    assignmentId: initial.id,
    hostId: host.id,
    assignmentEpoch: initial.epoch,
    targetSessionId: handle,
    maxAttempts: 3,
    driverless: true,
    payload: {
      generation,
      claimId,
      fence: 1,
      publication: "promote",
      expected: { head, remoteId: projectId, targetRef, priorTarget: base },
    },
  };
  await expect(
    insertCommand(db, {
      ...pending,
      payload: { ...pending.payload, claimId: randomUUID() },
    }),
  ).rejects.toMatchObject({
    cause: { constraint: "retained_workspace_publication_owner" },
  });
  const command = await insertCommand(db, pending);
  await expect(
    db
      .update(workspaces)
      .set({ removedAt: new Date() })
      .where(eq(workspaces.id, id)),
  ).rejects.toMatchObject({
    cause: { constraint: "unsettled_workspace_publication" },
  });
  expect(await git(repository, "rev-parse", targetRef)).toBe(base);
  await settle(command.id);
  expect(await git(repository, "rev-parse", targetRef)).toBe(head);
  expect(await getCommand(db, command.id)).toMatchObject({
    executionAssignmentId: initial.id,
    result: {
      publication: "promote",
      git: { generation, priorTarget: base, head, observedTarget: head },
    },
  });
  await db
    .update(workspaces)
    .set({ promotionState: "done" })
    .where(eq(workspaces.id, id));
}, 60_000);

it("C-09 keeps the same prepared checkout and reuses its checkpoint after a new epoch", async () => {
  const { db, host, initial, runId, readWorkspace, patchOf, settle } =
    await prepareWorkspaceFixture();
  await db.update(runs).set({ status: "Running" }).where(eq(runs.id, runId));
  const checkpoint = await reserveWorkspaceGitOperation(db, {
    runId,
    assignmentId: initial.id,
    kind: "workspace.checkpoint",
    operationKey: "prior",
  });
  await settle(checkpoint.id);
  const workspace = await readWorkspace();
  await expect(
    db.transaction((tx) =>
      mintPlacement(tx, {
        runId,
        reason: "rework_return",
        host: { ...host, id: "substituted" },
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const next = await db.transaction((tx) =>
    mintPlacement(tx, { runId, reason: "rework_return" }),
  );
  expect(next).toMatchObject({
    epoch: 2,
    executionHostId: host.id,
    executionWorkspaceId: workspace.executionWorkspaceId,
  });
  const workload = {
    runId,
    operationKey: "review-reentry",
    declarationId: "fixture-edit",
    workload: "cli" as const,
  };
  await expect(
    reserveWorkspaceWorkload(db, { ...workload, assignmentId: initial.id }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const edit = await reserveWorkspaceWorkload(db, { ...workload, assignmentId: next.id });
  await settle(edit.id);
  expect(await getCommand(db, edit.id)).toMatchObject({
    result: { processOutcome: "exited", exitCode: 0, quiescence: "proved" },
  });
  expect(await patchOf(workspace)).toContain("+after handoff");
  const restore = await reserveWorkspaceGitOperation(db, {
    runId,
    assignmentId: next.id,
    kind: "workspace.restore",
    operationKey: "undo",
    checkpointId: checkpoint.id,
  });
  await settle(restore.id);
  expect((await readWorkspace()).preparationAssignmentId).toBe(initial.id);
  expect(await patchOf(workspace)).toBe("");

  await db
    .update(runSessions)
    .set({ capabilityAgent: "codex" })
    .where(
      and(eq(runSessions.runId, runId), eq(runSessions.sessionName, "default")),
    );
  const execution = createExecutionHosts({ db });
  const acp = await execution.forAssignment({ id: next.id });
  const start = {
    stepId: "validate",
    executor: { agent: "codex" as const, model: "gpt-5.4" },
  };
  const issued = await acp.createSession(start);
  await acp.checkpoint(issued.hostSessionId);
  const resumed = await acp.createSession({
    ...start,
    resumeSessionId: issued.acpSessionId,
  });
  try {
    expect(resumed.acpSessionId).toBe(issued.acpSessionId);
    expect(resumed.hostSessionId).not.toBe(issued.hostSessionId);
    expect((await getCommand(db, restore.id))?.result).toMatchObject({
      checkpointId: checkpoint.id,
      tree: expect.any(String),
    });
    expect(acp.assignment.executionWorkspaceId).toBe(
      workspace.executionWorkspaceId,
    );
  } finally {
    await acp.checkpoint(resumed.hostSessionId);
  }
}, 60_000);

it("C-09 claims and returns operator commits from the selected supervisor through the normal Run routes", async () => {
  const {
    db,
    host,
    initial,
    base,
    runId,
    readWorkspace,
    supervisor: owningHost,
  } = await prepareWorkspaceFixture();
  await db
    .update(runs)
    .set({ status: "NeedsInput", currentStepId: "review" })
    .where(eq(runs.id, runId));
  await db.insert(nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "review",
    nodeType: "human",
    attempt: 1,
    status: "NeedsInput",
    executionAssignmentId: initial.id,
  });
  const workspace = await readWorkspace();
  const handle = workspace.executionWorkspaceId;
  if (!handle) throw new Error("the takeover fixture has no prepared handle");
  const privateCheckout = privateCheckoutPath(owningHost, handle);
  const { POST: claim } =
    await import("@/app/api/runs/[runId]/takeover/claim/route");
  const { POST: returnClaim } =
    await import("@/app/api/runs/[runId]/takeover/return/route");
  const params = { params: Promise.resolve({ runId }) };
  const request = (action: string) =>
    new NextRequest(`http://localhost/api/runs/${runId}/takeover/${action}`, {
      method: "POST",
    });
  startCanonicalProjectionWorker();
  const claimed = await claim(request("claim"), params);
  const claimedBody = await claimed.json();
  expect(claimed.status, JSON.stringify(claimedBody)).toBe(200);
  expect(claimedBody).toMatchObject({
    worktreePath: null,
    executionHostId: host.id,
    workspaceHandle: handle,
  });
  expect(JSON.stringify(claimedBody)).not.toContain(privateCheckout);

  expect((await returnClaim(request("return"), params)).status).toBe(409);
  await writeFile(join(privateCheckout, "README.md"), "operator edit\n");
  expect((await returnClaim(request("return"), params)).status).toBe(409);
  await git(privateCheckout, "add", "--", "README.md");
  await git(
    privateCheckout,
    "-c",
    "user.name=Operator",
    "-c",
    "user.email=operator@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "operator changed the selected checkout",
  );
  const returned = await returnClaim(request("return"), params);
  expect(returned.status, await returned.clone().text()).toBe(200);
  await vi.waitFor(
    async () => {
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      expect(run.status).toBe("Review");
    },
    { timeout: 15_000 },
  );
  const history = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.runId, runId));
  expect(history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        epoch: 2,
        executionHostId: host.id,
        executionWorkspaceId: handle,
      }),
    ]),
  );
  const attempts = await db
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.runId, runId));
  expect(attempts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ownerUserId: session.userId,
        claimHeadSha: base,
      }),
      expect.objectContaining({
        nodeId: "validate",
        status: "Succeeded",
        stdout: "validation continued",
      }),
    ]),
  );
  const artifacts = await db
    .select()
    .from(artifactInstances)
    .where(eq(artifactInstances.runId, runId));
  expect(artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        producer: "takeover",
        kind: "diff",
        locator: { kind: "execution-object", objectId: expect.any(String) },
      }),
      expect.objectContaining({
        producer: "takeover",
        kind: "commit_set",
        locator: { kind: "execution-object", objectId: expect.any(String) },
      }),
    ]),
  );
}, 90_000);
