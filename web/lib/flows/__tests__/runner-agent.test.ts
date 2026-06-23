import type { FlowContext } from "@/lib/flows/types";
import type { PromptResult, SupervisorEvent } from "@/lib/supervisor-client";

import { describe, expect, it, vi } from "vitest";

import {
  assignmentEvents as assignmentEventsTable,
  assignments as assignmentsTable,
  hitlRequests as hitlRequestsTable,
  runs as runsTable,
  webhookEvents as webhookEventsTable,
} from "@/lib/db/schema";
import {
  assertSessionProfileConsistent,
  runAgentStep,
  type RunAgentStepCtx,
  type SupervisorApi,
} from "@/lib/flows/runner-agent";
import { isMaisterError } from "@/lib/errors";

// M34 (ADR-089): the agent-binding resolution is mocked at the module
// boundary — the resolver's own contract (registration, `flow` trigger,
// enabled/quarantine gates, subagent materialization) is covered by
// lib/agents/__tests__/flow-binding-floor.test.ts; here we assert the
// runner's substitution WIRING.
const flowBindingMock = vi.hoisted(() => ({
  resolveFlowBoundAgent: vi.fn(async () => ({
    mode: "session" as const,
    prompt: "E2E-HELPER-SYSTEM-PROMPT-MARKER\nYou are the bound agent.",
  })),
}));

vi.mock("@/lib/agents/flow-binding", () => flowBindingMock);

const baseFlowCtx: FlowContext = {
  task: { id: "t1", title: "T", prompt: "go", attemptNumber: 1 },
  run: { id: "run-1", attemptNumber: 1, projectSlug: "demo" },
  executor: { id: "e1", agent: "claude", model: "claude-sonnet-4-6" },
  steps: {},
  env: {},
  artifacts: {},
};

function makeCtx(
  db: unknown,
  overrides: Partial<RunAgentStepCtx> = {},
): RunAgentStepCtx {
  return {
    runtimeRoot: "/tmp",
    projectSlug: "demo",
    runId: "run-1",
    stepId: "plan",
    worktreePath: "/tmp/wt",
    executor: { id: "e1", agent: "claude", model: "claude-sonnet-4-6" },
    context: baseFlowCtx,
    sessionState: { currentSessionId: null, lastSeenMonotonicId: 0 },
    db,
    ...overrides,
  };
}

type InsertSpy = {
  insertCalls: Array<Record<string, unknown>>;
  assignmentRows: Array<Record<string, unknown>>;
  assignmentEventRows: Array<Record<string, unknown>>;
  updates: Array<{ set: Record<string, unknown> }>;
  insertFails: boolean;
};

type FakeTableName =
  | "hitl_requests"
  | "runs"
  | "assignments"
  | "assignment_events"
  | "webhook_events";

function tableOf(table: unknown): FakeTableName {
  if (table === hitlRequestsTable) return "hitl_requests";
  if (table === runsTable) return "runs";
  if (table === assignmentsTable) return "assignments";
  if (table === assignmentEventsTable) return "assignment_events";
  if (table === webhookEventsTable) return "webhook_events";

  throw new Error("unknown table");
}

function makeFakeDb(
  opts: {
    insertFails?: boolean;
    priorIntent?: Record<string, unknown> | null;
    resolvedPromptUpdateFails?: boolean;
  } = {},
): InsertSpy & {
  insert: (...args: unknown[]) => unknown;
  update: (...args: unknown[]) => unknown;
  select: (...args: unknown[]) => unknown;
  transaction: (fn: (tx: unknown) => Promise<void>) => Promise<void>;
} {
  const state: InsertSpy = {
    insertCalls: [],
    assignmentRows: [],
    assignmentEventRows: [],
    updates: [],
    insertFails: Boolean(opts.insertFails),
  };
  const insertChain = (table: unknown) => {
    const name = tableOf(table);

    return {
      values: (row: Record<string, unknown>) => {
        if (state.insertFails && name === "hitl_requests") {
          throw new Error("simulated INSERT failure");
        }
        if (name === "hitl_requests") {
          state.insertCalls.push(row);
        }
        if (name === "assignments") {
          state.assignmentRows.push(row);
        }
        if (name === "assignment_events") {
          state.assignmentEventRows.push(row);
        }

        const inserted =
          name === "assignments"
            ? {
                ...row,
                projectId: row.projectId ?? "proj-1",
                runId: row.runId ?? "run-1",
              }
            : row;
        const result: any = Promise.resolve(undefined);

        result.onConflictDoUpdate = () => result;
        result.returning = async () => [inserted];

        return result;
      },
    };
  };
  const updateChain = () => ({
    set: (vals: Record<string, unknown>) => {
      if (opts.resolvedPromptUpdateFails && "resolvedPrompt" in vals) {
        throw new Error("simulated resolved_prompt UPDATE failure");
      }

      return {
        where: (..._args: unknown[]) => {
          state.updates.push({ set: vals });
          // Thenable that also exposes .returning() so callers that
          // either `await db.update(t).set(...).where(...)` or
          // `db.update(t).set(...).where(...).returning(...)` both work.
          const result: any = Promise.resolve([{ id: "x" }]);

          result.returning = async () => [{ id: "x" }];

          return result;
        },
      };
    },
  });
  // M8 T11: tryAutoDeliverStoredIntent reads hitl_requests for a prior
  // stored intent. Tests without `priorIntent` get an empty result so
  // the legacy "INSERT new row" path still fires.
  const selectChain = () => ({
    from: (table: unknown) => ({
      where: () => {
        const name = tableOf(table);
        const rows =
          name === "hitl_requests" && opts.priorIntent
            ? [opts.priorIntent]
            : name === "runs"
              ? [{ projectId: "proj-1", taskId: null }]
              : [];
        const result: any = Promise.resolve(rows);

        result.limit = async () => rows;

        return result;
      },
    }),
  });

  return {
    ...state,
    insert: insertChain,
    update: updateChain,
    select: selectChain,
    transaction: async (fn) => {
      await fn({
        insert: insertChain,
        update: updateChain,
        select: selectChain,
      });
    },
  };
}

async function* eventStream(
  events: SupervisorEvent[],
): AsyncGenerator<SupervisorEvent> {
  for (const ev of events) {
    yield ev;
    await new Promise((r) => setImmediate(r));
  }
}

function makeApi(opts: {
  events: SupervisorEvent[];
  promptStopReason?: PromptResult["stopReason"];
  cancelImpl?: (
    sessionId: string,
    requestId: string,
    reason: string,
  ) => Promise<{ ok: true }>;
}): SupervisorApi & { cancelSpy: ReturnType<typeof vi.fn> } {
  const cancelSpy = vi.fn(
    opts.cancelImpl ?? (async () => ({ ok: true }) as { ok: true }),
  );

  return {
    createSession: vi.fn(async () => ({
      sessionId: "sup-session-1",
      pid: 1234,
      acpSessionId: "acp-1",
    })),
    deleteSession: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => ({
      stopReason: opts.promptStopReason ?? "end_turn",
    })),
    streamSession: vi.fn(() =>
      eventStream(opts.events),
    ) as unknown as SupervisorApi["streamSession"],
    cancelPermission: cancelSpy as unknown as SupervisorApi["cancelPermission"],
    checkpointSession: async () => ({
      alreadyCheckpointed: false,
      sessionId: "s",
      monotonicId: 0,
    }),
    deliverPermission: vi.fn(
      async () => ({ ok: true }) as { ok: true },
    ) as unknown as SupervisorApi["deliverPermission"],
    cancelSpy,
  };
}

function permissionRequest(
  monotonicId: number,
  requestId: string,
): SupervisorEvent {
  return {
    type: "session.permission_request",
    sessionId: "sup-session-1",
    monotonicId,
    requestId,
    options: [
      { optionId: "allow", kind: "allow_always", name: "Allow" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ],
    toolCall: { toolCallId: "tc-1", title: "Edit", kind: "execute" },
  };
}

function update(monotonicId: number, text: string): SupervisorEvent {
  return {
    type: "session.update",
    sessionId: "sup-session-1",
    monotonicId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

function exited(monotonicId: number): SupervisorEvent {
  return {
    type: "session.exited",
    sessionId: "sup-session-1",
    monotonicId,
    exitCode: 0,
  };
}

function checkpointExited(monotonicId: number): SupervisorEvent {
  return {
    type: "session.exited",
    sessionId: "sup-session-1",
    monotonicId,
    exitCode: 0,
    reason: "checkpoint",
  };
}

function intentionalExited(monotonicId: number): SupervisorEvent {
  return {
    type: "session.exited",
    sessionId: "sup-session-1",
    monotonicId,
    exitCode: 0,
    reason: "intentional",
  };
}

describe("runner-agent — session.permission_request handling", () => {
  it("inserts hitl_requests row + UPDATEs runs to NeedsInput on happy path", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [permissionRequest(1, "req-A"), update(2, "ok"), exited(3)],
    });

    await runAgentStep(
      {
        id: "plan",
        type: "agent",
        mode: "new-session",
        prompt: "go",
      },
      makeCtx(db),
      api,
    );

    expect(db.insertCalls).toHaveLength(1);
    const inserted = db.insertCalls[0];

    expect(inserted.kind).toBe("permission");
    expect(inserted.runId).toBe("run-1");
    expect(inserted.stepId).toBe("plan");
    expect((inserted.schema as { requestId: string }).requestId).toBe("req-A");
    expect(
      (inserted.schema as { supervisorSessionId: string }).supervisorSessionId,
    ).toBe("sup-session-1");

    const statusUpdates = db.updates.map((u) => u.set.status).filter(Boolean);

    expect(statusUpdates).toContain("NeedsInput");
    expect(statusUpdates).toContain("Running");
  });

  it("two permission_requests for the same step produce two hitl_requests rows", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [
        permissionRequest(1, "req-1"),
        update(2, "chunk1"),
        permissionRequest(3, "req-2"),
        update(4, "chunk2"),
        exited(5),
      ],
    });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(db.insertCalls).toHaveLength(2);
    expect((db.insertCalls[0].schema as { requestId: string }).requestId).toBe(
      "req-1",
    );
    expect((db.insertCalls[1].schema as { requestId: string }).requestId).toBe(
      "req-2",
    );
  });

  it("cancels supervisor deferred + transitions run to Crashed AND returns ok=false errorCode=CRASH when INSERT fails", async () => {
    const db = makeFakeDb({ insertFails: true });
    const api = makeApi({
      events: [permissionRequest(1, "req-fail"), update(2, "tail"), exited(3)],
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(api.cancelSpy).toHaveBeenCalledTimes(1);
    expect(api.cancelSpy).toHaveBeenCalledWith(
      "sup-session-1",
      "req-fail",
      expect.stringContaining("DB_PERSIST_FAILED"),
    );

    const statusUpdates = db.updates.map((u) => u.set.status).filter(Boolean);

    expect(statusUpdates).toContain("Crashed");
    // The crash signal must reach runFlow — otherwise the final Review
    // transition would overwrite the Crashed state.
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("CRASH");
  });

  it("keeps consuming the stream AND returns errorCode=CRASH when INSERT + cancelPermission both fail", async () => {
    const db = makeFakeDb({ insertFails: true });
    const api = makeApi({
      events: [permissionRequest(1, "req-X"), update(2, "tail"), exited(3)],
      cancelImpl: async () => {
        throw new Error("supervisor unreachable");
      },
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(api.cancelSpy).toHaveBeenCalledTimes(1);
    const statusUpdates = db.updates.map((u) => u.set.status).filter(Boolean);

    expect(statusUpdates).toContain("Crashed");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("CRASH");
  });

  it("no-hidden-deferred regression: cancelPermission called exactly once with the matching (sessionId, requestId)", async () => {
    const db = makeFakeDb({ insertFails: true });
    const api = makeApi({
      events: [permissionRequest(1, "req-spy"), exited(2)],
    });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(api.cancelSpy).toHaveBeenCalledTimes(1);
    expect(api.cancelSpy.mock.calls[0][0]).toBe("sup-session-1");
    expect(api.cancelSpy.mock.calls[0][1]).toBe("req-spy");
  });

  it("event consumer captures session.update text chunks after permission_request resolves", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [
        permissionRequest(1, "req-after"),
        update(2, "post-permission chunk"),
        exited(3),
      ],
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(result.stdout).toContain("post-permission chunk");
  });
});

describe("runner-agent — B1 autoApprovePermissions threading", () => {
  it("threads ctx.autoApprovePermissions into createSession (new-session)", async () => {
    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "hi"), exited(2)] });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db, { autoApprovePermissions: true }),
      api,
    );

    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ autoApprovePermissions: true }),
    );
  });

  it("leaves autoApprovePermissions undefined when the ctx omits it", async () => {
    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "hi"), exited(2)] });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ autoApprovePermissions: undefined }),
    );
  });
});

describe("runner-agent — hooksConfig threading (ADR-108)", () => {
  it("threads ctx.hooksConfig into createSession (new-session)", async () => {
    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "hi"), exited(2)] });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db, {
        hooksConfig: { repetition: { max: 5 }, noProgress: { maxTurns: 15 } },
      }),
      api,
    );

    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        hooksConfig: { repetition: { max: 5 }, noProgress: { maxTurns: 15 } },
      }),
    );
  });

  it("leaves hooksConfig undefined when the ctx omits it", async () => {
    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "hi"), exited(2)] });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ hooksConfig: undefined }),
    );
  });
});

// M8 Codex review fix #1: when the supervisor checkpoints the agent
// mid-permission, the adapter cancels the pending requestPermission with
// `{outcome: "cancelled"}` and the prompt returns with
// `stopReason: "end_turn"` (the cancelled permission is journaled for
// replay on --resume, not denied). The runner-agent MUST inspect
// `session.exited.reason` and suppress step success even when the
// stopReason looks successful.
describe("runner-agent — session.exited.reason handling (M8 Codex fix #1)", () => {
  it("session.exited.reason='checkpoint' suppresses success and returns STEP_CHECKPOINTED", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [permissionRequest(1, "req-cp"), checkpointExited(2)],
      promptStopReason: "end_turn",
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    // Step is paused, not succeeded — even though stopReason says end_turn.
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("STEP_CHECKPOINTED");

    // markCheckpointedFromExit must have fired — confirmed by an UPDATE
    // setting status to NeedsInputIdle (with checkpointAt + null keepalive).
    const statusUpdates = db.updates.map((u) => u.set.status).filter(Boolean);

    expect(statusUpdates).toContain("NeedsInputIdle");
    const idleUpdate = db.updates.find(
      (u) => u.set.status === "NeedsInputIdle",
    );

    expect(idleUpdate).toBeDefined();
    expect(idleUpdate?.set.keepaliveUntil).toBeNull();
  });

  it("session.exited with no reason still treats end_turn as success (regression guard)", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [update(1, "hello"), exited(2)],
      promptStopReason: "end_turn",
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(result.ok).toBe(true);
    expect(result.errorCode).toBeUndefined();

    const statusUpdates = db.updates.map((u) => u.set.status).filter(Boolean);

    expect(statusUpdates).not.toContain("NeedsInputIdle");
  });

  it("session.exited.reason='intentional' does NOT trigger STEP_CHECKPOINTED (only checkpoint reason should)", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [update(1, "hi"), intentionalExited(2)],
      promptStopReason: "end_turn",
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(result.ok).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it("checkpoint reason on slash-in-existing also returns STEP_CHECKPOINTED", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [permissionRequest(1, "req-cp-slash"), checkpointExited(2)],
      promptStopReason: "end_turn",
    });

    const ctx = makeCtx(db, {
      sessionState: {
        currentSessionId: "sup-session-1",
        lastSeenMonotonicId: 0,
      },
    });
    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "slash-in-existing", prompt: "go" },
      ctx,
      api,
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("STEP_CHECKPOINTED");
  });
});

// M14 T4.5: long-living session profile-consistency guard (AC #5/#9).
// A session that already ran one resolved capability profile must not
// silently serve a node with a DIFFERENT resolved profile. The guard is
// an allow-list: reuse permitted iff the digests are equal (or either is
// undefined). The pure helper encapsulates that allow-list; the guard in
// runSlashInExisting calls it.
describe("runner-agent — assertSessionProfileConsistent (M14 T4.5 pure guard)", () => {
  it("equal digests → does NOT throw", () => {
    expect(() =>
      assertSessionProfileConsistent("digest-A", "digest-A"),
    ).not.toThrow();
  });

  it("different digests → throws MaisterError code CONFIG", () => {
    let caught: unknown;

    try {
      assertSessionProfileConsistent("digest-A", "digest-B");
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe("CONFIG");
  });

  it("existing undefined, incoming defined → does NOT throw (first materialized node)", () => {
    expect(() =>
      assertSessionProfileConsistent(undefined, "digest-A"),
    ).not.toThrow();
  });

  it("existing defined, incoming undefined → does NOT throw (non-capability node reuse)", () => {
    expect(() =>
      assertSessionProfileConsistent("digest-A", undefined),
    ).not.toThrow();
  });

  it("both undefined → does NOT throw", () => {
    expect(() =>
      assertSessionProfileConsistent(undefined, undefined),
    ).not.toThrow();
  });
});

describe("runner-agent — runSlashInExisting profile-consistency guard (M14 T4.5 wiring)", () => {
  it("reuse with matching digest → proceeds (no throw)", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [update(1, "reused"), exited(2)],
      promptStopReason: "end_turn",
    });

    const ctx = makeCtx(db, {
      sessionState: {
        currentSessionId: "sup-session-1",
        lastSeenMonotonicId: 0,
        profileDigest: "digest-A",
      },
      profileDigest: "digest-A",
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "slash-in-existing", prompt: "go" },
      ctx,
      api,
    );

    // Session is reused, driven to completion — no createSession on reuse.
    expect(api.createSession).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it("reuse with mismatched digest → throws MaisterError code CONFIG", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [update(1, "should-not-run"), exited(2)],
      promptStopReason: "end_turn",
    });

    const ctx = makeCtx(db, {
      sessionState: {
        currentSessionId: "sup-session-1",
        lastSeenMonotonicId: 0,
        profileDigest: "digest-A",
      },
      profileDigest: "digest-B",
    });

    let caught: unknown;

    try {
      await runAgentStep(
        { id: "plan", type: "agent", mode: "slash-in-existing", prompt: "go" },
        ctx,
        api,
      );
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe("CONFIG");
    // Mismatch must throw BEFORE any session I/O on the reused session.
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it("fresh seed records the incoming digest on the session state", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [update(1, "seeded"), exited(2)],
      promptStopReason: "end_turn",
    });

    const ctx = makeCtx(db, {
      sessionState: {
        currentSessionId: null,
        lastSeenMonotonicId: 0,
      },
      profileDigest: "digest-X",
    });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "slash-in-existing", prompt: "go" },
      ctx,
      api,
    );

    expect((ctx.sessionState as { profileDigest?: string }).profileDigest).toBe(
      "digest-X",
    );
  });

  it("adopts the first MATERIALIZED digest on a reuse of a profile-less session, then rejects a different one", async () => {
    const db = makeFakeDb();
    const api = makeApi({
      events: [update(1, "reused"), exited(2)],
      promptStopReason: "end_turn",
    });

    // A long-living session seeded by a profile-LESS node (stored digest undefined).
    const ctx = makeCtx(db, {
      sessionState: {
        currentSessionId: "sup-session-1",
        lastSeenMonotonicId: 0,
        profileDigest: undefined,
      },
      profileDigest: "digest-A",
    });

    // First MATERIALIZED node reuses the session — permitted (stored undefined),
    // and the session must ADOPT digest-A so the pin tracks first-materialized,
    // not first-seed.
    const first = await runAgentStep(
      { id: "n1", type: "agent", mode: "slash-in-existing", prompt: "go" },
      ctx,
      api,
    );

    expect(first.ok).toBe(true);
    expect((ctx.sessionState as { profileDigest?: string }).profileDigest).toBe(
      "digest-A",
    );

    // A later node with a DIFFERENT profile now mismatches the adopted digest
    // (without the adopt, it would compare against undefined and slip through).
    ctx.profileDigest = "digest-B";

    let caught: unknown;

    try {
      await runAgentStep(
        { id: "n2", type: "agent", mode: "slash-in-existing", prompt: "go" },
        ctx,
        api,
      );
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe("CONFIG");
  });
});

describe("runner-agent — catalog-agent binding substitution (M34, ADR-089)", () => {
  it("session-mode binding sends the agent body + '## Task' + node prompt as the session prompt", async () => {
    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "ok"), exited(2)] });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go do it" },
      makeCtx(db, { agentBinding: { id: "e2e-helper" } }),
      api,
    );

    expect(flowBindingMock.resolveFlowBoundAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "e2e-helper",
        executorAgent: "claude",
        worktreePath: "/tmp/wt",
      }),
    );

    const prompt = (api.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .prompt as string;

    expect(prompt).toContain("E2E-HELPER-SYSTEM-PROMPT-MARKER");
    expect(prompt).toContain("\n\n## Task\n\ngo do it");
    // The agent body leads — it is the system block.
    expect(prompt.startsWith("E2E-HELPER-SYSTEM-PROMPT-MARKER")).toBe(true);
  });

  // M39 (ADR-106): the run-driving persona — an agent launched WITH a flow_ref
  // augments EVERY ai_coding node with its .md body, skipping the flow-trigger
  // check (it is launched by its own trigger, not bound to a flow node).
  it("a run-driving persona (runPersonaAgentId) prepends the agent body + '## Task', skipping the flow-trigger check", async () => {
    flowBindingMock.resolveFlowBoundAgent.mockClear();

    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "ok"), exited(2)] });

    await runAgentStep(
      { id: "code", type: "agent", mode: "new-session", prompt: "implement X" },
      makeCtx(db, { runPersonaAgentId: "pkg:driver" }),
      api,
    );

    expect(flowBindingMock.resolveFlowBoundAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "pkg:driver",
        requireFlowTrigger: false,
      }),
    );

    const prompt = (api.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .prompt as string;

    expect(prompt.startsWith("E2E-HELPER-SYSTEM-PROMPT-MARKER")).toBe(true);
    expect(prompt).toContain("\n\n## Task\n\nimplement X");
  });

  it("a per-node agentBinding wins over the run-driving persona (resolver called once, for the node binding)", async () => {
    flowBindingMock.resolveFlowBoundAgent.mockClear();

    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "ok"), exited(2)] });

    await runAgentStep(
      { id: "code", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db, {
        agentBinding: { id: "node-helper" },
        runPersonaAgentId: "pkg:driver",
      }),
      api,
    );

    expect(flowBindingMock.resolveFlowBoundAgent).toHaveBeenCalledTimes(1);
    expect(flowBindingMock.resolveFlowBoundAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "node-helper" }),
    );
    expect(flowBindingMock.resolveFlowBoundAgent).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "pkg:driver" }),
    );
  });

  it("an unbound step never touches the resolver and keeps the inline prompt", async () => {
    flowBindingMock.resolveFlowBoundAgent.mockClear();

    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "ok"), exited(2)] });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "plain" },
      makeCtx(db),
      api,
    );

    expect(flowBindingMock.resolveFlowBoundAgent).not.toHaveBeenCalled();

    const prompt = (api.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .prompt as string;

    expect(prompt).toBe("plain");
  });
});

describe("runner-agent — resolved_prompt capture (migration 0053)", () => {
  it("eagerly persists the resolved prompt to node_attempts before dispatch", async () => {
    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "ok"), exited(2)] });

    const result = await runAgentStep(
      {
        id: "plan",
        type: "agent",
        mode: "new-session",
        prompt: "implement {{ task.prompt }}",
      },
      makeCtx(db, { nodeAttemptId: "na-1" }),
      api,
    );

    const promptUpdate = db.updates.find((u) => "resolvedPrompt" in u.set);

    expect(promptUpdate).toBeDefined();
    // {{ task.prompt }} resolves to the FlowContext task prompt ("go").
    expect(promptUpdate?.set.resolvedPrompt).toBe("implement go");
    expect(api.sendPrompt).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("a failed resolved_prompt write is swallowed and the step still dispatches", async () => {
    const db = makeFakeDb({ resolvedPromptUpdateFails: true });
    const api = makeApi({ events: [update(1, "ok"), exited(2)] });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db, { nodeAttemptId: "na-2" }),
      api,
    );

    // Best-effort: the throw never blocks dispatch (the agent turn ran).
    expect(api.sendPrompt).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(db.updates.find((u) => "resolvedPrompt" in u.set)).toBeUndefined();
  });

  it("skips the write when the step has no nodeAttemptId", async () => {
    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "ok"), exited(2)] });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(db.updates.find((u) => "resolvedPrompt" in u.set)).toBeUndefined();
  });
});
