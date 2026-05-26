import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";

import { EventEmitter } from "node:events";

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
};

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
  ): void {
    if (this.entries.has(record.sessionId)) {
      throw new SupervisorError(
        "PRECONDITION",
        `duplicate sessionId: ${record.sessionId}`,
      );
    }

    this.entries.set(record.sessionId, {
      record,
      child,
      emitter,
      intentionalShutdown: false,
    });
    this.logger.debug(
      { sessionId: record.sessionId, runId: record.runId, pid: record.pid },
      "register",
    );
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
