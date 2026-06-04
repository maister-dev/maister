import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import {
  cancelPermission,
  checkSupervisorDiagnostics,
  checkSupervisorHealth,
  checkpointSession,
  createSession,
  deleteSession,
  deliverPermission,
  getPlatformStatus,
  listSessions,
  sendPrompt,
  streamSession,
  type SupervisorEvent,
} from "@/lib/supervisor-client";
import { MaisterError } from "@/lib/errors";

let fetchSpy: MockInstance<typeof fetch>;

function mockOnce(response: Response): void {
  fetchSpy.mockResolvedValueOnce(response);
}

function mockReject(err: unknown): void {
  fetchSpy.mockRejectedValueOnce(err);
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as MockInstance<
    typeof fetch
  >;
  process.env.MAISTER_SUPERVISOR_URL = "http://supervisor:7777";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MAISTER_SUPERVISOR_URL;
});

const validInput = {
  runId: "run-1",
  projectSlug: "demo",
  worktreePath: "/repos/x",
  stepId: "plan",
  executor: { agent: "claude" as const, model: "claude-sonnet-4-6" },
};

describe("createSession", () => {
  it("returns sessionId+pid+acpSessionId on 201", async () => {
    mockOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          pid: 4242,
          acpSessionId: "acp-1",
        }),
        { status: 201 },
      ),
    );

    const result = await createSession(validInput);

    expect(result).toEqual({
      sessionId: "s1",
      pid: 4242,
      acpSessionId: "acp-1",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://supervisor:7777/sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("serializes capability launch fields into createSession", async () => {
    mockOnce(
      new Response(
        JSON.stringify({ sessionId: "s1", pid: 4242, acpSessionId: "acp-1" }),
        { status: 201 },
      ),
    );

    await createSession({
      ...validInput,
      capabilityProfilePath: "/repos/x/.maister/capabilities/run/profile.json",
      adapterLaunch: {
        env: { MAISTER_CAPABILITY_PROFILE_PATH: "/repos/x/profile.json" },
        preArgs: ["--capability-profile"],
      },
    });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(body).toMatchObject({
      capabilityProfilePath: "/repos/x/.maister/capabilities/run/profile.json",
      adapterLaunch: {
        env: { MAISTER_CAPABILITY_PROFILE_PATH: "/repos/x/profile.json" },
        preArgs: ["--capability-profile"],
      },
    });
  });

  it("translates 409 PRECONDITION to MaisterError", async () => {
    mockOnce(
      new Response(JSON.stringify({ code: "PRECONDITION", message: "bad" }), {
        status: 409,
      }),
    );

    await expect(createSession(validInput)).rejects.toMatchObject({
      code: "PRECONDITION",
      message: "bad",
    });
  });

  it("translates 503 EXECUTOR_UNAVAILABLE to MaisterError", async () => {
    mockOnce(
      new Response(
        JSON.stringify({
          code: "EXECUTOR_UNAVAILABLE",
          message: "no executor",
        }),
        { status: 503 },
      ),
    );

    await expect(createSession(validInput)).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
    });
  });

  it("translates 500 SPAWN to MaisterError", async () => {
    mockOnce(
      new Response(JSON.stringify({ code: "SPAWN", message: "ENOENT" }), {
        status: 500,
      }),
    );

    await expect(createSession(validInput)).rejects.toMatchObject({
      code: "SPAWN",
    });
  });

  it("falls back to ACP_PROTOCOL on unknown code", async () => {
    mockOnce(
      new Response(JSON.stringify({ code: "BANANAS", message: "?" }), {
        status: 500,
      }),
    );

    await expect(createSession(validInput)).rejects.toMatchObject({
      code: "ACP_PROTOCOL",
    });
  });

  it("translates network failure to EXECUTOR_UNAVAILABLE", async () => {
    mockReject(new TypeError("fetch failed"));

    const promise = createSession(validInput);

    await expect(promise).rejects.toBeInstanceOf(MaisterError);
    await expect(promise).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
    });
  });
});

describe("deleteSession", () => {
  it("resolves on 204", async () => {
    mockOnce(new Response(null, { status: 204 }));

    await expect(deleteSession("s1")).resolves.toBeUndefined();
  });

  it("rejects on 404", async () => {
    mockOnce(
      new Response(JSON.stringify({ code: "PRECONDITION", message: "nope" }), {
        status: 404,
      }),
    );

    await expect(deleteSession("none")).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });
});

describe("listSessions", () => {
  it("returns the array body", async () => {
    const records = [{ sessionId: "s1", status: "live" }];

    mockOnce(new Response(JSON.stringify(records), { status: 200 }));

    const result = await listSessions();

    expect(result).toEqual(records);
  });
});

describe("checkSupervisorHealth", () => {
  const readyHealth = {
    status: "ready",
    version: "0.0.1",
    uptimeMs: 42,
    checkedAt: "2026-05-30T12:00:00.000Z",
    sessions: { live: 1, exited: 2, crashed: 3 },
  };

  it("maps a valid health response to ready", async () => {
    mockOnce(new Response(JSON.stringify(readyHealth), { status: 200 }));

    await expect(checkSupervisorHealth()).resolves.toEqual({
      kind: "ready",
      health: readyHealth,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://supervisor:7777/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("maps network failure to unavailable", async () => {
    mockReject(new TypeError("fetch failed"));

    await expect(checkSupervisorHealth()).resolves.toMatchObject({
      kind: "unavailable",
      reason: "network",
    });
  });

  it("maps timeout to unavailable", async () => {
    fetchSpy.mockImplementationOnce(
      (...args: Parameters<typeof fetch>) =>
        new Promise<Response>((_resolve, reject) => {
          args[1]?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    await expect(
      checkSupervisorHealth({ timeoutMs: 1 }),
    ).resolves.toMatchObject({
      kind: "unavailable",
      reason: "timeout",
    });
  });

  it("maps non-200 response to unavailable", async () => {
    mockOnce(new Response(JSON.stringify({ code: "CRASH" }), { status: 503 }));

    await expect(checkSupervisorHealth()).resolves.toMatchObject({
      kind: "unavailable",
      reason: "http",
    });
  });

  it("maps malformed body to unavailable", async () => {
    mockOnce(
      new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    );

    await expect(checkSupervisorHealth()).resolves.toMatchObject({
      kind: "unavailable",
      reason: "malformed",
    });
  });

  it("getPlatformStatus returns the health status", async () => {
    mockOnce(new Response(JSON.stringify(readyHealth), { status: 200 }));

    await expect(getPlatformStatus()).resolves.toEqual({
      kind: "ready",
      health: readyHealth,
    });
  });
});

describe("checkSupervisorDiagnostics", () => {
  const diagnostics = {
    status: "ready",
    version: "0.0.1",
    checkedAt: "2026-06-03T12:00:00.000Z",
    adapters: [
      { id: "claude", binary: "claude-agent-acp", available: true },
      { id: "codex", binary: "codex-acp", available: false },
    ],
    sidecars: [{ id: "ccr-default", kind: "ccr", state: "idle" }],
    envRefs: [{ name: "MAISTER_CCR_AUTH_TOKEN", present: true }],
  };

  it("maps valid diagnostics to ready", async () => {
    mockOnce(new Response(JSON.stringify(diagnostics), { status: 200 }));

    await expect(checkSupervisorDiagnostics()).resolves.toEqual({
      kind: "ready",
      diagnostics,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://supervisor:7777/diagnostics",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects diagnostics bodies that include raw env values", async () => {
    mockOnce(
      new Response(
        JSON.stringify({
          ...diagnostics,
          envRefs: [
            {
              name: "MAISTER_CCR_AUTH_TOKEN",
              present: true,
              value: "secret",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(checkSupervisorDiagnostics()).resolves.toMatchObject({
      kind: "unavailable",
      reason: "malformed",
    });
  });
});

describe("checkpointSession (M8)", () => {
  it("resolves on 200 with a typed CheckpointResponse body", async () => {
    mockOnce(
      new Response(
        JSON.stringify({
          alreadyCheckpointed: false,
          sessionId: "s1",
          monotonicId: 42,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const r = await checkpointSession("s1");

    expect(r.alreadyCheckpointed).toBe(false);
    expect(r.sessionId).toBe("s1");
    expect(r.monotonicId).toBe(42);
  });

  it("resolves on 200 with alreadyCheckpointed: true (idempotency)", async () => {
    mockOnce(
      new Response(
        JSON.stringify({
          alreadyCheckpointed: true,
          sessionId: "s1",
          monotonicId: 99,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const r = await checkpointSession("s1");

    expect(r.alreadyCheckpointed).toBe(true);
    expect(r.monotonicId).toBe(99);
  });

  it("rejects with EXECUTOR_UNAVAILABLE on 500 (retryable; sweeper retries)", async () => {
    mockOnce(
      new Response(
        JSON.stringify({
          code: "EXECUTOR_UNAVAILABLE",
          message: "checkpoint timed out — SIGKILL escalation",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(checkpointSession("s1")).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
    });
  });

  it("rejects with CHECKPOINT on 404 (unknown session — terminal)", async () => {
    mockOnce(
      new Response(
        JSON.stringify({ code: "PRECONDITION", message: "unknown session" }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(checkpointSession("s1")).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("rejects with CHECKPOINT on malformed 200 response body", async () => {
    mockOnce(
      new Response(JSON.stringify({ alreadyCheckpointed: "yes" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(checkpointSession("s1")).rejects.toMatchObject({
      code: "CHECKPOINT",
    });
  });
});

describe("streamSession", () => {
  it("parses SSE events with id, event, and JSON data", async () => {
    const event1 = {
      type: "session.line" as const,
      sessionId: "s1",
      monotonicId: 1,
      line: "hello",
    };
    const event2 = {
      type: "session.exited" as const,
      sessionId: "s1",
      monotonicId: 2,
      exitCode: 0,
    };
    const wire =
      `id: 1\nevent: session.line\ndata: ${JSON.stringify(event1)}\n\n` +
      `id: 2\nevent: session.exited\ndata: ${JSON.stringify(event2)}\n\n`;

    mockOnce(
      new Response(wire, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const events: SupervisorEvent[] = [];

    for await (const evt of streamSession("s1")) {
      events.push(evt);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("session.line");
    expect(events[1].type).toBe("session.exited");
  });

  it("sends Last-Event-ID header when lastEventId is provided", async () => {
    mockOnce(new Response("", { status: 200 }));

    const iter = streamSession("s1", { lastEventId: 42 });

    await iter.next();

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/sessions/s1/stream"),
      expect.objectContaining({
        headers: expect.objectContaining({ "Last-Event-ID": "42" }),
      }),
    );
  });

  it("throws ACP_PROTOCOL on non-200 SSE response", async () => {
    mockOnce(
      new Response(JSON.stringify({ code: "ACP_PROTOCOL", message: "bad" }), {
        status: 500,
      }),
    );

    const iter = streamSession("s1");

    await expect(iter.next()).rejects.toMatchObject({ code: "ACP_PROTOCOL" });
  });

  it("forwards AbortSignal to fetch", async () => {
    mockOnce(new Response("", { status: 200 }));

    const controller = new AbortController();
    const iter = streamSession("s1", { signal: controller.signal });

    await iter.next();

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/sessions/s1/stream"),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("sendPrompt", () => {
  it("returns the PromptResult on 200", async () => {
    mockOnce(
      new Response(
        JSON.stringify({ stopReason: "end_turn", meta: { foo: "bar" } }),
        { status: 200 },
      ),
    );

    const result = await sendPrompt("s1", { stepId: "plan", prompt: "go" });

    expect(result).toEqual({ stopReason: "end_turn", meta: { foo: "bar" } });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://supervisor:7777/sessions/s1/prompt",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ stepId: "plan", prompt: "go" }),
      }),
    );
  });

  it("translates 404 PRECONDITION to MaisterError", async () => {
    mockOnce(
      new Response(
        JSON.stringify({ code: "PRECONDITION", message: "unknown session" }),
        { status: 404 },
      ),
    );

    await expect(
      sendPrompt("s-missing", { stepId: "plan", prompt: "go" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      message: "unknown session",
    });
  });

  it("translates network failure to EXECUTOR_UNAVAILABLE", async () => {
    mockReject(new TypeError("fetch failed"));

    let caught: unknown;

    try {
      await sendPrompt("s1", { stepId: "plan", prompt: "go" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MaisterError);
    expect((caught as MaisterError).code).toBe("EXECUTOR_UNAVAILABLE");
  });
});

describe("deliverPermission", () => {
  const requestId = "00000000-0000-0000-0000-000000000001";

  it("posts {kind:permission, action:select, requestId, optionId} and returns ok on 200", async () => {
    mockOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await deliverPermission("s1", requestId, "allow");

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://supervisor:7777/sessions/s1/input",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "permission",
          action: "select",
          requestId,
          optionId: "allow",
        }),
      }),
    );
  });

  it("throws HITL_TIMEOUT on supervisor 410 (M7+: deferred expired — terminal)", async () => {
    mockOnce(
      new Response(
        JSON.stringify({ code: "HITL_TIMEOUT", message: "no pending" }),
        { status: 410 },
      ),
    );

    const promise = deliverPermission("s1", requestId, "allow");

    await expect(promise).rejects.toBeInstanceOf(MaisterError);
    await expect(promise).rejects.toMatchObject({ code: "HITL_TIMEOUT" });
  });

  it("throws HITL_TIMEOUT on supervisor 404 (defensive fallback for pre-M7 supervisors)", async () => {
    mockOnce(
      new Response(
        JSON.stringify({ code: "NEEDS_INPUT", message: "no pending" }),
        { status: 404 },
      ),
    );

    const promise = deliverPermission("s1", requestId, "allow");

    await expect(promise).rejects.toBeInstanceOf(MaisterError);
    await expect(promise).rejects.toMatchObject({ code: "HITL_TIMEOUT" });
  });

  it("throws EXECUTOR_UNAVAILABLE on supervisor 503 (M7+: unknown session — retryable)", async () => {
    mockOnce(
      new Response(
        JSON.stringify({
          code: "EXECUTOR_UNAVAILABLE",
          message: "unknown session — supervisor may have restarted",
        }),
        { status: 503 },
      ),
    );

    await expect(
      deliverPermission("s1", requestId, "allow"),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
  });

  it("throws EXECUTOR_UNAVAILABLE on supervisor 5xx (retryable)", async () => {
    mockOnce(
      new Response(JSON.stringify({ code: "CRASH", message: "boom" }), {
        status: 502,
      }),
    );

    await expect(
      deliverPermission("s1", requestId, "allow"),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
  });

  it("throws EXECUTOR_UNAVAILABLE on network error (retryable)", async () => {
    mockReject(new TypeError("fetch failed"));

    await expect(
      deliverPermission("s1", requestId, "allow"),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
  });

  it("throws ACP_PROTOCOL on supervisor 409 (bug, body shape drift)", async () => {
    mockOnce(
      new Response(JSON.stringify({ code: "PRECONDITION", message: "shape" }), {
        status: 409,
      }),
    );

    await expect(
      deliverPermission("s1", requestId, "allow"),
    ).rejects.toMatchObject({ code: "ACP_PROTOCOL" });
  });
});

describe("cancelPermission", () => {
  const requestId = "00000000-0000-0000-0000-000000000002";

  it("posts {kind:permission, action:cancel, requestId, reason} and returns ok on 200", async () => {
    mockOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await cancelPermission("s1", requestId, "DB_PERSIST_FAILED");

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://supervisor:7777/sessions/s1/input",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "permission",
          action: "cancel",
          requestId,
          reason: "DB_PERSIST_FAILED",
        }),
      }),
    );
  });

  it("truncates reason to 256 chars", async () => {
    mockOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const longReason = "x".repeat(500);

    await cancelPermission("s1", requestId, longReason);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining(`"reason":"${"x".repeat(256)}"`),
      }),
    );
  });

  it("throws HITL_TIMEOUT on supervisor 404 (informational; runner-agent treats as best-effort)", async () => {
    mockOnce(
      new Response(
        JSON.stringify({ code: "NEEDS_INPUT", message: "no pending" }),
        { status: 404 },
      ),
    );

    await expect(
      cancelPermission("s1", requestId, "reason"),
    ).rejects.toMatchObject({ code: "HITL_TIMEOUT" });
  });

  it("throws EXECUTOR_UNAVAILABLE on network error", async () => {
    mockReject(new TypeError("fetch failed"));

    await expect(
      cancelPermission("s1", requestId, "reason"),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
  });
});

describe("permission helpers — body shape regression", () => {
  it("deliverPermission body never contains kind:form", async () => {
    mockOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await deliverPermission(
      "s1",
      "00000000-0000-0000-0000-000000000003",
      "allow",
    );

    const call = fetchSpy.mock.calls[0];
    const body = (call?.[1] as RequestInit | undefined)?.body as string;

    expect(body).not.toContain('"kind":"form"');
    expect(body).toContain('"kind":"permission"');
  });

  it("cancelPermission body never contains kind:form", async () => {
    mockOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await cancelPermission(
      "s1",
      "00000000-0000-0000-0000-000000000004",
      "reason",
    );

    const call = fetchSpy.mock.calls[0];
    const body = (call?.[1] as RequestInit | undefined)?.body as string;

    expect(body).not.toContain('"kind":"form"');
    expect(body).toContain('"kind":"permission"');
  });
});
