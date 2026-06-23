#!/usr/bin/env node
// ADR-104 (M40): a mock ACP adapter that scripts tool-call streams to drive the
// supervisor's universal guardrail interceptor end-to-end. Scenarios (argv):
//   --scenario repetition  --count N   → N identical permission requests
//   --scenario path_guard              → one out-of-lane then one in-lane write
//   --scenario no_progress --count M   → M non-write tool_call turns
// Sessions are launched with autoApprovePermissions=true (an unattended run), so
// non-tripping permission requests auto-approve via B1 and the mock never blocks
// on a HITL deferred — while guardrail denies/halts still fire BEFORE B1.
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const args = process.argv.slice(2);
let scenario = "none";
let count = 5;

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--scenario") scenario = args[++i];
  else if (args[i] === "--count") count = Number.parseInt(args[++i], 10);
}

const OPTIONS = [
  { optionId: "allow", kind: "allow_once", name: "Allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
];

class GuardrailAgent {
  constructor(connection) {
    this.connection = connection;
    this.outcomes = [];
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

  async requestWrite(sessionId, path, id) {
    const res = await this.connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: id,
        kind: "edit",
        title: `Edit ${path}`,
        locations: [{ path }],
      },
      options: OPTIONS,
    });

    this.outcomes.push(res.outcome.outcome);
  }

  async prompt(params) {
    const sessionId = params.sessionId;

    if (scenario === "repetition") {
      // Identical tool calls — same kind/title/locations, only toolCallId varies.
      for (let i = 0; i < count; i += 1) {
        await this.requestWrite(sessionId, "src/x.ts", `tc-rep-${i}`);
      }
    } else if (scenario === "path_guard") {
      // One out-of-lane write (denied), then one in-lane write (allowed) — proves
      // deny-and-continue + selective enforcement, even under auto-approve.
      await this.requestWrite(sessionId, "secrets/.env", "tc-pg-out");
      await this.requestWrite(sessionId, "src/ok.ts", "tc-pg-in");
    } else if (scenario === "no_progress") {
      // M non-write tool_call turns — no diff-producing call resets the counter.
      for (let i = 0; i < count; i += 1) {
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `tc-np-${i}`,
            kind: "read",
            title: `read ${i}`,
            status: "pending",
          },
        });
      }
    }

    return { stopReason: "end_turn" };
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new acp.AgentSideConnection((conn) => new GuardrailAgent(conn), stream);

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

setInterval(() => {}, 1 << 30);
