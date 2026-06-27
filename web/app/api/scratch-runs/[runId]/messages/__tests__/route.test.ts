import type { NextRequest } from "next/server";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  runtimeRoot: vi.fn(),
  sendScratchPromptAndProjectEvents: vi.fn(),
  sendPrompt: vi.fn(),
}));

type FakeDb = {
  select: (fields?: unknown) => {
    from: (table: unknown) => {
      where: (predicate: unknown) => Promise<Record<string, unknown>[]>;
    };
  };
  insert: (table: unknown) => {
    values: (values: unknown) => Promise<void>;
  };
  update: (table: unknown) => {
    set: (values: unknown) => {
      where: (predicate: unknown) => Promise<void>;
    };
  };
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

const runId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const state: {
  scratchSelectCalls: number;
  scratchStatus: string;
  inserts: unknown[];
  updates: unknown[];
  runtimeRoot: string | null;
} = {
  scratchSelectCalls: 0,
  scratchStatus: "WaitingForUser",
  inserts: [],
  updates: [],
  runtimeRoot: null,
};
const tableNameSymbol = Symbol.for("drizzle:Name");

function tableName(table: unknown): string | null {
  if (!table || typeof table !== "object") return null;

  return (table as Record<symbol, unknown>)[tableNameSymbol] as string | null;
}

const fakeDb: FakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: async () => {
        const name = tableName(table);

        if (name === "runs") {
          return [
            { id: runId, runKind: "scratch", projectId, status: "Running" },
          ];
        }
        if (name === "scratch_runs") {
          state.scratchSelectCalls += 1;

          return [
            {
              runId,
              dialogStatus:
                state.scratchSelectCalls === 2
                  ? "Running"
                  : state.scratchStatus,
              supervisorSessionId: "supervisor-session-1",
            },
          ];
        }
        if (name === "workspaces") {
          return [
            {
              runId,
              parentRepoPath: "/repos/demo",
              worktreePath: "/tmp/worktrees/demo/run",
            },
          ];
        }
        if (name === "scratch_messages") {
          return [{ sequence: 1 }, { sequence: 2 }];
        }
        if (name === "projects") {
          return [{ id: projectId, slug: "demo" }];
        }

        return [];
      },
    }),
  }),
  insert: () => ({
    values: async (values: unknown) => {
      state.inserts.push(values);
    },
  }),
  update: () => ({
    set: (values: unknown) => ({
      where: async () => {
        state.updates.push(values);
      },
    }),
  }),
  transaction: async <T>(fn: (tx: FakeDb) => Promise<T>) => fn(fakeDb),
};

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

// M42 (ADR-114): the scratch service reads runner identity + writes the resume
// handle on the run's active run_sessions row; the fake DB models only the
// legacy tables, so stub the helper with a single default session.
vi.mock("@/lib/runs/active-run-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runs/active-run-session")>()),
  loadActiveRunSession: vi.fn(async () => ({
    sessionName: "default",
    acpSessionId: null,
    runnerSnapshot: null,
    capabilityAgent: "claude",
    runnerId: null,
    runnerResolutionTier: null,
  })),
  persistRunSessionAcpSessionId: vi.fn(async () => {}),
}));
vi.mock("@/lib/supervisor-client", () => ({
  sendPrompt: mocks.sendPrompt,
}));
vi.mock("@/lib/instance-config", () => ({
  runtimeRoot: mocks.runtimeRoot,
}));
vi.mock("@/lib/scratch-runs/events", () => ({
  sendScratchPromptAndProjectEvents: mocks.sendScratchPromptAndProjectEvents,
  normalizeScratchPrompt: (prompt: string) => prompt,
}));

let POST: (
  req: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
) => Promise<Response>;

beforeEach(async () => {
  state.scratchSelectCalls = 0;
  state.scratchStatus = "WaitingForUser";
  state.inserts = [];
  state.updates = [];
  state.runtimeRoot = await mkdtemp(
    path.join(tmpdir(), "maister-scratch-message-"),
  );
  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "member" });
  mocks.runtimeRoot.mockReturnValue(state.runtimeRoot);
  mocks.sendPrompt.mockResolvedValue({ stopReason: "end_turn" });
  mocks.sendScratchPromptAndProjectEvents.mockResolvedValue({
    stopReason: "end_turn",
  });

  ({ POST } = await import("../route"));
});

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  if (state.runtimeRoot) {
    await rm(state.runtimeRoot, { recursive: true, force: true });
    state.runtimeRoot = null;
  }
});

function request(content = "Continue"): NextRequest {
  return new Request("http://x/api/scratch-runs/run/messages", {
    method: "POST",
    body: JSON.stringify({ content, attachments: [] }),
  }) as NextRequest;
}

function multipartRequest(args: {
  content: string;
  attachments?: Array<Record<string, unknown>>;
  files?: File[];
}): NextRequest {
  const formData = new FormData();

  formData.set(
    "payload",
    JSON.stringify({
      content: args.content,
      attachments: args.attachments ?? [],
    }),
  );
  for (const file of args.files ?? []) formData.append("files", file);

  return new Request("http://x/api/scratch-runs/run/messages", {
    method: "POST",
    body: formData,
  }) as NextRequest;
}

function ctx() {
  return { params: Promise.resolve({ runId }) };
}

describe("POST /api/scratch-runs/[runId]/messages", () => {
  it("appends the next user message and sends a supervisor prompt", async () => {
    const res = await POST(request("Continue please"), ctx());
    const body = (await res.json()) as {
      ok?: boolean;
      sequence?: number;
      dialogStatus?: string;
    };

    expect(res.status).toBe(202);
    expect(body.ok).toBe(true);
    expect(body.sequence).toBe(3);
    expect(body.dialogStatus).toBe("WaitingForUser");
    expect(state.inserts[0]).toEqual(
      expect.objectContaining({
        runId,
        sequence: 3,
        role: "user",
        content: "Continue please",
      }),
    );
    expect(mocks.sendScratchPromptAndProjectEvents).toHaveBeenCalledWith({
      runId,
      sessionId: "supervisor-session-1",
      stepId: "dialog",
      prompt: "Continue please",
    });
  });

  it("accepts multipart messages with mixed metadata and uploaded files", async () => {
    const res = await POST(
      multipartRequest({
        content: "Continue with file",
        attachments: [{ kind: "text_note", value: "note" }],
        files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
      }),
      ctx(),
    );
    const body = (await res.json()) as { ok?: boolean; sequence?: number };
    const attachmentRows =
      state.inserts.find((values) => {
        if (!Array.isArray(values)) return false;

        return values.some(
          (row: Record<string, unknown>) => row.kind === "uploaded_file",
        );
      }) ?? [];
    const uploaded = Array.isArray(attachmentRows)
      ? attachmentRows.find(
          (row: Record<string, unknown>) => row.kind === "uploaded_file",
        )
      : null;

    expect(res.status).toBe(202);
    expect(body).toMatchObject({ ok: true, sequence: 3 });
    expect(uploaded).toMatchObject({
      kind: "uploaded_file",
      fileName: "notes.txt",
      mimeType: "text/plain",
      byteSize: 5,
    });
    // T5.4 B: uploaded files now ride as ACP resource_link content blocks
    // (a leading text block carries the prompt), not inline prompt text lines.
    expect(mocks.sendScratchPromptAndProjectEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Continue with file",
        contentBlocks: expect.arrayContaining([
          { type: "text", text: "Continue with file" },
          expect.objectContaining({
            type: "resource_link",
            name: "notes.txt",
            mimeType: "text/plain",
          }),
        ]),
      }),
    );
  });

  it("rejects while a scratch prompt is already running", async () => {
    state.scratchStatus = "Running";

    const res = await POST(request(), ctx());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    expect(state.inserts).toHaveLength(0);
    expect(mocks.sendScratchPromptAndProjectEvents).not.toHaveBeenCalled();
  });

  it("leaves the dialog retryable when supervisor prompt delivery fails", async () => {
    const { MaisterError: CurrentMaisterError } = await import("@/lib/errors");

    mocks.sendScratchPromptAndProjectEvents.mockRejectedValueOnce(
      new CurrentMaisterError("EXECUTOR_UNAVAILABLE", "supervisor unavailable"),
    );

    const res = await POST(request("Retryable prompt"), ctx());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
    expect(state.inserts[0]).toEqual(
      expect.objectContaining({
        runId,
        sequence: 3,
        role: "user",
        content: "Retryable prompt",
      }),
    );
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        dialogStatus: "WaitingForUser",
        errorCode: "EXECUTOR_UNAVAILABLE",
      }),
    );
    expect(state.updates).not.toContainEqual(
      expect.objectContaining({ dialogStatus: "Crashed" }),
    );
  });
});
