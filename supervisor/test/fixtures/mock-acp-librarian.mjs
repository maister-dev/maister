#!/usr/bin/env node
// ADR-185 (T2.14): a mock ACP adapter for the personal librarian round trip.
// The prompt carries a scripted plan as a fenced ```json block:
//   {"calls":[{"tool":"project_list","args":{}}],"reply":"Found {{results}}"}
// For each call the adapter asks permission for `mcp__maister__<tool>` — the
// claude ordering, so the supervisor's capability_guard arbitrates it — then
// calls the tool on the `maister` stdio MCP server the session was given, and
// finally replies with `reply`, `{{results}}` replaced by a compact JSON of
// the outcomes. Logs go to stderr only; stdout is the ACP channel.
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OPTIONS = [
  { optionId: "allow", kind: "allow_once", name: "Allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
];

function log(message, fields = {}) {
  process.stderr.write(
    `${JSON.stringify({ fixture: "mock-acp-librarian", message, ...fields })}\n`,
  );
}

function promptText(prompt) {
  return (prompt ?? [])
    .map((block) => (block?.type === "text" ? block.text : ""))
    .join("\n");
}

function readPlan(text) {
  const match = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1);

  if (!match) return { calls: [], reply: "ok" };
  try {
    const plan = JSON.parse(match[1]);

    return {
      calls: Array.isArray(plan.calls) ? plan.calls : [],
      reply: typeof plan.reply === "string" ? plan.reply : "ok",
    };
  } catch {
    return { calls: [], reply: "ok" };
  }
}

function envRecord(env) {
  if (Array.isArray(env))
    return Object.fromEntries(env.map((entry) => [entry.name, entry.value]));

  return env ?? {};
}

class LibrarianAgent {
  constructor(connection) {
    this.connection = connection;
    this.servers = new Map();
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {},
        sessionCapabilities: { resume: {} },
      },
    };
  }

  async newSession(params) {
    const sessionId = `mock-librarian-${randomUUID()}`;

    this.servers.set(sessionId, params.mcpServers ?? []);

    return { sessionId };
  }

  async resumeSession(params) {
    this.servers.set(params.sessionId, params.mcpServers ?? []);

    return {};
  }

  async loadSession() {
    return {};
  }

  async closeSession() {
    return {};
  }

  async listSessions() {
    return { sessions: [] };
  }

  async setSessionMode() {
    return {};
  }

  async setSessionConfigOption() {
    return { configOptions: [] };
  }

  async authenticate() {
    return {};
  }

  async cancel() {}

  async callTools(sessionId, calls) {
    const server = (this.servers.get(sessionId) ?? []).find(
      (entry) => entry.name === "maister",
    );
    const results = [];

    if (calls.length === 0) return results;
    if (!server) return [{ error: "no maister server" }];
    const client = new Client({ name: "mock-acp-librarian", version: "1.0.0" });

    await client.connect(
      new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...process.env, ...envRecord(server.env) },
        stderr: "inherit",
      }),
    );
    try {
      for (const call of calls) {
        if (Number.isSafeInteger(call.delayMs) && call.delayMs > 0)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(call.delayMs, 10_000)),
          );
        const toolCallId = `tc-${randomUUID()}`;
        const permission = await this.connection.requestPermission({
          sessionId,
          toolCall: {
            toolCallId,
            kind: "other",
            title: `mcp__maister__${call.tool}`,
          },
          options: OPTIONS,
        });
        const allowed =
          permission.outcome.outcome === "selected" &&
          permission.outcome.optionId === "allow";

        if (!allowed) {
          results.push({ tool: call.tool, denied: true });
          continue;
        }
        const output = await client.callTool({
          name: call.tool,
          arguments: call.args ?? {},
        });
        const text = output.content?.find((part) => part.type === "text")?.text;

        results.push({
          tool: call.tool,
          isError: output.isError === true,
          text: typeof text === "string" ? text.slice(0, 400) : null,
        });
      }
    } finally {
      await client.close();
    }
    log("tools called", { count: results.length });

    return results;
  }

  async prompt(params) {
    const plan = readPlan(promptText(params.prompt));
    const results = await this.callTools(params.sessionId, plan.calls);
    const reply = plan.reply.replace("{{results}}", JSON.stringify(results));

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: reply },
      },
    });

    return { stopReason: "end_turn" };
  }
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);

new acp.AgentSideConnection(
  (connection) => new LibrarianAgent(connection),
  acp.ndJsonStream(input, output),
);

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

setInterval(() => {}, 1 << 30);
