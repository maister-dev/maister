#!/usr/bin/env node
// ADR-108 (M40): a mock ACP adapter that scripts tool-call streams to drive the
// supervisor's universal guardrail interceptor end-to-end. Scenarios (argv):
//   --scenario repetition          --count N → N identical permission requests
//   --scenario path_guard                    → one out-of-lane then one in-lane write
//   --scenario path_guard_repeat   --count N → N IDENTICAL out-of-lane writes (each
//                                              denied) — proves repeated denials
//                                              feed the liveness breakers
//   --scenario path_guard_kindonly --count N → N write requests with NO locations
//   --scenario no_progress         --count M → M non-write tool_call turns
//   --scenario no_progress_reset   --count M → (M-1) idle, one write (reset), (M-1) idle
//   --scenario deferred_cancel     --count M → open a real HITL deferred, then trip
//                                              no_progress (M idle turns) → cancel it
// Most scenarios run with autoApprovePermissions=true (an unattended run), so
// non-tripping permission requests auto-approve via B1 and the mock never blocks
// on a HITL deferred — while guardrail denies/halts still fire BEFORE B1. The
// `deferred_cancel` scenario runs with autoApprove OFF so a real deferred opens
// and the no_progress halt's cancel loop must release it (no leaked deferred).
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

  // A write-kind tool call carrying NO `locations` — the kind-only-fallback shape
  // (gemini/opencode/mimo). An armed path_guard denies it conservatively.
  async requestWriteNoPath(sessionId, id) {
    const res = await this.connection.requestPermission({
      sessionId,
      toolCall: { toolCallId: id, kind: "edit", title: "Edit (no path)" },
      options: OPTIONS,
    });

    this.outcomes.push(res.outcome.outcome);
  }

  // A write-kind tool_call NOTIFICATION (resets the no_progress counter — it is a
  // diff-producing turn), distinct from a permission request.
  async progressTurn(sessionId, id) {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: id,
        kind: "edit",
        title: `edit ${id}`,
        status: "pending",
      },
    });
  }

  async idleTurn(sessionId, id) {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: id,
        kind: "read",
        title: `read ${id}`,
        status: "pending",
      },
    });
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
    } else if (scenario === "path_guard_repeat") {
      // N IDENTICAL out-of-lane writes — same kind/title/locations, only
      // toolCallId varies. Each is denied by path_guard; the repeated denials
      // must feed the liveness breakers (repetition / no_progress) so the run
      // halts EXACTLY once instead of looping forever.
      for (let i = 0; i < count; i += 1) {
        await this.requestWrite(sessionId, "secrets/.env", `tc-pgr-${i}`);
      }
    } else if (scenario === "path_guard_kindonly") {
      // N write requests with no `locations` — an armed path_guard denies each
      // (kind-only fallback) but WARNs only once per session.
      for (let i = 0; i < count; i += 1) {
        await this.requestWriteNoPath(sessionId, `tc-ko-${i}`);
      }
    } else if (scenario === "no_progress") {
      // M non-write tool_call turns — no diff-producing call resets the counter.
      for (let i = 0; i < count; i += 1) {
        await this.idleTurn(sessionId, `tc-np-${i}`);
      }
    } else if (scenario === "no_progress_reset") {
      // (M-1) idle, one write (resets to 0), (M-1) idle — never M consecutive
      // idle turns, so with maxTurns=M the watchdog must NOT trip.
      for (let i = 0; i < count - 1; i += 1) {
        await this.idleTurn(sessionId, `tc-npr-a-${i}`);
      }
      await this.progressTurn(sessionId, "tc-npr-reset");
      for (let i = 0; i < count - 1; i += 1) {
        await this.idleTurn(sessionId, `tc-npr-b-${i}`);
      }
    } else if (scenario === "deferred_cancel") {
      // Open a REAL HITL deferred (autoApprove OFF, only no_progress armed → the
      // write falls through to the deferred), THEN trip no_progress with M idle
      // turns. The halt's cancel loop must release the still-open deferred — the
      // ndjson stream is FIFO, so the supervisor registers the deferred before it
      // processes the idle turns. If the cancel leaks, this await never resolves
      // and the prompt (and the test) hangs.
      const pending = this.requestWrite(sessionId, "src/x.ts", "tc-dc");

      for (let i = 0; i < count; i += 1) {
        await this.idleTurn(sessionId, `tc-dc-np-${i}`);
      }
      await pending;
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
