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
  checkpointSession,
  createSession,
  deleteSession,
  listSessions,
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
  prompt: "go",
  executor: { agent: "claude" as const, model: "claude-sonnet-4-6" },
};

describe("createSession", () => {
  it("returns sessionId+pid on 201", async () => {
    mockOnce(
      new Response(JSON.stringify({ sessionId: "s1", pid: 4242 }), {
        status: 201,
      }),
    );

    const result = await createSession(validInput);

    expect(result).toEqual({ sessionId: "s1", pid: 4242 });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://supervisor:7777/sessions",
      expect.objectContaining({ method: "POST" }),
    );
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

describe("checkpointSession", () => {
  it("resolves on 202", async () => {
    mockOnce(
      new Response(JSON.stringify({ status: "deferred" }), { status: 202 }),
    );

    await expect(checkpointSession("s1")).resolves.toBeUndefined();
  });

  it("rejects with CHECKPOINT fallback on 500", async () => {
    mockOnce(new Response("oops", { status: 500 }));

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
