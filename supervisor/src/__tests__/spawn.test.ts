import type { SessionEvent, StartSessionRequest } from "../types";

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";

import { spawnSession } from "../spawn";
import { SESSION_EVENT_CHANNEL, SessionRegistry } from "../registry";

const FIXTURE_PATH = resolve(
  fileURLToPath(import.meta.url),
  "../../../test/fixtures/fake-acp.mjs",
);
const silentLogger = pino({ level: "silent" });

function makeRequest(
  over: Partial<StartSessionRequest> = {},
): StartSessionRequest {
  return {
    runId: "run-1",
    projectSlug: "demo",
    worktreePath: process.cwd(),
    stepId: "step-1",
    executor: { agent: "claude", model: "claude-sonnet-4-6" },
    ...over,
  };
}

function collectEvents(emitter: EventEmitter): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];

  return new Promise<SessionEvent[]>((resolveP) => {
    emitter.on(SESSION_EVENT_CHANNEL, (e: SessionEvent) => events.push(e));
    setTimeout(() => resolveP(events), 1000);
  });
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "spawn-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("spawnSession", () => {
  it("spawns a child via binaryOverride and emits line events with monotonic ids", async () => {
    const sessionId = "session-1";
    const request = makeRequest();
    const { child, emitter, record, logPath } = await spawnSession({
      sessionId,
      request,
      runtimeRoot: tempDir,
      logger: silentLogger,
      binaryOverride: "node",
      preArgs: [FIXTURE_PATH, "--lines", "3", "--emit-usage"],
    });

    expect(record.sessionId).toBe(sessionId);
    expect(record.pid).toBeGreaterThan(0);
    expect(logPath.startsWith(tempDir)).toBe(true);

    const eventsPromise = collectEvents(emitter);

    await new Promise<void>((r) => child.once("exit", () => r()));

    const events = await eventsPromise;
    const lineEvents = events.filter((e) => e.type === "session.line");

    expect(lineEvents).toHaveLength(3);
    expect(lineEvents[0].monotonicId).toBe(1);
    expect(lineEvents[1].monotonicId).toBe(2);
    expect(lineEvents[2].monotonicId).toBe(3);

    const lastLine = JSON.parse((lineEvents[2] as { line: string }).line) as {
      usage?: { input_tokens?: number };
    };

    expect(lastLine.usage?.input_tokens).toBe(100);
  });

  it("writes child stdout to log file", async () => {
    const request = makeRequest({ runId: "run-log", stepId: "stepX" });
    const { child, logPath } = await spawnSession({
      sessionId: "session-log",
      request,
      runtimeRoot: tempDir,
      logger: silentLogger,
      binaryOverride: "node",
      preArgs: [FIXTURE_PATH, "--lines", "2"],
    });

    await new Promise<void>((r) => child.once("exit", () => r()));
    await new Promise<void>((r) => setTimeout(r, 50));

    const contents = await readFile(logPath, "utf8");

    expect(contents.split("\n").filter(Boolean)).toHaveLength(2);
    expect(contents).toContain(`"line 0"`);
    expect(contents).toContain(`"line 1"`);
  });

  it("passes --resume flag when resumeSessionId is set", async () => {
    const request = makeRequest({
      runId: "run-resume",
      resumeSessionId: "uuid-abc-123",
    });
    const { child, emitter } = await spawnSession({
      sessionId: "session-r",
      request,
      runtimeRoot: tempDir,
      logger: silentLogger,
      binaryOverride: "node",
      preArgs: [FIXTURE_PATH, "--lines", "0"],
    });

    const eventsPromise = collectEvents(emitter);

    await new Promise<void>((r) => child.once("exit", () => r()));

    const events = await eventsPromise;
    const lineEvents = events.filter((e) => e.type === "session.line");

    expect(lineEvents.length).toBeGreaterThanOrEqual(1);
    const first = JSON.parse((lineEvents[0] as { line: string }).line) as {
      type: string;
      sessionId: string;
    };

    expect(first.type).toBe("resumed");
    expect(first.sessionId).toBe("uuid-abc-123");
  });

  it("passes capability launch args and env to the adapter process", async () => {
    const request = makeRequest({
      runId: "run-cap",
      capabilityProfilePath: `${process.cwd()}/.maister/capabilities/run-cap/profile.json`,
      adapterLaunch: {
        env: { MAISTER_TEST_PROFILE_ENV: "profile-ready" },
        preArgs: ["--cap-pre"],
        postArgs: ["--cap-post"],
      },
    });
    const { child, emitter } = await spawnSession({
      sessionId: "session-cap",
      request,
      runtimeRoot: tempDir,
      logger: silentLogger,
      binaryOverride: "node",
      preArgs: [
        FIXTURE_PATH,
        "--lines",
        "0",
        "--echo-env",
        "MAISTER_TEST_PROFILE_ENV",
      ],
    });

    expect(child.spawnargs).toContain("--cap-pre");
    expect(child.spawnargs).toContain("--cap-post");

    const eventsPromise = collectEvents(emitter);

    await new Promise<void>((r) => child.once("exit", () => r()));

    const events = await eventsPromise;
    const envLine = events.find((e) => e.type === "session.line") as
      | { line: string }
      | undefined;

    expect(envLine).toBeDefined();
    expect(JSON.parse(envLine?.line ?? "{}")).toMatchObject({
      type: "env",
      name: "MAISTER_TEST_PROFILE_ENV",
      value: "profile-ready",
    });
  });

  it("throws SupervisorError(SPAWN) when binary does not exist", async () => {
    const request = makeRequest();

    await expect(
      spawnSession({
        sessionId: "session-bad",
        request,
        runtimeRoot: tempDir,
        logger: silentLogger,
        binaryOverride: "/definitely/not/a/real/binary",
      }),
    ).rejects.toMatchObject({ code: "SPAWN" });
  });

  it("writes events.jsonl with one line per emitted SessionEvent after registry hookup", async () => {
    const sessionId = "session-elog";
    const request = makeRequest({ runId: "run-elog", stepId: "elog" });
    const { child, emitter, record, eventsLog, eventsLogPath } =
      await spawnSession({
        sessionId,
        request,
        runtimeRoot: tempDir,
        logger: silentLogger,
        binaryOverride: "node",
        preArgs: [FIXTURE_PATH, "--lines", "3"],
      });

    const registry = new SessionRegistry(silentLogger);

    registry.register(record, child, emitter, { eventsLog });

    await new Promise<void>((r) => child.once("exit", () => r()));
    await new Promise<void>((r) => setTimeout(r, 100));

    record.monotonicId += 1;
    registry.emit(sessionId, {
      type: "session.exited",
      sessionId,
      monotonicId: record.monotonicId,
      exitCode: 0,
    });
    await new Promise<void>((r) => setTimeout(r, 100));

    const raw = await readFile(eventsLogPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);

    expect(lines.length).toBeGreaterThanOrEqual(4);
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);

    expect(types.filter((t) => t === "session.line")).toHaveLength(3);
    expect(types).toContain("session.exited");
  });

  it("uses run-scoped run.events.jsonl shared across multiple spawns for the same run (regression: multi-step SSE)", async () => {
    const sessionA = "sess-A";
    const sessionB = "sess-B";
    const request = makeRequest({ runId: "run-multi", stepId: "stepA" });

    const a = await spawnSession({
      sessionId: sessionA,
      request,
      runtimeRoot: tempDir,
      logger: silentLogger,
      binaryOverride: "node",
      preArgs: [FIXTURE_PATH, "--lines", "2"],
    });

    expect(a.eventsLogPath.endsWith("/runs/run-multi/run.events.jsonl")).toBe(
      true,
    );

    const registry = new SessionRegistry(silentLogger);

    registry.register(a.record, a.child, a.emitter, { eventsLog: a.eventsLog });
    await new Promise<void>((r) => a.child.once("exit", () => r()));
    await new Promise<void>((r) => setTimeout(r, 50));
    a.record.monotonicId += 1;
    registry.emit(sessionA, {
      type: "session.exited",
      sessionId: sessionA,
      monotonicId: a.record.monotonicId,
      exitCode: 0,
    });
    await new Promise<void>((r) => setTimeout(r, 100));

    const b = await spawnSession({
      sessionId: sessionB,
      request: { ...request, stepId: "stepB" },
      runtimeRoot: tempDir,
      logger: silentLogger,
      binaryOverride: "node",
      preArgs: [FIXTURE_PATH, "--lines", "1"],
    });

    expect(b.eventsLogPath).toBe(a.eventsLogPath);

    registry.register(b.record, b.child, b.emitter, { eventsLog: b.eventsLog });
    await new Promise<void>((r) => b.child.once("exit", () => r()));
    await new Promise<void>((r) => setTimeout(r, 50));
    b.record.monotonicId += 1;
    registry.emit(sessionB, {
      type: "session.exited",
      sessionId: sessionB,
      monotonicId: b.record.monotonicId,
      exitCode: 0,
    });
    await new Promise<void>((r) => setTimeout(r, 100));

    const raw = await readFile(a.eventsLogPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const events = lines.map(
      (l) => JSON.parse(l) as { sessionId: string; monotonicId: number },
    );

    expect(
      events.filter((e) => e.sessionId === sessionA).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      events.filter((e) => e.sessionId === sessionB).length,
    ).toBeGreaterThanOrEqual(1);

    // Regression: per-run monotonicId must be strictly increasing
    // across consecutive sessions. Without the tail-seed, sessionB's
    // ids would restart at 1 and the SSE bridge's `monotonicId >
    // lastSeen` filter would silently drop them on reconnect.
    const monotonicIds = events.map((e) => e.monotonicId);
    const sessionBMin = Math.min(
      ...events
        .filter((e) => e.sessionId === sessionB)
        .map((e) => e.monotonicId),
    );
    const sessionAMax = Math.max(
      ...events
        .filter((e) => e.sessionId === sessionA)
        .map((e) => e.monotonicId),
    );

    expect(sessionBMin).toBeGreaterThan(sessionAMax);
    for (let i = 1; i < monotonicIds.length; i += 1) {
      expect(monotonicIds[i]).toBeGreaterThan(monotonicIds[i - 1]);
    }
  });

  it("closes events.jsonl after terminal event so the file stat is stable", async () => {
    const sessionId = "session-elog-close";
    const request = makeRequest({
      runId: "run-elog-close",
      stepId: "elog-close",
    });
    const { child, emitter, record, eventsLog, eventsLogPath } =
      await spawnSession({
        sessionId,
        request,
        runtimeRoot: tempDir,
        logger: silentLogger,
        binaryOverride: "node",
        preArgs: [FIXTURE_PATH, "--lines", "1"],
      });

    const registry = new SessionRegistry(silentLogger);

    registry.register(record, child, emitter, { eventsLog });

    await new Promise<void>((r) => child.once("exit", () => r()));
    await new Promise<void>((r) => setTimeout(r, 50));

    record.monotonicId += 1;
    registry.emit(sessionId, {
      type: "session.exited",
      sessionId,
      monotonicId: record.monotonicId,
      exitCode: 0,
    });
    await new Promise<void>((r) => setTimeout(r, 100));

    const before = await stat(eventsLogPath);

    await new Promise<void>((r) => setTimeout(r, 50));
    const after = await stat(eventsLogPath);

    expect(after.size).toBe(before.size);
  });

  it("caps single line at MAX_LINE_BYTES and emits a truncated event", async () => {
    const request = makeRequest({ runId: "run-giant", stepId: "giant" });
    const giantBytes = 1024 * 1024 + 1024;
    const { child, emitter, record } = await spawnSession({
      sessionId: "session-giant",
      request,
      runtimeRoot: tempDir,
      logger: silentLogger,
      binaryOverride: "node",
      preArgs: [FIXTURE_PATH, "--giant-bytes", String(giantBytes)],
    });

    const eventsPromise = collectEvents(emitter);

    await new Promise<void>((r) => child.once("exit", () => r()));

    const events = await eventsPromise;
    const lineEvents = events.filter((e) => e.type === "session.line");

    expect(lineEvents.length).toBeGreaterThanOrEqual(1);
    for (const ev of lineEvents) {
      expect((ev as { line: string }).line.length).toBeLessThanOrEqual(
        1024 * 1024,
      );
    }
    expect(record.monotonicId).toBeGreaterThanOrEqual(1);
  });
});
