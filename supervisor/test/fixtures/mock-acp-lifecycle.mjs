#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const args = process.argv.slice(2);
let lines = 3;
let exitCode = 0;
let hang = false;
let hangInitialize = false;
let hangNewSession = false;
let hangPrompt = false;
let hangPermission = false;
let exitDelayMs = 0;
let emitUsage = false;
const outputWrites = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];

  if (arg === "--lines") {
    lines = Number.parseInt(args[++i], 10);
  } else if (arg === "--exit-code") {
    exitCode = Number.parseInt(args[++i], 10);
  } else if (arg === "--hang") {
    hang = true;
  } else if (arg === "--hang-initialize") {
    hangInitialize = true;
  } else if (arg === "--hang-new-session") {
    hangNewSession = true;
  } else if (arg === "--hang-prompt") {
    hangPrompt = true;
  } else if (arg === "--hang-permission") {
    hangPermission = true;
  } else if (arg === "--exit-delay-ms") {
    exitDelayMs = Number.parseInt(args[++i], 10);
  } else if (arg === "--emit-usage") {
    emitUsage = true;
  } else if (arg === "--write-env") {
    outputWrites.push({ envName: args[++i], content: args[++i] });
  }
}

function never() {
  return new Promise(() => {});
}

class LifecycleAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize() {
    if (hangInitialize) return never();

    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  async newSession() {
    if (hangNewSession) return never();

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
    for (const output of outputWrites) {
      const outputPath = process.env[output.envName];

      if (!outputPath) {
        throw new Error(`missing required output environment ${output.envName}`);
      }
      await writeFile(outputPath, output.content, { encoding: "utf8", mode: 0o600 });
    }

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

    // ADR-166 F10: park the turn on an OPEN permission request so an eviction
    // lands while the deferred is pending; the outcome is irrelevant (the
    // eviction SIGTERMs us), so the turn stays open afterwards.
    if (hangPermission) {
      await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "call-1",
          title: "write file",
          kind: "edit",
          status: "pending",
        },
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      });

      return never();
    }

    // ADR-166 F6: keep the turn open forever so an eviction lands mid-prompt.
    if (hangPrompt) return never();

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

// --exit-delay-ms: hold the process open after SIGTERM so a test can prove an
// eviction is awaited (nothing spawns beside a dying lower-epoch session).
process.on("SIGTERM", () => setTimeout(() => process.exit(143), exitDelayMs));
process.on("SIGINT", () => process.exit(130));

setInterval(() => {}, 1 << 30);
