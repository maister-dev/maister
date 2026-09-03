import type { PromptResult, SupervisorEvent } from "@/lib/execution-host";
import type { FlowContext } from "@/lib/flows/types";
import type { FakeCall } from "@/test-support/fake-execution-host";

import { describe, expect, it, vi } from "vitest";

import {
  assignmentEvents as assignmentEventsTable,
  assignments as assignmentsTable,
  hitlRequests as hitlRequestsTable,
  runs as runsTable,
  webhookEvents as webhookEventsTable,
} from "@/lib/db/schema";
import { runAgentStep, type RunAgentStepCtx } from "@/lib/flows/runner-agent";
import { fakeAgentExecution } from "@/test-support/fake-execution-host";

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
  task: {
    id: "t1",
    title: "T",
    prompt: "go",
    effectivePrompt: "go",
    clarifications: [],
    attemptNumber: 1,
  },
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
  // stored intent. When `priorIntent` is set it wins; otherwise hitl_requests
  // reads reflect prior INSERTs (they carry no response/respondedAt, so they
  // read as OPEN + UNDECIDED) — this is what the resume re-emit dedup path
  // queries to find an existing open permission row instead of inserting again.
  const selectChain = () => ({
    from: (table: unknown) => ({
      where: () => {
        const name = tableOf(table);
        const rows =
          name === "hitl_requests"
            ? opts.priorIntent
              ? [opts.priorIntent]
              : [...state.insertCalls]
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

// ADR-166: the runner's execution seam is a fake-backed BoundClient + admin
// stream (no ledger, no database). `events` scripts the session stream; the
// permission input the runner sends is observed on the fake transport.
function makeApi(opts: {
  events: SupervisorEvent[];
  promptStopReason?: PromptResult["stopReason"];
  cancelFails?: boolean;
}) {
  const execution = fakeAgentExecution({
    events: opts.events,
    promptStopReason: opts.promptStopReason,
  });
  const { fake } = execution;

  if (opts.cancelFails) {
    fake.failOnce("deliverInput", new Error("supervisor unreachable"));
  }

  const inputs = (action: "select" | "cancel") =>
    fake
      .callsOf("deliverInput")
      .filter(
        (c) =>
          (c.envelope?.payload as { action?: string } | undefined)?.action ===
          action,
      );
  const payloadOf = (call: FakeCall | undefined) =>
    (call?.envelope?.payload ?? {}) as Record<string, unknown>;
  // The step deletes its session in `finally`, so the host session id is read
  // off the prompt command the runner sent (its URL key), not the live map.
  const sessionId = () => fake.callsOf("sendPrompt")[0]?.args[0] as string;

  return {
    ...execution,
    sessionId,
    cancels: () => inputs("cancel"),
    creates: () => fake.callsOf("createSession").map(payloadOf),
    prompts: () => fake.callsOf("sendPrompt").map(payloadOf),
    cancelArgs: (call: FakeCall) => ({
      sessionId: call.args[0] as string,
      requestId: payloadOf(call).requestId as string,
      reason: payloadOf(call).reason as string,
    }),
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
    // The HITL row stores the HOST session id (the supervisor's URL key).
    expect(
      (inserted.schema as { supervisorSessionId: string }).supervisorSessionId,
    ).toBe(api.sessionId());

    const statusUpdates = db.updates.map((u) => u.set.status).filter(Boolean);

    expect(statusUpdates).toContain("NeedsInput");
    expect(statusUpdates).toContain("Running");

    // Entering NeedsInput must ARM the keep-alive window (mirrors the agent
    // path + spec). Without it, keepalive_until stays null, the sweeper — which
    // filters on `keepalive_until IS NOT NULL AND < now` — never idles the run,
    // and the agent runs forever re-emitting permissions.
    const needsInputUpdate = db.updates.find(
      (u) => u.set.status === "NeedsInput",
    );

    expect(needsInputUpdate?.set.keepaliveUntil).toBeInstanceOf(Date);
  });

  it("re-emitted permission_request for the same step reuses the open row (no duplicate)", async () => {
    // Regression: a keep-alive checkpoint→resume cycle re-emits the pending
    // permission with a fresh requestId. The prior open (undecided) row must be
    // REUSED, not duplicated — otherwise every 30-min cycle piles another card
    // into the inbox, all pointing at the same blocked step.
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

    // Only the FIRST emit persists a row; the re-emit reuses it.
    expect(db.insertCalls).toHaveLength(1);
    expect((db.insertCalls[0].schema as { requestId: string }).requestId).toBe(
      "req-1",
    );
    // The re-emit refreshes the open row's requestId in place (so a later
    // response delivers to the live supervisor deferred, not the dead one).
    const reuseUpdate = db.updates.find(
      (u) =>
        (u.set.schema as { requestId?: string } | undefined)?.requestId ===
        "req-2",
    );

    expect(reuseUpdate).toBeDefined();
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

    const cancels = api.cancels();

    expect(cancels).toHaveLength(1);
    expect(api.cancelArgs(cancels[0])).toMatchObject({
      sessionId: api.sessionId(),
      requestId: "req-fail",
      reason: expect.stringContaining("DB_PERSIST_FAILED"),
    });

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
      cancelFails: true,
    });

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(api.cancels()).toHaveLength(1);
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

    const cancels = api.cancels();

    expect(cancels).toHaveLength(1);
    expect(api.cancelArgs(cancels[0]).sessionId).toBe(api.sessionId());
    expect(api.cancelArgs(cancels[0]).requestId).toBe("req-spy");
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

    expect(api.creates()[0]).toMatchObject({ autoApprovePermissions: true });
  });

  it("leaves autoApprovePermissions undefined when the ctx omits it", async () => {
    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "hi"), exited(2)] });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(api.creates()[0].autoApprovePermissions).toBeUndefined();
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

    expect(api.creates()[0]).toMatchObject({
      hooksConfig: { repetition: { max: 5 }, noProgress: { maxTurns: 15 } },
    });
  });

  it("leaves hooksConfig undefined when the ctx omits it", async () => {
    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "hi"), exited(2)] });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(api.creates()[0].hooksConfig).toBeUndefined();
  });
});

// ADR-166 D7: the session body is the HANDLE form — no path, no run identity
// (both ride the fence and the adopted workspace handle).
describe("runner-agent — handle-form session body (ADR-166)", () => {
  it("createSession carries executionWorkspaceId and no path fields", async () => {
    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "hi"), exited(2)] });

    await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db, { contextMounts: [] }),
      api,
    );

    const [create] = api.creates();

    expect(create.executionWorkspaceId).toMatch(/^ws_/);
    for (const field of [
      "runId",
      "projectSlug",
      "worktreePath",
      "repoPath",
      "confineRoot",
      "contextMounts",
    ]) {
      expect(create).not.toHaveProperty(field);
    }
    // The prompt and the delete both address the HOST session id.
    expect(api.fake.callsOf("sendPrompt")[0].args[0]).toBe(api.sessionId());
    expect(api.fake.callsOf("deleteSession")[0].args[0]).toBe(api.sessionId());
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
});

// ADR-166 E-EH-11: a fenced command means a newer driver owns the run — the
// step yields without deleting the session or touching run state.
describe("runner-agent — driver yield rule (ADR-166)", () => {
  it("a FENCED prompt returns {fenced:true} with no delete and no status write", async () => {
    const db = makeFakeDb();
    const api = makeApi({ events: [update(1, "hi"), exited(2)] });

    // A second driver generation already advanced the host's fence.
    api.fake.fences.set("run-1", api.client.assignment.epoch + 1);

    const result = await runAgentStep(
      { id: "plan", type: "agent", mode: "new-session", prompt: "go" },
      makeCtx(db),
      api,
    );

    expect(result.ok).toBe(false);
    expect(result.fenced).toBe(true);
    expect(result.errorCode).toBe("CONFLICT");
    expect(api.fake.callsOf("deleteSession")).toHaveLength(0);
    expect(db.updates.filter((u) => u.set.status)).toHaveLength(0);
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

    const prompt = api.prompts()[0].prompt as string;

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

    const prompt = api.prompts()[0].prompt as string;

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

    expect(api.prompts()[0].prompt).toBe("plain");
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
    expect(api.prompts()).toHaveLength(1);
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
    expect(api.prompts()).toHaveLength(1);
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
