#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const STOP_REASON = process.env.MOCK_ACP_STOP_REASON ?? "end_turn";
const REQUEST_PERMISSION = process.env.MOCK_ACP_REQUEST_PERMISSION === "1";

function extractText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join(" ");
}

class MockAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  async newSession(_params) {
    const sessionId = `mock-${randomUUID()}`;
    this.sessions.set(sessionId, { prompts: 0 });
    return { sessionId };
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
    /* no-op ack */
  }

  async prompt(params) {
    const text = extractText(params.prompt);
    const session = this.sessions.get(params.sessionId);
    if (session) session.prompts += 1;

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `echo: ${text}` },
      },
    });

    if (REQUEST_PERMISSION) {
      await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "tc-1", title: "Mock tool", kind: "execute" },
        options: [
          { optionId: "allow", kind: "allow_always", name: "Allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      });
    }

    return { stopReason: STOP_REASON };
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
new acp.AgentSideConnection((connToAgent) => new MockAgent(connToAgent), stream);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

setInterval(() => {}, 1 << 30);
