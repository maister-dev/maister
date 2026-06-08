#!/usr/bin/env node
// M8 fixture: cross-process session persistence modelling claude-agent-acp /
// codex-acp resume via the ACP `session/resume` protocol call:
//
//   1. On a cancelled requestPermission whose outcome marker is
//      `reason="checkpoint"`, the adapter records the pending toolCall in
//      its on-disk session journal so a future resumed instance can replay it.
//   2. A fresh process resumes through `resumeSession({ sessionId })` (NOT a
//      `--resume` CLI flag — the real adapters ignore that on argv). It loads
//      the journal for that id and replays the recorded permission request on
//      the FIRST `prompt()` call. Per the ACP spec, session/resume MUST NOT
//      replay conversation history.
//
// Why this fixture exists:
//   The real claude-agent-acp records cancelled-with-reason events in its
//   own JSONL session store (`~/.claude/projects/<cwd>/<uuid>.jsonl`,
//   verified in docs/kaa-maister-m0-spike-findings-20260525.md). M8 locks
//   mock-only validation, so this fixture is the contract for the rest of M8
//   (T4 graceful checkpoint, T11 runner-agent auto-deliver).
//
// Env vars:
//   MOCK_ACP_STATE_DIR        directory where session journals are stored
//                             (per-session file `<acpSessionId>.json`).
//                             Required for resume behaviour to work.
//   MOCK_ACP_STOP_REASON      stopReason returned from prompt(). Default "end_turn".
//   MOCK_ACP_REQUEST_PERMISSION  "1" → call requestPermission on first prompt.

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

// pendingReplay is hydrated from the journal inside resumeSession(); gets
// cleared after the replay round-trip completes (selected) or is re-issued
// (cancelled-again).
let pendingReplay = null;

class MockAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      // Advertise session/resume so the supervisor resumes via that protocol
      // call (restores context WITHOUT replaying history) — mirroring
      // claude-agent-acp/codex-acp, which both expose sessionCapabilities.resume.
      agentCapabilities: {
        promptCapabilities: {},
        sessionCapabilities: { resume: {} },
      },
    };
  }

  async newSession() {
    const acpSessionId = `mock-${randomUUID()}`;

    this.sessions.set(acpSessionId, { prompts: 0 });
    writeJournal(acpSessionId, { acpSessionId });
    log("info", { msg: "new-session", acpSessionId });

    return { sessionId: acpSessionId };
  }

  async loadSession() {
    return {};
  }

  // session/resume: restore the prior session by id from the on-disk journal
  // (no `--resume` CLI flag — the real adapters ignore that) and arm any
  // recorded pending-permission for replay on the next prompt. MUST NOT replay
  // conversation history, per the ACP spec.
  async resumeSession(params) {
    this.sessions.set(params.sessionId, { prompts: 0 });
    const journal = readJournal(params.sessionId);

    if (journal && journal.pendingPermission) {
      pendingReplay = journal.pendingPermission;
    }
    log("info", {
      msg: "resume-session",
      acpSessionId: params.sessionId,
      hasPending: Boolean(pendingReplay),
    });

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
