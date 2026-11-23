#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { hostname } from "node:os";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serveAgent } from "../fixtures/acp-agent-app.mjs";

const record = (pairs) =>
  Object.fromEntries((pairs ?? []).map(({ name, value }) => [name, value]));
async function call(server) {
  const client = new Client({
    name: "assigned-host-qualification",
    version: "1",
  });
  const local = server.type !== "http";
  const transport = local
    ? new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: {
          NODE_ENV: "production",
          NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
          ...record(server.env),
        },
        stderr: "inherit",
      })
    : new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: record(server.headers) },
      });
  const tool = server.name === "maister" ? "project_list" : "identify";
  try {
    await client.connect(transport);
    assert.equal(process.env.MAISTER_MCP_SECRET_HTTP, undefined);
    assert.equal(process.env.MAISTER_PROJECT_TOKEN, undefined);
    const inventory = await client.listTools();
    assert(inventory.tools.some((item) => item.name === tool));
    const result = await client.callTool({ name: tool, arguments: {} });
    assert(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  } finally {
    await client.close();
  }
}

class QualificationAgent {
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {},
        mcpCapabilities: { http: true },
      },
    };
  }
  async newSession(args) {
    try {
      return await this.qualify(args);
    } catch (error) {
      await writeFile(
        args.cwd + "/tool-receipt.json",
        JSON.stringify({ error: String(error) }),
      );
      throw error;
    }
  }
  async qualify({ cwd, mcpServers }) {
    assert.equal(process.env.MAISTER_MCP_SECRET_HTTP, undefined);
    assert.equal(process.env.MAISTER_PROJECT_TOKEN, undefined);
    const inventory = mcpServers.map((s) => s.name).sort();
    const httpOnly = process.env.QUALIFICATION_ONLY_HTTP === "1";
    assert.deepEqual(
      inventory,
      httpOnly
        ? ["fixture-http"]
        : ["fixture-http", "fixture-stdio", "maister"],
    );
    const results = {};
    for (const server of mcpServers) results[server.name] = await call(server);
    assert.equal(results["fixture-http"].source, "private-http");
    if (!httpOnly) {
      assert.equal(results["fixture-stdio"].host, hostname());
      assert.throws(() => process.kill(results["fixture-stdio"].pid, 0), {
        code: "ESRCH",
      });
      assert.deepEqual(results.maister, { items: ["qualification-project"] });
    }
    await writeFile(
      cwd + "/tool-receipt.json",
      JSON.stringify({
        host: hostname(),
        inventory,
        results,
        stdioExited: !httpOnly,
      }),
    );
    return { sessionId: randomUUID() };
  }
  async closeSession() {
    return {};
  }
  async cancel() {}
}
serveAgent(
  () => new QualificationAgent(),
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
);
