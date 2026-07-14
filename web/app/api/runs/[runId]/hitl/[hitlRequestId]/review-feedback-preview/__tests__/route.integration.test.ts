import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const execFileAsync = promisify(execFile);

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
const pathsToRemove: string[] = [];

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ user: { id: "reviewer-1" } })),
  requireProjectAction: vi.fn(async () => {}),
}));

let POST: typeof import("@/app/api/runs/[runId]/hitl/[hitlRequestId]/review-feedback-preview/route").POST;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout.trim();
}

async function seedReviewGate(): Promise<{
  runId: string;
  hitlRequestId: string;
  threadId: string;
}> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const hitlRequestId = randomUUID();
  const threadId = randomUUID();
  const repo = await mkdtemp(join(tmpdir(), "review-preview-route-"));

  pathsToRemove.push(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "reviewer@example.test");
  await git(repo, "config", "user.name", "Reviewer");
  await writeFile(join(repo, "src.ts"), "export const value = 1;\n");
  await git(repo, "add", "src.ts");
  await git(repo, "commit", "-q", "-m", "base");
  const baseCommit = await git(repo, "rev-parse", "HEAD");

  await writeFile(join(repo, "src.ts"), "export const value = 2;\n");
  await writeFile(join(repo, "untracked.ts"), "export const extra = true;\n");

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
    slug: `review-preview-${projectId.slice(0, 8)}`,
    name: "Review preview",
    repoPath: repo,
    maisterYamlPath: join(repo, "maister.yaml"),
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    flowVersion: "v1",
    status: "NeedsInput",
    runKind: "flow",
    currentStepId: "review",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    projectId,
    runId,
    branch: "main",
    worktreePath: repo,
    parentRepoPath: repo,
    baseBranch: "main",
    baseCommit,
  });
  await db.insert(schema.hitlRequests).values({
    id: hitlRequestId,
    runId,
    stepId: "review",
    kind: "human",
    prompt: "Review the change",
    schema: {
      review: true,
      allowedDecisions: ["approve", "rework"],
      transitions: { approve: "done", rework: "fix" },
      reworkTargets: ["fix"],
      workspacePolicies: ["keep"],
      commentsVar: "review_comments",
    },
  });
  await db.insert(schema.reviewComments).values({
    id: threadId,
    runId,
    hitlRequestId,
    nodeId: "review",
    gateAttempt: 1,
    authorLabel: "Reviewer",
    filePath: "src.ts",
    side: "new",
    line: 1,
    lineContent: "export const value = 2;",
    body: "Validate the empty path too.",
    status: "open",
  });

  return { runId, hitlRequestId, threadId };
}

function previewRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/review-feedback-preview", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "review_feedback_preview_route_test",
  });
  db = testDatabase.db;
  ({ POST } = await import(
    "@/app/api/runs/[runId]/hitl/[hitlRequestId]/review-feedback-preview/route"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  await Promise.all(
    pathsToRemove
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("POST review-feedback-preview", () => {
  it("returns the current complete source and packet without claiming the gate", async () => {
    const { runId, hitlRequestId, threadId } = await seedReviewGate();

    const response = await POST(
      previewRequest({
        response: {
          decision: "rework",
          comments: "Exercise empty input.",
          workspacePolicy: "keep",
        },
      }),
      { params: Promise.resolve({ runId, hitlRequestId }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      reviewSource: {
        scope: "review",
        baseCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
        fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      feedback: {
        fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        target: { nodeId: "fix", commentsVar: "review_comments" },
        openThreadIds: [threadId],
        resolvedThreadCount: 0,
        payload: expect.stringContaining("Exercise empty input."),
      },
    });

    const rows = await db
      .select({
        response: schema.hitlRequests.response,
        respondedAt: schema.hitlRequests.respondedAt,
      })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, hitlRequestId));

    expect(rows[0]).toEqual({ response: null, respondedAt: null });
  });

  it("rejects a pending gate-chat turn without claiming or mutating it", async () => {
    const { runId, hitlRequestId } = await seedReviewGate();
    const userMessageId = randomUUID();

    await db.insert(schema.gateChatMessages).values({
      id: userMessageId,
      runId,
      hitlRequestId,
      nodeId: "review",
      gateAttempt: 1,
      role: "user",
      authorLabel: "Reviewer",
      body: "Can you explain this change?",
      acpSessionId: "acp-review",
      seq: 1,
    });
    await db.insert(schema.gateChatTurns).values({
      runId,
      hitlRequestId,
      userMessageId,
      state: "pending",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    const response = await POST(
      previewRequest({
        response: {
          decision: "rework",
          comments: "Exercise empty input.",
          workspacePolicy: "keep",
        },
      }),
      { params: Promise.resolve({ runId, hitlRequestId }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "PRECONDITION",
    });

    const [hitl, turn] = await Promise.all([
      db
        .select({
          response: schema.hitlRequests.response,
          respondedAt: schema.hitlRequests.respondedAt,
        })
        .from(schema.hitlRequests)
        .where(eq(schema.hitlRequests.id, hitlRequestId)),
      db
        .select({
          state: schema.gateChatTurns.state,
          completedAt: schema.gateChatTurns.completedAt,
          errorCode: schema.gateChatTurns.errorCode,
        })
        .from(schema.gateChatTurns)
        .where(eq(schema.gateChatTurns.hitlRequestId, hitlRequestId)),
    ]);

    expect(hitl[0]).toEqual({ response: null, respondedAt: null });
    expect(turn[0]).toEqual({
      state: "pending",
      completedAt: null,
      errorCode: null,
    });
  });

  it("rejects a body that names server-derived review resources", async () => {
    const { runId, hitlRequestId } = await seedReviewGate();

    const response = await POST(
      previewRequest({
        response: { decision: "rework", workspacePolicy: "keep" },
        target: "fix",
      }),
      { params: Promise.resolve({ runId, hitlRequestId }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "CONFIG" });
  });
});
