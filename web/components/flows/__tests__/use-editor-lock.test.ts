import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEditorLockController,
  createEditorSessionId,
  createHttpEditorLockTransport,
  type EditorLockSnapshot,
  type EditorLockTransport,
} from "@/components/flows/use-editor-lock";

const HELD: EditorLockSnapshot = {
  held: true,
  heldByMe: true,
  holderLabel: null,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordingTransport(opts?: {
  syncDelayMs?: (mode: string) => number;
  syncImpl?: (mode: string) => Promise<EditorLockSnapshot>;
}): { transport: EditorLockTransport; calls: string[] } {
  const calls: string[] = [];
  const transport: EditorLockTransport = {
    sync: async (mode) => {
      calls.push(`sync:${mode}:start`);
      await delay(opts?.syncDelayMs?.(mode) ?? 0);
      calls.push(`sync:${mode}:end`);

      if (opts?.syncImpl) return opts.syncImpl(mode);

      return HELD;
    },
    release: async () => {
      calls.push("release:start");
      await delay(0);
      calls.push("release:end");
    },
    releaseBeacon: () => {
      calls.push("beacon");
    },
  };

  return { transport, calls };
}

describe("createEditorLockController", () => {
  it("applies lock ops in issue order even when an earlier op is slower", async () => {
    // The 13d9d1674 race: an unmount release settling after a later acquire
    // silently cleared the fresh lock while the editor still showed itself as
    // the holder.
    const { transport, calls } = recordingTransport({
      syncDelayMs: (mode) => (mode === "acquire" ? 30 : 0),
    });
    const controller = createEditorLockController({
      transport,
      onState: () => undefined,
    });

    const acquired = controller.acquire();
    const released = controller.release();

    await Promise.all([acquired, released]);

    expect(calls).toEqual([
      "sync:acquire:start",
      "sync:acquire:end",
      "release:start",
      "release:end",
    ]);
  });

  it("degrades to read-only when a refresh fails", async () => {
    const states: EditorLockSnapshot[] = [];
    const { transport } = recordingTransport({
      syncImpl: async (mode) => {
        if (mode === "refresh") throw new Error("409");

        return HELD;
      },
    });
    const controller = createEditorLockController({
      transport,
      onState: (state) => states.push(state),
    });

    await controller.acquire();
    await controller.refresh();

    expect(states[0]).toMatchObject({ heldByMe: true });
    expect(states.at(-1)).toMatchObject({ held: false, heldByMe: false });
  });

  // The controller SWALLOWS transport errors (sync → NOT_HELD), so a failing
  // acquire never reaches the queue as a rejection — this asserts later ops
  // still run. The queue's own reject-non-wedge property is proved directly in
  // `lock-op-queue.test.ts`.
  it("runs later ops after an earlier op's transport error is swallowed", async () => {
    const { transport, calls } = recordingTransport({
      syncImpl: async (mode) => {
        if (mode === "acquire") throw new Error("boom");

        return HELD;
      },
    });
    const controller = createEditorLockController({
      transport,
      onState: () => undefined,
    });

    await controller.acquire();
    await controller.refresh();
    await controller.release();

    expect(calls).toContain("sync:refresh:end");
    expect(calls).toContain("release:end");
  });

  it("sends the teardown beacon without queueing it", () => {
    const { transport, calls } = recordingTransport();
    const controller = createEditorLockController({
      transport,
      onState: () => undefined,
    });

    controller.releaseBeacon();

    // The beacon must bypass the queue: it fires during document teardown,
    // where a chained op would never get a turn to run.
    expect(calls).toEqual(["beacon"]);
  });
});

// The HTTP transport is where a real defect lives — every controller test above
// injects a fake, so a broken URL or a swallowed !ok response is invisible to
// them. These drive the real transport against a stubbed fetch.
describe("createHttpEditorLockTransport", () => {
  const BASE = "/api/projects/demo/catalog/caps/cap-1";

  function stubFetch(
    impl: (url: string, init: RequestInit) => Promise<Response> | Response,
  ): ReturnType<typeof vi.fn> {
    // Always hand back a Promise — real `fetch` does, and `release()` chains
    // `.then` on the result directly rather than awaiting it.
    const spy = vi.fn(((url: string, init: RequestInit) =>
      Promise.resolve(impl(url, init))) as never);

    vi.stubGlobal("fetch", spy);

    return spy as ReturnType<typeof vi.fn>;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts acquire/refresh to <base>/lock-refresh with the session and mode", async () => {
    const spy = stubFetch(() =>
      Response.json({ held: true, heldByMe: true, holderLabel: null }),
    );
    const transport = createHttpEditorLockTransport(BASE, "s1");

    await transport.sync("refresh");

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`${BASE}/lock-refresh`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: "s1",
      mode: "refresh",
    });
  });

  it("normalizes a missing holderLabel to null", async () => {
    stubFetch(() => Response.json({ held: true, heldByMe: true }));
    const transport = createHttpEditorLockTransport(BASE, "s1");

    expect(await transport.sync("acquire")).toEqual({
      held: true,
      heldByMe: true,
      holderLabel: null,
    });
  });

  it("throws on a non-ok response so the controller degrades to read-only", async () => {
    stubFetch(() => Response.json({ code: "CONFLICT" }, { status: 409 }));
    const transport = createHttpEditorLockTransport(BASE, "s1");

    await expect(transport.sync("refresh")).rejects.toThrow(/409/);
  });

  it("posts release to <base>/lock-release with keepalive and swallows failures", async () => {
    const spy = stubFetch(() => Promise.reject(new Error("network down")));
    const transport = createHttpEditorLockTransport(BASE, "s1");

    // A release that rejects must not surface — it runs during teardown.
    await expect(transport.release()).resolves.toBeUndefined();

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`${BASE}/lock-release`);
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: "s1" });
  });

  it("prefers sendBeacon and falls back to fetch when it declines", () => {
    const sendBeacon = vi.fn(() => false);

    vi.stubGlobal("navigator", { sendBeacon });
    const spy = stubFetch(() => Response.json({}));
    const transport = createHttpEditorLockTransport(BASE, "s1");

    transport.releaseBeacon();

    expect(sendBeacon).toHaveBeenCalledWith(
      `${BASE}/lock-release`,
      expect.any(Blob),
    );
    // sendBeacon returned false (queue full) -> the fetch path must still run,
    // otherwise the lock leaks until its TTL expires.
    expect(spy).toHaveBeenCalledWith(
      `${BASE}/lock-release`,
      expect.objectContaining({ keepalive: true }),
    );
  });

  it("does not fall back to fetch when sendBeacon accepts the payload", () => {
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => true) });
    const spy = stubFetch(() => Response.json({}));
    const transport = createHttpEditorLockTransport(BASE, "s1");

    transport.releaseBeacon();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("createEditorSessionId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses crypto.randomUUID when available", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "uuid-from-crypto" });

    expect(createEditorSessionId()).toBe("uuid-from-crypto");
  });

  it("falls back to a unique id when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});

    const a = createEditorSessionId();
    const b = createEditorSessionId();

    expect(a).toMatch(/^el-/);
    expect(a).not.toBe(b);
  });
});
