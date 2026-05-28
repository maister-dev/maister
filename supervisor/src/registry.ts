import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import type * as acp from "@agentclientprotocol/sdk";

import { EventEmitter } from "node:events";

import { type EventsLogWriter } from "./events-log";
import { pendingPermissions } from "./pending-permissions";
import {
  SupervisorError,
  type SessionEvent,
  type SessionRecord,
} from "./types";

export type SessionEmitter = EventEmitter;

export const SESSION_EVENT_CHANNEL = "session.event";

export type RegistryEntry = {
  record: SessionRecord;
  child: ChildProcess;
  emitter: SessionEmitter;
  intentionalShutdown: boolean;
  eventBuffer: SessionEvent[];
  connection?: acp.ClientSideConnection;
  acpSessionId?: string;
  eventsLog?: EventsLogWriter;
};

export type RegisterOptions = {
  connection?: acp.ClientSideConnection;
  acpSessionId?: string;
  eventsLog?: EventsLogWriter;
};

const MAX_EVENT_BUFFER = 1000;

export class SessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "registry" });
  }

  register(
    record: SessionRecord,
    child: ChildProcess,
    emitter: SessionEmitter,
    options: RegisterOptions = {},
  ): void {
    if (this.entries.has(record.sessionId)) {
      throw new SupervisorError(
        "PRECONDITION",
        `duplicate sessionId: ${record.sessionId}`,
      );
    }

    const entry: RegistryEntry = {
      record,
      child,
      emitter,
      intentionalShutdown: false,
      eventBuffer: [],
      connection: options.connection,
      acpSessionId: options.acpSessionId,
      eventsLog: options.eventsLog,
    };

    this.entries.set(record.sessionId, entry);
    emitter.on(SESSION_EVENT_CHANNEL, (event: SessionEvent) => {
      entry.eventBuffer.push(event);
      if (entry.eventBuffer.length > MAX_EVENT_BUFFER) {
        entry.eventBuffer.shift();
      }
      entry.eventsLog?.append(event);
      if (
        event.type === "session.exited" ||
        event.type === "session.crashed"
      ) {
        pendingPermissions.purgeSession(record.sessionId);
        if (entry.eventsLog) {
          const closing = entry.eventsLog;

          void closing.close().catch((err: unknown) => {
            this.logger.warn(
              {
                sessionId: record.sessionId,
                err: err instanceof Error ? err.message : String(err),
              },
              "events-log close failed",
            );
          });
        }
      }
    });
    this.logger.debug(
      { sessionId: record.sessionId, runId: record.runId, pid: record.pid },
      "register",
    );
  }

  attachAcp(
    sessionId: string,
    connection: acp.ClientSideConnection,
    acpSessionId: string,
  ): void {
    const entry = this.entries.get(sessionId);

    if (!entry) {
      throw new SupervisorError(
        "PRECONDITION",
        `unknown sessionId: ${sessionId}`,
      );
    }

    entry.connection = connection;
    entry.acpSessionId = acpSessionId;
  }

  markIntentionalShutdown(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);

    if (!entry) return false;

    entry.intentionalShutdown = true;

    return true;
  }

  get(sessionId: string): RegistryEntry | undefined {
    return this.entries.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  list(): SessionRecord[] {
    return Array.from(this.entries.values(), (entry) => entry.record);
  }

  remove(sessionId: string, reason: string): boolean {
    const removed = this.entries.delete(sessionId);

    if (removed) {
      this.logger.debug({ sessionId, reason }, "remove");
    }

    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  forEach(cb: (entry: RegistryEntry) => void): void {
    for (const entry of this.entries.values()) {
      cb(entry);
    }
  }

  emit(sessionId: string, event: SessionEvent): boolean {
    const entry = this.entries.get(sessionId);

    if (!entry) return false;

    entry.emitter.emit(SESSION_EVENT_CHANNEL, event);

    return true;
  }

  snapshotEvents(sessionId: string): SessionEvent[] {
    const entry = this.entries.get(sessionId);

    return entry ? [...entry.eventBuffer] : [];
  }

  subscribe(
    sessionId: string,
    listener: (event: SessionEvent) => void,
  ): () => void {
    const entry = this.entries.get(sessionId);

    if (!entry) {
      throw new SupervisorError(
        "PRECONDITION",
        `unknown sessionId: ${sessionId}`,
      );
    }

    entry.emitter.on(SESSION_EVENT_CHANNEL, listener);

    return () => {
      entry.emitter.off(SESSION_EVENT_CHANNEL, listener);
    };
  }
}
