import { describe, expect, it, vi } from "vitest";

import {
  createEditorLockController,
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

  it("releases through the queue on teardown", async () => {
    const { transport, calls } = recordingTransport();
    const controller = createEditorLockController({
      transport,
      onState: () => undefined,
    });

    await controller.acquire();
    await controller.release();

    expect(calls).toContain("release:end");
  });

  it("does not wedge the queue when an op rejects", async () => {
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

    expect(calls).toEqual(["beacon"]);
    expect(transport.releaseBeacon).toBeDefined();
  });

  it("reports a foreign live lock as read-only with its holder label", async () => {
    const onState = vi.fn();
    const { transport } = recordingTransport({
      syncImpl: async () => ({
        held: true,
        heldByMe: false,
        holderLabel: "Ada Lovelace",
      }),
    });
    const controller = createEditorLockController({ transport, onState });

    await controller.acquire();

    expect(onState).toHaveBeenCalledWith({
      held: true,
      heldByMe: false,
      holderLabel: "Ada Lovelace",
    });
  });
});
