#!/usr/bin/env node
// T2.1 fixture: a minimal ACP adapter that advertises a model list on
// `session/new` (NewSessionResponse.models = SessionModelState). Used by the
// model-catalog ACP-probe integration test. Modes (via MOCK_ACP_MODELS_MODE):
//   "ok"               (default) — newSession returns availableModels.
//   "reject-newsession"          — newSession throws (deferred-release test:
//                                  the probe must still SIGTERM the child).
//   "hang-newsession"            — newSession never resolves (timeout test:
//                                  the probe must time out and SIGTERM).
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const MODE = process.env.MOCK_ACP_MODELS_MODE ?? "ok";

class ModelsAgent {
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  async newSession() {
    if (MODE === "reject-newsession") {
      throw new Error("mock newSession rejection");
    }

    if (MODE === "hang-newsession") {
      return new Promise(() => {});
    }

    return {
      sessionId: `mock-${randomUUID()}`,
      models: {
        availableModels: [
          { modelId: "glm-5.1", name: "GLM-5.1" },
          { modelId: "glm-5", name: "GLM-5" },
        ],
        currentModelId: "glm-5.1",
      },
    };
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

  async prompt() {
    return { stopReason: "end_turn" };
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

new acp.AgentSideConnection((connToAgent) => new ModelsAgent(connToAgent), stream);

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

setInterval(() => {}, 1 << 30);
