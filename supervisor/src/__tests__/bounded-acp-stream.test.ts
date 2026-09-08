import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import type { BoundedAcpClient } from "../bounded-acp-stream";

import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { boundedAcpStream, captureAcpFrames } from "../bounded-acp-stream";
import { SupervisorError } from "../types";

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
