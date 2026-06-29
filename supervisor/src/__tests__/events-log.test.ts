import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";

import { openEventsLog } from "../events-log";
import { type SessionEvent } from "../types";

const silentLogger = pino({ level: "silent" });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "events-log-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lineEvent(monotonicId: number, line: string): SessionEvent {
  return {
    type: "session.line",
    sessionId: "s1",
    monotonicId,
    line,
  };
}

describe("openEventsLog", () => {
  it("writes 3 events as 3 JSON lines that round-trip via JSON.parse", async () => {
    const path = join(dir, "step-1.events.jsonl");
    const w = await openEventsLog(path, { logger: silentLogger });

    w.append(lineEvent(1, "first"));
    w.append(lineEvent(2, "second"));
    w.append(lineEvent(3, "third"));
    await w.close();

    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);

    expect(lines).toHaveLength(3);
    const parsed = lines.map(
      (l) => JSON.parse(l) as { monotonicId: number; line: string },
    );

    expect(parsed[0].line).toBe("first");
    expect(parsed[1].line).toBe("second");
    expect(parsed[2].monotonicId).toBe(3);
  });

  it("stamps sessionName on every event line when configured (M42)", async () => {
    const path = join(dir, "step-session.events.jsonl");
    const w = await openEventsLog(path, {
      logger: silentLogger,
      sessionName: "review",
    });

    w.append(lineEvent(1, "first"));
    await w.close();

    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw.trim()) as {
      sessionName?: string;
      line: string;
    };

    expect(parsed.sessionName).toBe("review");
    expect(parsed.line).toBe("first");
  });

  it("omits sessionName when not configured (single-session run)", async () => {
    const path = join(dir, "step-nosession.events.jsonl");
    const w = await openEventsLog(path, { logger: silentLogger });

    w.append(lineEvent(1, "first"));
    await w.close();

    const raw = await readFile(path, "utf8");

    expect(JSON.parse(raw.trim())).not.toHaveProperty("sessionName");
  });

  it("stamps nodeAttemptId on every event line when configured (T-B0)", async () => {
    const path = join(dir, "step-node-attempt.events.jsonl");
    const w = await openEventsLog(path, {
      logger: silentLogger,
      sessionName: "implement",
      nodeAttemptId: "node-attempt-7",
    });

    w.append(lineEvent(1, "first"));
    w.append(lineEvent(2, "second"));
    await w.close();

    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const parsed = lines.map(
      (l) =>
        JSON.parse(l) as {
          sessionName?: string;
          nodeAttemptId?: string;
          line: string;
        },
    );

    expect(parsed).toHaveLength(2);
    for (const p of parsed) {
      expect(p.sessionName).toBe("implement");
      expect(p.nodeAttemptId).toBe("node-attempt-7");
    }
  });

  it("omits nodeAttemptId cleanly when not configured (scratch/single-session)", async () => {
    const path = join(dir, "step-no-node-attempt.events.jsonl");
    const w = await openEventsLog(path, {
      logger: silentLogger,
      sessionName: "default",
    });

    w.append(lineEvent(1, "first"));
    await w.close();

    const raw = await readFile(path, "utf8");

    expect(JSON.parse(raw.trim())).not.toHaveProperty("nodeAttemptId");
  });

  it("preserves append order on rapid sequential calls", async () => {
    const path = join(dir, "step-order.events.jsonl");
    const w = await openEventsLog(path, { logger: silentLogger });

    for (let i = 1; i <= 50; i += 1) {
      w.append(lineEvent(i, `line ${i}`));
    }

    await w.close();

    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);

    expect(lines).toHaveLength(50);
    for (let i = 0; i < 50; i += 1) {
      const parsed = JSON.parse(lines[i]) as { monotonicId: number };

      expect(parsed.monotonicId).toBe(i + 1);
    }
  });

  it("close is idempotent", async () => {
    const path = join(dir, "step-close.events.jsonl");
    const w = await openEventsLog(path, { logger: silentLogger });

    w.append(lineEvent(1, "hello"));
    await w.close();
    await w.close();

    const info = await stat(path);

    expect(info.size).toBeGreaterThan(0);
  });

  it("creates the file even when no events are appended", async () => {
    const path = join(dir, "step-empty.events.jsonl");
    const w = await openEventsLog(path, { logger: silentLogger });

    await w.close();

    const info = await stat(path);

    expect(info.size).toBe(0);
  });
});
