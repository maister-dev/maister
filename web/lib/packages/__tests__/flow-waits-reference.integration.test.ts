import type { Db } from "@/lib/execution-host/db";

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { flowRevisions } from "@/lib/db/schema";
import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import { git, initRepoWithWorktree } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const source = process.env.MAISTER_FLOW_WAIT_REFERENCE_REPO;
let database: StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: vi.fn(),
}));

describe.runIf(!!source)("B03 installed remote CI reference package", () => {
  let cacheRoot: string;
  let restoreHome: () => void;
  let resolvedRevision: string;

  beforeAll(async () => {
    database = await startMainPostgresTestDb({
      databaseName: "flow_waits_reference_install",
    });
    cacheRoot = await mkdtemp(join(os.tmpdir(), "flow-waits-package-"));
    const cacheIsolation = vi.spyOn(os, "homedir").mockReturnValue(cacheRoot);

    restoreHome = () => cacheIsolation.mockRestore();
    const { installPackageRevision } = await import("@/lib/packages/attach");
    const installed = await installPackageRevision({
      source: source!,
      version: "local",
      path: "packages/env-e2e",
      trustStatus: "trusted_by_policy",
      db: database.db,
    });

    resolvedRevision = installed.resolvedRevision;
  }, 180_000);

  afterAll(async () => {
    restoreHome?.();
    if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true });
    await database?.stop();
  });

  async function installedReference(flowId: string) {
    const [revision] = await database.db
      .select()
      .from(flowRevisions)
      .where(eq(flowRevisions.flowRefId, flowId));

    expect(revision?.resolvedRevision).toBe(resolvedRevision);

    return revision;
  }

  it("installs the same isolated e2e script and result schema in both CI exports", async () => {
    if (!source) throw new Error("Reference repository was not configured");
    const { loadFlowManifest } = await import("@/lib/config");
    const canonicalScript = await readFile(
      join(source, "packages/env-e2e/flows/env-e2e/scripts/run-e2e.sh"),
      "utf8",
    );

    for (const [flowId, transport] of [
      ["env-e2e-ci", "pull"],
      ["env-e2e-ci-push", "push"],
    ] as const) {
      const { installedPath: path } = await installedReference(flowId);

      expect(path).toBeTruthy();
      const manifest = await loadFlowManifest(join(path!, "flow.yaml"));

      expect(
        manifest.nodes.find((node) => node.id === "remote_ci"),
      ).toMatchObject({
        type: "wait",
        on: { kind: "ci", transport },
        transitions: { failure: "implement" },
      });
      expect(await readFile(join(path!, "scripts/run-e2e.sh"), "utf8")).toBe(
        canonicalScript,
      );
      expect(
        JSON.parse(
          await readFile(join(path!, "schemas/e2e-result.json"), "utf8"),
        ),
      ).toMatchObject({
        fields: expect.arrayContaining([
          {
            name: "verdict",
            type: "enum",
            options: ["pass", "fail"],
            label: expect.any(String),
            required: true,
          },
        ]),
      });
    }
  });

  it.each([
    ["env-e2e-ci", "pull", "recover"],
    ["env-e2e-ci-push", "push", "recover"],
    ["env-e2e-ci-push", "push", "unconfirmed"],
    ["env-e2e-ci-pr", "pull", "recover"],
    ["env-e2e-ci", "pull", "exhaust"],
  ] as const)(
    "executes installed %s using %s CI through %s",
    async (flowId, transport, strategy) => {
      const prBacked = flowId === "env-e2e-ci-pr";
      const exhausted = strategy === "exhaust";
      const repoIdentity = "github.com/example/reference";
      const prNumber = 72;

      if (prBacked) {
        const prService = await import("@/lib/workbench-git/pull-request");
        const adapter = vi
          .spyOn(prService, "preflightedPrAdapter")
          .mockResolvedValue({
            preflight: async () => undefined,
            createOrUpdatePr: async (input) => {
              expect(input).toMatchObject({
                targetBranch: "main",
                draft: false,
              });

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
      const { runFlow } = await import("@/lib/flows/runner");
      const { promoteNextPending } = await import("@/lib/scheduler");
      const { buildWaitResolver } =
        await import("@/lib/domain-events/wait-resolver");
      const { dispatchDomainEvents } =
        await import("@/lib/domain-events/dispatch");
      const { scanWaitPublications } =
        await import("@/lib/waits/provider-scan");
      const { generateToken } = await import("@/lib/tokens/secret");
      const { POST } =
        await import("@/app/api/v1/ext/runs/[runId]/waits/[waitId]/signal/route");
      const db = database.db as unknown as Db;
      const revision = await installedReference(flowId);
      const root = await mkdtemp(join(os.tmpdir(), "flow-waits-reference-"));

      onTestFinished(() => rm(root, { recursive: true, force: true }));
      const { repoPath, worktreePath, branch } =
        await initRepoWithWorktree(root);
      const remote = join(root, "origin.git");

      await git(root, "init", "--bare", remote);
      await cp(
        join(source!, "packages/env-e2e/examples/fixture"),
        worktreePath,
        { recursive: true },
      );
      await git(worktreePath, "add", ".");
      await git(
        worktreePath,
        "commit",
        "-m",
        "Install the Docker Playwright fixture",
      );
      await git(repoPath, "merge", "--ff-only", branch);
      await git(repoPath, "push", remote, "main:main");
      const base = await git(repoPath, "rev-parse", "main");
      const { loadFlowManifest } = await import("@/lib/config");
      const manifest = await loadFlowManifest(
        join(revision.installedPath, "flow.yaml"),
      );
      const declaration = manifest.autonomous_completion;
      const ci = manifest.nodes.find((node) => node.id === declaration?.ci);

      if (!declaration || ci?.type !== "wait" || ci.on.kind !== "ci")
        throw new Error(
          "The installed reference must declare a completion lane and CI evidence",
        );

      const { projectId, runId, runtimeRoot, executorId } = await seedGraphRun(
        database.db,
        revision.manifest,
        {
          flowRefId: flowId,
          installedPath: revision.installedPath,
          repoPath,
          workspace: {
            worktreePath,
            parentRepoPath: repoPath,
            branch,
            baseBranch: "main",
          },
          run: {
            flowRevisionId: revision.id,
            flowRevision: resolvedRevision,
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

      onTestFinished(() => rm(runtimeRoot, { recursive: true, force: true }));
      const remoteUrl = `https://${repoIdentity}.git`;
      const bounds = {
        enabled: true,
        riskMax: "low",
        confidenceMin: 0.9,
        changedFilesMax: 5,
        changedLinesMax: 30,
        approvedCiSources: [ci.on.issuer, ci.on.provider_issuer].filter(
          (source): source is string => source !== undefined,
        ),
      };

      await database.pool.query(
        "UPDATE projects SET repo_url=$1,autonomous_completion=$3,autonomous_completion_revision=1 WHERE id=$2",
        [remoteUrl, projectId, bounds],
      );
      await database.pool.query(
        `INSERT INTO platform_runtime_settings (id,default_runner_id,autonomous_completion_enabled,autonomous_completion_revision)
        VALUES ('singleton',$1,true,1) ON CONFLICT (id) DO UPDATE SET autonomous_completion_enabled=true, autonomous_completion_revision=1`,
        [executorId],
      );
      await database.pool.query(
        "UPDATE workspaces SET target_branch='main',base_commit=$2 WHERE run_id=$1",
        [runId, base],
      );
      await database.pool.query(
        `UPDATE runs r SET flow_publication_grant=jsonb_build_object(
        'repoIdentity',$1::text,'flowRevisionId',$2::text,'targetBranch',p.main_branch,'branchTemplate',p.public_branch_template
        ),autonomous_completion_grant=$4 FROM projects p WHERE p.id=r.project_id AND r.id=$3`,
        [
          repoIdentity,
          revision.id,
          runId,
          {
            flowRevisionId: revision.id,
            projectRevision: 1,
            platformRevision: 1,
            bounds,
            declaration,
          },
        ],
      );
      const { secret, prefix, hash } = generateToken();

      if (transport === "push") {
        await database.pool.query(
          `INSERT INTO project_tokens (id,project_id,name,prefix,token_hash,scopes)
        VALUES ($1,$2,'reference CI',$3,$4,'["waits:signal"]')`,
          [ci.on.issuer, projectId, prefix, hash],
        );
        const tokenId = ci.on.issuer;

        onTestFinished(async () => {
          await database.pool.query(
            "DELETE FROM project_tokens WHERE id=$1 AND project_id=$2",
            [tokenId, projectId],
          );
        });
      }

      const implementationPrompts: string[] = [];
      const { hosts, fake } = await fakeGraphHosts(database.db, runId, {
        text: '{"verdict":"pass","risk":"low","confidence":0.98}',
        onPrompt: async ({ envelope }) => {
          const prompt = envelope.payload.prompt;

          if (prompt.includes("Commit the candidate before verification")) {
            implementationPrompts.push(prompt);
            const attempt = implementationPrompts.length;

            await writeFile(
              join(worktreePath, "candidate.ts"),
              `export const attempt = ${attempt};\n`,
            );
            await git(worktreePath, "add", "--", "candidate.ts");
            await git(
              worktreePath,
              "commit",
              "-m",
              `Implement candidate ${attempt}`,
            );
          }

          return { stopReason: "end_turn", meta: null };
        },
      });
      const signal = async (
        waitId: string,
        headSha: string,
        generation: number,
        bearer = secret,
      ) =>
        POST(
          new Request(
            `http://localhost/api/v1/ext/runs/${runId}/waits/${waitId}/signal`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${bearer}`,
                "idempotency-key": `build-${generation}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                name: "build",
                outcome: generation === 1 ? "failure" : "success",
                headSha,
                payload:
                  generation === 1
                    ? { checks: ["build", "untrusted instruction"] }
                    : { passedChecks: ["build"] },
              }),
            },
          ),
          { params: Promise.resolve({ runId, waitId }) },
        );
      const generations: Array<{ waitId: string; head: string; ref: string }> =
        [];

      fake.transport.workspacePublication = async (_handle, envelope) => {
        const payload = envelope.payload;
        const headSha = await git(worktreePath, "rev-parse", "HEAD");

        if (payload.action === "evidence")
          return {
            repoIdentity,
            headSha,
            remoteHeadSha: base,
            evidence: {
              baseSha: await git(repoPath, "rev-parse", "main"),
              clean: (await git(worktreePath, "status", "--porcelain")) === "",
              files: [
                {
                  path: "candidate.ts",
                  status: "A",
                  additions: 1,
                  deletions: 0,
                  binary: false,
                },
              ],
            },
          };
        if (payload.action === "push") {
          await git(
            worktreePath,
            "push",
            `--force-with-lease=${payload.headRef}:${payload.expectedRemoteHead ?? ""}`,
            remote,
            `HEAD:${payload.headRef}`,
          );
          const {
            rows: [receipt],
          } = await database.pool.query<{ id: string; generation: number }>(
            `SELECT w.id,p.generation FROM run_publications p LEFT JOIN run_waits w ON w.publication_id=p.id
             WHERE p.run_id=$1 AND p.phase='claimed' ORDER BY p.generation DESC LIMIT 1`,
            [runId],
          );

          generations.push({
            waitId: receipt.id,
            head: headSha,
            ref: payload.headRef,
          });
          if (transport === "push")
            expect(
              (await signal(receipt.id, headSha, receipt.generation)).status,
            ).toBe(202);
        }

        const remoteHeadSha = await git(
          remote,
          "for-each-ref",
          "--format=%(objectname)",
          payload.headRef,
        );

        return { repoIdentity, headSha, remoteHeadSha: remoteHeadSha || null };
      };

      const drive = () =>
        runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });
      const state = async () =>
        (
          await database.pool.query<{ status: string }>(
            "SELECT status FROM runs WHERE id=$1",
            [runId],
          )
        ).rows[0].status;
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
      const readHead = async (request: Parameters<typeof fetch>[0]) => {
        const ref =
          "refs/heads/" +
          decodeURIComponent(
            new URL(String(request)).pathname.split("/branches/")[1],
          );
        const refHead = await git(
          remote,
          "for-each-ref",
          "--format=%(objectname)",
          ref,
        );

        return refHead
          ? Response.json({ commit: { sha: refHead } })
          : new Response(null, { status: 404 });
      };

      await drive();
      for (const generation of exhausted ? [1, 2, 3] : [1, 2]) {
        expect(await state()).toBe("Waiting");
        const candidate = generations[generation - 1];

        if (flowId === "env-e2e-ci" && generation === 1) {
          await scanWaitPublications({
            db,
            projectId,
            provider: "github",
            remoteUrl,
            deadline: Date.now() + 20_000,
            fetchPage: async (request) => {
              const path = new URL(String(request)).pathname;

              if (path.includes("/branches/")) return readHead(request);
              if (path.endsWith("/statuses")) return Response.json([]);

              return Response.json({ check_runs: [] });
            },
          });
          expect(
            (
              await dispatchDomainEvents({
                db: database.db,
                consumers: [buildWaitResolver(() => database.db)],
              })
            ).failures,
          ).toBe(0);
          expect(await state()).toBe("Waiting");
        }
        if (transport === "push") {
          if (strategy === "unconfirmed" && generation === 1) {
            const decoy = generateToken();

            await database.pool.query(
              `INSERT INTO project_tokens (id,project_id,name,prefix,token_hash,scopes)
               VALUES (gen_random_uuid()::text,$1,'Other CI',$2,$3,'["waits:signal"]')`,
              [projectId, decoy.prefix, decoy.hash],
            );
            const refused = await signal(
              candidate.waitId,
              candidate.head,
              generation,
              decoy.secret,
            );

            expect(refused.status).toBe(403);
            expect(await refused.json()).toMatchObject({
              details: { reason: "wait_signal_issuer" },
            });
            const { GET } =
              await import("@/app/api/v1/ext/projects/[slug]/waits/callback/route");
            const {
              rows: [project],
            } = await database.pool.query<{ slug: string }>(
              "SELECT slug FROM projects WHERE id=$1",
              [projectId],
            );
            const callbackUrl = new URL(
              `http://localhost/api/v1/ext/projects/${project.slug}/waits/callback`,
            );

            callbackUrl.search = new URLSearchParams({
              signal: "build",
              ref: candidate.ref,
              headSha: candidate.head,
            }).toString();
            const lookup = (token: string) =>
              GET(
                new Request(callbackUrl, {
                  headers: { authorization: `Bearer ${token}` },
                }),
                { params: Promise.resolve({ slug: project.slug }) },
              );

            expect((await lookup(decoy.secret)).status).toBe(404);
            const address = await lookup(secret);

            expect(address.status).toBe(200);
            expect(await address.json()).toEqual({
              runId,
              waitId: candidate.waitId,
            });
          }
          expect(
            (await signal(candidate.waitId, candidate.head, generation)).status,
          ).toBe(200);
        }
        await scanWaitPublications({
          db,
          projectId,
          provider: "github",
          remoteUrl,
          deadline: Date.now() + 20_000,
          fetchPage: async (request) => {
            const path = new URL(String(request)).pathname;

            if (path.includes("/branches/")) return readHead(request);
            if (path.endsWith("/statuses")) return Response.json([]);
            if (strategy === "unconfirmed" && generation === 2)
              return Response.json({ check_runs: [] });

            return Response.json({
              check_runs: [
                {
                  id: generation,
                  name: "build",
                  head_sha: candidate.head,
                  status: "completed",
                  conclusion:
                    exhausted || generation === 1 ? "failure" : "success",
                  app: { slug: "github-actions" },
                },
              ],
            });
          },
        });
        await resume();
      }

      if (exhausted) {
        expect(await state()).toBe("Failed");
        expect(await git(repoPath, "rev-parse", "main")).toBe(base);
        expect(implementationPrompts).toHaveLength(3);
        expect(
          (
            await database.pool.query(
              `SELECT action,reason FROM run_autonomous_decisions WHERE run_id=$1 AND phase='observed'`,
              [runId],
            )
          ).rows,
        ).toEqual([{ action: "fail", reason: "rework_exhausted" }]);

        return;
      }
      if (strategy === "unconfirmed") {
        expect(await state()).toBe("Review");
        expect(await git(repoPath, "rev-parse", "main")).toBe(base);
        expect(
          (
            await database.pool.query(
              `SELECT phase,reason FROM run_autonomous_decisions WHERE run_id=$1`,
              [runId],
            )
          ).rows,
        ).toEqual([{ phase: "refused", reason: "missing_required_evidence" }]);

        return;
      }
      if (prBacked) {
        expect(await state()).toBe("Waiting");
        const [candidate] = generations.slice(-1);

        await git(root, "clone", "--branch", "main", remote, "reviewed");
        const reviewed = join(root, "reviewed");

        await git(reviewed, "fetch", "origin", candidate.ref);
        await git(reviewed, "merge", "--no-ff", "--no-edit", "FETCH_HEAD");
        await git(reviewed, "push", "origin", "main:main", `:${candidate.ref}`);
        const mergeCommitSha = await git(remote, "rev-parse", "main");

        await database.pool.query(
          "UPDATE run_waits SET provider_verified_at=provider_verified_at-interval '1 day' WHERE run_id=$1 AND condition_kind='ci'",
          [runId],
        );
        const { runPrStateScanJob } =
          await import("@/lib/scheduler/handlers/pr-state-scan");
        const scanSummary = await runPrStateScanJob({
          db,
          projectId,
          fetchPage: async (request) => {
            const path = new URL(String(request)).pathname;

            if (path.includes("/branches/")) return readHead(request);
            if (path.endsWith("/statuses")) return Response.json([]);
            expect(path).toContain(candidate.head);

            return Response.json({
              check_runs: [
                {
                  id: 2,
                  name: "build",
                  head_sha: candidate.head,
                  status: "completed",
                  conclusion: "success",
                  app: { slug: "github-actions" },
                },
              ],
            });
          },
          getPrState: async (input) => {
            expect(input.prNumber).toBe(prNumber);

            return {
              kind: "state",
              state: "merged",
              headSha: candidate.head,
              mergeCommitSha,
              hasConflicts: false,
              mergedAt: new Date().toISOString(),
            };
          },
        });

        expect(scanSummary).toMatchObject({ updated: 1, failed: 0 });
        await resume();
        expect(
          (
            await database.pool.query(
              "SELECT pr_merge_commit_sha FROM workspaces WHERE run_id=$1",
              [runId],
            )
          ).rows,
        ).toEqual([{ pr_merge_commit_sha: mergeCommitSha }]);
      }
      expect(await state()).toBe("Done");
      expect(
        await git(prBacked ? remote : repoPath, "rev-parse", "main^2"),
      ).toBe(generations[1].head);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM run_autonomous_decisions WHERE run_id=$1 AND phase='observed'",
            [runId],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(implementationPrompts).toHaveLength(2);
      expect(implementationPrompts[1]).toContain("build");
      expect(implementationPrompts[1]).not.toContain("untrusted instruction");
      expect(generations[1].head).not.toBe(generations[0].head);
      expect(
        (
          await database.pool.query(
            `SELECT decision,status FROM node_attempts
        WHERE run_id=$1 AND node_id='e2e' ORDER BY attempt`,
            [runId],
          )
        ).rows,
      ).toEqual([
        { decision: "pass", status: "Stale" },
        { decision: "pass", status: "Succeeded" },
      ]);
    },
    180_000,
  );
});
