import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";

import { dispatchDomainEvents } from "@/lib/domain-events/dispatch";
import { buildWaitResolver } from "@/lib/domain-events/wait-resolver";
import { generateToken } from "@/lib/tokens/secret";
import { scanWaitPublications } from "@/lib/waits/provider-scan";
import { recordWaitSignal } from "@/lib/waits/store";
import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import { git, initRepoWithWorktree } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const repoIdentity = "github.com/example/project";
const head = "a".repeat(40);

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "publication_wait_roundtrip",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it.each([
  "green",
  "stale-review",
  "merged-pr",
  "wrong-pr-head",
  "closed-pr",
  "recover-merge",
] as const)(
  "C02/C04/C05 settles %s retained evidence through the engine promotion service",
  async (scenario) => {
    const { runFlow } = await import("@/lib/flows/runner");
    const { promoteNextPending } = await import("@/lib/scheduler");
    const prBacked =
      scenario === "merged-pr" ||
      scenario === "wrong-pr-head" ||
      scenario === "closed-pr";
    const prNumber = 31;
    const mergeCommitSha = "b".repeat(40);

    if (prBacked) {
      const prAdapter = await import("@/lib/workbench-git/pull-request");
      const adapter = vi
        .spyOn(prAdapter, "preflightedPrAdapter")
        .mockResolvedValue({
          preflight: async () => undefined,
          createOrUpdatePr: async (input) => {
            expect(input).toMatchObject({ targetBranch: "main", draft: true });

            return {
              url: `https://${repoIdentity}/pull/${prNumber}`,
              number: prNumber,
              reused: false,
            };
          },
        });

      onTestFinished(() => {
        adapter.mockRestore();
      });
    }
    const root = await mkdtemp(join(tmpdir(), "completion-evidence-"));
    const { repoPath, worktreePath, branch } = await initRepoWithWorktree(root);
    const base = await git(repoPath, "rev-parse", "HEAD");
    const declaration = {
      ci: "ci",
      gates: [{ node: "verified", gate: "tests" }],
      review: { node: "verified", gate: "review" },
    };
    const bounds = {
      enabled: true,
      riskMax: "low",
      confidenceMin: 0.9,
      changedFilesMax: 10,
      changedLinesMax: 300,
      approvedCiSources: ["github-actions"],
    };

    await writeFile(
      join(worktreePath, "result.ts"),
      "export const result = true;\n",
    );
    await git(worktreePath, "add", "--", "result.ts");
    await git(worktreePath, "commit", "-m", "candidate");
    const head = await git(worktreePath, "rev-parse", "HEAD");
    const seeded = await seedGraphRun(
      database.db,
      {
        schemaVersion: 1,
        name: "Autonomous completion",
        compat: { engine_min: "3.15.0" },
        autonomous_completion: declaration,
        nodes: [
          {
            type: "publish",
            id: "publish",
            ...(prBacked ? { pr: "draft" } : {}),
            transitions: { success: "ci" },
          },
          {
            type: "wait",
            id: "ci",
            timeout: 120,
            on: {
              kind: "ci",
              publication: "publish",
              transport: "pull",
              checks: ["build"],
              issuer: "github-actions",
            },
            transitions: {
              success: prBacked ? "await_pr" : "done",
              failure: "done",
              cancelled: "done",
              timeout: "done",
              stale: "done",
            },
          },
          ...(prBacked
            ? [
                {
                  type: "wait",
                  id: "await_pr",
                  timeout: 120,
                  on: { kind: "pr", publication: "publish" },
                  transitions: {
                    merged: "done",
                    closed: "done",
                    conflict: "done",
                    timeout: "done",
                    cancelled: "done",
                    stale: "done",
                  },
                },
              ]
            : []),
          {
            type: "cli",
            id: "verified",
            action: { command: "true" },
            pre_finish: {
              gates: [
                {
                  id: "tests",
                  kind: "command_check",
                  mode: "blocking",
                  command: "true",
                },
                {
                  id: "review",
                  kind: "ai_judgment",
                  mode: "blocking",
                  prompt: "Review",
                },
              ],
            },
            transitions: { success: "publish" },
          },
        ],
      },
      {
        flowRevision: true,
        repoPath,
        workspace: {
          worktreePath,
          parentRepoPath: repoPath,
          branch,
          baseBranch: "main",
        },
        run: {
          executionPolicy: {
            preset: "supervised",
            overrides: { autonomousCompletion: "evidence_gated" },
          },
          deliveryPolicySnapshot: {
            strategy: prBacked ? "pull_request" : "merge",
            trigger: "manual",
            push: "never",
            targetBranch: "main",
          },
        },
      },
    );
    const { runId, projectId, flowRevisionId, executorId, runtimeRoot } =
      seeded;

    onTestFinished(async () => {
      await Promise.all(
        [runtimeRoot, root].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    });

    await database.pool.query(
      `UPDATE projects SET repo_url=$1,autonomous_completion=$2,autonomous_completion_revision=1 WHERE id=$3`,
      [`https://${repoIdentity}.git`, bounds, projectId],
    );
    await database.pool.query(
      `UPDATE runs SET autonomous_completion_grant=$1,flow_publication_grant=$2,current_step_id='publish' WHERE id=$3`,
      [
        {
          flowRevisionId,
          projectRevision: 1,
          platformRevision: 1,
          bounds,
          declaration,
        },
        {
          repoIdentity,
          flowRevisionId,
          targetBranch: "main",
          branchTemplate: "feature/{task_key}-{slug}",
        },
        runId,
      ],
    );
    await database.pool.query(
      "UPDATE workspaces SET target_branch='main',base_commit=$2 WHERE run_id=$1",
      [runId, base],
    );
    await database.pool.query(
      `INSERT INTO platform_runtime_settings (id,default_runner_id,autonomous_completion_enabled,autonomous_completion_revision)
    VALUES ('singleton',$1,true,1) ON CONFLICT (id) DO UPDATE SET autonomous_completion_enabled=true, autonomous_completion_revision=1`,
      [executorId],
    );
    const verifiedAttempt = randomUUID();

    await database.pool.query(
      `INSERT INTO node_attempts(id,run_id,node_id,node_type,status,completion_git_anchor,finish_continuation)
    VALUES ($1,$2,'verified','cli','Succeeded',$3,'{"version":1,"targetNodeId":"publish","injectedVars":{},"sessionPolicy":null,"autoRetry":false}')`,
      [
        verifiedAttempt,
        runId,
        {
          head: scenario === "stale-review" ? "f".repeat(40) : head,
          base,
          state: "verified",
        },
      ],
    );
    await database.pool.query(
      `INSERT INTO gate_results(id,run_id,node_attempt_id,gate_id,kind,status,verdict)
    VALUES ($1,$2,$3,'tests','command_check','passed',NULL),($4,$2,$3,'review','ai_judgment','passed',$5)`,
      [
        randomUUID(),
        runId,
        verifiedAttempt,
        randomUUID(),
        { verdict: "pass", risk: "low", confidence: 0.9 },
      ],
    );
    const { hosts, fake } = await fakeGraphHosts(database.db, runId);
    let remoteHeadSha: string | null = null;

    fake.transport.workspacePublication = async (_handle, envelope) => {
      if (envelope.payload.action === "push")
        remoteHeadSha = envelope.payload.expectedHead;
      if (envelope.payload.action !== "evidence")
        return { repoIdentity, headSha: head, remoteHeadSha };

      return {
        repoIdentity,
        headSha: await git(worktreePath, "rev-parse", "HEAD"),
        remoteHeadSha,
        evidence: {
          baseSha: await git(repoPath, "rev-parse", "main"),
          clean: true,
          files: [
            {
              path: "result.ts",
              status: "A",
              additions: 1,
              deletions: 0,
              binary: false,
            },
          ],
        },
      };
    };
    const drive = () =>
      runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });

    await drive();
    const db = database.db as unknown as import("@/lib/execution-host/db").Db;
    const scan = () =>
      scanWaitPublications({
        db,
        projectId,
        provider: "github",
        remoteUrl: `https://${repoIdentity}.git`,
        deadline: Date.now() + 20_000,
        readPr: async (request) => {
          expect(request.prNumber).toBe(prNumber);

          return {
            kind: "state",
            state: scenario === "closed-pr" ? "closed" : "merged",
            headSha: scenario === "wrong-pr-head" ? "e".repeat(40) : head,
            mergeCommitSha: scenario === "closed-pr" ? null : mergeCommitSha,
            mergedAt:
              scenario === "closed-pr" ? null : new Date().toISOString(),
            hasConflicts: false,
          };
        },
        fetchPage: async (request) => {
          const path = new URL(String(request)).pathname;

          if (path.includes("/branches/"))
            return Response.json({ commit: { sha: head } });
          if (path.endsWith("/statuses")) return Response.json([]);

          return Response.json({
            check_runs: [
              {
                id: 1,
                name: "build",
                head_sha: head,
                status: "completed",
                conclusion: "success",
                app: { slug: "github-actions" },
              },
            ],
          });
        },
      });
    const resume = async () => {
      expect(
        (
          await dispatchDomainEvents({
            db: database.db,
            consumers: [buildWaitResolver(() => database.db)],
          })
        ).failures,
      ).toBe(0);
      expect(
        (
          await promoteNextPending({
            db: database.db,
            runFlow: () => undefined,
          })
        ).promotedRunId,
      ).toBe(runId);
      await drive();
    };

    const decisions = await import("@/lib/auto-promotion/decisions");
    const originalWriter = decisions.recordAutonomousDecision;
    const { MaisterError } = await import("@/lib/errors");
    const interrupt =
      scenario === "recover-merge"
        ? vi
            .spyOn(decisions, "recordAutonomousDecision")
            .mockImplementation(async (tx, decision) => {
              if (decision.phase === "observed")
                throw new MaisterError(
                  "CONFLICT",
                  "Injected interruption after Git effect",
                );

              return originalWriter(tx, decision);
            })
        : null;

    onTestFinished(() => {
      interrupt?.mockRestore();
    });
    await scan();
    await resume();

    if (interrupt) {
      const delivered = await git(repoPath, "rev-parse", "main");

      expect(await git(repoPath, "rev-parse", "main^2")).toBe(head);
      expect(
        (
          await database.pool.query("SELECT status FROM runs WHERE id=$1", [
            runId,
          ])
        ).rows,
      ).toEqual([{ status: "Review" }]);
      interrupt.mockRestore();
      await database.pool.query(
        "UPDATE workspaces SET promotion_claimed_at='2000-01-01T00:00:00Z' WHERE run_id=$1",
        [runId],
      );
      await database.pool.query(
        "UPDATE platform_runtime_settings SET autonomous_completion_enabled=false WHERE id='singleton'",
      );
      const { deliverRunIfAutoReady } =
        await import("@/lib/runs/auto-delivery");

      await deliverRunIfAutoReady(runId, db, undefined, hosts);
      expect(await git(repoPath, "rev-parse", "main")).toBe(delivered);
    }

    if (prBacked) {
      expect(
        (
          await database.pool.query("SELECT status FROM runs WHERE id=$1", [
            runId,
          ])
        ).rows,
      ).toEqual([{ status: "Waiting" }]);
      if (scenario !== "closed-pr") remoteHeadSha = null;
      await scan();
      await resume();
      const prResult = await database.pool.query<{ outcome: string }>(
        "SELECT result->>'outcome' AS outcome FROM run_waits WHERE run_id=$1 AND condition_kind='pr'",
        [runId],
      );

      expect(prResult.rows).toEqual([
        {
          outcome:
            scenario === "closed-pr"
              ? "closed"
              : scenario === "wrong-pr-head"
                ? "stale"
                : "merged",
        },
      ]);
    }

    const localDelivery = scenario === "green" || scenario === "recover-merge";
    const status =
      localDelivery || scenario === "merged-pr" ? "Done" : "Review";

    expect(
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          runId,
        ])
      ).rows,
    ).toEqual([{ status }]);
    expect(
      await git(repoPath, "rev-parse", localDelivery ? "main^2" : "main"),
    ).toBe(localDelivery ? head : base);
    expect(
      (
        await database.pool.query(
          "SELECT phase,reason FROM run_autonomous_decisions WHERE run_id=$1 ORDER BY created_at",
          [runId],
        )
      ).rows,
    ).toEqual(
      status === "Done"
        ? [
            { phase: "claimed", reason: "evidence_gated" },
            ...(scenario === "recover-merge"
              ? [{ phase: "claimed", reason: "reconcile_effect" }]
              : []),
            {
              phase: "observed",
              reason: prBacked ? "confirmed_merged_pr" : "evidence_gated",
            },
          ]
        : [
            {
              phase: "refused",
              reason: prBacked ? "missing_required_evidence" : "required_gate",
            },
          ],
    );
    const { getAutonomousCompletionCounts } =
      await import("@/lib/queries/autonomous-completion");
    const period = {
      since: new Date(Date.now() - 60_000),
      until: new Date(Date.now() + 60_000),
    };
    const counts = () =>
      getAutonomousCompletionCounts(db, [projectId], period, "all");

    expect(await counts()).toEqual({
      done: status === "Done" ? 1 : 0,
      failed: 0,
      reverted: 0,
    });

    if (scenario !== "green") return;
    const { recordAutonomousReversal } =
      await import("@/lib/auto-promotion/reversals");
    const observed = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM run_autonomous_decisions WHERE run_id=$1 AND phase='observed'",
        [runId],
      )
    ).rows[0];
    const delivered = await git(repoPath, "rev-parse", "main");

    await git(repoPath, "revert", "--no-edit", "-m", "1", delivered);
    const reverted = await git(repoPath, "rev-parse", "main");
    const reporter = randomUUID();

    await database.pool.query(
      "INSERT INTO users (id,email,role,account_status) VALUES ($1,$2,'admin','active')",
      [reporter, `${reporter}@example.test`],
    );
    const reversal = {
      runId,
      projectId,
      decisionId: observed.id,
      reporterId: reporter,
      revertSha: reverted,
    };
    const verifyWith =
      (actorType: "Bot" | "User"): typeof fetch =>
      async (request) => {
        const path = new URL(String(request)).pathname;

        if (path.includes("/branches/"))
          return Response.json({ commit: { sha: reverted } });
        if (path.startsWith("/repos/example/project/commits/"))
          return Response.json([{ number: 19 }]);

        return Response.json({
          merged: true,
          merged_at: new Date().toISOString(),
          merge_commit_sha: reverted,
          base: { ref: "main", repo: { full_name: "example/project" } },
          merged_by: {
            id: 701,
            login: actorType === "User" ? "reviewer" : "revert-bot",
            type: actorType,
          },
        });
      };
    const oldToken = process.env.GH_TOKEN;

    process.env.GH_TOKEN = "test-token";
    onTestFinished(() => {
      if (oldToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = oldToken;
    });

    await expect(
      recordAutonomousReversal(db, reversal, verifyWith("Bot")),
    ).rejects.toMatchObject({
      details: { reason: "autonomy_reversal_unverified" },
    });
    const first = await recordAutonomousReversal(
      db,
      reversal,
      verifyWith("User"),
    );

    expect(first.created).toBe(true);
    expect(
      await recordAutonomousReversal(db, reversal, verifyWith("User")),
    ).toEqual({ ...first, created: false });
    expect(await counts()).toEqual({ done: 1, failed: 0, reverted: 1 });
  },
);

it("B01 replays a retained publication when the original delivery lost its acknowledgement", async () => {
  const { runFlow } = await import("@/lib/flows/runner");
  const { runId, projectId, flowRevisionId, runtimeRoot, worktreePath } =
    await seedGraphRun(
      database.db,
      {
        schemaVersion: 1,
        name: "Publication receipt recovery",
        compat: { engine_min: "3.14.0" },
        nodes: [
          { type: "publish", id: "publish", transitions: { success: "done" } },
        ],
      },
      { flowRevision: true },
    );

  onTestFinished(async () => {
    await Promise.all(
      [runtimeRoot, worktreePath].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });
  await database.pool.query("UPDATE projects SET repo_url=$1 WHERE id=$2", [
    `https://${repoIdentity}.git`,
    projectId,
  ]);
  const { hosts, fake } = await fakeGraphHosts(database.db, runId);
  const attemptId = randomUUID();
  const operationKey = createHash("sha256")
    .update(`flow-publication:${attemptId}`)
    .digest("hex");
  const {
    rows: [run],
  } = await database.pool.query<{
    execution_assignment_id: string;
    flow_revision: string;
  }>(
    `UPDATE runs r SET
    current_step_id='publish', flow_publication_grant=jsonb_build_object('repoIdentity',$1::text,'flowRevisionId',$2::text,
      'targetBranch',p.main_branch,'branchTemplate',p.public_branch_template)
    FROM projects p WHERE p.id=r.project_id AND r.id=$3 RETURNING r.execution_assignment_id,r.flow_revision`,
    [repoIdentity, flowRevisionId, runId],
  );
  const {
    rows: [workspace],
  } = await database.pool.query<{ id: string }>(
    `UPDATE workspaces SET lifecycle_operation_state='claiming',
    lifecycle_operation_attempt_id=$2,lifecycle_operation_claimed_at=statement_timestamp(),lifecycle_operation_name='exportBranch',
    lifecycle_operation_expected_run_status='Running',lifecycle_operation_lease_expires_at=statement_timestamp()+interval '30 seconds'
    WHERE run_id=$1 RETURNING id`,
    [runId, operationKey],
  );

  await database.pool.query(
    `INSERT INTO node_attempts (id,run_id,node_id,node_type,status,execution_assignment_id)
    VALUES ($1,$2,'publish','publish','Running',$3)`,
    [attemptId, runId, run.execution_assignment_id],
  );
  await database.pool.query(
    `INSERT INTO run_publications (id,run_id,project_id,node_attempt_id,workspace_id,
    operation_key,flow_revision,assignment_id,remote_name,repo_identity,head_ref,base_ref,source_head,generation,pr_mode,phase)
    VALUES ($1,$2,$3,$4,$5,$1,$6,$7,'origin',$8,'refs/heads/run/candidate','refs/heads/main',$9,1,'none','claimed')`,
    [
      operationKey,
      runId,
      projectId,
      attemptId,
      workspace.id,
      run.flow_revision,
      run.execution_assignment_id,
      repoIdentity,
      head,
    ],
  );
  const observeExistingRef = vi.fn(async () => ({
    repoIdentity,
    headSha: head,
    remoteHeadSha: head,
  }));

  fake.transport.workspacePublication = observeExistingRef;

  await runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });

  expect(observeExistingRef).toHaveBeenCalledTimes(1);
  expect(
    (
      await database.pool.query(
        `SELECT id,phase,observed_head FROM run_publications WHERE run_id=$1`,
        [runId],
      )
    ).rows,
  ).toEqual([{ id: operationKey, phase: "observed", observed_head: head }]);
  expect(
    (
      await database.pool.query(
        `SELECT id,status FROM node_attempts WHERE run_id=$1 AND node_id='publish'`,
        [runId],
      )
    ).rows,
  ).toEqual([{ id: attemptId, status: "Succeeded" }]);
});

it("B01 refuses a graph publication without retained launch authority", async () => {
  const { runFlow } = await import("@/lib/flows/runner");
  const { runId, projectId, runtimeRoot, worktreePath } = await seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "Publication without grant",
      compat: { engine_min: "3.14.0" },
      nodes: [
        { type: "publish", id: "publish", transitions: { success: "done" } },
      ],
    },
  );

  await database.pool.query("UPDATE projects SET repo_url=$1 WHERE id=$2", [
    `https://${repoIdentity}.git`,
    projectId,
  ]);

  onTestFinished(async () => {
    await Promise.all(
      [runtimeRoot, worktreePath].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });

  const { hosts, fake } = await fakeGraphHosts(database.db, runId);
  const actions: string[] = [];

  fake.transport.workspacePublication = async (_handle, envelope) => {
    actions.push(envelope.payload.action);

    return { repoIdentity, headSha: head, remoteHeadSha: head };
  };
  await runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });

  expect(actions).toEqual([]);
  expect(
    (
      await database.pool.query(
        "SELECT 1 FROM run_publications WHERE run_id=$1",
        [runId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (await database.pool.query("SELECT status FROM runs WHERE id=$1", [runId]))
      .rows,
  ).toEqual([{ status: "Failed" }]);
});

it.each(["pull", "push"] as const)(
  "B02 drives publication and %s CI through graph and admission",
  async (transport) => {
    const { runFlow } = await import("@/lib/flows/runner");
    const { promoteNextPending } = await import("@/lib/scheduler");
    const expectedPushIssuer = randomUUID();
    const seeded = await seedGraphRun(
      database.db,
      {
        schemaVersion: 1,
        name: "Publication CI",
        compat: { engine_min: "3.14.0" },
        nodes: [
          { type: "publish", id: "publish", transitions: { success: "ci" } },
          {
            type: "wait",
            id: "ci",
            timeout: 120,
            on: {
              kind: "ci",
              publication: "publish",
              transport,
              checks: ["build"],
              issuer:
                transport === "push" ? expectedPushIssuer : "github-actions",
              ...(transport === "push" ? { name: "build" } : {}),
            },
            transitions: {
              success: "done",
              failure: "done",
              cancelled: "done",
              timeout: "done",
              stale: "done",
            },
          },
        ],
      },
      { flowRevision: true },
    );
    const { runId, projectId, flowRevisionId, runtimeRoot, worktreePath } =
      seeded;

    await database.pool.query("UPDATE projects SET repo_url=$1 WHERE id=$2", [
      `https://${repoIdentity}.git`,
      projectId,
    ]);
    await database.pool.query(
      `UPDATE runs r SET flow_publication_grant=jsonb_build_object(
    'repoIdentity',$1::text,'flowRevisionId',$2::text,'targetBranch',p.main_branch,'branchTemplate',p.public_branch_template
  ) FROM projects p WHERE p.id=r.project_id AND r.id=$3`,
      [repoIdentity, flowRevisionId, runId],
    );

    onTestFinished(async () => {
      await Promise.all(
        [runtimeRoot, worktreePath].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    });

    const { hosts, fake } = await fakeGraphHosts(database.db, runId);
    let remoteHeadSha: string | null = null;
    let earlyReceipt: string | undefined;
    let rejectedReceipt:
      Awaited<ReturnType<typeof recordWaitSignal>> | undefined;

    fake.transport.workspacePublication = async (_handle, envelope) => {
      if (envelope.payload.action === "push") {
        remoteHeadSha = envelope.payload.expectedHead;
        if (transport === "push") {
          const { claimLifecycleOperation } =
            await import("@/lib/workbench-lifecycle/service");
          const {
            rows: [workspace],
          } = await database.pool.query<{ id: string }>(
            "SELECT id FROM workspaces WHERE run_id=$1",
            [runId],
          );

          await expect(
            claimLifecycleOperation({
              database:
                database.db as unknown as import("@/lib/execution-host/db").Db,
              runId,
              workspaceId: workspace.id,
              operation: "sync",
              expectedRunStatus: "Running",
            }),
          ).rejects.toMatchObject({
            code: "CONFLICT",
            details: { reason: "busy" },
          });
          const { prefix, hash } = generateToken();
          const {
            rows: [token],
          } = await database.pool.query<{ id: string }>(
            `INSERT INTO project_tokens (id,project_id,name,prefix,token_hash,scopes) VALUES (gen_random_uuid()::text,$1,'ci',$2,$3,'["waits:signal"]') RETURNING id`,
            [projectId, prefix, hash],
          );
          const {
            rows: [reservation],
          } = await database.pool.query<{
            id: string;
            node_attempt_id: string | null;
            phase: string;
          }>(
            `SELECT w.id,w.node_attempt_id,p.phase FROM run_waits w JOIN run_publications p ON p.id=w.publication_id
            WHERE w.run_id=$1 AND w.state='reserved'`,
            [runId],
          );

          expect(reservation).toMatchObject({
            node_attempt_id: null,
            phase: "claimed",
          });
          const signal = { name: "build", outcome: "success", headSha: head };

          rejectedReceipt = await recordWaitSignal(database.db, {
            runId,
            projectId,
            waitId: reservation.id,
            actor: { kind: "project_token", id: token.id },
            idempotencyKey: "wrong-ci-token",
            signal,
          });

          const approved = generateToken();

          await database.pool.query(
            `INSERT INTO project_tokens (id,project_id,name,prefix,token_hash,scopes)
             VALUES ($1,$2,'approved CI',$3,$4,'["waits:signal"]')`,
            [expectedPushIssuer, projectId, approved.prefix, approved.hash],
          );
          const receipt = await recordWaitSignal(database.db, {
            runId,
            projectId,
            waitId: reservation.id,
            actor: { kind: "project_token", id: expectedPushIssuer },
            idempotencyKey: "run-1",
            signal: { name: "build", outcome: "success", headSha: head },
          });

          expect(receipt).toMatchObject({
            disposition: "accepted",
            application: "pending",
          });
          earlyReceipt = receipt.waitId;
          expect(
            (
              await database.pool.query(
                "SELECT state,result FROM run_waits WHERE id=$1",
                [earlyReceipt],
              )
            ).rows,
          ).toEqual([{ state: "reserved", result: null }]);
        }
      }

      return { repoIdentity, headSha: head, remoteHeadSha };
    };
    const drive = () =>
      runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });

    await drive();
    const {
      rows: [wait],
    } = await database.pool.query<{ id: string; head_ref: string }>(
      `SELECT run_waits.id,run_publications.head_ref FROM run_waits
      JOIN run_publications ON run_publications.id=run_waits.publication_id WHERE run_waits.run_id=$1 AND run_waits.state='open'`,
      [runId],
    );

    expect(wait).toBeDefined();

    if (transport === "push") {
      expect(wait.id).toBe(earlyReceipt);
      expect(rejectedReceipt).toMatchObject({
        disposition: "rejected",
        application: "not_applied",
        reason: "wait_signal_issuer",
      });
    }

    const seen: string[] = [];

    await scanWaitPublications({
      db: database.db as unknown as import("@/lib/execution-host/db").Db,
      projectId,
      provider: "github",
      remoteUrl: `https://${repoIdentity}.git`,
      deadline: Date.now() + 20_000,
      fetchPage: async (request) => {
        const url = new URL(String(request));

        seen.push(url.pathname);
        if (url.pathname.includes("/branches/"))
          return Response.json({ commit: { sha: head } });
        if (url.pathname.endsWith("/statuses")) return Response.json([]);

        return Response.json({
          check_runs: [
            {
              id: 1,
              name: "build",
              head_sha: head,
              status: "completed",
              conclusion: "success",
              app: { slug: "github-actions" },
            },
          ],
        });
      },
    });
    const { failures } = await dispatchDomainEvents({
      db: database.db,
      consumers: [buildWaitResolver(() => database.db)],
    });

    expect(failures).toBe(0);
    expect(seen.some((path) => path.endsWith("/check-runs"))).toBe(
      transport === "pull",
    );
    expect(
      (await promoteNextPending({ db: database.db, runFlow: () => undefined }))
        .promotedRunId,
    ).toBe(runId);
    await drive();

    const evidence = await database.pool.query(
      `SELECT r.status,w.result->>'outcome' AS outcome,w.result->>'source' AS source
      FROM run_waits w JOIN runs r ON r.id=w.run_id WHERE w.id=$1`,
      [wait.id],
    );

    expect(evidence.rows).toEqual([
      {
        status: "Review",
        outcome: "success",
        source: transport === "pull" ? "provider" : "signal",
      },
    ]);
  },
);
