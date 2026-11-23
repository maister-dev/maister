import type { SupervisorError } from "../types";

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import * as acp from "@agentclientprotocol/sdk/unstable";
import { expect, it } from "vitest";

import { classifyAcpMethodError } from "../acp-client";
import { connectAcpClient } from "../acp-connection";
import { clientCapabilitiesForAdapter } from "../adapter-registry";
import { boundedAcpStream, captureAcpFrames } from "../bounded-acp-stream";

async function startCodexFixture(mode: string) {
  const cwd = await mkdtemp(join(tmpdir(), "maister-codex-context-"));
  const fixture = fileURLToPath(
    new URL(
      "../../test/fixtures/codex-context-app-server.mjs",
      import.meta.url,
    ),
  );
  const binary = fileURLToPath(
    new URL(
      "../../node_modules/@agentclientprotocol/codex-acp/dist/index.js",
      import.meta.url,
    ),
  );
  const child = spawn(process.execPath, [binary], {
    cwd,
    env: {
      HOME: cwd,
      CODEX_HOME: cwd,
      PATH: process.env.PATH,
      CODEX_PATH: fixture,
      MAISTER_CODEX_CONTEXT_FIXTURE: mode,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = once(child, "close");

  return {
    cwd,
    child,
    async stop(): Promise<void> {
      child.stdin.end();
      child.kill();
      await exited;
    },
  };
}

it.each([
  ["notification", true],
  ["completion", true],
  ["budget", false],
  ["retry-warning", false],
  ["out-of-turn", false],
  ["success", false],
] as const)(
  "preserves terminal Codex context evidence on the pinned wire for %s",
  async (mode, overflow) => {
    const { cwd, child, stop } = await startCodexFixture(mode);

    try {
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      const connection = connectAcpClient(stream, {
        sessionUpdate: async () => {},
      });
      const init = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: clientCapabilitiesForAdapter("codex"),
      });

      expect(init.agentInfo?.version).toBe("2.9.0");
      expect(init.protocolVersion).toBe(1);
      const { sessionId } = await connection.newSession({
        cwd,
        mcpServers:
          mode === "success"
            ? [
                {
                  name: "path-mcp",
                  command: "node",
                  args: ["--version"],
                  env: [],
                },
              ]
            : [],
      });
      const result = connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Context fixture" }],
      });

      if (overflow) {
        const rejection: unknown = await result.catch(
          (error: unknown) => error,
        );

        expect(rejection).toMatchObject({
          code: -32603,
          data: { codexErrorInfo: "contextWindowExceeded" },
        });
        expect(
          classifyAcpMethodError({
            adapter: "codex",
            method: "prompt",
            err: rejection,
          }),
        ).toMatchObject({
          code: "ACP_PROTOCOL",
          details: { reason: "context_exhausted" },
        });
      } else {
        await expect(result).resolves.toMatchObject({ stopReason: "end_turn" });
      }
    } finally {
      await stop();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15_000,
);

it("resumes the retained Codex session through its auth status notification", async () => {
  const { cwd, child, stop } = await startCodexFixture("success");
  const failures: SupervisorError[] = [];
  const authEnvelopes: Array<{
    method: string;
    kind: "request" | "notification";
  }> = [];
  let finishDrain: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    finishDrain = resolve;
  });
  const log = createWriteStream(join(cwd, "stdout.log"), {
    flags: "wx",
    mode: 0o600,
  });
  const source = captureAcpFrames({
    source: child.stdout,
    directory: cwd,
    log,
    onFailure: (error) => failures.push(error),
    onDrained: finishDrain,
  });
  const connection = connectAcpClient(
    boundedAcpStream({
      source,
      stdin: child.stdin,
      adapter: "codex",
      client: {
        async sessionUpdate() {},
        async requestPermission() {
          return { outcome: { outcome: "cancelled" } };
        },
      },
      onLine(line) {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.method === "auth/status_update")
          authEnvelopes.push({
            method: message.method,
            kind: "id" in message ? "request" : "notification",
          });
      },
      onFailure: (error) => {
        failures.push(error);
        source.destroy();
      },
    }),
  );

  try {
    const init = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: clientCapabilitiesForAdapter("codex"),
    });
    expect(init.agentInfo?.version).toBe("2.9.0");
    const sessionId = "context-fixture-thread";
    const resumed = await connection
      .resumeSession({ cwd, sessionId, mcpServers: [] })
      .catch((error: unknown) => error);

    expect(authEnvelopes).toContainEqual({
      method: "auth/status_update",
      kind: "notification",
    });
    expect(failures.map((error) => error.details)).toEqual([]);
    expect(resumed).toMatchObject({ configOptions: expect.any(Array) });
    await expect(
      connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Resume fixture" }],
      }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
  } finally {
    await stop();
    await drained;
    await rm(cwd, { recursive: true, force: true });
  }
}, 15_000);
