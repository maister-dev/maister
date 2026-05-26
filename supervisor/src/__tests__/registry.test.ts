import type { ChildProcess } from "node:child_process";

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import pino from "pino";

import { SESSION_EVENT_CHANNEL, SessionRegistry } from "../registry";
import { SupervisorError, type SessionRecord } from "../types";

const silentLogger = pino({ level: "silent" });

function makeRecord(sessionId: string): SessionRecord {
  return {
    sessionId,
    runId: "run-x",
    projectSlug: "demo",
    stepId: "step-1",
    status: "live",
    pid: 12345,
    startedAt: new Date().toISOString(),
    logPath: "/tmp/log",
    monotonicId: 0,
  };
}

function makeFakeChild(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

describe("SessionRegistry", () => {
  it("registers and retrieves a session", () => {
    const registry = new SessionRegistry(silentLogger);
    const record = makeRecord("s1");
    const child = makeFakeChild();
    const emitter = new EventEmitter();

    registry.register(record, child, emitter);

    expect(registry.has("s1")).toBe(true);
    expect(registry.get("s1")?.record).toBe(record);
    expect(registry.size()).toBe(1);
    expect(registry.list()).toEqual([record]);
  });

  it("rejects duplicate session ids", () => {
    const registry = new SessionRegistry(silentLogger);

    registry.register(makeRecord("s1"), makeFakeChild(), new EventEmitter());

    expect(() =>
      registry.register(makeRecord("s1"), makeFakeChild(), new EventEmitter()),
    ).toThrow(SupervisorError);
  });

  it("removes entries", () => {
    const registry = new SessionRegistry(silentLogger);

    registry.register(makeRecord("s1"), makeFakeChild(), new EventEmitter());

    expect(registry.remove("s1", "test")).toBe(true);
    expect(registry.has("s1")).toBe(false);
    expect(registry.remove("s1", "test")).toBe(false);
  });

  it("emits events to subscribers", () => {
    const registry = new SessionRegistry(silentLogger);

    registry.register(makeRecord("s1"), makeFakeChild(), new EventEmitter());

    const received: unknown[] = [];
    const unsubscribe = registry.subscribe("s1", (e) => received.push(e));

    registry.emit("s1", {
      type: "session.line",
      sessionId: "s1",
      monotonicId: 1,
      line: "hello",
    });

    expect(received).toHaveLength(1);
    expect((received[0] as { line: string }).line).toBe("hello");

    unsubscribe();
    registry.emit("s1", {
      type: "session.line",
      sessionId: "s1",
      monotonicId: 2,
      line: "ignored",
    });

    expect(received).toHaveLength(1);
  });

  it("emit returns false for unknown session", () => {
    const registry = new SessionRegistry(silentLogger);

    expect(
      registry.emit("none", {
        type: "session.line",
        sessionId: "none",
        monotonicId: 1,
        line: "x",
      }),
    ).toBe(false);
  });

  it("subscribe throws for unknown session", () => {
    const registry = new SessionRegistry(silentLogger);

    expect(() => registry.subscribe("none", () => undefined)).toThrow(
      SupervisorError,
    );
  });

  it("markIntentionalShutdown flips the flag", () => {
    const registry = new SessionRegistry(silentLogger);

    registry.register(makeRecord("s1"), makeFakeChild(), new EventEmitter());

    expect(registry.get("s1")?.intentionalShutdown).toBe(false);
    expect(registry.markIntentionalShutdown("s1")).toBe(true);
    expect(registry.get("s1")?.intentionalShutdown).toBe(true);
    expect(registry.markIntentionalShutdown("none")).toBe(false);
  });

  it("exposes SESSION_EVENT_CHANNEL constant", () => {
    expect(SESSION_EVENT_CHANNEL).toBe("session.event");
  });
});
