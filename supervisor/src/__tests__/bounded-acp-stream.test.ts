import type { AnyMessage, Stream } from "@agentclientprotocol/sdk/unstable";
import type { BoundedAcpClient } from "../bounded-acp-stream";

import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { boundedAcpStream, captureAcpFrames } from "../bounded-acp-stream";
import { SupervisorError } from "../types";

const spoolGate = vi.hoisted(() => ({
  current: null as Readonly<{
    path: string;
    entered: () => void;
    release: Promise<void>;
  }> | null,
}));

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();

  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const gate = spoolGate.current;

      if (gate && args[0] === gate.path) {
        gate.entered();
        await gate.release;
      }

      return actual.open(...args);
    },
  };
});

function createClient(): { client: BoundedAcpClient; messages: AnyMessage[] } {
  const messages: AnyMessage[] = [];
  const client: BoundedAcpClient = {
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } };
    },
    async sessionUpdate(params) {
      messages.push({ jsonrpc: "2.0", method: "session/update", params });
    },
  };

  return { client, messages };
}

describe("bounded ACP framed-source contract", () => {
  it("refuses a byte-mode source at construction with a typed protocol error", async () => {
    const source = new PassThrough();
    const stdin = new PassThrough();
    const failures: SupervisorError[] = [];
    let stream: Stream | undefined;

    try {
      expect(() => {
        stream = boundedAcpStream({
          source,
          stdin,
          client: createClient().client,
          onFailure: (error) => failures.push(error),
        });
      }).toThrowError(
        expect.objectContaining({
          code: "ACP_PROTOCOL",
          details: {
            reason: "required_output_incomplete",
            outputFailure: "producer_frame_invalid",
          },
        }),
      );
      expect(failures).toEqual([]);
    } finally {
      await stream?.readable.cancel();
      source.destroy();
      stdin.destroy();
    }
  });

  it("retains native child stdout while the private frame spool is opening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bounded-acp-exit-"));
    const spoolPath = join(directory, "frame.tmp");
    let releaseOpen: () => void = () => {};
    let enteredOpen: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredOpen = resolve;
    });

    spoolGate.current = {
      path: spoolPath,
      entered: enteredOpen,
      release: blocked,
    };
    const bytes = "one\ntwo\nthree\n";
    const child = spawn(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(bytes)});`],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const source = child.stdout;

    if (!source) throw new Error("Native capture fixture requires stdout");
    const readableListeners = source.listenerCount("readable");
    const exited = once(child, "exit");
    const closed = once(child, "close");
    const resumed = once(source, "resume");
    const frames: string[] = [];
    const failures: unknown[] = [];
    let finishDrain: () => void = () => {};
    const drained = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    const tap = captureAcpFrames({
      source,
      directory,
      spoolPath,
      log: createWriteStream(join(directory, "stdout.log")),
      onFailure: (error) => failures.push(error),
      onDrained: finishDrain,
    });

    tap.on("data", (frame: Buffer) => frames.push(frame.toString("utf8")));
    tap.on("error", (error: unknown) => failures.push(error));
    try {
      await entered;
      await exited;
      await resumed;
      // Both arms observe the native exit-time auto-resume finishing its work:
      // preserved bytes remain buffered in readable mode; lost bytes reach EOF.
      await expect
        .poll(
          () =>
            source.readableEnded ||
            (source.readableFlowing === false &&
              source.readableLength === Buffer.byteLength(bytes)),
        )
        .toBe(true);
      releaseOpen();
      await drained;
      await closed;
      expect(source.listenerCount("readable")).toBe(readableListeners);
      expect(child.exitCode).toBe(0);
      expect(failures).toEqual([]);
      expect(frames).toEqual(["one\n", "two\n", "three\n"]);
    } finally {
      releaseOpen();
      spoolGate.current = null;
      if (child.exitCode === null) child.kill("SIGKILL");
      await closed;
      await drained;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("decodes a notification and result in order from one production-framed byte write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bounded-acp-stream-"));
    const source = new PassThrough();
    const stdin = new PassThrough();
    const failures: SupervisorError[] = [];
    const { client, messages } = createClient();
    const notification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "compat-framed-source",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "permission selected:allow" },
        },
      },
    } as const;
    const result = {
      jsonrpc: "2.0",
      id: 2,
      result: { stopReason: "end_turn" },
    } as const;
    let resolveDrained: () => void = () => {};
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });
    const tap = captureAcpFrames({
      source,
      directory,
      log: createWriteStream(join(directory, "stdout.log")),
      onLine: () => {},
      onFailure: (error) => failures.push(error),
      onDrained: resolveDrained,
    });
    const stream = boundedAcpStream({
      source: tap,
      stdin,
      client,
      onFailure: (error) => failures.push(error),
    });
    const reader = stream.readable.getReader();

    try {
      expect(tap.readableObjectMode).toBe(true);
      source.write(
        `${JSON.stringify(notification)}\n${JSON.stringify(result)}\n`,
      );
      source.end();

      const next = await reader.read();

      expect(next.done).toBe(false);
      expect(next.value).toEqual(result);
      if (!next.done) messages.push(next.value);
      expect(messages).toEqual([notification, result]);
      await expect(reader.read()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      await drained;
      expect(failures).toEqual([]);
      expect(await readdir(directory)).toEqual(["stdout.log"]);
    } finally {
      await reader.cancel();
      source.destroy();
      stdin.destroy();
      await drained;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
