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
  // The preparation protocol carries IDs and a digest. Keeping exactly these
  // fields allows recovery without persisting locations, inputs or credentials.
  "workspace.prepare": (payload) =>
    pickScalars(payload, [
      "mode",
      "repositoryId",
      "commit",
      "parentHandle",
      "parentGeneration",
      "directoryProfileId",
      "inputDigest",
    ]),
  "workspace.materialize": (payload) => ({
    ...pickScalars(payload, ["generation", "manifestDigest"]),
    objects: Array.isArray(payload.objects)
      ? payload.objects.map((value) => pickScalars(asObject(value), ["objectId", "sha256"]))
      : [],
  }),
  "workspace.run": (payload) => ({
    ...pickScalars(payload, ["generation", "workload", "declarationId", "inputGeneration", "inputDigest"]),
    ...(payload.templateContext === undefined ? {} : {
      templateContext: pickScalars(asObject(payload.templateContext), ["objectId", "sha256"]),
    }),
  }),
  "workspace.cancel": (payload) => pickScalars(payload, ["generation", "targetCommandId"]),
  "workspace.checkpoint": (payload) => pickScalars(payload, ["generation"]),
  "workspace.restore": (payload) => pickScalars(payload, ["generation", "checkpointId", "policy"]),
  "workspace.preserve": (payload) => pickScalars(payload, ["generation", "claimId", "fence", "disposition", "quiescenceId"]),
  "workspace.sync": (payload) => ({
    ...pickScalars(payload, ["generation", "claimId", "fence", "strategy", "onConflict"]),
    expected: pickScalars(asObject(payload.expected), ["head", "remoteId", "targetRef", "priorTarget"]),
    ...(payload.publish === undefined ? {} : {
      publish: {
        ...pickScalars(asObject(payload.publish), ["targetRef", "priorTarget"]),
        ...(asObject(payload.publish).priorTarget === null ? { priorTarget: null } : {}),
      },
    }),
  }),
  "workspace.publish": (payload) => {
    const expected = asObject(payload.expected);

    return {
      ...pickScalars(payload, ["generation", "claimId", "fence", "publication", "integration"]),
      expected: {
        ...pickScalars(expected, ["head", "remoteId", "targetRef", "priorTarget"]),
        ...(expected.priorTarget === null ? { priorTarget: null } : {}),
      },
      ...(payload.publication === "openPullRequest"
        ? { pullRequest: pickScalars(asObject(payload.pullRequest), ["baseRef", "baseCommit", "title", "body", "draft"]) }
        : {}),
    };
  },
  "workspace.adopt": (p) => ({
    ...pickScalars(p, ["runId", "projectSlug", "kind"]),
    ...(asObject(p.owner).kind === "company"
      ? {
          ownerKind: "company",
          ...pickScalars(asObject(p.owner), ["companyId"]),
        }
      : {}),
    contextMountCount: countOf(p.contextMounts),
  }),
  "workspace.release": (payload) => typeof payload.claimId === "string"
    ? pickScalars(payload, ["generation", "claimId", "fence", "dispositionId", "quiescenceId"])
    : {},
  "workspace.publication": (payload) =>
    pickScalars(payload, [
      "action",
      "remote",
      "headRef",
      "expectedHead",
      "expectedRemoteHead",
    ]),
  "workspace.observe_head": (payload) =>
    pickScalars(payload, ["waitId", "workspaceGeneration", "register"]),
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
      hasCapabilityProfile: typeof p.capabilityProfileObjectId === "string",
      hasCapabilityInstructions:
        typeof p.capabilityInstructionsObjectId === "string",
      runtimeOutputCount: countOf(p.outputObjects),
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
  // ADR-182: the steer text never reaches the ledger — only its size.
  "session.steer": (p) => ({
    ...pickScalars(p, ["parentCommandId"]),
    promptBytes: Buffer.byteLength(
      JSON.stringify(p.contentBlocks ?? []),
      "utf8",
    ),
    contentBlockCount: countOf(p.contentBlocks),
  }),
  "session.cancel": () => ({}),
  "session.checkpoint": () => ({}),
  "session.delete": () => ({}),
  "runtime_object.reserve": (p) => ({
    ...pickScalars(p, [
      "objectId",
      "kind",
      "logicalName",
      "mimeType",
      "sizeBytes",
      "sha256",
      "generation",
      "retentionClass",
      "expiresAt",
    ]),
  }),
  "runtime_object.upload": (p) =>
    pickScalars(p, [
      "objectId",
      "generation",
      "sizeBytes",
      "sha256",
      "mimeType",
    ]),
  "runtime_object.delete": (p) => pickScalars(p, ["objectId", "generation"]),
  "stand.dispatch": (p) => {
    const before = asObject(p.before);

    return {
      ...pickScalars(p, [
        "operationId",
        "targetIncarnation",
        "componentId",
        "action",
        "requestDigest",
        "resourceKey",
        "ownerEpoch",
        "businessOwnerEpoch",
        "beforeObservationId",
        "predecessorId",
      ]),
      nodeAttemptId:
        typeof p.nodeAttemptId === "string" ? p.nodeAttemptId : null,
      ...(typeof before.state === "string"
        ? {
            before: {
              state: before.state,
              invocationId:
                typeof before.invocationId === "string"
                  ? before.invocationId
                  : null,
            },
          }
        : {}),
    };
  },
};

export function redactPayload(kind: CommandKind, payload: unknown): Payload {
  return PAYLOAD_PROJECTION[kind](asObject(payload));
}
