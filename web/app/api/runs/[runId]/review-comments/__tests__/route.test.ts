import type { ReviewComment } from "@/lib/review-comments/service";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  projects as projectsTable,
  runs as runsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  createReply,
  createRoot,
  listThreads,
} from "@/lib/review-comments/service";
import {
  diffRunWorkspace,
  diffWorkingTree,
  resolveBaseRef,
} from "@/lib/worktree";

// Task 9 (TDD, ADR-072): GET + POST /api/runs/[runId]/review-comments.
//   - GET: readBoard (viewer), NOT status-gated; one listThreads + at most one
//     server-recomputed diff per request; placement computed per root via the
//     REAL anchor lib over the REAL prepareDiff parse (the worktree diff source
//     is mocked, the parse path is not — same rule as anchor.test.ts).
//     Diff unavailable (GC'd worktree / git failure) degrades every placement
//     to "outdated" — never a 500, history stays visible like the diff.
//   - POST: answerHitl (member). Shape-discriminated strict union: root
//     {filePath, side, line, body} | reply {parentId, body}. lineContent is
//     SERVER-extracted from the recomputed diff — a client-sent value is an
//     unknown key → 400. Anchor failures (truncated/file_absent/line_absent)
//     and the service's open-gate guard map to 409 PRECONDITION; reply
//     integrity to 409 CONFLICT. Responses are explicit OpenAPI DTOs
//     (ReviewCommentThreadsResponse / ReviewCommentResponse) — exact keys, no
//     raw-row leak.
// The service layer is mocked (its guard/integrity logic has its own unit +
// testcontainers coverage); this suite pins the ROUTE contract: authz, zod,
// orchestration, error mapping, DTO projection.

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
  workspaces: Row[];
  projects: Row[];
};

const dbState: { tables: Tables } = {
  tables: { runs: [], workspaces: [], projects: [] },
};

function tableOf(t: unknown): keyof Tables {
  if (t === runsTable) return "runs";
  if (t === workspacesTable) return "workspaces";
  if (t === projectsTable) return "projects";
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

vi.mock("@/lib/worktree", () => ({
  diffRunWorkspace: vi.fn(),
  diffWorkingTree: vi.fn(),
  resolveBaseRef: vi.fn(),
}));

vi.mock("@/lib/review-comments/service", () => ({
  listThreads: vi.fn(),
  createRoot: vi.fn(),
  createReply: vi.fn(),
}));

// Real git-diff stdout always ends with a newline; prepareDiff trims the raw
// text, so the fixture must too (mirrors anchor.test.ts).
const withFinalNewline = (lines: string[]): string => `${lines.join("\n")}\n`;

// src/calc.ts hunk line map:
//   ctx "const keep = 1;"    old 10 / new 10
//   del "const removed = 2;" old 11
//   add "const added = 2;"   new 11
//   ctx "const tail = 3;"    old 12 / new 12
const FIXTURE_DIFF = withFinalNewline([
  "diff --git a/src/calc.ts b/src/calc.ts",
  "index 1111111..2222222 100644",
  "--- a/src/calc.ts",
  "+++ b/src/calc.ts",
  "@@ -10,3 +10,3 @@",
  " const keep = 1;",
  "-const removed = 2;",
  "+const added = 2;",
  " const tail = 3;",
]);

const UNTRACKED_DIFF = withFinalNewline([
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1,2 @@",
  "+# Draft",
  "+body",
]);

const RUN_ID = "run-rc";
const PARENT_UUID = "0b6cbb0e-6b9e-4d27-9a44-1f0d6a3e7f10";

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
    id: "11111111-1111-4111-8111-111111111111",
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

function replyRow(
  parentId: string,
  over: Partial<ReviewComment> = {},
): ReviewComment {
  return commentRow({
    id: "22222222-2222-4222-8222-222222222222",
    parentId,
    filePath: null,
    side: null,
    line: null,
    lineContent: null,
    body: "agreed",
    ...over,
  });
}

function seedRun(
  overrides: Partial<{
    status: string;
    baseCommit: string | null;
    removedAt: Date | null;
    workspaceMissing: boolean;
  }> = {},
): string {
  dbState.tables.runs.push({
    id: RUN_ID,
    runKind: "flow",
    projectId: "project-1",
    status: overrides.status ?? "NeedsInput",
  });
  dbState.tables.projects.push({
    id: "project-1",
    mainBranch: "main",
    repoPath: "/repos/demo",
  });
  if (!overrides.workspaceMissing) {
    dbState.tables.workspaces.push({
      id: "workspace-1",
      runId: RUN_ID,
      projectId: "project-1",
      branch: "maister/feature-x",
      worktreePath: "/repos/demo/.maister/wt-1",
      parentRepoPath: "/repos/demo",
      baseCommit:
        overrides.baseCommit === undefined ? "feedbeef" : overrides.baseCommit,
      removedAt: overrides.removedAt ?? null,
    });
  }

  return RUN_ID;
}

function reviewCommentsUrl(runId: string, query = ""): string {
  const suffix = query.length > 0 ? `?${query}` : "";

  return `http://localhost/api/runs/${runId}/review-comments${suffix}`;
}

async function invokeGet(runId: string, query = "") {
  const { GET } = await import("../route");
  const req = new NextRequest(
    new Request(reviewCommentsUrl(runId, query), {
      method: "GET",
    }),
  );

  return GET(req, { params: Promise.resolve({ runId }) });
}

async function invokePost(runId: string, body: unknown, query = "") {
  const { POST } = await import("../route");
  const req = new NextRequest(
    new Request(reviewCommentsUrl(runId, query), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  return POST(req, { params: Promise.resolve({ runId }) });
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
  dbState.tables = { runs: [], workspaces: [], projects: [] };
  vi.mocked(requireActiveSession).mockReset();
  vi.mocked(requireActiveSession).mockResolvedValue(sessionUser);
  vi.mocked(requireProjectAction).mockReset();
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: sessionUser,
    role: "member",
  } as Awaited<ReturnType<typeof requireProjectAction>>);
  vi.mocked(diffRunWorkspace).mockReset();
  vi.mocked(diffRunWorkspace).mockResolvedValue({
    text: FIXTURE_DIFF,
    truncated: false,
  });
  vi.mocked(diffWorkingTree).mockReset();
  vi.mocked(diffWorkingTree).mockResolvedValue({
    text: UNTRACKED_DIFF,
    truncated: false,
    nameStatus: [{ path: "docs/new.md", status: "A" }],
  });
  vi.mocked(resolveBaseRef).mockReset();
  vi.mocked(resolveBaseRef).mockResolvedValue(
    "resolvedbase0000000000000000000000000000",
  );
  vi.mocked(listThreads).mockReset();
  vi.mocked(listThreads).mockResolvedValue([]);
  vi.mocked(createRoot).mockReset();
  vi.mocked(createRoot).mockResolvedValue(commentRow());
  vi.mocked(createReply).mockReset();
  vi.mocked(createReply).mockResolvedValue(replyRow(PARENT_UUID));
});

describe("GET /api/runs/[runId]/review-comments — authz + existence", () => {
  it("returns 401 when unauthenticated, before touching threads", async () => {
    seedRun();
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "Sign in required"),
    );

    const res = await invokeGet(RUN_ID);

    expect(res.status).toBe(401);
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("returns bare 404 for an unknown run, before project authz", async () => {
    const res = await invokeGet("does-not-exist");

    expect(res.status).toBe(404);
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("gates with readBoard (viewer) on the run's server-derived projectId", async () => {
    seedRun();

    const res = await invokeGet(RUN_ID);

    expect(res.status).toBe(200);
    expect(requireProjectAction).toHaveBeenCalledWith("project-1", "readBoard");
  });

  it("returns 403 when the caller is denied readBoard", async () => {
    seedRun();
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeGet(RUN_ID);

    expect(res.status).toBe(403);
    expect(listThreads).not.toHaveBeenCalled();
  });
});

describe("GET /api/runs/[runId]/review-comments — threads + placement", () => {
  it("returns {threads: []} without computing any diff when the run has no comments", async () => {
    seedRun();

    const res = await invokeGet(RUN_ID);
    const body = (await res.json()) as { threads?: unknown[] };

    expect(res.status).toBe(200);
    expect(body).toEqual({ threads: [] });
    expect(diffRunWorkspace).not.toHaveBeenCalled();
  });

  it("returns the EXACT OpenAPI ReviewCommentThreadsResponse shape with inline placement", async () => {
    seedRun();
    const root = commentRow();
    const reply = replyRow(root.id, {
      createdAt: new Date("2026-06-10T10:05:00.000Z"),
    });

    vi.mocked(listThreads).mockResolvedValueOnce([{ root, replies: [reply] }]);

    const res = await invokeGet(RUN_ID);
    const body = (await res.json()) as {
      threads: { root: Row; placement: string; replies: Row[] }[];
    };

    expect(res.status).toBe(200);
    expect(body).toEqual({
      threads: [
        {
          root: {
            id: root.id,
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
            createdAt: "2026-06-10T10:00:00.000Z",
            updatedAt: null,
          },
          placement: "inline",
          replies: [
            {
              id: reply.id,
              runId: RUN_ID,
              hitlRequestId: "hitl-1",
              nodeId: "review",
              gateAttempt: 1,
              parentId: root.id,
              authorUserId: "user-1",
              authorLabel: "Reviewer One",
              filePath: null,
              side: null,
              line: null,
              lineContent: null,
              body: "agreed",
              status: "open",
              resolvedByUserId: null,
              resolvedAt: null,
              createdAt: "2026-06-10T10:05:00.000Z",
              updatedAt: null,
            },
          ],
        },
      ],
    });
    // Explicit DTO projection: exactly the OpenAPI keys, nothing extra leaks.
    expect(Object.keys(body)).toEqual(["threads"]);
    expect(Object.keys(body.threads[0]).sort()).toEqual([
      "placement",
      "replies",
      "root",
    ]);
    expect(Object.keys(body.threads[0].root).sort()).toEqual(COMMENT_DTO_KEYS);
    expect(Object.keys(body.threads[0].replies[0]).sort()).toEqual(
      COMMENT_DTO_KEYS,
    );
    // One DB read for threads + one diff computation — no N+1.
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(diffRunWorkspace).toHaveBeenCalledTimes(1);
    expect(diffRunWorkspace).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo/.maister/wt-1",
      baseCommit: "feedbeef",
      branch: "maister/feature-x",
    });
  });

  it("computes placement per root against ONE diff: matching anchor inline, stale anchor outdated", async () => {
    seedRun();
    const inlineRoot = commentRow();
    const outdatedRoot = commentRow({
      id: "33333333-3333-4333-8333-333333333333",
      lineContent: "const added = 99;",
    });

    vi.mocked(listThreads).mockResolvedValueOnce([
      { root: inlineRoot, replies: [] },
      { root: outdatedRoot, replies: [] },
    ]);

    const res = await invokeGet(RUN_ID);
    const body = (await res.json()) as { threads: { placement: string }[] };

    expect(res.status).toBe(200);
    expect(body.threads.map((t) => t.placement)).toEqual([
      "inline",
      "outdated",
    ]);
    expect(diffRunWorkspace).toHaveBeenCalledTimes(1);
  });

  it("degrades every placement to outdated when the diff computation throws (GC'd worktree)", async () => {
    seedRun();
    vi.mocked(listThreads).mockResolvedValueOnce([
      { root: commentRow(), replies: [] },
    ]);
    vi.mocked(diffRunWorkspace).mockRejectedValueOnce(
      new Error("fatal: not a git repository"),
    );

    const res = await invokeGet(RUN_ID);
    const body = (await res.json()) as { threads: { placement: string }[] };

    expect(res.status).toBe(200);
    expect(body.threads.map((t) => t.placement)).toEqual(["outdated"]);
  });

  it("degrades to outdated (200, no git call) when the workspace row is removed", async () => {
    seedRun({ removedAt: new Date() });
    vi.mocked(listThreads).mockResolvedValueOnce([
      { root: commentRow(), replies: [] },
    ]);

    const res = await invokeGet(RUN_ID);
    const body = (await res.json()) as { threads: { placement: string }[] };

    expect(res.status).toBe(200);
    expect(body.threads.map((t) => t.placement)).toEqual(["outdated"]);
    expect(diffRunWorkspace).not.toHaveBeenCalled();
  });

  it("falls back to resolveBaseRef when workspace.baseCommit is null (same source as the diff view)", async () => {
    seedRun({ baseCommit: null });
    vi.mocked(listThreads).mockResolvedValueOnce([
      { root: commentRow(), replies: [] },
    ]);

    const res = await invokeGet(RUN_ID);

    expect(res.status).toBe(200);
    expect(resolveBaseRef).toHaveBeenCalledWith({
      worktreePath: "/repos/demo/.maister/wt-1",
      branch: "maister/feature-x",
      mainBranch: "main",
    });
    expect(diffRunWorkspace).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo/.maister/wt-1",
      baseCommit: "resolvedbase0000000000000000000000000000",
      branch: "maister/feature-x",
    });
  });

  it("uses the working-tree diff for uncommitted placement, including untracked files", async () => {
    seedRun();
    vi.mocked(listThreads).mockResolvedValueOnce([
      {
        root: commentRow({
          filePath: "docs/new.md",
          line: 1,
          lineContent: "# Draft",
        }),
        replies: [],
      },
    ]);

    const res = await invokeGet(RUN_ID, "scope=uncommitted");
    const body = (await res.json()) as { threads: { placement: string }[] };

    expect(res.status).toBe(200);
    expect(body.threads.map((t) => t.placement)).toEqual(["inline"]);
    expect(diffWorkingTree).toHaveBeenCalledWith("/repos/demo/.maister/wt-1");
    expect(diffRunWorkspace).not.toHaveBeenCalled();
  });
});

describe("POST /api/runs/[runId]/review-comments — root comments", () => {
  const rootBody = {
    filePath: "src/calc.ts",
    side: "new",
    line: 11,
    body: "tighten this",
  };

  it("201: validates the anchor against ONE recomputed diff and calls the service with the SERVER-extracted lineContent", async () => {
    seedRun();

    const res = await invokePost(RUN_ID, rootBody);
    const body = (await res.json()) as { comment: Row };

    expect(res.status).toBe(201);
    expect(requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "answerHitl",
    );
    expect(diffRunWorkspace).toHaveBeenCalledTimes(1);
    expect(createRoot).toHaveBeenCalledTimes(1);

    const [, actor, calledRunId, input] = vi.mocked(createRoot).mock.calls[0];

    // Author identity comes from the session, never the body.
    expect(actor).toEqual({ userId: "user-1", label: "Reviewer One" });
    expect(calledRunId).toBe(RUN_ID);
    // lineContent is extracted from the server diff — the client never sent it.
    expect(input).toEqual({
      filePath: "src/calc.ts",
      side: "new",
      line: 11,
      lineContent: "const added = 2;",
      body: "tighten this",
    });
    expect(body).toEqual({
      comment: {
        id: "11111111-1111-4111-8111-111111111111",
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
        createdAt: "2026-06-10T10:00:00.000Z",
        updatedAt: null,
      },
    });
    expect(Object.keys(body.comment).sort()).toEqual(COMMENT_DTO_KEYS);
  });

  it("201: validates an uncommitted root anchor against the working-tree diff, including untracked additions", async () => {
    seedRun();

    const res = await invokePost(
      RUN_ID,
      {
        filePath: "docs/new.md",
        side: "new",
        line: 1,
        body: "comment on untracked",
      },
      "scope=uncommitted",
    );

    expect(res.status).toBe(201);
    expect(diffWorkingTree).toHaveBeenCalledWith("/repos/demo/.maister/wt-1");
    expect(diffRunWorkspace).not.toHaveBeenCalled();
    expect(createRoot).toHaveBeenCalledTimes(1);

    const [, , calledRunId, input] = vi.mocked(createRoot).mock.calls[0];

    expect(calledRunId).toBe(RUN_ID);
    expect(input).toEqual({
      filePath: "docs/new.md",
      side: "new",
      line: 1,
      lineContent: "# Draft",
      body: "comment on untracked",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    seedRun();
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "Sign in required"),
    );

    const res = await invokePost(RUN_ID, rootBody);

    expect(res.status).toBe(401);
    expect(createRoot).not.toHaveBeenCalled();
  });

  it("returns bare 404 for an unknown run", async () => {
    const res = await invokePost("does-not-exist", rootBody);

    expect(res.status).toBe(404);
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(createRoot).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer (answerHitl denied) before any diff computation", async () => {
    seedRun();
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "Requires project role member"),
    );

    const res = await invokePost(RUN_ID, rootBody);

    expect(res.status).toBe(403);
    expect(diffRunWorkspace).not.toHaveBeenCalled();
    expect(createRoot).not.toHaveBeenCalled();
  });

  it("409 PRECONDITION when the line is absent on the named side; nothing written", async () => {
    seedRun();

    const res = await invokePost(RUN_ID, { ...rootBody, line: 999 });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(createRoot).not.toHaveBeenCalled();
  });

  it("409 PRECONDITION when the file is absent from the parsed diff", async () => {
    seedRun();

    const res = await invokePost(RUN_ID, {
      ...rootBody,
      filePath: "not/in/diff.ts",
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(createRoot).not.toHaveBeenCalled();
  });

  it("409 PRECONDITION when the diff is truncated — anchors cannot be validated", async () => {
    seedRun();
    vi.mocked(diffRunWorkspace).mockResolvedValueOnce({
      text: FIXTURE_DIFF,
      truncated: true,
    });

    const res = await invokePost(RUN_ID, rootBody);
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(createRoot).not.toHaveBeenCalled();
  });

  it("maps the service's open-gate guard PRECONDITION to 409", async () => {
    seedRun({ status: "Review" });
    vi.mocked(createRoot).mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "run has no open review gate"),
    );

    const res = await invokePost(RUN_ID, rootBody);
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
  });

  it("rejects a client-supplied lineContent as an unknown key (400) — never trusted", async () => {
    seedRun();

    const camel = await invokePost(RUN_ID, {
      ...rootBody,
      lineContent: "const added = 2;",
    });
    const snake = await invokePost(RUN_ID, {
      ...rootBody,
      line_content: "const added = 2;",
    });

    expect(camel.status).toBe(400);
    expect(snake.status).toBe(400);
    expect(createRoot).not.toHaveBeenCalled();
  });
});

describe("POST /api/runs/[runId]/review-comments — replies", () => {
  const replyBody = { parentId: PARENT_UUID, body: "agreed" };

  it("201: calls createReply with the session actor and never computes a diff", async () => {
    seedRun();

    const res = await invokePost(RUN_ID, replyBody);
    const body = (await res.json()) as { comment: Row };

    expect(res.status).toBe(201);
    expect(diffRunWorkspace).not.toHaveBeenCalled();
    expect(createRoot).not.toHaveBeenCalled();
    expect(createReply).toHaveBeenCalledTimes(1);

    const [, actor, calledRunId, input] = vi.mocked(createReply).mock.calls[0];

    expect(actor).toEqual({ userId: "user-1", label: "Reviewer One" });
    expect(calledRunId).toBe(RUN_ID);
    expect(input).toEqual({ parentId: PARENT_UUID, body: "agreed" });
    expect(Object.keys(body.comment).sort()).toEqual(COMMENT_DTO_KEYS);
    expect(body.comment.parentId).toBe(PARENT_UUID);
  });

  it("maps the service's reply-integrity CONFLICT to 409", async () => {
    seedRun();
    vi.mocked(createReply).mockRejectedValueOnce(
      new MaisterError(
        "CONFLICT",
        "parentId must resolve to a root comment of this run",
      ),
    );

    const res = await invokePost(RUN_ID, replyBody);
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
  });
});

describe("POST /api/runs/[runId]/review-comments — zod body validation (400 CONFIG)", () => {
  async function expectRejected(body: unknown) {
    seedRun();

    const res = await invokePost(RUN_ID, body);
    const parsed = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(parsed.code).toBe("CONFIG");
    expect(createRoot).not.toHaveBeenCalled();
    expect(createReply).not.toHaveBeenCalled();
  }

  it("rejects an empty object (neither root nor reply shape)", async () => {
    await expectRejected({});
  });

  it("rejects a root without body", async () => {
    await expectRejected({ filePath: "src/calc.ts", side: "new", line: 11 });
  });

  it("rejects an empty body string", async () => {
    await expectRejected({
      filePath: "src/calc.ts",
      side: "new",
      line: 11,
      body: "",
    });
  });

  it("rejects a body over 10 000 chars", async () => {
    await expectRejected({
      filePath: "src/calc.ts",
      side: "new",
      line: 11,
      body: "x".repeat(10_001),
    });
  });

  it("rejects an unknown side", async () => {
    await expectRejected({
      filePath: "src/calc.ts",
      side: "left",
      line: 11,
      body: "hm",
    });
  });

  it("rejects a non-integer line", async () => {
    await expectRejected({
      filePath: "src/calc.ts",
      side: "new",
      line: 11.5,
      body: "hm",
    });
  });

  it("rejects a line below 1", async () => {
    await expectRejected({
      filePath: "src/calc.ts",
      side: "new",
      line: 0,
      body: "hm",
    });
  });

  it("rejects a mixed root+reply shape", async () => {
    await expectRejected({
      filePath: "src/calc.ts",
      side: "new",
      line: 11,
      parentId: PARENT_UUID,
      body: "hm",
    });
  });

  it("rejects unknown keys on a reply", async () => {
    await expectRejected({
      parentId: PARENT_UUID,
      body: "hm",
      extra: true,
    });
  });

  it("rejects a non-uuid parentId", async () => {
    await expectRejected({ parentId: "not-a-uuid", body: "hm" });
  });

  it("rejects malformed JSON with 400 CONFIG", async () => {
    seedRun();
    const { POST } = await import("../route");
    const req = new NextRequest(
      new Request(`http://localhost/api/runs/${RUN_ID}/review-comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid",
      }),
    );

    const res = await POST(req, { params: Promise.resolve({ runId: RUN_ID }) });
    const parsed = (await res.json()) as { code?: string };

    expect(res.status).toBe(400);
    expect(parsed.code).toBe("CONFIG");
    expect(createRoot).not.toHaveBeenCalled();
    expect(createReply).not.toHaveBeenCalled();
  });
});
