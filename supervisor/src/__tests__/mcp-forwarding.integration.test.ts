// T4.5-C (RED): the supervisor must forward capability MCP server defs from
// StartSessionRequest.mcpServers onto the ACP wire via
// connection.newSession({ cwd, mcpServers: [...] }), resolving each envKey to
// its VALUE from the supervisor's OWN process.env (secrets stay host-side).
//
// This test is RED today because:
//   (a) StartSessionRequestSchema is `.strict()` and has NO `mcpServers` key,
//       so POST /sessions returns 409 PRECONDITION (unknown key), AND
//   (b) acp-client.ts hardcodes `newSession({ ..., mcpServers: [] })`, so even
//       if the field were accepted the adapter would never see the server.
//
// The recording mock adapter (mock-acp-record-newsession.mjs) writes the
// params it receives in `newSession` (cwd + mcpServers) to a JSON file. The
// test reads that file back and asserts the github server arrived with its
// env resolved to the sentinel value.
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
  it("passes mcpServers to newSession with env resolved from supervisor process.env", async () => {
    if (!booted) throw new Error("not booted");
    const { recordPath } = booted;

    const res = await createSession(booted, [
      {
        name: "github",
        command: "github-mcp",
        args: [],
        envKeys: [SENTINEL_ENV_KEY],
      },
    ]);

    // RED reason (a): schema is `.strict()` with no `mcpServers` key, so the
    // unknown key trips Zod and the route returns 409 PRECONDITION here.
    expect(res.status).toBe(201);

    const record = await readRecord(recordPath);

    // RED reason (b): acp-client.ts hardcodes `mcpServers: []`, so even when
    // the schema accepts the field the adapter receives an empty array.
    const github = (record.mcpServers as Array<Record<string, unknown>>).find(
      (s) => s.name === "github",
    );

    expect(github).toBeDefined();
    expect(github?.command).toBe("github-mcp");
    expect(github?.args).toEqual([]);
    expect(github?.env).toContainEqual({
      name: SENTINEL_ENV_KEY,
      value: SENTINEL_ENV_VALUE,
    });
  });

  it("forwards literal env values, which win over same-named envKeys (M34, agent-token channel)", async () => {
    if (!booted) throw new Error("not booted");
    const { recordPath } = booted;

    const res = await createSession(booted, [
      {
        name: "maister",
        command: "maister-facade",
        args: ["--stdio"],
        envKeys: [SENTINEL_ENV_KEY],
        env: {
          [SENTINEL_ENV_KEY]: "literal-wins",
          MAISTER_PROJECT_TOKEN: "tok_ephemeral",
        },
      },
    ]);

    expect(res.status).toBe(201);

    const record = await readRecord(recordPath);
    const maister = (record.mcpServers as Array<Record<string, unknown>>).find(
      (s) => s.name === "maister",
    );
    const env = maister?.env as Array<{ name: string; value: string }>;

    expect(env).toContainEqual({
      name: SENTINEL_ENV_KEY,
      value: "literal-wins",
    });
    expect(env).toContainEqual({
      name: "MAISTER_PROJECT_TOKEN",
      value: "tok_ephemeral",
    });
    expect(env.filter((e) => e.name === SENTINEL_ENV_KEY)).toHaveLength(1);
  });

  it("forwards an http MCP server as type=http with url + headers resolved from process.env (M27/T-C4)", async () => {
    if (!booted) throw new Error("not booted");
    const { recordPath } = booted;

    const res = await createSession(booted, [
      {
        name: "remote",
        transport: "http",
        url: "https://mcp.example.com/sse",
        headerKeys: [SENTINEL_ENV_KEY],
      },
    ]);

    expect(res.status).toBe(201);

    const record = await readRecord(recordPath);
    const remote = (record.mcpServers as Array<Record<string, unknown>>).find(
      (s) => s.name === "remote",
    );

    expect(remote).toBeDefined();
    expect(remote?.type).toBe("http");
    expect(remote?.url).toBe("https://mcp.example.com/sse");
    expect(remote?.headers).toContainEqual({
      name: SENTINEL_ENV_KEY,
      value: SENTINEL_ENV_VALUE,
    });
    expect(remote?.command).toBeUndefined();
  });
});
