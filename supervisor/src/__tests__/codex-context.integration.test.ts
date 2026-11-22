import { spawn } from "node:child_process";
import { once } from "node:events";
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
      child.stdin.end();
      child.kill();
      await exited;
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15_000,
);
