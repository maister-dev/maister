import type { CommandKind } from "./types";

// Ledger payload projection (ADR-166 E-EH-12). `execution_commands.payload`
// keeps only what explains a command — kind-specific ids, names, adapter and
// model, counts — through a per-kind ALLOW-list: nothing a caller did not name
// here reaches the row, so a prompt body, an env value, an argv token, or a
// URL secret can never survive by hiding under an unexpected key. Retries reuse
// the in-memory envelope and recovery re-sends only the driverless kinds, whose
// payloads are empty, so the projection is never replayed to the host.

type Payload = Record<string, unknown>;

type Projection = (payload: Payload) => Payload;

function asObject(value: unknown): Payload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

function pickScalars(payload: Payload, keys: readonly string[]): Payload {
  const out: Payload = {};

  for (const key of keys) {
    const value = payload[key];

    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }

  return out;
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

const PAYLOAD_PROJECTION: Readonly<Record<CommandKind, Projection>> = {
  "workspace.adopt": (p) => ({
    ...pickScalars(p, ["runId", "projectSlug", "kind"]),
    contextMountCount: countOf(p.contextMounts),
  }),
  "workspace.release": () => ({}),
  "session.create": (p) => {
    const executor = asObject(p.executor);
    const runner = asObject(p.runner);
    const provider = asObject(runner.provider);

    return {
      ...pickScalars(p, [
        "executionWorkspaceId",
        "stepId",
        "nodeAttemptId",
        "sessionName",
        "resumeSessionId",
        "readOnlySession",
        "autoApprovePermissions",
        "reapOnEndTurn",
      ]),
      executor: pickScalars(executor, ["agent", "model"]),
      runner: {
        ...pickScalars(runner, ["adapter", "model"]),
        provider: pickScalars(provider, ["kind"]),
      },
      mcpServerCount: countOf(p.mcpServers),
      hasCapabilityProfile: typeof p.capabilityProfilePath === "string",
      hasAdapterLaunch:
        p.adapterLaunch !== undefined && p.adapterLaunch !== null,
      hasHooksConfig: p.hooksConfig !== undefined && p.hooksConfig !== null,
      hasEnforcementProfile:
        p.enforcementProfile !== undefined && p.enforcementProfile !== null,
    };
  },
  "session.prompt": (p) => ({
    ...pickScalars(p, ["stepId"]),
    promptBytes:
      typeof p.prompt === "string" ? Buffer.byteLength(p.prompt, "utf8") : 0,
    contentBlockCount: countOf(p.contentBlocks),
  }),
  "session.input": (p) =>
    pickScalars(p, ["kind", "action", "requestId", "optionId", "reason"]),
  "session.cancel": () => ({}),
  "session.checkpoint": () => ({}),
  "session.delete": () => ({}),
};

export function redactPayload(kind: CommandKind, payload: unknown): Payload {
  return PAYLOAD_PROJECTION[kind](asObject(payload));
}
