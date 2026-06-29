#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const mode = process.argv.includes("--gemini-load-only")
  ? "gemini-load-only"
  : process.argv.includes("--gemini-reject-authenticate")
    ? "gemini-reject-authenticate"
  : "opencode-resume";

// The kind reported in the single permission request the agent emits per
// prompt. Defaults to a write-class "edit" (the existing compatibility tests
// rely on it); the readOnlySession wire tests override it to exercise both the
// auto-deny (write-class) and auto-approve (read-class) L1 paths.
const permissionKindIdx = process.argv.indexOf("--permission-kind");
const permissionKind =
  permissionKindIdx >= 0 ? process.argv[permissionKindIdx + 1] : "edit";

function modelState(currentModelId = "observed-model") {
  return {
    availableModels: [
      { modelId: "observed-model", name: "Observed Model" },
      { modelId: "configured-model", name: "Configured Model" },
    ],
    currentModelId,
  };
}

class CompatibilityAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {},
        sessionCapabilities:
          mode === "gemini-load-only" ? { load: true } : { resume: true },
      },
    };
  }

  async newSession() {
    if (mode === "gemini-load-only") {
      throw new Error("newSession fallback must not run for Gemini resume");
    }

    return {
      sessionId: `compat-${randomUUID()}`,
      models: modelState(),
    };
  }

  async loadSession() {
    return {
      models: modelState(),
    };
  }

  async resumeSession() {
    if (mode !== "opencode-resume") {
      throw new Error("resumeSession is not supported in gemini-load-only mode");
    }

    return {
      models: modelState(),
    };
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
    if (mode === "gemini-reject-authenticate") {
      throw new Error("Gemini CLI-native auth must not use ACP authenticate");
    }

    return {};
  }

  async cancel() {
    return {};
  }

  async prompt(params) {
    const result = await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "compat-tool-call",
        kind: permissionKind,
        title: "compat permission",
      },
      options: [
        { optionId: "allow", kind: "allow_always", name: "Allow" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text:
            result.outcome.outcome === "selected"
              ? `permission selected:${result.outcome.optionId}`
              : "permission cancelled",
        },
      },
    });

    return { stopReason: "end_turn" };
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

const connection = new acp.AgentSideConnection(
  (connToAgent) => new CompatibilityAgent(connToAgent),
  stream,
);

globalThis.__maisterCompatibilityConnection = connection;

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

setInterval(() => {}, 1 << 30);
