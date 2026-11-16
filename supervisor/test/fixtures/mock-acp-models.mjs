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
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk/unstable";

import { serveAgent } from "./acp-agent-app.mjs";

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
  currentModel =
    MODE === "env-model"
      ? (process.env.ANTHROPIC_MODEL ?? "glm-5.1")
      : "glm-5.1";

  async recordModel(method, params) {
    if (MODE !== "env-model") return;
    const tracePath = process.env.MOCK_ACP_MODELS_TRACE_PATH;

    if (!tracePath) throw new Error("env-model requires a model trace path");
    const options = params._meta?.claudeCode?.options ?? {};
    const settings = JSON.parse(
      await readFile(path.join(params.cwd, ".claude/settings.local.json"), "utf8"),
    );

    // The installed adapter passes options.model to the SDK; its settings.env
    // is merged after the inherited process environment. Record both inputs
    // so a correct adapter picker alone cannot hide an unpinned SDK startup.
    await writeFile(
      tracePath,
      JSON.stringify({
        method,
        model: this.currentModel,
        sdkModel: options.model ?? settings.env?.ANTHROPIC_MODEL ?? this.currentModel,
        configuredModelOption: options.model ?? null,
        permissionAsk: options.settings?.permissions?.ask ?? null,
      }),
    );
  }

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

  async newSession(params) {
    if (MODE === "reject-newsession") {
      throw new Error("mock newSession rejection");
    }

    if (MODE === "hang-newsession") {
      return new Promise(() => {});
    }

    await this.recordModel("session/new", params);

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
        currentModelId: this.currentModel,
      },
    };
  }

  async loadSession() {
    return {};
  }

  async resumeSession(params) {
    await this.recordModel("session/resume", params);
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
        currentModelId: this.currentModel,
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

serveAgent((connToAgent) => new ModelsAgent(connToAgent), stream);

// "ignore-sigterm": register a no-op handler so SIGTERM is swallowed (Node's
// default terminate is overridden) — only SIGKILL can end the child.
if (MODE === "ignore-sigterm") {
  process.on("SIGTERM", () => {});
} else {
  process.on("SIGTERM", () => process.exit(143));
}
process.on("SIGINT", () => process.exit(130));

setInterval(() => {}, 1 << 30);
