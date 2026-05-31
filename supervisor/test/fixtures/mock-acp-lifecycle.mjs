#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const args = process.argv.slice(2);
let lines = 3;
let exitCode = 0;
let hang = false;
let emitUsage = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];

  if (arg === "--lines") {
    lines = Number.parseInt(args[++i], 10);
  } else if (arg === "--exit-code") {
    exitCode = Number.parseInt(args[++i], 10);
  } else if (arg === "--hang") {
    hang = true;
  } else if (arg === "--emit-usage") {
    emitUsage = true;
  }
}

class LifecycleAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  async newSession() {
    return { sessionId: `mock-${randomUUID()}` };
  }

  async loadSession() {
    return {};
  }

  async resumeSession() {
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

  async cancel() {
    /* no-op */
  }

  async prompt(params) {
    for (let i = 0; i < lines; i += 1) {
      const isLast = i === lines - 1;

      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `line ${i}` },
          ...(isLast && emitUsage
            ? {
                model: "claude-sonnet-4-6",
                usage: {
                  input_tokens: 100,
                  output_tokens: 200,
                  cache_creation_input_tokens: 5000,
                  cache_read_input_tokens: 0,
                },
              }
            : {}),
        },
      });
    }

    if (!hang) {
      setTimeout(() => process.exit(exitCode), 10);
    }

    return { stopReason: "end_turn" };
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new acp.AgentSideConnection(
  (connToAgent) => new LifecycleAgent(connToAgent),
  stream,
);

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

setInterval(() => {}, 1 << 30);
