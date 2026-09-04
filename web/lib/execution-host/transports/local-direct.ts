import type {
  AdoptWorkspaceResult,
  AdoptWorkspaceWire,
  CommandReceipt,
  CreateSessionPayload,
  ExecutionHostTransport,
  HostHealth,
  InputPayload,
  RuntimeObjectContent,
  RuntimeObjectMetadata,
  WorkspaceRecord,
} from "../contracts";
import type { CommandEnvelope, CommandKind, WorkspaceKind } from "../types";

import { asExecutionWorkspaceId } from "../types";
import { RuntimeEventEnvelopeSchema } from "../runtime-events";

import * as wire from "@/lib/supervisor-client";
import { MaisterError } from "@/lib/errors";

// ADR-166 D10: the local-direct transport — the only importer of the
// enveloped `supervisor-client` wire. Pure adaptation: no DB, no ledger, no
// retry; classification (definitive vs unknown-outcome) is the wire's job and
// the deliverer's to act on. `MAISTER_SUPERVISOR_URL` is read by the wire at
// call time — transport configuration, never a domain concept.

function toHostHealth(status: wire.PlatformStatus): HostHealth {
  if (status.kind !== "ready") return status;

  const health = status.health as typeof status.health & {
    host?: wire.ExecutionHostIdentity;
  };

  return {
    kind: "ready",
    identity: health.host ?? null,
    version: health.version,
    sessions: health.sessions,
  };
}

function toReceipt(receipt: wire.CommandReceiptWire): CommandReceipt {
  return {
    ...receipt,
    kind: receipt.kind as CommandKind,
    completedAt: receipt.completedAt ?? null,
  };
}

function toWorkspaceRecord(record: wire.WorkspaceRecordWire): WorkspaceRecord {
  return {
    ...record,
    executionWorkspaceId: asExecutionWorkspaceId(record.executionWorkspaceId),
    kind: record.kind as WorkspaceKind,
  };
}

function toRuntimeObjectMetadata(
  metadata: wire.RuntimeObjectWireMetadata,
): RuntimeObjectMetadata {
  return {
    ...metadata,
    kind: metadata.kind as RuntimeObjectMetadata["kind"],
    retentionClass: metadata.retentionClass as RuntimeObjectMetadata["retentionClass"],
    state: metadata.state as RuntimeObjectMetadata["state"],
  };
}

export function createLocalDirectTransport(): ExecutionHostTransport {
  return {
    async health(opts) {
      return toHostHealth(await wire.checkSupervisorHealth(opts));
    },
    capabilities() {
      return wire.getExecutionHostCapabilities();
    },
    diagnostics(opts) {
      return wire.checkSupervisorDiagnostics(opts);
    },
    platformStatus(opts) {
      return wire.checkSupervisorHealth(opts);
    },
    resolveModelSuggestions(draft, opts) {
      return wire.resolveModelSuggestions(draft, opts);
    },
    probeMcp(req) {
      return wire.probeMcpViaSupervisor(req);
    },
    listSessions() {
      return wire.listSessions();
    },
    streamSession(sessionId, opts) {
      return wire.streamSession(sessionId, opts);
    },
    async *streamRuntimeEvents(opts) {
      const health = toHostHealth(await wire.checkSupervisorHealth());

      if (health.kind !== "ready" || !health.identity) {
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "execution host identity is unavailable for runtime event streaming",
        );
      }
      for await (const raw of wire.streamRuntimeEvents(opts)) {
        const parsed = RuntimeEventEnvelopeSchema.safeParse(raw);

        if (!parsed.success) {
          throw new MaisterError(
            "ACP_PROTOCOL",
            "execution host emitted an invalid runtime event envelope",
          );
        }
        if (parsed.data.hostKey !== health.identity.hostKey) {
          throw new MaisterError(
            "CONFLICT",
            "execution host event identity differs from its health identity",
            { details: { reason: "host_identity_mismatch" } },
          );
        }
        yield parsed.data;
      }
    },
    acknowledgeRuntimeEvents(input) {
      return wire.acknowledgeRuntimeEvents(input);
    },
    async getCommandReceipt(commandId) {
      const receipt = await wire.getCommandReceipt(commandId);

      return receipt ? toReceipt(receipt) : null;
    },
    async getWorkspace(executionWorkspaceId) {
      const record = await wire.getWorkspace(executionWorkspaceId);

      return record ? toWorkspaceRecord(record) : null;
    },
    async getRuntimeObject(objectId) {
      const metadata = await wire.getRuntimeObject(objectId);
      return metadata ? toRuntimeObjectMetadata(metadata) : null;
    },
    async getRuntimeObjectContent(objectId, opts): Promise<RuntimeObjectContent> {
      return wire.getRuntimeObjectContent(objectId, opts);
    },
    async openRuntimeObjectContent(objectId, opts) {
      return wire.openRuntimeObjectContent(objectId, opts);
    },
    async reserveRuntimeObject(envelope, opts) {
      return toRuntimeObjectMetadata(
        await wire.reserveRuntimeObject(envelope, opts),
      );
    },
    async uploadRuntimeObject(input) {
      return toRuntimeObjectMetadata(await wire.uploadRuntimeObject(input));
    },
    deleteRuntimeObject(objectId, envelope, opts) {
      return wire.deleteRuntimeObject(objectId, envelope, opts);
    },
    async adoptWorkspace(
      envelope: CommandEnvelope<AdoptWorkspaceWire>,
      opts,
    ): Promise<AdoptWorkspaceResult> {
      const result = await wire.adoptWorkspace(envelope, opts);

      return {
        executionWorkspaceId: asExecutionWorkspaceId(
          result.executionWorkspaceId,
        ),
        kind: result.kind as WorkspaceKind,
        replayed: result.replayed,
      };
    },
    releaseWorkspace(executionWorkspaceId, envelope, opts) {
      return wire.releaseWorkspace(executionWorkspaceId, envelope, opts);
    },
    createSession(envelope: CommandEnvelope<CreateSessionPayload>, opts) {
      return wire.createSessionEnveloped(envelope, opts);
    },
    startPrompt(sessionId, envelope, opts) {
      return wire.startPromptEnveloped(sessionId, envelope, opts);
    },
    deliverInput(sessionId, envelope: CommandEnvelope<InputPayload>, opts) {
      return wire.deliverInputEnveloped(sessionId, envelope, opts);
    },
    cancelPrompt(sessionId, envelope, opts) {
      return wire.cancelPromptEnveloped(sessionId, envelope, opts);
    },
    checkpointSession(sessionId, envelope, opts) {
      return wire.checkpointSessionEnveloped(sessionId, envelope, opts);
    },
    deleteSession(sessionId, envelope, opts) {
      return wire.deleteSessionEnveloped(sessionId, envelope, opts);
    },
  };
}
