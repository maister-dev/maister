import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { hitlRequests } from "@/lib/db/schema";
import { createRoot } from "@/lib/review-comments/service";
import { createCompanyGrants } from "@/lib/company/grants";
import { buildAgentProfileContract } from "@/lib/run-results/contract";
import { seedWorkspace } from "@/test-support/execution-host-seed";
import { git, initRepoWithWorktree } from "@/test-support/git-fixture";
import { seedNativeFindingsExecution } from "@/test-support/native-findings-seed";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
let sessionUserId: string | null = null;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/auth", () => ({
  auth: async () =>
    sessionUserId === null ? null : { user: { id: sessionUserId } },
}));

const contract = buildAgentProfileContract({
  profileName: "findings",
  flowRefId: "native-workbench",
  resolvedRevision: "a".repeat(40),
  sourceFlowRevisionId: "pinned-findings",
  schemaStem: "findings.v1",
  nativeContract: "evidence_findings_v1",
  schemaVersion: 1,
  schema: { schemaVersion: 1, fields: [] },
  sha256: "b".repeat(64),
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "native-workbench-disclosure-"));
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "native_workbench_disclosure",
  });
}, 180000);
afterAll(async () => {
  try {
    await database?.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["files", "diff", "change-summary", "review-comments"] as const)(
  "IT-CBE-06 actual %s checks source authority before exposing a native worktree and permits an authorized reader",
  async (kind) => {
    const source = await seedNativeFindingsExecution(database, contract);
    const record = await getKnowledgeRecord(
      database.db,
      { kind: "token", tokenId: source.tokenId },
      { recordId: source.recordId },
    );
    const workspace = await initRepoWithWorktree(root, randomUUID());
    const base = await git(workspace.repoPath, "rev-parse", "HEAD");
    const privateFile = `source-${randomUUID()}.md`;

    await writeFile(
      join(workspace.worktreePath, privateFile),
      record.assertion,
    );
    await git(workspace.worktreePath, "add", "--", privateFile);
    await git(workspace.worktreePath, "commit", "-m", "Retain fixture finding");
    await database.pool.query("UPDATE projects SET repo_path=$2 WHERE id=$1", [
      source.projectId,
      workspace.repoPath,
    ]);
    await database.pool.query(
      "UPDATE runs SET agent_workspace='worktree' WHERE id=$1",
      [source.runId],
    );
    const workspaceId = await seedWorkspace(database.db, {
      runId: source.runId,
      projectId: source.projectId,
      worktreePath: workspace.worktreePath,
      parentRepoPath: workspace.repoPath,
      branch: workspace.branch,
    });

    await database.pool.query(
      "UPDATE workspaces SET base_branch='main',target_branch='main',base_commit=$2 WHERE id=$1",
      [workspaceId, base],
    );
    const userId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [userId, `${userId}@example.test`],
    );
    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
      [randomUUID(), source.projectId, userId],
    );
    sessionUserId = userId;
    if (kind === "review-comments") {
      await database.pool.query(
        "UPDATE runs SET status='NeedsInput' WHERE id=$1",
        [source.runId],
      );
      await database.db.insert(hitlRequests).values({
        id: randomUUID(),
        runId: source.runId,
        stepId: "review",
        kind: "human",
        prompt: "Review finding",
        schema: { review: true },
      });
      await createRoot(
        database.db,
        { userId, label: "Reviewer" },
        source.runId,
        {
          filePath: privateFile,
          side: "new",
          line: 1,
          lineContent: record.assertion,
          body: "Check retained assertion",
        },
      );
    }
    const read = async (): Promise<Response> => {
      const request = new NextRequest(
        `http://localhost/api/runs/${source.runId}/${kind}`,
      );
      const params = { params: Promise.resolve({ runId: source.runId }) };

      if (kind === "files")
        return (await import("@/app/api/runs/[runId]/files/route")).GET(
          request,
          params,
        );
      if (kind === "diff")
        return (await import("@/app/api/runs/[runId]/diff/route")).GET(
          request,
          params,
        );

      if (kind === "review-comments")
        return (
          await import("@/app/api/runs/[runId]/review-comments/route")
        ).GET(request, params);

      return (await import("@/app/api/runs/[runId]/change-summary/route")).GET(
        request,
        params,
      );
    };
    const denied = await read();

    expect(denied.status).toBe(409);
    expect(await denied.text()).not.toContain(privateFile);
    await createCompanyGrants(database.db, source.submitterId, {
      principalKind: "user",
      principalId: userId,
      actions: ["knowledge:read"],
      idempotencyKey: `workbench-reader:${source.runId}`,
    });
    const accepted = await read();

    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain(privateFile);
  },
);
