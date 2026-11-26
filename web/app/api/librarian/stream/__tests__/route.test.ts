import { getEventListeners } from "node:events";

import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requireActiveSessionMock = vi.fn(async () => ({
  id: "user-1",
  role: "member",
  accountStatus: "active",
  mustChangePassword: false,
}));

const librarianStreamFramesMock = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireActiveSession: () => requireActiveSessionMock(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({}),
}));

vi.mock("@/lib/librarian/stream", () => ({
  librarianStreamFrames: (input: { signal: AbortSignal }) =>
    librarianStreamFramesMock(input),
}));

type RouteModule = typeof import("../route");
let route: RouteModule;

beforeAll(async () => {
  route = await import("../route");
});

describe("GET /api/librarian/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActiveSessionMock.mockResolvedValue({
      id: "user-1",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    });
  });

  it("leaves zero abort listeners on request.signal after reader.cancel()", async () => {
    let observedSignal: AbortSignal | null = null;
    let returned = false;

    librarianStreamFramesMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) => {
        observedSignal = signal;

        return (async function* () {
          try {
            yield 'data: {"type":"librarian.heartbeat"}\n\n';
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();

                return;
              }
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          } finally {
            returned = true;
          }
        })();
      },
    );

    const requestController = new AbortController();
    const request = new NextRequest("http://localhost/api/librarian/stream", {
      signal: requestController.signal,
    });
    const response = await route.GET(request);

    expect(response.status).toBe(200);
    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);

    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain(
      "librarian.heartbeat",
    );
    expect(observedSignal).not.toBeNull();
    expect(observedSignal!.aborted).toBe(false);

    await reader.cancel();

    expect(observedSignal!.aborted).toBe(true);
    expect(returned).toBe(true);
    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
  });

  it("exits cleanly with zero abort listeners for a pre-aborted request", async () => {
    let observedSignal: AbortSignal | null = null;
    let yielded = false;

    librarianStreamFramesMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) => {
        observedSignal = signal;

        return (async function* () {
          if (signal.aborted) return;
          yielded = true;
          yield 'data: {"type":"librarian.heartbeat"}\n\n';
        })();
      },
    );

    const requestController = new AbortController();

    requestController.abort();
    const request = new NextRequest("http://localhost/api/librarian/stream", {
      signal: requestController.signal,
    });
    const response = await route.GET(request);

    expect(response.status).toBe(200);
    expect(observedSignal).not.toBeNull();
    expect(observedSignal!.aborted).toBe(true);

    const reader = response.body!.getReader();
    const result = await reader.read();

    expect(result).toEqual({ done: true, value: undefined });
    expect(yielded).toBe(false);
    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
  });
});
