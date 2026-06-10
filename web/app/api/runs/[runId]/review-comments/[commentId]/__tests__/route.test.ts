import type { ReviewComment } from "@/lib/review-comments/service";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { runs as runsTable } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { editBody, remove, setStatus } from "@/lib/review-comments/service";

// Task 10 (TDD, ADR-071): PATCH + DELETE
// /api/runs/[runId]/review-comments/[commentId].
//   - PATCH: answerHitl (member). Strict shape-discriminated union — exactly
//     one of {body} (author-only edit → service editBody) or
//     {status: open|resolved} (root-only → service setStatus). Mixed / empty /
//     unknown keys → 400 CONFIG, parsed BEFORE auth (sibling convention).
//   - DELETE: answerHitl (member), author-only at the service (remove); a root
//     delete cascades replies at the DB. Success = 204 with an EMPTY body.
//   - commentId is a url-param: the SERVICE loads the row and compares
//     row.run_id === runId server-state — null return = bare 404 at the route.
//     The ROUTE still loads the run row first to derive projectId for authz.
//   - Neither method imports the diff pipeline, so unlike the sibling
//     collection suite there is no worktree mock here.
// The service layer is mocked (gate guard / author rules / root-only resolve
// have their own unit + testcontainers coverage); this suite pins the ROUTE
// contract: authz, zod, error mapping, DTO projection.

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
};

const dbState: { tables: Tables } = {
  tables: { runs: [] },
};

function tableOf(t: unknown): keyof Tables {
  if (t === runsTable) return "runs";
  throw new Error("unknown table");
}

const selectChain = () => ({
  from: (table: unknown) => ({
    where: async () => dbState.tables[tableOf(table)],
  }),
});

const fakeDb = {
  select: selectChain,
};

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

vi.mock("@/lib/review-comments/service", () => ({
  editBody: vi.fn(),
  setStatus: vi.fn(),
  remove: vi.fn(),
}));

const RUN_ID = "run-rc";
const COMMENT_ID = "11111111-1111-4111-8111-111111111111";

// The full OpenAPI ReviewComment wire DTO — exactly these 18 keys, no more.
const COMMENT_DTO_KEYS = [
  "authorLabel",
  "authorUserId",
  "body",
  "createdAt",
  "filePath",
  "gateAttempt",
  "hitlRequestId",
  "id",
  "line",
  "lineContent",
  "nodeId",
  "parentId",
  "resolvedAt",
  "resolvedByUserId",
  "runId",
  "side",
  "status",
  "updatedAt",
];

function commentRow(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: COMMENT_ID,
    runId: RUN_ID,
    hitlRequestId: "hitl-1",
    nodeId: "review",
    gateAttempt: 1,
    parentId: null,
    authorUserId: "user-1",
    authorLabel: "Reviewer One",
    filePath: "src/calc.ts",
    side: "new",
    line: 11,
    lineContent: "const added = 2;",
    body: "tighten this",
    status: "open",
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: new Date("2026-06-10T10:00:00.000Z"),
    updatedAt: null,
    ...over,
  };
}

function seedRun(overrides: Partial<{ status: string }> = {}): string {
  dbState.tables.runs.push({
    id: RUN_ID,
    runKind: "flow",
    projectId: "project-1",
    status: overrides.status ?? "NeedsInput",
  });

  return RUN_ID;
}

async function invokePatch(runId: string, commentId: string, body: unknown) {
  const { PATCH } = await import("../route");
  const req = new NextRequest(
    new Request(
      `http://localhost/api/runs/${runId}/review-comments/${commentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );

  return PATCH(req, { params: Promise.resolve({ runId, commentId }) });
}

async function invokeDelete(runId: string, commentId: string) {
  const { DELETE } = await import("../route");
  const req = new NextRequest(
    new Request(
      `http://localhost/api/runs/${runId}/review-comments/${commentId}`,
      { method: "DELETE" },
    ),
  );

  return DELETE(req, { params: Promise.resolve({ runId, commentId }) });
}

const sessionUser = {
  id: "user-1",
  role: "member",
  accountStatus: "active",
  mustChangePassword: false,
  email: "reviewer@example.com",
  name: "Reviewer One",
} as Awaited<ReturnType<typeof requireActiveSession>>;

beforeEach(() => {
  dbState.tables = { runs: [] };
  vi.mocked(requireActiveSession).mockReset();
  vi.mocked(requireActiveSession).mockResolvedValue(sessionUser);
  vi.mocked(requireProjectAction).mockReset();
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: sessionUser,
    role: "member",
  } as Awaited<ReturnType<typeof requireProjectAction>>);
  vi.mocked(editBody).mockReset();
  vi.mocked(editBody).mockResolvedValue(
    commentRow({
      body: "tightened",
      updatedAt: new Date("2026-06-10T11:00:00.000Z"),
    }),
  );
  vi.mocked(setStatus).mockReset();
  vi.mocked(setStatus).mockResolvedValue(
    commentRow({
      status: "resolved",
      resolvedByUserId: "user-1",
      resolvedAt: new Date("2026-06-10T11:05:00.000Z"),
      updatedAt: new Date("2026-06-10T11:05:00.000Z"),
    }),
  );
  vi.mocked(remove).mockReset();
  vi.mocked(remove).mockResolvedValue(commentRow());
});

describe("PATCH /api/runs/[runId]/review-comments/[commentId] — authz + existence", () => {
  it("returns 401 when unauthenticated, before touching the service", async () => {
    seedRun();
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "Sign in required"),
    );

    const res = await invokePatch(RUN_ID, COMMENT_ID, { body: "tightened" });

    expect(res.status).toBe(401);
    expect(editBody).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("returns bare 404 for an unknown run, before project authz", async () => {
    const res = await invokePatch("does-not-exist", COMMENT_ID, {
      body: "tightened",
    });
    const body = (await res.json()) as Row;

    expect(res.status).toBe(404);
    expect(body).toEqual({ message: "not found" });
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(editBody).not.toHaveBeenCalled();
  });

  it("gates with answerHitl (member) on the run's server-derived projectId", async () => {
    seedRun();

    const res = await invokePatch(RUN_ID, COMMENT_ID, { body: "tightened" });

    expect(res.status).toBe(200);
    expect(requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "answerHitl",
    );
  });

  it("returns 403 for a viewer (answerHitl denied) before any service call", async () => {
    seedRun();
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "Requires project role member"),
    );

    const res = await invokePatch(RUN_ID, COMMENT_ID, { body: "tightened" });

    expect(res.status).toBe(403);
    expect(editBody).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/runs/[runId]/review-comments/[commentId] — {body} edit", () => {
  it("200: calls editBody with the session actor and returns the EXACT DTO", async () => {
    seedRun();

    const res = await invokePatch(RUN_ID, COMMENT_ID, { body: "tightened" });
    const body = (await res.json()) as { comment: Row };

    expect(res.status).toBe(200);
    expect(editBody).toHaveBeenCalledTimes(1);
    expect(setStatus).not.toHaveBeenCalled();

    const [, actor, calledRunId, calledCommentId, calledBody] =
      vi.mocked(editBody).mock.calls[0];

    // Author identity comes from the session, never the body.
    expect(actor).toEqual({ userId: "user-1", label: "Reviewer One" });
    expect(calledRunId).toBe(RUN_ID);
    expect(calledCommentId).toBe(COMMENT_ID);
    expect(calledBody).toBe("tightened");
    expect(body).toEqual({
      comment: {
        id: COMMENT_ID,
        runId: RUN_ID,
        hitlRequestId: "hitl-1",
        nodeId: "review",
        gateAttempt: 1,
        parentId: null,
        authorUserId: "user-1",
        authorLabel: "Reviewer One",
        filePath: "src/calc.ts",
        side: "new",
        line: 11,
        lineContent: "const added = 2;",
        body: "tightened",
        status: "open",
        resolvedByUserId: null,
        resolvedAt: null,
        createdAt: "2026-06-10T10:00:00.000Z",
        updatedAt: "2026-06-10T11:00:00.000Z",
      },
    });
    expect(Object.keys(body.comment).sort()).toEqual(COMMENT_DTO_KEYS);
  });

  it("returns bare 404 when the service resolves null (unknown or cross-run commentId)", async () => {
    seedRun();
    vi.mocked(editBody).mockResolvedValueOnce(null);

    const res = await invokePatch(RUN_ID, COMMENT_ID, { body: "tightened" });
    const body = (await res.json()) as Row;

    expect(res.status).toBe(404);
    expect(body).toEqual({ message: "not found" });
  });

  it("maps the service's author-only UNAUTHORIZED to 403", async () => {
    seedRun();
    vi.mocked(editBody).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "only the comment author may edit it"),
    );

    const res = await invokePatch(RUN_ID, COMMENT_ID, { body: "tightened" });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("maps the service's closed-gate PRECONDITION to 409", async () => {
    seedRun({ status: "Review" });
    vi.mocked(editBody).mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "run has no open review gate"),
    );

    const res = await invokePatch(RUN_ID, COMMENT_ID, { body: "tightened" });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
  });
});

describe("PATCH /api/runs/[runId]/review-comments/[commentId] — {status} resolve / re-open", () => {
  it("200: resolves a root via setStatus and returns the resolution fields", async () => {
    seedRun();

    const res = await invokePatch(RUN_ID, COMMENT_ID, { status: "resolved" });
    const body = (await res.json()) as { comment: Row };

    expect(res.status).toBe(200);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(editBody).not.toHaveBeenCalled();

    const [, actor, calledRunId, calledCommentId, calledStatus] =
      vi.mocked(setStatus).mock.calls[0];

    expect(actor).toEqual({ userId: "user-1", label: "Reviewer One" });
    expect(calledRunId).toBe(RUN_ID);
    expect(calledCommentId).toBe(COMMENT_ID);
    expect(calledStatus).toBe("resolved");
    expect(body.comment.status).toBe("resolved");
    expect(body.comment.resolvedByUserId).toBe("user-1");
    expect(body.comment.resolvedAt).toBe("2026-06-10T11:05:00.000Z");
    expect(Object.keys(body.comment).sort()).toEqual(COMMENT_DTO_KEYS);
  });

  it("200: re-opens a root (status: open) with the resolution fields cleared", async () => {
    seedRun();
    vi.mocked(setStatus).mockResolvedValueOnce(
      commentRow({
        status: "open",
        resolvedByUserId: null,
        resolvedAt: null,
        updatedAt: new Date("2026-06-10T11:10:00.000Z"),
      }),
    );

    const res = await invokePatch(RUN_ID, COMMENT_ID, { status: "open" });
    const body = (await res.json()) as { comment: Row };

    expect(res.status).toBe(200);

    const [, , , , calledStatus] = vi.mocked(setStatus).mock.calls[0];

    expect(calledStatus).toBe("open");
    expect(body.comment.status).toBe("open");
    expect(body.comment.resolvedByUserId).toBeNull();
    expect(body.comment.resolvedAt).toBeNull();
  });

  it("maps the service's root-only CONFLICT (resolve targeting a reply) to 409", async () => {
    seedRun();
    vi.mocked(setStatus).mockRejectedValueOnce(
      new MaisterError(
        "CONFLICT",
        "status is root-only: replies carry no own status",
      ),
    );

    const res = await invokePatch(RUN_ID, COMMENT_ID, { status: "resolved" });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
  });

  it("returns bare 404 when setStatus resolves null (unknown or cross-run commentId)", async () => {
    seedRun();
    vi.mocked(setStatus).mockResolvedValueOnce(null);

    const res = await invokePatch(RUN_ID, COMMENT_ID, { status: "resolved" });
    const body = (await res.json()) as Row;

    expect(res.status).toBe(404);
    expect(body).toEqual({ message: "not found" });
  });
});

describe("PATCH /api/runs/[runId]/review-comments/[commentId] — zod body validation (400 CONFIG)", () => {
  async function expectRejected(body: unknown) {
    seedRun();

    const res = await invokePatch(RUN_ID, COMMENT_ID, body);
    const parsed = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(parsed.code).toBe("CONFIG");
    // Parse-before-auth ordering (sibling convention): an invalid body never
    // reaches the session, the run row, or the service.
    expect(requireActiveSession).not.toHaveBeenCalled();
    expect(editBody).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  }

  it("rejects an empty object (neither {body} nor {status})", async () => {
    await expectRejected({});
  });

  it("rejects a mixed {body, status} payload", async () => {
    await expectRejected({ body: "tightened", status: "resolved" });
  });

  it("rejects unknown keys", async () => {
    await expectRejected({ body: "tightened", extra: true });
  });

  it("rejects an empty body string", async () => {
    await expectRejected({ body: "" });
  });

  it("rejects a body over 10 000 chars", async () => {
    await expectRejected({ body: "x".repeat(10_001) });
  });

  it("rejects an unknown status value", async () => {
    await expectRejected({ status: "closed" });
  });

  it("rejects malformed JSON with 400 CONFIG", async () => {
    seedRun();
    const { PATCH } = await import("../route");
    const req = new NextRequest(
      new Request(
        `http://localhost/api/runs/${RUN_ID}/review-comments/${COMMENT_ID}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{not valid",
        },
      ),
    );

    const res = await PATCH(req, {
      params: Promise.resolve({ runId: RUN_ID, commentId: COMMENT_ID }),
    });
    const parsed = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(parsed.code).toBe("CONFIG");
    expect(editBody).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/runs/[runId]/review-comments/[commentId]", () => {
  it("204: calls remove with the session actor and returns an EMPTY body", async () => {
    seedRun();

    const res = await invokeDelete(RUN_ID, COMMENT_ID);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "answerHitl",
    );

    const [, actor, calledRunId, calledCommentId] =
      vi.mocked(remove).mock.calls[0];

    expect(actor).toEqual({ userId: "user-1", label: "Reviewer One" });
    expect(calledRunId).toBe(RUN_ID);
    expect(calledCommentId).toBe(COMMENT_ID);
  });

  it("returns 401 when unauthenticated", async () => {
    seedRun();
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "Sign in required"),
    );

    const res = await invokeDelete(RUN_ID, COMMENT_ID);

    expect(res.status).toBe(401);
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer (answerHitl denied) before any service call", async () => {
    seedRun();
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "Requires project role member"),
    );

    const res = await invokeDelete(RUN_ID, COMMENT_ID);

    expect(res.status).toBe(403);
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns bare 404 for an unknown run, before project authz", async () => {
    const res = await invokeDelete("does-not-exist", COMMENT_ID);
    const body = (await res.json()) as Row;

    expect(res.status).toBe(404);
    expect(body).toEqual({ message: "not found" });
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns bare 404 when remove resolves null (unknown or cross-run commentId)", async () => {
    seedRun();
    vi.mocked(remove).mockResolvedValueOnce(null);

    const res = await invokeDelete(RUN_ID, COMMENT_ID);
    const body = (await res.json()) as Row;

    expect(res.status).toBe(404);
    expect(body).toEqual({ message: "not found" });
  });

  it("maps the service's author-only UNAUTHORIZED to 403", async () => {
    seedRun();
    vi.mocked(remove).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "only the comment author may delete it"),
    );

    const res = await invokeDelete(RUN_ID, COMMENT_ID);
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("maps the service's closed-gate PRECONDITION to 409", async () => {
    seedRun({ status: "Review" });
    vi.mocked(remove).mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "run has no open review gate"),
    );

    const res = await invokeDelete(RUN_ID, COMMENT_ID);
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
  });
});
