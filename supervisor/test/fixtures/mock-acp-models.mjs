#!/usr/bin/env node
// T2.1 fixture: a minimal ACP adapter that advertises a model list on
// `session/new` — as the ACP 1.x "model" config option AND the pre-1.0
// `models` extension field, mirroring codex-acp. Used by the
// model-catalog ACP-probe integration test. Modes (via MOCK_ACP_MODELS_MODE):
//   "ok"               (default) — newSession returns availableModels.
//   "reject-newsession"          — newSession throws (deferred-release test:
//                                  the probe must still SIGTERM the child).
//   "hang-newsession"            — newSession never resolves (timeout test:
//                                  the probe must time out and SIGTERM).
//   "ignore-sigterm"             — newSession answers, but SIGTERM is swallowed
//                                  (escalation test: the probe must SIGKILL so
//                                  no orphaned child remains).
//   "legacy-models"              — responses carry only the pre-1.0 `models`
//                                  field, no "model" config option (the
//                                  supervisor cannot apply → advisory).
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const MODE = process.env.MOCK_ACP_MODELS_MODE ?? "ok";

const MODEL_OPTIONS = [
  { value: "glm-5.1", name: "GLM-5.1" },
  { value: "glm-5", name: "GLM-5" },
];

function configOptions(currentValue) {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: MODEL_OPTIONS,
    },
  ];
}

class ModelsAgent {
  currentModel = "glm-5.1";

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {},
        // Both bundled adapters advertise resume; the supervisor FAILS LOUD on
        // a resume request without it, so the resumed-session tests need it.
        sessionCapabilities: { resume: true },
      },
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
      ...(MODE === "legacy-models"
        ? {}
        : { configOptions: configOptions(this.currentModel) }),
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
    // ResumeSessionResponse carries model state too — the resumed-session
    // application/harvest tests read it.
    return {
      ...(MODE === "legacy-models"
        ? {}
        : { configOptions: configOptions(this.currentModel) }),
      models: {
        availableModels: [
          { modelId: "glm-5.1", name: "GLM-5.1" },
          { modelId: "glm-5", name: "GLM-5" },
        ],
        currentModelId: "glm-5.1",
      },
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

  async setSessionConfigOption(params) {
    if (params?.configId === "model" && typeof params.value === "string")
      this.currentModel = params.value;

    return { configOptions: configOptions(this.currentModel) };
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

// "ignore-sigterm": register a no-op handler so SIGTERM is swallowed (Node's
// default terminate is overridden) — only SIGKILL can end the child.
if (MODE === "ignore-sigterm") {
  process.on("SIGTERM", () => {});
} else {
  process.on("SIGTERM", () => process.exit(143));
}
process.on("SIGINT", () => process.exit(130));

setInterval(() => {}, 1 << 30);
