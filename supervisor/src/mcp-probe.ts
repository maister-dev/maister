import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ADR-129 (W-F): a real MCP `initialize` handshake against a target server. The
// web tier sends NAMES only (`envKeys`/`headerKeys`); the supervisor resolves
// their VALUES from `process.env` — a value never crosses the wire or a log.
// Deferred-release: `transport.close()` (SDK: SIGTERM → grace → SIGKILL) runs on
// EVERY path (success, handshake error, timeout, spawn error) in `finally`.

export const MCP_PROBE_TIMEOUT_MS = Number(
  process.env.MAISTER_MCP_PROBE_TIMEOUT_MS ?? 8_000,
);

export type McpProbeRequest = {
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  envKeys?: string[];
  url?: string;
  headerKeys?: string[];
};

export type McpProbeResult = {
  ok: boolean;
  latencyMs?: number;
  serverInfo?: { name: string; version: string } | null;
  reason?: string;
};

export type ProbeOptions = {
  timeoutMs?: number;
  // Test seam: inject a transport (e.g. to spy on close for the deferred-release
  // regression) instead of building the real SDK transport from the request.
  createTransport?: (req: McpProbeRequest) => Transport;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Resolve env-var NAMES → { NAME: value } from the supervisor's process.env.
// NAMES come from the web tier; VALUES are read here, never transmitted.
function resolveNames(
  names: readonly string[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const raw of names ?? []) {
    const name = raw.startsWith("env:") ? raw.slice(4) : raw;

    out[name] = process.env[name] ?? "";
  }

  return out;
}

// Build the transport-appropriate SDK client transport from a NAMES-only request.
// Exported so the "three transports shaped correctly" contract is unit-testable.
export function buildMcpTransport(req: McpProbeRequest): Transport {
  if (req.transport === "stdio") {
    return new StdioClientTransport({
      command: req.command ?? "",
      args: req.args ?? [],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...resolveNames(req.envKeys),
      },
      stderr: "ignore",
    });
  }

  const url = new URL(req.url ?? "");
  const headers = resolveNames(req.headerKeys);
  const requestInit = { headers };

  return req.transport === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`mcp probe timed out after ${ms}ms`)),
      ms,
    );

    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function probeMcpServer(
  req: McpProbeRequest,
  opts: ProbeOptions = {},
): Promise<McpProbeResult> {
  const timeoutMs = opts.timeoutMs ?? MCP_PROBE_TIMEOUT_MS;
  const transport = (opts.createTransport ?? buildMcpTransport)(req);
  const client = new Client(
    { name: "maister-mcp-probe", version: "1.0.0" },
    { capabilities: {} },
  );
  const startedAt = Date.now();

  try {
    const connect = client.connect(transport);

    // On timeout the connect promise loses the race but keeps running; closing
    // the transport rejects it. Swallow that late rejection.
    connect.catch(() => {});
    await withTimeout(timeoutMs, connect);

    const info = client.getServerVersion();

    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      serverInfo: info ? { name: info.name, version: info.version } : null,
    };
  } catch (err) {
    return { ok: false, reason: errorMessage(err) };
  } finally {
    // Deferred-release on EVERY path — SDK close() escalates SIGTERM → SIGKILL.
    await transport.close().catch(() => {});
  }
}
