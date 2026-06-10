import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  createReply,
  createRoot,
  editBody,
  listThreads,
  remove,
  setStatus,
  type ReviewCommentActor,
} from "@/lib/review-comments/service";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// service.ts consumes PENDING_HITL_RUN_STATUS from @/lib/services/hitl, whose
// module graph pulls authz (NextAuth), supervisor-client, and the flow runner.
// Mock those boundaries exactly like hitl.integration.test.ts does.
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/supervisor-client", () => ({
  deliverPermission: vi.fn(async () => ({ ok: true })),
  cancelPermission: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/flows/runner", () => ({
  runFlow: vi.fn(async () => {}),
}));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("review_comments_service_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedUser(
  label: string,
): Promise<{ userId: string; actor: ReviewCommentActor }> {
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@test.local`,
    name: label,
  });

  return { userId, actor: { userId, label } };
}

async function seedProject(): Promise<string> {
  const projectId = randomUUID();
  const slug = `p-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  return projectId;
}

async function seedRun(
  status: (typeof schema.runs.$inferSelect)["status"] = "NeedsInput",
): Promise<string> {
  const projectId = await seedProject();
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    status,
    flowVersion: "v1.0.0",
  });

  return runId;
}

async function seedGate(
  runId: string,
  opts: {
    nodeId?: string;
    kind?: "permission" | "form" | "human";
    schema?: unknown;
    respondedAt?: Date;
  } = {},
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.hitlRequests).values({
    id,
    runId,
    stepId: opts.nodeId ?? "review",
    kind: opts.kind ?? "human",
    prompt: "Review the change",
    schema: opts.schema === undefined ? { review: true } : opts.schema,
    respondedAt: opts.respondedAt ?? null,
  });

  return id;
}

async function seedOpenGate(
  status: "NeedsInput" | "NeedsInputIdle" = "NeedsInput",
  gateSchema?: unknown,
): Promise<{ runId: string; hitlRequestId: string }> {
  const runId = await seedRun(status);
  const hitlRequestId = await seedGate(runId, { schema: gateSchema });

  return { runId, hitlRequestId };
}

async function seedNodeAttempts(
  runId: string,
  nodeId: string,
  n: number,
): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId,
      nodeType: "human",
      attempt: i,
      status: i === n ? "NeedsInput" : "Reworked",
    });
  }
}

function anchorInput(
  over: Partial<{
    filePath: string;
    side: "old" | "new";
    line: number;
    lineContent: string;
    body: string;
  }> = {},
): {
  filePath: string;
  side: "old" | "new";
  line: number;
  lineContent: string;
  body: string;
} {
  return {
    filePath: "src/app.ts",
    side: "new",
    line: 7,
    lineContent: "const x = 1;",
    body: "This looks wrong",
    ...over,
  };
}

async function commentRows(runId: string) {
  return db
    .select()
    .from(schema.reviewComments)
    .where(eq(schema.reviewComments.runId, runId));
}

describe("open-review-gate guard", () => {
  it("accepts writes when run is NeedsInput with a pending review gate", async () => {
    const { runId, hitlRequestId } = await seedOpenGate("NeedsInput");
    const { actor } = await seedUser("Alice");

    const created = await createRoot(db, actor, runId, anchorInput());

    expect(created.runId).toBe(runId);
    expect(created.hitlRequestId).toBe(hitlRequestId);
  });

  it("accepts writes when run is NeedsInputIdle", async () => {
    const { runId, hitlRequestId } = await seedOpenGate("NeedsInputIdle");
    const { actor } = await seedUser("Alice");

    const created = await createRoot(db, actor, runId, anchorInput());

    expect(created.hitlRequestId).toBe(hitlRequestId);
  });

  it.each(["Running", "Review", "Done"] as const)(
    "rejects PRECONDITION when run status is %s even with a pending gate row",
    async (status) => {
      const runId = await seedRun(status);

      await seedGate(runId);
      const { actor } = await seedUser("Alice");

      await expect(
        createRoot(db, actor, runId, anchorInput()),
      ).rejects.toMatchObject({ name: "MaisterError", code: "PRECONDITION" });
    },
  );

  it("rejects PRECONDITION when the review-gate hitl row is already responded", async () => {
    const runId = await seedRun("NeedsInput");

    await seedGate(runId, { respondedAt: new Date() });
    const { actor } = await seedUser("Alice");

    await expect(
      createRoot(db, actor, runId, anchorInput()),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("rejects PRECONDITION when the pending hitl row is not kind=human", async () => {
    const runId = await seedRun("NeedsInput");

    await seedGate(runId, { kind: "form", schema: { review: true } });
    const { actor } = await seedUser("Alice");

    await expect(
      createRoot(db, actor, runId, anchorInput()),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("rejects PRECONDITION when schema.review is not exactly true", async () => {
    const runId = await seedRun("NeedsInput");

    await seedGate(runId, { schema: { fields: [] } });
    const { actor } = await seedUser("Alice");

    await expect(
      createRoot(db, actor, runId, anchorInput()),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("rejects PRECONDITION when the run does not exist", async () => {
    const { actor } = await seedUser("Alice");

    await expect(
      createRoot(db, actor, randomUUID(), anchorInput()),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("guards ALL writes: edit/setStatus/remove on a closed gate throw PRECONDITION before author checks", async () => {
    const { runId } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const root = await createRoot(db, actor, runId, anchorInput());

    // Close the gate: respond the hitl row + move the run out of NeedsInput.
    await db
      .update(schema.hitlRequests)
      .set({ respondedAt: new Date() })
      .where(eq(schema.hitlRequests.runId, runId));
    await db
      .update(schema.runs)
      .set({ status: "Review" })
      .where(eq(schema.runs.id, runId));

    await expect(
      editBody(db, actor, runId, root.id, "new body"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    await expect(
      setStatus(db, actor, runId, root.id, "resolved"),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    await expect(remove(db, actor, runId, root.id)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("rejects createReply with PRECONDITION when the gate is closed (Running run)", async () => {
    const { runId } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const root = await createRoot(db, actor, runId, anchorInput());

    await db
      .update(schema.runs)
      .set({ status: "Running" })
      .where(eq(schema.runs.id, runId));

    await expect(
      createReply(db, actor, runId, { parentId: root.id, body: "Late" }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("never mutates runs.status across any mutation kind", async () => {
    const { runId } = await seedOpenGate("NeedsInput");
    const { actor } = await seedUser("Alice");

    const root = await createRoot(db, actor, runId, anchorInput());
    const reply = await createReply(db, actor, runId, {
      parentId: root.id,
      body: "Reply",
    });

    await editBody(db, actor, runId, root.id, "Edited");
    await setStatus(db, actor, runId, root.id, "resolved");
    await remove(db, actor, runId, reply.id);

    const runRows = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));

    expect(runRows[0]?.status).toBe("NeedsInput");
  });
});

describe("createRoot", () => {
  it("stamps author, node id, gate attempt, and the pending hitl FK", async () => {
    const { runId, hitlRequestId } = await seedOpenGate("NeedsInput", {
      review: true,
      gateAttempt: 1,
    });
    const { userId, actor } = await seedUser("Alice");

    const created = await createRoot(
      db,
      actor,
      runId,
      anchorInput({ filePath: "lib/x.ts", side: "old", line: 3 }),
    );

    expect(created.id).toBeTruthy();
    expect(created.runId).toBe(runId);
    expect(created.hitlRequestId).toBe(hitlRequestId);
    expect(created.nodeId).toBe("review");
    expect(created.gateAttempt).toBe(1);
    expect(created.parentId).toBeNull();
    expect(created.authorUserId).toBe(userId);
    expect(created.authorLabel).toBe("Alice");
    expect(created.filePath).toBe("lib/x.ts");
    expect(created.side).toBe("old");
    expect(created.line).toBe(3);
    expect(created.lineContent).toBe("const x = 1;");
    expect(created.body).toBe("This looks wrong");
    expect(created.status).toBe("open");
    expect(created.resolvedByUserId).toBeNull();
    expect(created.resolvedAt).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it("reads gate_attempt from schema.gateAttempt when present", async () => {
    const { runId } = await seedOpenGate("NeedsInput", {
      review: true,
      gateAttempt: 3,
    });
    const { actor } = await seedUser("Alice");

    const created = await createRoot(db, actor, runId, anchorInput());

    expect(created.gateAttempt).toBe(3);
  });

  it("derives gate_attempt from the node_attempts count when schema lacks it", async () => {
    const { runId } = await seedOpenGate("NeedsInput", { review: true });

    await seedNodeAttempts(runId, "review", 2);
    const { actor } = await seedUser("Alice");

    const created = await createRoot(db, actor, runId, anchorInput());

    expect(created.gateAttempt).toBe(2);
  });

  it("floors derived gate_attempt at 1 when no attempts ledger exists", async () => {
    const { runId } = await seedOpenGate("NeedsInput", { review: true });
    const { actor } = await seedUser("Alice");

    const created = await createRoot(db, actor, runId, anchorInput());

    expect(created.gateAttempt).toBe(1);
  });
});

describe("createReply", () => {
  it("creates an anchor-free reply stamped from the CURRENT pending gate", async () => {
    const { runId } = await seedOpenGate("NeedsInput", {
      review: true,
      gateAttempt: 1,
    });
    const { actor: alice } = await seedUser("Alice");
    const root = await createRoot(db, alice, runId, anchorInput());

    // Close visit 1, open visit 2 — the reply must FK the visit-2 row.
    await db
      .update(schema.hitlRequests)
      .set({ respondedAt: new Date() })
      .where(eq(schema.hitlRequests.id, root.hitlRequestId));
    const gate2 = await seedGate(runId, {
      schema: { review: true, gateAttempt: 2 },
    });

    const { userId: bobId, actor: bob } = await seedUser("Bob");
    const reply = await createReply(db, bob, runId, {
      parentId: root.id,
      body: "Agreed",
    });

    expect(reply.parentId).toBe(root.id);
    expect(reply.runId).toBe(runId);
    expect(reply.hitlRequestId).toBe(gate2);
    expect(reply.nodeId).toBe("review");
    expect(reply.gateAttempt).toBe(2);
    expect(reply.authorUserId).toBe(bobId);
    expect(reply.authorLabel).toBe("Bob");
    expect(reply.filePath).toBeNull();
    expect(reply.side).toBeNull();
    expect(reply.line).toBeNull();
    expect(reply.lineContent).toBeNull();
  });

  it("allows replying to a RESOLVED root without re-opening it", async () => {
    const { runId } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const root = await createRoot(db, actor, runId, anchorInput());

    await setStatus(db, actor, runId, root.id, "resolved");
    const reply = await createReply(db, actor, runId, {
      parentId: root.id,
      body: "Late note",
    });

    expect(reply.parentId).toBe(root.id);

    const rows = await commentRows(runId);
    const rootRow = rows.find((r) => r.id === root.id);

    expect(rootRow?.status).toBe("resolved");
  });

  it("rejects reply-to-reply with CONFLICT", async () => {
    const { runId } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const root = await createRoot(db, actor, runId, anchorInput());
    const reply = await createReply(db, actor, runId, {
      parentId: root.id,
      body: "First reply",
    });

    await expect(
      createReply(db, actor, runId, { parentId: reply.id, body: "Nested" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a parent from another run with CONFLICT", async () => {
    const { runId: runA } = await seedOpenGate();
    const { runId: runB } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const rootA = await createRoot(db, actor, runA, anchorInput());

    await expect(
      createReply(db, actor, runB, { parentId: rootA.id, body: "Cross" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a nonexistent parentId with CONFLICT", async () => {
    const { runId } = await seedOpenGate();
    const { actor } = await seedUser("Alice");

    await expect(
      createReply(db, actor, runId, { parentId: randomUUID(), body: "?" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("editBody", () => {
  it("lets the author edit a root and stamps updated_at", async () => {
    const { runId } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const root = await createRoot(db, actor, runId, anchorInput());

    expect(root.updatedAt).toBeNull();

    const updated = await editBody(db, actor, runId, root.id, "Edited body");

    expect(updated?.body).toBe("Edited body");
    expect(updated?.updatedAt).toBeInstanceOf(Date);
  });

  it("lets the author edit a reply", async () => {
    const { runId } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const root = await createRoot(db, actor, runId, anchorInput());
    const reply = await createReply(db, actor, runId, {
      parentId: root.id,
      body: "Reply",
    });

    const updated = await editBody(db, actor, runId, reply.id, "Reply v2");

    expect(updated?.body).toBe("Reply v2");
  });

  it("rejects a non-author with UNAUTHORIZED", async () => {
    const { runId } = await seedOpenGate();
    const { actor: alice } = await seedUser("Alice");
    const { actor: bob } = await seedUser("Bob");
    const root = await createRoot(db, alice, runId, anchorInput());

    await expect(
      editBody(db, bob, runId, root.id, "Hijack"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("a null-author comment (deleted account) is permanently un-editable", async () => {
    const { runId } = await seedOpenGate();
    const { userId, actor } = await seedUser("Ghost");
    const root = await createRoot(db, actor, runId, anchorInput());

    // Deleting the user SET NULLs author_user_id on the comment.
    await db.delete(schema.users).where(eq(schema.users.id, userId));

    await expect(
      editBody(db, actor, runId, root.id, "Still me"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns null (not-found semantics) for a commentId of another run", async () => {
    const { runId: runA } = await seedOpenGate();
    const { runId: runB } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const rootA = await createRoot(db, actor, runA, anchorInput());

    const result = await editBody(db, actor, runB, rootA.id, "Cross-run");

    expect(result).toBeNull();
  });

  it("returns null for a nonexistent commentId", async () => {
    const { runId } = await seedOpenGate();
    const { actor } = await seedUser("Alice");

    const result = await editBody(db, actor, runId, randomUUID(), "Nothing");

    expect(result).toBeNull();
  });
});

describe("setStatus", () => {
  it("resolve stamps resolved_by/resolved_at/updated_at and is open to non-authors", async () => {
    const { runId } = await seedOpenGate();
    const { actor: alice } = await seedUser("Alice");
    const { userId: bobId, actor: bob } = await seedUser("Bob");
    const root = await createRoot(db, alice, runId, anchorInput());

    const resolved = await setStatus(db, bob, runId, root.id, "resolved");

    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedByUserId).toBe(bobId);
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);
    expect(resolved?.updatedAt).toBeInstanceOf(Date);
  });

  it("re-open clears resolved_by/resolved_at and stamps updated_at", async () => {
    const { runId } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const root = await createRoot(db, actor, runId, anchorInput());

    await setStatus(db, actor, runId, root.id, "resolved");
    const reopened = await setStatus(db, actor, runId, root.id, "open");

    expect(reopened?.status).toBe("open");
    expect(reopened?.resolvedByUserId).toBeNull();
    expect(reopened?.resolvedAt).toBeNull();
    expect(reopened?.updatedAt).toBeInstanceOf(Date);
  });

  it("same-status set is a no-op success that keeps the first resolver", async () => {
    const { runId } = await seedOpenGate();
    const { actor: alice } = await seedUser("Alice");
    const { userId: bobId, actor: bob } = await seedUser("Bob");
    const root = await createRoot(db, alice, runId, anchorInput());

    const first = await setStatus(db, bob, runId, root.id, "resolved");
    const second = await setStatus(db, alice, runId, root.id, "resolved");

    expect(second?.status).toBe("resolved");
    expect(second?.resolvedByUserId).toBe(bobId);
    expect(second?.resolvedAt?.getTime()).toBe(first?.resolvedAt?.getTime());
  });

  it("rejects a reply target with CONFLICT (status is root-only)", async () => {
    const { runId } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const root = await createRoot(db, actor, runId, anchorInput());
    const reply = await createReply(db, actor, runId, {
      parentId: root.id,
      body: "Reply",
    });

    await expect(
      setStatus(db, actor, runId, reply.id, "resolved"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("returns null for a commentId of another run", async () => {
    const { runId: runA } = await seedOpenGate();
    const { runId: runB } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const rootA = await createRoot(db, actor, runA, anchorInput());

    const result = await setStatus(db, actor, runB, rootA.id, "resolved");

    expect(result).toBeNull();
  });
});

describe("remove", () => {
  it("author root delete cascades its replies", async () => {
    const { runId } = await seedOpenGate();
    const { actor: alice } = await seedUser("Alice");
    const { actor: bob } = await seedUser("Bob");
    const root = await createRoot(db, alice, runId, anchorInput());

    await createReply(db, bob, runId, { parentId: root.id, body: "r1" });
    await createReply(db, alice, runId, { parentId: root.id, body: "r2" });

    const removed = await remove(db, alice, runId, root.id);

    expect(removed?.id).toBe(root.id);
    expect(await commentRows(runId)).toHaveLength(0);
  });

  it("reply delete removes only the reply", async () => {
    const { runId } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const root = await createRoot(db, actor, runId, anchorInput());
    const reply1 = await createReply(db, actor, runId, {
      parentId: root.id,
      body: "r1",
    });
    const reply2 = await createReply(db, actor, runId, {
      parentId: root.id,
      body: "r2",
    });

    const removed = await remove(db, actor, runId, reply1.id);

    expect(removed?.id).toBe(reply1.id);

    const rest = (await commentRows(runId)).map((r) => r.id).sort();

    expect(rest).toEqual([root.id, reply2.id].sort());
  });

  it("rejects a non-author with UNAUTHORIZED", async () => {
    const { runId } = await seedOpenGate();
    const { actor: alice } = await seedUser("Alice");
    const { actor: bob } = await seedUser("Bob");
    const root = await createRoot(db, alice, runId, anchorInput());

    await expect(remove(db, bob, runId, root.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("returns null for a commentId of another run", async () => {
    const { runId: runA } = await seedOpenGate();
    const { runId: runB } = await seedOpenGate();
    const { actor } = await seedUser("Alice");
    const rootA = await createRoot(db, actor, runA, anchorInput());

    const result = await remove(db, actor, runB, rootA.id);

    expect(result).toBeNull();

    expect(await commentRows(runA)).toHaveLength(1);
  });
});

describe("listThreads", () => {
  async function seedComment(
    runId: string,
    hitlRequestId: string,
    over: Partial<typeof schema.reviewComments.$inferInsert> = {},
  ): Promise<string> {
    const id = randomUUID();
    const isReply = over.parentId !== undefined && over.parentId !== null;

    await db.insert(schema.reviewComments).values({
      id,
      runId,
      hitlRequestId,
      nodeId: "review",
      gateAttempt: 1,
      authorLabel: "Seeder",
      body: "seeded",
      ...(isReply
        ? {}
        : {
            filePath: "src/app.ts",
            side: "new" as const,
            line: 1,
            lineContent: "x",
          }),
      ...over,
    });

    return id;
  }

  it("orders roots by (file_path, line, side old<new, created_at, id) with replies by (created_at, id)", async () => {
    const runId = await seedRun("Done");
    const gateId = await seedGate(runId, { respondedAt: new Date() });
    const t = (ms: number) => new Date(2026, 5, 10, 12, 0, 0, ms);

    // Seed shuffled on purpose.
    const bNew1 = await seedComment(runId, gateId, {
      filePath: "b.ts",
      line: 1,
      side: "new",
      createdAt: t(0),
    });
    const a3new = await seedComment(runId, gateId, {
      filePath: "a.ts",
      line: 3,
      side: "new",
      createdAt: t(1),
    });
    const a3oldLate = await seedComment(runId, gateId, {
      filePath: "a.ts",
      line: 3,
      side: "old",
      createdAt: t(50),
    });
    const a3oldEarly = await seedComment(runId, gateId, {
      filePath: "a.ts",
      line: 3,
      side: "old",
      createdAt: t(10),
    });
    const a10old = await seedComment(runId, gateId, {
      filePath: "a.ts",
      line: 10,
      side: "old",
      createdAt: t(2),
    });
    const replyLate = await seedComment(runId, gateId, {
      parentId: a3new,
      createdAt: t(99),
    });
    const replyEarly = await seedComment(runId, gateId, {
      parentId: a3new,
      createdAt: t(5),
    });

    const threads = await listThreads(db, runId);

    expect(threads.map((th) => th.root.id)).toEqual([
      a3oldEarly,
      a3oldLate,
      a3new,
      a10old, // numeric line order: 10 sorts AFTER 3, not before
      bNew1,
    ]);

    const a3newThread = threads.find((th) => th.root.id === a3new);

    expect(a3newThread?.replies.map((r) => r.id)).toEqual([
      replyEarly,
      replyLate,
    ]);
  });

  it("includes open AND resolved threads and needs no open gate (terminal run)", async () => {
    const runId = await seedRun("Done");
    const gateId = await seedGate(runId, { respondedAt: new Date() });
    const openRoot = await seedComment(runId, gateId, {
      filePath: "a.ts",
      line: 1,
    });
    const resolvedRoot = await seedComment(runId, gateId, {
      filePath: "a.ts",
      line: 2,
      status: "resolved",
    });

    const threads = await listThreads(db, runId);

    expect(threads.map((th) => th.root.id)).toEqual([openRoot, resolvedRoot]);
    expect(threads.map((th) => th.root.status)).toEqual(["open", "resolved"]);
  });

  it("returns an empty array for a run without comments", async () => {
    const runId = await seedRun("Running");

    expect(await listThreads(db, runId)).toEqual([]);
  });
});
