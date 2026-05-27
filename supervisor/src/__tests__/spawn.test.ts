import type { SessionEvent, StartSessionRequest } from "../types";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";

import { spawnSession } from "../spawn";
import { SESSION_EVENT_CHANNEL } from "../registry";

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
