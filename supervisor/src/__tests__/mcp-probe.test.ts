import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { describe, expect, it, vi } from "vitest";

import {
  buildMcpTransport,
  probeMcpServer,
  type McpProbeRequest,
} from "../mcp-probe";

// ADR-129 (W-F): real MCP initialize handshake with deferred-release teardown.

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "_fixtures",
  "fake-mcp-server.mjs",
);

const stdio = (mode: string): McpProbeRequest => ({
  transport: "stdio",
  command: process.execPath,
  args: [FIXTURE, mode],
});

describe("probeMcpServer", () => {
  it("completes the initialize handshake and returns serverInfo (happy path)", async () => {
    const result = await probeMcpServer(stdio("ok"), { timeoutMs: 8_000 });

    expect(result.ok).toBe(true);
    expect(result.serverInfo).toEqual({ name: "fake-mcp", version: "9.9.9" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("times out on a non-responsive server AND releases the child (deferred-release)", async () => {
    // Wrap the real stdio transport so we can spy on close() and read its pid.
    let captured: StdioClientTransport | null = null;
    const createTransport = (req: McpProbeRequest): Transport => {
      const t = buildMcpTransport(req) as StdioClientTransport;

      captured = t;
      vi.spyOn(t, "close");

      return t;
    };

    const result = await probeMcpServer(stdio("hang"), {
      timeoutMs: 400,
      createTransport,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timed out/);
    // close() ran in finally (SDK escalates SIGTERM → SIGKILL) — deferred-release.
    expect(captured!.close).toHaveBeenCalledTimes(1);
    // The spawned child is gone (no orphan): its pid no longer signals.
    const pid = captured!.pid;

    if (pid) {
      // Give the SIGTERM/close a beat to land.
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });

  it("returns ok:false with a reason when the command cannot spawn", async () => {
    const result = await probeMcpServer(
      {
        transport: "stdio",
        command: "definitely-not-a-real-binary-xyz",
        args: [],
      },
      { timeoutMs: 2_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe("buildMcpTransport — three transports shaped correctly", () => {
  it("builds a StdioClientTransport for stdio", () => {
    const t = buildMcpTransport({
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      envKeys: ["FOO"],
    });

    expect(t).toBeInstanceOf(StdioClientTransport);
  });

  it("builds a StreamableHTTPClientTransport for http", () => {
    const t = buildMcpTransport({
      transport: "http",
      url: "https://mcp.example/mcp",
      headerKeys: ["Authorization"],
    });

    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it("builds an SSEClientTransport for sse", () => {
    const t = buildMcpTransport({
      transport: "sse",
      url: "https://mcp.example/sse",
    });

    expect(t).toBeInstanceOf(SSEClientTransport);
  });
});
