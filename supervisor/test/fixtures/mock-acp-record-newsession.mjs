#!/usr/bin/env node
// T4.5-C fixture: records the params received by `newSession` (notably
// `mcpServers`) to a JSON file so an integration test can assert that the
// supervisor forwarded capability MCP server defs (with env resolved from
// the supervisor's own process.env) onto the ACP wire.
//
// Env vars:
//   MOCK_ACP_NEWSESSION_RECORD_PATH  absolute path to write the recorded
//                                    newSession params (single JSON object).
//                                    Required — without it the fixture just
//                                    behaves like a hanging stub.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk/unstable";

import { serveAgent } from "./acp-agent-app.mjs";

const RECORD_PATH = process.env.MOCK_ACP_NEWSESSION_RECORD_PATH ?? null;
const PROMPT_RECORD_PATH = process.env.MOCK_ACP_PROMPT_RECORD_PATH ?? null;
const ENV_PROBE = process.env.MOCK_ACP_ENV_PROBE ?? null;

class RecordingAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  async newSession(params) {
    if (RECORD_PATH) {
      writeFileSync(
        RECORD_PATH,
        JSON.stringify({
          cwd: params.cwd,
          mcpServers: params.mcpServers,
          ...(ENV_PROBE
            ? { probePresent: Object.hasOwn(process.env, ENV_PROBE) }
            : {}),
        }),
      );
    }

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
    if (PROMPT_RECORD_PATH)
      writeFileSync(PROMPT_RECORD_PATH, JSON.stringify(params.prompt));
    return { stopReason: "end_turn" };
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

serveAgent((connToAgent) => new RecordingAgent(connToAgent), stream);

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

setInterval(() => {}, 1 << 30);
