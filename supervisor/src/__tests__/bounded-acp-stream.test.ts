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
  counts: null as {
    write: number;
    read: number;
    truncate: number;
  } | null,
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

      const handle = await actual.open(...args);
      const counts = spoolGate.counts;

      if (counts) {
        const origWrite = handle.write.bind(handle);
        const origRead = handle.read.bind(handle);
        const origTruncate = handle.truncate.bind(handle);

        handle.write = ((...writeArgs: unknown[]) => {
          counts.write += 1;

          return (origWrite as (...a: unknown[]) => unknown)(...writeArgs);
        }) as typeof handle.write;
        handle.read = ((...readArgs: unknown[]) => {
          counts.read += 1;

          return (origRead as (...a: unknown[]) => unknown)(...readArgs);
        }) as typeof handle.read;
        handle.truncate = ((...truncArgs: unknown[]) => {
          counts.truncate += 1;

          return (origTruncate as (...a: unknown[]) => unknown)(...truncArgs);
        }) as typeof handle.truncate;
      }

      return handle;
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
  it.each([
    ["auth/status_update", { id: null }, "request", "auth/status_update"],
    ["future/update", {}, "notification", "future/update"],
    ["unsafe\nmethod", {}, "notification", undefined],
    [`future/${"x".repeat(128)}`, {}, "notification", undefined],
  ] as const)(
    "refuses method %s and reports only bounded envelope metadata",
    async (method, id, acpMessageKind, acpMethod) => {
      const source = new PassThrough({ objectMode: true });
      const stdin = new PassThrough();
      const failures: SupervisorError[] = [];
      const reader = boundedAcpStream({
        source,
        stdin,
        client: createClient().client,
        onFailure: (error) => failures.push(error),
      }).readable.getReader();

      try {
        source.end(
          Buffer.from(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method,
              ...id,
              params: { private: "fixture content" },
            })}\n`,
          ),
        );
        await expect(reader.read()).rejects.toMatchObject({
          code: "ACP_PROTOCOL",
        });
        expect(failures.map((failure) => failure.details)).toEqual([
          {
            reason: "required_output_incomplete",
            outputFailure: "producer_method_unsupported",
            acpMessageKind,
            ...(acpMethod ? { acpMethod } : {}),
          },
        ]);
      } finally {
        reader.releaseLock();
        source.destroy();
        stdin.destroy();
      }
    },
  );

  it("keeps the prompt response reachable after malformed optional context frames", async () => {
    const source = new PassThrough({ objectMode: true });
    const stdin = new PassThrough();
    const { client, messages } = createClient();
    const onFailure = vi.fn();
    const reader = boundedAcpStream({
      source,
      stdin,
      client,
      onFailure,
      adapter: "codex",
    }).readable.getReader();

    try {
      for (const update of [
        { sessionUpdate: "usage_update", used: null, size: 100 },
        {
          sessionUpdate: "compaction_summary_chunk",
          compactionId: "one",
          content: {},
        },
        { sessionUpdate: "usage_update", used: 0, size: 100 },
      ]) {
        source.write(
          Buffer.from(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: "context-test", update },
            })}\n`,
          ),
        );
      }
      source.end(
        Buffer.from(
          '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}\n',
        ),
      );

      await expect(reader.read()).resolves.toMatchObject({
        value: { result: { stopReason: "end_turn" } },
      });
      expect(messages).toHaveLength(1);
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      await reader.cancel();
      reader.releaseLock();
      source.destroy();
      stdin.destroy();
    }
  });

  it.each([
    {
      label: "oversized identity",
      name: "x".repeat(5000),
      permissionKind: "read",
      permissionName: undefined,
      outputFailure: "producer_retained_limit",
    },
    {
      label: "contradictory tool kind",
      name: "Read",
      permissionKind: "execute",
      permissionName: undefined,
      outputFailure: "producer_permission_invalid",
    },
    {
      label: "contradictory tool identity",
      name: "Read",
      permissionKind: "read",
      permissionName: "Bash",
      outputFailure: "producer_permission_invalid",
    },
  ] as const)(
    "refuses $label before dispatching a permission callback",
    async ({ name, permissionKind, permissionName, outputFailure }) => {
      const source = new PassThrough({ objectMode: true });
      const stdin = new PassThrough();
      const failures: SupervisorError[] = [];
      let permissionCalls = 0;
      const stream = boundedAcpStream({
        source,
        stdin,
        client: {
          async sessionUpdate() {},
          async requestPermission(_params, prepared) {
            permissionCalls += 1;
            prepared?.();

            return { outcome: { outcome: "cancelled" } };
          },
        },
        onFailure: (error) => failures.push(error),
      });
      const reader = stream.readable.getReader();
      const frames = [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "bounded-identity",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "one",
              title: "Read",
              kind: "read",
              status: "pending",
              _meta: { claudeCode: { toolName: name } },
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "session/request_permission",
          params: {
            sessionId: "bounded-identity",
            toolCall: {
              toolCallId: "one",
              title: "Controlled file",
              kind: permissionKind,
              ...(permissionName
                ? { _meta: { claudeCode: { toolName: permissionName } } }
                : {}),
            },
            options: [{ optionId: "deny", kind: "reject_once", name: "Deny" }],
          },
        },
      ];

      try {
        for (const frame of frames)
          source.write(Buffer.from(`${JSON.stringify(frame)}\n`));
        source.end();
        await expect(reader.read()).rejects.toMatchObject({
          code: "ACP_PROTOCOL",
          details: { reason: "required_output_incomplete", outputFailure },
        });
        expect(permissionCalls).toBe(0);
        expect(failures).toHaveLength(1);
      } finally {
        reader.releaseLock();
        source.destroy();
        stdin.destroy();
      }
    },
  );

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

  it("fast-paths complete in-memory frames with zero spool disk I/O and a single UTF-8 decode per frame", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bounded-acp-fastpath-"));
    const source = new PassThrough();
    const stdin = new PassThrough();
    const failures: SupervisorError[] = [];
    const { client, messages } = createClient();
    const counts = { write: 0, read: 0, truncate: 0 };

    spoolGate.counts = counts;
    const decodeSpy = vi.spyOn(TextDecoder.prototype, "decode");
    let resolveDrained: () => void = () => {};
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });
    const notifications = [1, 2, 3].map((n) => ({
      jsonrpc: "2.0" as const,
      method: "session/update" as const,
      params: {
        sessionId: "fastpath-session",
        update: {
          sessionUpdate: "agent_message_chunk" as const,
          content: { type: "text" as const, text: `chunk-${n}` },
        },
      },
    }));
    const result = {
      jsonrpc: "2.0" as const,
      id: 7,
      result: { stopReason: "end_turn" },
    };
    const tap = captureAcpFrames({
      source,
      directory,
      log: createWriteStream(join(directory, "stdout.log")),
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
      source.write(
        `${notifications.map((n) => JSON.stringify(n)).join("\n")}\n${JSON.stringify(result)}\n`,
      );
      source.end();

      const next = await reader.read();

      expect(next.done).toBe(false);
      expect(next.value).toEqual(result);
      await expect(reader.read()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      await drained;
      expect(failures).toEqual([]);
      expect(messages).toEqual(notifications);
      expect(counts).toEqual({ write: 0, read: 0, truncate: 0 });
      expect(decodeSpy).toHaveBeenCalledTimes(notifications.length + 1);
    } finally {
      spoolGate.counts = null;
      decodeSpy.mockRestore();
      await reader.cancel();
      source.destroy();
      stdin.destroy();
      await drained;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid UTF-8 bytes on the fast-path even when onLine is unset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bounded-acp-bad-utf8-"));
    const source = new PassThrough();
    const failures: SupervisorError[] = [];
    let resolveDrained: () => void = () => {};
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });
    const tap = captureAcpFrames({
      source,
      directory,
      log: createWriteStream(join(directory, "stdout.log")),
      onFailure: (error) => failures.push(error),
      onDrained: resolveDrained,
    });

    tap.on("error", () => {});
    try {
      source.end(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
      const iter = tap[Symbol.asyncIterator]();

      await expect(iter.next()).rejects.toMatchObject({
        code: "ACP_PROTOCOL",
        details: { reason: "required_output_incomplete" },
      });
      await drained;
      expect(failures).toHaveLength(1);
      expect(failures[0]?.code).toBe("ACP_PROTOCOL");
    } finally {
      source.destroy();
      await drained;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["beforeWrite", "beforeFrame"] as const)(
    "spills exact fast-path bytes to spool and publishes CapturedStdoutSegment when %s transitions to drain",
    async (trigger) => {
      const directory = await mkdtemp(
        join(tmpdir(), `bounded-acp-${trigger}-`),
      );
      const source = new PassThrough();
      const failures: SupervisorError[] = [];
      const segments: Array<{
        sizeBytes: number;
        firstLogByteOffset: number;
        completeFrames: number;
        trailingFrameBytes: number;
      }> = [];
      const spoolBytesHistory: number[] = [];
      let resolveDrained: () => void = () => {};
      const drained = new Promise<void>((resolve) => {
        resolveDrained = resolve;
      });
      let frameCalls = 0;
      let writeCalls = 0;
      const line1 = '{"a":1}\n';
      const line2 = '{"b":2}\n';
      const line3 = '{"c":3}\n';
      const tap = captureAcpFrames({
        source,
        directory,
        log: createWriteStream(join(directory, "stdout.log")),
        onFailure: (error) => failures.push(error),
        onDrained: resolveDrained,
        onSpoolBytes: (bytes) => spoolBytesHistory.push(bytes),
        onSegment: (seg) =>
          segments.push({
            sizeBytes: seg.sizeBytes,
            firstLogByteOffset: seg.firstLogByteOffset,
            completeFrames: seg.completeFrames,
            trailingFrameBytes: seg.trailingFrameBytes,
          }),
        beforeWrite: async () => {
          writeCalls += 1;

          return trigger === "beforeWrite" && writeCalls === 2
            ? { kind: "drain" }
            : { kind: "capture" };
        },
        beforeFrame: async () => {
          frameCalls += 1;

          return trigger === "beforeFrame" && frameCalls === 2
            ? { kind: "drain" }
            : { kind: "decode", release: () => {} };
        },
      });
      const yielded: string[] = [];

      tap.on("error", () => {});
      try {
        source.write(line1);
        const iter = tap[Symbol.asyncIterator]();
        const first = await iter.next();

        expect(first.done).toBe(false);
        yielded.push((first.value as Buffer).toString("utf8"));

        source.end(`${line2}${line3}`);
        await expect(iter.next()).rejects.toMatchObject({
          code: "ACP_PROTOCOL",
          details: { outputFailure: "producer_output_incomplete" },
        });
        await drained;

        const expectedSpillBytes = Buffer.byteLength(`${line2}${line3}`);

        expect(yielded).toEqual([line1]);
        expect(segments).toEqual([
          {
            sizeBytes: expectedSpillBytes,
            firstLogByteOffset: Buffer.byteLength(line1),
            completeFrames: 2,
            trailingFrameBytes: 0,
          },
        ]);
        expect(spoolBytesHistory).toContain(expectedSpillBytes);
      } finally {
        source.destroy();
        await drained;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
