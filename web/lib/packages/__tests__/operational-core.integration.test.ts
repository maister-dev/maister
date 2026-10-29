import type { OperationalResultV1 } from "@/lib/run-results/operational-types";
import type { Db } from "@/lib/execution-host/db";

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runs, workspaces, runResults } from "@/lib/db/schema";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
} from "@/lib/agents/operational-integrity";
import { finalizeAgentRun } from "@/lib/agents/finalization";
import { loadRunPublicResult } from "@/lib/runs/run-result-dto";
import { agentWorkdirPath } from "@/lib/agents/workspace-paths";
import { createTask } from "@/lib/services/tasks";
import { addWorktree } from "@/lib/worktree";
import { initRepo } from "@/test-support/git-fixture";
import {
  operationalSuccessFixture,
  operationalBlockedFixture,
} from "@/test-support/operational-agent";
import { installPackageRevision, attachPackage } from "@/lib/packages/attach";
import { attachAgent } from "@/lib/agents/project-links";
import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";
import { buildOperationalContract } from "@/lib/agents/launch-contract";
import {
  agents,
  projects,
  agentProjectLinks,
  packageInstalls,
} from "@/lib/db/schema";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;
let root: string;
let repo: string;
let seam: Awaited<ReturnType<typeof fakeExecutionHosts>>;
let provider: Server;
let endpoint: string;
const priorWorktrees = process.env.MAISTER_WORKTREES_ROOT;
const execute = promisify(execFile);
const providerCalls: Array<{ method: string; path: string }> = [];
const projectId = randomUUID();
const originalHome = process.env.HOME;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "operational_core",
  });
  db = database.db;
  root = await mkdtemp(path.join(os.tmpdir(), "operational-core-"));
  process.env.HOME = root;
  seam = await fakeExecutionHosts(db);
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  repo = await initRepo(path.join(root, "repository"));
  provider = createServer((request, response) => {
    const resource = request.url ?? "/";

    providerCalls.push({ method: request.method ?? "", path: resource });
    const url = new URL(resource, "http://fixture.invalid");
    const scenario = url.searchParams.get("case");
    const page = url.searchParams.get("page");
    const status =
      scenario === "blocked"
        ? 403
        : scenario === "partial" && page === "2"
          ? 503
          : 200;

    response.writeHead(status, { "content-type": "application/json" });
    const data =
      status === 200
        ? {
            issues:
              scenario === "empty"
                ? []
                : [{ id: "fixture-issue-1", number: 1 }],
            hasNextPage: scenario === "partial",
          }
        : {
            message:
              status === 403
                ? "repository issues access denied"
                : "provider page unavailable",
          };

    response.end(
      JSON.stringify(
        url.pathname === "/mcp"
          ? { jsonrpc: "2.0", id: 1, result: data }
          : data,
      ),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();

  if (!address || typeof address === "string")
    throw new Error("provider fixture address missing");
  endpoint = `http://127.0.0.1:${address.port}`;
  await db.insert(projects).values({
    id: projectId,
    slug: "operational-core",
    name: "Core adopters",
    repoPath: repo,
    maisterYamlPath: path.join(root, "maister.yaml"),
    taskKey: "OPCORE",
  });
}, 180_000);
afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (priorWorktrees === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = priorWorktrees;
  await new Promise<void>((resolve, reject) =>
    provider?.close((error) => (error ? reject(error) : resolve())),
  );
  await database?.stop();
  await rm(root, { recursive: true, force: true });
});

describe("operational core package through real install/attach boundaries", () => {
  it("IT-OPA-05 IT-EDGE-OPA-04 installs zero flows and freezes both intake variants with the shared skill", async () => {
    const source =
      process.env.OPERATIONAL_CORE_CANDIDATE ??
      path.resolve("test-support/fixtures/operational-core");
    const installed = await installPackageRevision({
      source,
      version: "core/v1.4.0",
      trustStatus: "trusted",
      db,
    });

    expect(installed.manifest.spec.flows).toEqual([]);
    await attachPackage({
      db,
      projectId,
      projectSlug: "operational-core",
      packageInstallId: installed.id,
      workspaceRoot: root,
    });
    for (const agentId of ["core:github-intake-gh", "core:github-intake-mcp"]) {
      await attachAgent({ projectId, agentId }, db);
      const effective = await resolveEffectiveAgentDefinition(
        { projectId, agentId },
        db,
      );

      expect(effective.parsed).toMatchObject({
        kind: "operational",
        completion: { contract: "operational_v1" },
        workspace: "worktree",
        mode: "session",
      });
      const frozen = buildOperationalContract(effective);

      expect(frozen.provenance.resolvedRevision).toBe(
        installed.resolvedRevision,
      );
      expect(frozen.required).toBe(true);
      expect(frozen.promptAppendix).toContain("HTTP 403");
    }
    const [install] = await db
      .select()
      .from(packageInstalls)
      .where(eq(packageInstalls.id, installed.id));
    const skill = await readFile(
      path.join(
        install.installedPath,
        "capability/skills/github-issue-intake/SKILL.md",
      ),
      "utf8",
    );

    expect(skill).toContain("```json maister:output");
    expect(skill).toContain("created=1");
    expect(skill).toContain("HTTP 401/403");
    expect(skill).toContain("reconcile before any retry");
    expect(
      (
        await db
          .select()
          .from(agents)
          .where(
            inArray(agents.id, [
              "core:github-intake-gh",
              "core:github-intake-mcp",
            ]),
          )
      ).map((row) => row.kind),
    ).toEqual(["operational", "operational"]);
    expect(
      await db
        .select()
        .from(agentProjectLinks)
        .where(eq(agentProjectLinks.projectId, projectId)),
    ).toHaveLength(2);
  });
});

// The package contains instructions rather than executable intake logic. These
// controlled provider/actor fixtures qualify its frozen contract and platform
// settlement; they do not claim live model or real GitHub qualification.
for (const transport of ["gh", "mcp"] as const) {
  it.each(["empty", "created", "partial", "blocked"] as const)(
    `IT-OPA-05 ${transport} controlled provider outcome %s reaches the pinned contract`,
    async (scenario) => {
      const agentId = `core:github-intake-${transport}`;
      const effective = await resolveEffectiveAgentDefinition(
        { projectId, agentId },
        db,
      );
      const frozen = buildOperationalContract(effective);
      const runId = randomUUID();
      const cwd = agentWorkdirPath("operational-core", runId);

      await addWorktree({
        projectRepoPath: repo,
        worktreePath: cwd,
        branch: `maister/operation-${runId}`,
        startPoint: "main",
      });
      const baseline = await captureOperationalGeneration(
        cwd,
        await captureOperationalBaseline(cwd, "worktree"),
        [],
      );

      await db.insert(runs).values({
        id: runId,
        projectId,
        agentId,
        runKind: "agent",
        agentKind: "operational",
        agentWorkspace: "worktree",
        status: "Running",
        flowVersion: "agent",
        resultContract: frozen,
        operationalIntegrityBaseline: baseline,
      });
      await db.insert(workspaces).values({
        id: randomUUID(),
        runId,
        projectId,
        branch: `maister/operation-${runId}`,
        worktreePath: cwd,
        parentRepoPath: repo,
        baseBranch: "main",
        targetBranch: "main",
      });
      await seam.hosts.forRun(runId, { reason: "launch" });
      const request = async (
        page: number,
      ): Promise<{
        status: number;
        body: {
          issues?: Array<{ id: string; number: number }>;
          hasNextPage?: boolean;
          message?: string;
        };
      }> => {
        const url = `${endpoint}/${transport}?case=${scenario}&page=${page}`;

        if (transport === "mcp") {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "list_issues",
                arguments: { owner: "fixture", repo: "repo", page },
              },
            }),
          });
          const body = (await response.json()) as {
            result: {
              issues?: Array<{ id: string; number: number }>;
              hasNextPage?: boolean;
              message?: string;
            };
          };

          return { status: response.status, body: body.result };
        }
        try {
          return JSON.parse(
            (
              await execute(process.execPath, [
                path.resolve(
                  "test-support/fixtures/operational-provider-gh.mjs",
                ),
                url,
              ])
            ).stdout,
          );
        } catch (error) {
          if (!(
            error &&
            typeof error === "object" &&
            "stdout" in error &&
            typeof error.stdout === "string"
          ))
            throw error;

          return JSON.parse(error.stdout);
        }
      };
      const first = await request(1);
      let report: OperationalResultV1 =
        scenario === "blocked"
          ? operationalBlockedFixture()
          : operationalSuccessFixture();

      if (scenario === "blocked") expect(first.status).toBe(403);
      if (first.body.issues?.length) {
        const created = await createTask(
          {
            title: `Imported ${transport} issue`,
            prompt: `Source-GitHub-ID: ${first.body.issues[0].id}`,
          },
          { projectId, producedByRunId: runId },
          db,
        );

        report = {
          ...report,
          summary: "Imported source issue.",
          counts: {
            scanned: 1,
            attempted: 1,
            completed: 1,
            failed: 0,
            skipped: 0,
            created: 1,
          },
          references: [
            { kind: "task", id: created.taskId, state: "confirmed" },
            {
              kind: "external_issue",
              id: first.body.issues[0].id,
              state: "confirmed",
              url: "https://example.invalid/fixture/repo/issues/1",
            },
          ],
        };
        if (scenario === "partial") {
          const second = await request(2);

          expect(second.status).toBe(503);
          report = {
            ...report,
            outcome: "partial",
            coverage: { state: "incomplete", remainingKnown: null },
            counts: { ...report.counts, completed: 0, failed: 1 },
            diagnostics: [
              {
                code: "github_page_503",
                severity: "error",
                operation: "list_remaining_and_confirm_receipt",
                message: "A provider page and receipt remain unresolved.",
                retryable: true,
                remediation:
                  "Reconcile the existing task and pending receipt before retrying remaining pages.",
                service: "github",
                httpStatus: 503,
              },
            ],
          };
        }
      }
      await finalizeAgentRun(runId, "Done", {
        db,
        finalText: `\`\`\`json maister:output\n${JSON.stringify(report)}\n\`\`\``,
      });
      const dto = await loadRunPublicResult(db, runId);

      expect(dto?.operationalOutcome).toMatchObject({
        reportedOutcome: report.outcome,
        effectiveOutcome: report.outcome,
        successful: report.outcome === "success",
      });
      expect(
        (await db.select().from(runs).where(eq(runs.id, runId)))[0],
      ).toMatchObject({
        status: report.outcome === "success" ? "Done" : "Failed",
        promotedHeadSha: null,
        mergeCommitSha: null,
      });
      expect(
        (
          await db.select().from(runResults).where(eq(runResults.runId, runId))
        )[0].value,
      ).toEqual(report);
      if (report.counts.created)
        expect(dto?.operationalOutcome?.referenceLinks).toContainEqual({
          kind: "task",
          id: report.references[0].id,
          href: expect.stringMatching(
            /^\/projects\/operational-core\/tasks\/[0-9]+$/,
          ),
        });
      expect(
        providerCalls.some(
          (call) =>
            call.method === (transport === "gh" ? "GET" : "POST") &&
            call.path.startsWith(`/${transport}?case=${scenario}`),
        ),
      ).toBe(true);
    },
  );
}
