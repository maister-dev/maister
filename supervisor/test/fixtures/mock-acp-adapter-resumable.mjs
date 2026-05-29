#!/usr/bin/env node
// M8 spike fixture (T1):
// extension of mock-acp-adapter.mjs with cross-process session persistence
// modelling the assumed behaviour of claude-agent-acp under `--resume`:
//
//   1. On a cancelled requestPermission whose outcome marker is
//      `reason="checkpoint"`, the adapter records the pending toolCall in
//      its on-disk session journal so a future `--resume` instance can
//      replay it.
//   2. On startup with `--resume <id>` AND a matching journal file, the
//      adapter restores the prior `acpSessionId` and replays the recorded
//      permission request on the FIRST `prompt()` call.
//
// Why this fixture exists:
//   The real claude-agent-acp records cancelled-with-reason events in its
//   own JSONL session store (`~/.claude/projects/<cwd>/<uuid>.jsonl`,
//   verified in docs/kaa-maister-m0-spike-findings-20260525.md). T1's
//   user-locked decision (2026-05-29) is "mock-only validation, no paid
//   real-adapter run", so this fixture is the contract we lock for the
//   rest of M8 (T4 graceful checkpoint, T11 runner-agent auto-deliver).
//
// Env vars:
//   MOCK_ACP_STATE_DIR        directory where session journals are stored
//                             (per-session file `<acpSessionId>.json`).
//                             Required for resume behaviour to work.
//   MOCK_ACP_STOP_REASON      stopReason returned from prompt(). Default "end_turn".
//   MOCK_ACP_REQUEST_PERMISSION  "1" → call requestPermission on first prompt.
//
// CLI args:
//   --resume <acpSessionId>   restore prior session journal.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const STOP_REASON = process.env.MOCK_ACP_STOP_REASON ?? "end_turn";
const REQUEST_PERMISSION = process.env.MOCK_ACP_REQUEST_PERMISSION === "1";
const STATE_DIR = process.env.MOCK_ACP_STATE_DIR ?? null;

function log(level, payload) {
  // stderr-only — the supervisor's stdio config is `pipe/pipe/inherit`,
  // so stderr appears in the test runner output without polluting the
  // ACP wire on stdout.
  process.stderr.write(
    `[mock-resumable] ${level} ${JSON.stringify(payload)}\n`,
  );
}

function parseResumeArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--resume" && i + 1 < argv.length) {
      return argv[i + 1];
    }
  }

  return null;
}

function statePathFor(acpSessionId) {
  if (!STATE_DIR) return null;

  return join(STATE_DIR, `${acpSessionId}.json`);
}

function readJournal(acpSessionId) {
  const p = statePathFor(acpSessionId);

  if (!p) return null;

  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJournal(acpSessionId, journal) {
  const p = statePathFor(acpSessionId);

  if (!p) return;

  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(p, JSON.stringify(journal));
  } catch (err) {
    log("warn", { msg: "journal-write-failed", err: String(err) });
  }
}

function extractText(blocks) {
  if (!Array.isArray(blocks)) return "";

  return blocks
    .map((b) =>
      b && b.type === "text" && typeof b.text === "string" ? b.text : "",
    )
    .filter(Boolean)
    .join(" ");
}

const RESUMED_FROM = parseResumeArg(process.argv);
// pendingReplay is hydrated from the journal at startup; gets cleared
// after the replay round-trip completes (selected) or is re-issued
// (cancelled-again).
let pendingReplay = null;
let hydratedAcpSessionId = null;

if (RESUMED_FROM) {
  const journal = readJournal(RESUMED_FROM);

  if (journal && journal.acpSessionId === RESUMED_FROM) {
    hydratedAcpSessionId = RESUMED_FROM;
    if (journal.pendingPermission) {
      pendingReplay = journal.pendingPermission;
    }
    log("info", {
      msg: "resumed-from-journal",
      acpSessionId: RESUMED_FROM,
      hasPending: Boolean(pendingReplay),
    });
  } else {
    log("warn", {
      msg: "resume-journal-missing",
      acpSessionId: RESUMED_FROM,
    });
  }
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

  async newSession() {
    // When resuming, reuse the prior acpSessionId so the supervisor's
    // pendingPermissions registry can still be addressed by the
    // original id at the wire level. This is the protocol invariant
    // claude-agent-acp also preserves (verified in the M0 spike round-trip).
    const acpSessionId = hydratedAcpSessionId ?? `mock-${randomUUID()}`;

    this.sessions.set(acpSessionId, { prompts: 0 });
    if (!hydratedAcpSessionId) {
      writeJournal(acpSessionId, { acpSessionId });
    }
    log("info", {
      msg: "new-session",
      acpSessionId,
      resumed: Boolean(hydratedAcpSessionId),
    });

    return { sessionId: acpSessionId };
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

    if (pendingReplay) {
      const toolCall = pendingReplay.toolCall;
      const options = pendingReplay.options;
      // Clear in-memory marker BEFORE the await so a second prompt
      // doesn't double-replay if the first cancels again.
      pendingReplay = null;
      log("info", {
        msg: "replaying-permission",
        acpSessionId: params.sessionId,
        toolCallId: toolCall?.toolCallId,
      });
      const result = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall,
        options,
      });
      const outcome = result?.outcome;

      if (outcome?.outcome === "selected") {
        writeJournal(params.sessionId, {
          acpSessionId: params.sessionId,
        });
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `replayed permission outcome: selected ${outcome.optionId}`,
            },
          },
        });
      } else {
        writeJournal(params.sessionId, {
          acpSessionId: params.sessionId,
          pendingPermission: { toolCall, options },
        });
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "replayed permission outcome: cancelled",
            },
          },
        });
      }
    } else if (REQUEST_PERMISSION) {
      const toolCall = {
        toolCallId: "tc-1",
        title: "Mock tool",
        kind: "execute",
      };
      const options = [
        { optionId: "allow", kind: "allow_always", name: "Allow" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ];

      // Persist BEFORE the await so a checkpoint-cancel arriving while
      // we're awaiting still leaves a recoverable replay marker. This
      // models claude-agent-acp's session JSONL append-on-emit.
      writeJournal(params.sessionId, {
        acpSessionId: params.sessionId,
        pendingPermission: { toolCall, options },
      });

      const result = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall,
        options,
      });
      const outcome = result?.outcome;

      if (outcome?.outcome === "selected") {
        writeJournal(params.sessionId, { acpSessionId: params.sessionId });
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `permission outcome: selected ${outcome.optionId}`,
            },
          },
        });
      } else {
        // Cancelled-with-reason: keep the pendingPermission marker so a
        // future --resume process replays it. This is the M8 contract
        // the spike locks.
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "permission outcome: cancelled" },
          },
        });
      }
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
