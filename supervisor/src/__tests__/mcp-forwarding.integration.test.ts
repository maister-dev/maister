// T4.5-C + ADR-179: the supervisor forwards capability MCP server defs from
// StartSessionRequest.mcpServers onto the ACP wire via
// connection.newSession({ cwd, mcpServers: [...] }), resolving each `env:NAME`
// value from the supervisor's OWN process.env and passing each literal
// verbatim (the value behind a reference stays host-side).
//
// The recording mock adapter (mock-acp-record-newsession.mjs) writes the params
// it receives in `newSession` (cwd + mcpServers) to a JSON file. The test reads
// that file back and asserts the shape the adapters actually accept — in
// particular that a stdio entry stays UNTAGGED, because claude-agent-acp
// silently DROPS a server carrying an explicit `type:"stdio"`.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bootHost,
  cleanupRuntimeRoot,
  createEnvelope,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

const SENTINEL_ENV_KEY = "TEST_MCP_TOKEN";
const SENTINEL_ENV_VALUE = "tok-123";

type BootResult = BootedHost & { recordPath: string };

async function boot(): Promise<BootResult> {
  const host = await bootHost({ fixture: "mock-acp-record-newsession.mjs" });

  return {
    ...host,
    recordPath: join(host.runtimeRoot, "newsession-record.json"),
  };
}

async function createSession(
  host: BootedHost,
  mcpServers: Array<Record<string, unknown>>,
) {
  return postJson(
    `${host.url}/sessions`,
    await createEnvelope(host, { runId: "run-mcp" }, { mcpServers }),
  );
}

async function readRecord(
  recordPath: string,
  maxMs = 5_000,
): Promise<{ cwd: string; mcpServers: unknown[] }> {
  const deadline = Date.now() + maxMs;

  for (;;) {
    try {
      return JSON.parse(await readFile(recordPath, "utf8"));
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise<void>((r) => setTimeout(r, 25));
    }
  }
}

let booted: BootResult | null = null;
let originalSentinel: string | undefined;
const RECORD_PATH_ENV = "MOCK_ACP_NEWSESSION_RECORD_PATH";

beforeEach(async () => {
  originalSentinel = process.env[SENTINEL_ENV_KEY];
  process.env[SENTINEL_ENV_KEY] = SENTINEL_ENV_VALUE;
  booted = await boot();
  // The supervisor spawns the adapter with `...process.env`, so the recording
  // fixture reads this to know where to write the newSession params it saw.
  process.env[RECORD_PATH_ENV] = booted.recordPath;
});

afterEach(async () => {
  if (booted) {
    await booted.stop();
    await cleanupRuntimeRoot(booted.runtimeRoot);
    booted = null;
  }
  delete process.env[RECORD_PATH_ENV];
  if (originalSentinel === undefined) {
    delete process.env[SENTINEL_ENV_KEY];
  } else {
    process.env[SENTINEL_ENV_KEY] = originalSentinel;
  }
});

describe("T4.5-C — supervisor forwards capability MCP servers to ACP adapter", () => {
  it("forwards a stdio env map: a reference resolves, a literal passes verbatim, ${X} stays literal", async () => {
    if (!booted) throw new Error("not booted");
    const { recordPath } = booted;

    const res = await createSession(booted, [
      {
        name: "github",
        command: "github-mcp",
        args: [],
        env: {
          [SENTINEL_ENV_KEY]: `env:${SENTINEL_ENV_KEY}`,
          FASTMCP_LOG_LEVEL: "ERROR",
          // D2: no interpolation — a provisioner substituting inside literals
          // would corrupt values meant for the server.
          TEMPLATE_LIKE: "${" + SENTINEL_ENV_KEY + "}",
          MISSING: "env:MCP_FORWARDING_ABSENT_SENTINEL",
          // M34/ADR-089: the server-GENERATED credential channel — a literal
          // that exists in no process.env.
          MAISTER_PROJECT_TOKEN: "tok_ephemeral",
        },
      },
    ]);

    expect(res.status).toBe(201);

    const record = await readRecord(recordPath);
    const github = (record.mcpServers as Array<Record<string, unknown>>).find(
      (s) => s.name === "github",
    );

    expect(github).toBeDefined();
    expect(github?.command).toBe("github-mcp");
    expect(github?.args).toEqual([]);
    // T4: stdio entries stay UNTAGGED — claude-agent-acp drops a server
    // carrying an explicit `type:"stdio"`.
    expect(github?.type).toBeUndefined();

    const env = github?.env as Array<{ name: string; value: string }>;

    expect(env).toEqual([
      { name: SENTINEL_ENV_KEY, value: SENTINEL_ENV_VALUE },
      { name: "FASTMCP_LOG_LEVEL", value: "ERROR" },
      { name: "TEMPLATE_LIKE", value: "${" + SENTINEL_ENV_KEY + "}" },
      // D3: an unset reference resolves to "", never fail-fast.
      { name: "MISSING", value: "" },
      { name: "MAISTER_PROJECT_TOKEN", value: "tok_ephemeral" },
    ]);
  });

  it("forwards an http MCP server with headers resolved and Authorization composed LAST", async () => {
    if (!booted) throw new Error("not booted");
    const { recordPath } = booted;

    const res = await createSession(booted, [
      {
        name: "remote",
        transport: "http",
        url: "https://mcp.example.com/v1",
        headers: {
          "X-Tenant": "acme",
          "X-Key": `env:${SENTINEL_ENV_KEY}`,
        },
        bearerTokenEnv: `env:${SENTINEL_ENV_KEY}`,
      },
    ]);

    expect(res.status).toBe(201);

    const record = await readRecord(recordPath);
    const remote = (record.mcpServers as Array<Record<string, unknown>>).find(
      (s) => s.name === "remote",
    );

    expect(remote).toBeDefined();
    expect(remote?.type).toBe("http");
    expect(remote?.url).toBe("https://mcp.example.com/v1");
    expect(remote?.command).toBeUndefined();

    // The MCP authorization spec fixes the header name and scheme, so the
    // composed header is appended LAST, after every declared row.
    expect(remote?.headers).toEqual([
      { name: "X-Tenant", value: "acme" },
      { name: "X-Key", value: SENTINEL_ENV_VALUE },
      { name: "Authorization", value: `Bearer ${SENTINEL_ENV_VALUE}` },
    ]);
  });

  it("forwards sse as type=sse — the adapter gate is web-side, the supervisor forwards", async () => {
    if (!booted) throw new Error("not booted");
    const { recordPath } = booted;

    const res = await createSession(booted, [
      {
        name: "legacy",
        transport: "sse",
        url: "https://mcp.example.com/sse",
        headers: { "X-Tenant": "acme" },
      },
    ]);

    expect(res.status).toBe(201);

    const record = await readRecord(recordPath);
    const legacy = (record.mcpServers as Array<Record<string, unknown>>).find(
      (s) => s.name === "legacy",
    );

    expect(legacy?.type).toBe("sse");
    expect(legacy?.url).toBe("https://mcp.example.com/sse");
  });
});
