import type { Logger } from "pino";
import type { CostRecord } from "./cost";
import type { AppendRuntimeEventInput, HostState } from "./host-state";
import type { RuntimeObjectPublicMetadata } from "./runtime-objects";
import type { SessionEvent, SessionRecord } from "./types";

import { type RuntimeEventType } from "./runtime-events";

const TERMINAL_EVENT_TYPES = new Set<RuntimeEventType>([
  "session.exited",
  "session.crashed",
]);

function sessionEventPayload(
  record: SessionRecord,
  event: SessionEvent,
): Record<string, unknown> {
  const payload = Object.fromEntries(
    Object.entries(event).filter(
      ([key]) => !["type", "sessionId", "monotonicId"].includes(key),
    ),
  );

  return {
    sourceMonotonicId: event.monotonicId,
    sessionName: record.sessionName,
    ...(record.nodeAttemptId ? { nodeAttemptId: record.nodeAttemptId } : {}),
    ...payload,
  } as Record<string, unknown>;
}

function isTerminalSessionEvent(event: SessionEvent): boolean {
  return (
    TERMINAL_EVENT_TYPES.has(event.type) ||
    (event.type === "session.command" && event.phase === "completed")
  );
}

function assignmentForRecord(record: SessionRecord): {
  assignmentId: string;
  assignmentEpoch: number;
} {
  if (!record.assignmentId || !record.assignmentEpoch) {
    throw new Error(
      `session ${record.sessionId} cannot publish a canonical event without an assignment fence`,
    );
  }

  return {
    assignmentId: record.assignmentId,
    assignmentEpoch: record.assignmentEpoch,
  };
}

export class RuntimeEventPublisher {
  private readonly logger: Logger;

  constructor(
    private readonly state: HostState,
    logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.logger = logger.child({ component: "runtime-event-publisher" });
  }

  sessionEventInput(
    record: SessionRecord,
    event: SessionEvent,
  ): AppendRuntimeEventInput {
    const assignment = assignmentForRecord(record);

    return {
      draft: {
        runId: record.runId,
        assignmentId: assignment.assignmentId,
        assignmentEpoch: assignment.assignmentEpoch,
        hostSessionId: record.sessionId,
        eventType: event.type,
        occurredAt: this.now().toISOString(),
        payload: sessionEventPayload(record, event),
      },
      terminal: isTerminalSessionEvent(event),
    };
  }

  runtimeObjectInput(input: {
    runId: string;
    assignmentId: string;
    assignmentEpoch: number;
    metadata: RuntimeObjectPublicMetadata;
  }): AppendRuntimeEventInput {
    const metadata = input.metadata;
    const available = metadata.state === "available";

    return {
      terminal: metadata.state === "deleted" || metadata.state === "corrupt",
      draft: {
        runId: input.runId,
        assignmentId: input.assignmentId,
        assignmentEpoch: input.assignmentEpoch,
        hostSessionId: null,
        eventType: available
          ? "runtime_object.available"
          : "runtime_object.state",
        occurredAt: this.now().toISOString(),
        payload: available
          ? {
              objectId: metadata.objectId,
              kind: metadata.kind,
              logicalName: metadata.logicalName,
              mimeType: metadata.mimeType,
              sizeBytes: metadata.sizeBytes,
              sha256: metadata.sha256,
              generation: metadata.generation,
              retentionClass: metadata.retentionClass,
              state: metadata.state,
              sealedAt: metadata.sealedAt,
              expiresAt: metadata.expiresAt,
            }
          : {
              objectId: metadata.objectId,
              generation: metadata.generation,
              state: metadata.state,
              deletedAt: metadata.deletedAt,
            },
      },
    };
  }

  publishSessionEvent(record: SessionRecord, event: SessionEvent): void {
    const persisted = this.state.appendRuntimeEvent(
      this.sessionEventInput(record, event),
    );

    this.logger.debug(
      {
        runId: record.runId,
        hostSessionId: record.sessionId,
        eventId: persisted.eventId,
        sequence: persisted.sequence,
        eventType: event.type,
        bytes: persisted.encodedBytes,
        queueDepth: this.state.runtimeEventOutboxStats().unacknowledgedCount,
      },
      "runtime-event-appended",
    );
  }

  publishSessionCreated(record: SessionRecord): void {
    const assignment = assignmentForRecord(record);
    const persisted = this.state.appendRuntimeEvent({
      draft: {
        runId: record.runId,
        assignmentId: assignment.assignmentId,
        assignmentEpoch: assignment.assignmentEpoch,
        hostSessionId: record.sessionId,
        eventType: "session.created",
        occurredAt: this.now().toISOString(),
        payload: {
          adapter: record.adapter,
          sessionName: record.sessionName,
          acpSessionId: record.acpSessionId ?? null,
        },
      },
    });

    this.logger.info(
      {
        runId: record.runId,
        hostSessionId: record.sessionId,
        eventId: persisted.eventId,
        sequence: persisted.sequence,
      },
      "runtime-session-created-appended",
    );
  }

  publishUsage(record: SessionRecord, cost: CostRecord): void {
    const assignment = assignmentForRecord(record);
    const persisted = this.state.appendRuntimeEvent({
      draft: {
        runId: record.runId,
        assignmentId: assignment.assignmentId,
        assignmentEpoch: assignment.assignmentEpoch,
        hostSessionId: record.sessionId,
        eventType: "usage.recorded",
        occurredAt: cost.ts,
        payload: {
          sessionName: record.sessionName,
          inputTokens: cost.input_tokens ?? null,
          outputTokens: cost.output_tokens ?? null,
          cacheCreationInputTokens: cost.cache_creation_input_tokens ?? null,
          cacheReadInputTokens: cost.cache_read_input_tokens ?? null,
          model: cost.model ?? null,
          resumed: cost.resumed === true,
          nodeAttemptId: cost.nodeAttemptId ?? null,
          stepId: cost.stepId ?? null,
        },
      },
    });

    this.logger.debug(
      {
        runId: record.runId,
        hostSessionId: record.sessionId,
        eventId: persisted.eventId,
        sequence: persisted.sequence,
        bytes: persisted.encodedBytes,
      },
      "runtime-usage-recorded-appended",
    );
  }
}
