import type {
  AdoptWorkspaceResult,
  AdoptWorkspaceWire,
  CommandReceipt,
  CreateSessionPayload,
  ExecutionHostTransport,
  HostHealth,
  InputPayload,
  WorkspaceRecord,
} from "../contracts";
import type { CommandEnvelope, CommandKind, WorkspaceKind } from "../types";

import { asExecutionWorkspaceId } from "../types";

import * as wire from "@/lib/supervisor-client";

// ADR-165 D10: the local-direct transport — the only importer of the
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

export function createLocalDirectTransport(): ExecutionHostTransport {
  return {
    async health(opts) {
      return toHostHealth(await wire.checkSupervisorHealth(opts));
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
    async getCommandReceipt(commandId) {
      const receipt = await wire.getCommandReceipt(commandId);

      return receipt ? toReceipt(receipt) : null;
    },
    async getWorkspace(executionWorkspaceId) {
      const record = await wire.getWorkspace(executionWorkspaceId);

      return record ? toWorkspaceRecord(record) : null;
    },
    async adoptWorkspace(
      envelope: CommandEnvelope<AdoptWorkspaceWire>,
    ): Promise<AdoptWorkspaceResult> {
      const result = await wire.adoptWorkspace(envelope);

      return {
        executionWorkspaceId: asExecutionWorkspaceId(
          result.executionWorkspaceId,
        ),
        kind: result.kind as WorkspaceKind,
        replayed: result.replayed,
      };
    },
    releaseWorkspace(executionWorkspaceId, envelope) {
      return wire.releaseWorkspace(executionWorkspaceId, envelope);
    },
    createSession(envelope: CommandEnvelope<CreateSessionPayload>) {
      return wire.createSessionEnveloped(envelope);
    },
    sendPrompt(sessionId, envelope, opts) {
      return wire.sendPromptEnveloped(sessionId, envelope, opts);
    },
    deliverInput(sessionId, envelope: CommandEnvelope<InputPayload>) {
      return wire.deliverInputEnveloped(sessionId, envelope);
    },
    cancelPrompt(sessionId, envelope) {
      return wire.cancelPromptEnveloped(sessionId, envelope);
    },
    checkpointSession(sessionId, envelope) {
      return wire.checkpointSessionEnveloped(sessionId, envelope);
    },
    deleteSession(sessionId, envelope) {
      return wire.deleteSessionEnveloped(sessionId, envelope);
    },
  };
}
