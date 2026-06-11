import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { RunnerLaunch, SessionEvent, SessionRecord } from "../types";

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { createAcpConnection, sendPromptOnConnection } from "../acp-client";
import { modelCatalogCache } from "../model-catalog/cache";
import { createPendingPermissions } from "../pending-permissions";
import { SESSION_EVENT_CHANNEL } from "../registry";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/mock-acp-compatibility.mjs",
);
const logger = pino({ level: "silent" });

type FixtureChild = ChildProcessByStdio<Writable, Readable, null>;

const children: FixtureChild[] = [];

function spawnFixture(args: readonly string[] = []): FixtureChild {
  const child = spawn(process.execPath, [FIXTURE_PATH, ...args], {
    stdio: ["pipe", "pipe", "ignore"],
  });

  children.push(child);

  return child;
}

function recordFor(adapter: "gemini" | "opencode" | "mimo"): SessionRecord {
  return {
    sessionId: `compat-${adapter}`,
    adapter,
    runId: `run-${adapter}`,
    projectSlug: "demo",
    stepId: "step-1",
    status: "live",
    pid: 1,
    startedAt: new Date().toISOString(),
    logPath: `/tmp/compat-${adapter}.log`,
    monotonicId: 0,
  };
}

function runnerFor(adapter: "gemini" | "opencode" | "mimo"): RunnerLaunch {
  return {
    version: 1,
    runnerId: `${adapter}-compat`,
    adapter,
    capabilityAgent: adapter,
    model: "configured-model",
    provider:
      adapter === "gemini"
        ? { kind: "google_gemini" }
        : { kind: "agent_native" },
    permissionPolicy: "default",
  };
}

function eventCollector(emitter: EventEmitter): SessionEvent[] {
  const events: SessionEvent[] = [];

  emitter.on(SESSION_EVENT_CHANNEL, (event: SessionEvent) => {
    events.push(event);
  });

  return events;
}

function waitForEvent(
  emitter: EventEmitter,
  predicate: (event: SessionEvent) => boolean,
): Promise<SessionEvent> {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      emitter.off(SESSION_EVENT_CHANNEL, listener);
      rejectP(new Error("timed out waiting for ACP event"));
    }, 5_000);
    const listener = (event: SessionEvent) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      emitter.off(SESSION_EVENT_CHANNEL, listener);
      resolveP(event);
    };

    emitter.on(SESSION_EVENT_CHANNEL, listener);
  });
}

async function expectPromptPermission(args: {
  adapter: "opencode" | "mimo";
  acpSessionId: string;
  connection: Awaited<ReturnType<typeof createAcpConnection>>["connection"];
  emitter: EventEmitter;
  pendingPermissions: ReturnType<typeof createPendingPermissions>;
  record: SessionRecord;
}): Promise<void> {
  const prompt = sendPromptOnConnection(
    args.connection,
    {
      adapter: args.adapter,
      acpSessionId: args.acpSessionId,
      stepId: "step-1",
      prompt: "request permission",
    },
    logger,
  );
  const permission = await waitForEvent(
    args.emitter,
    (event) => event.type === "session.permission_request",
  );

  expect(permission.type).toBe("session.permission_request");
  if (permission.type !== "session.permission_request") {
    throw new Error("expected permission request");
  }

  expect(
    args.pendingPermissions.resolve(
      args.record.sessionId,
      permission.requestId,
      "allow",
    ),
  ).toBe(true);
  await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  modelCatalogCache.clear();
});

describe("adapter compatibility fixtures", () => {
  it("drives OpenCode-like newSession, prompt permission, model advisory, and resume through ACP", async () => {
    const pendingPermissions = createPendingPermissions({ timeoutMs: 5_000 });
    const newChild = spawnFixture();
    const newEmitter = new EventEmitter();
    const newEvents = eventCollector(newEmitter);
    const newRecord = recordFor("opencode");
    const newConnection = await createAcpConnection({
      stdin: newChild.stdin,
      stdoutSource: newChild.stdout,
      sessionId: newRecord.sessionId,
      worktreePath: process.cwd(),
      record: newRecord,
      emitter: newEmitter,
      logger,
      adapter: "opencode",
      pendingPermissions,
      runner: runnerFor("opencode"),
    });

    expect(newConnection.acpSessionId).toMatch(/^compat-/);
    expect(newEvents).toContainEqual(
      expect.objectContaining({
        type: "session.update",
        update: expect.objectContaining({
          sessionUpdate: "model_advisory",
          channel: "advisory",
        }),
      }),
    );

    await expectPromptPermission({
      adapter: "opencode",
      acpSessionId: newConnection.acpSessionId,
      connection: newConnection.connection,
      emitter: newEmitter,
      pendingPermissions,
      record: newRecord,
    });

    const resumeChild = spawnFixture();
    const resumeEmitter = new EventEmitter();
    const resumeRecord = recordFor("opencode");
    const resumed = await createAcpConnection({
      stdin: resumeChild.stdin,
      stdoutSource: resumeChild.stdout,
      sessionId: resumeRecord.sessionId,
      worktreePath: process.cwd(),
      record: resumeRecord,
      emitter: resumeEmitter,
      logger,
      adapter: "opencode",
      pendingPermissions,
      resumeSessionId: "existing-opencode-session",
      runner: runnerFor("opencode"),
    });

    expect(resumed.acpSessionId).toBe("existing-opencode-session");
  });

  it("drives MiMo-like newSession, prompt permission, and resume through ACP without OpenCode aliasing", async () => {
    const pendingPermissions = createPendingPermissions({ timeoutMs: 5_000 });
    const newChild = spawnFixture();
    const newEmitter = new EventEmitter();
    const newEvents = eventCollector(newEmitter);
    const newRecord = recordFor("mimo");
    const newConnection = await createAcpConnection({
      stdin: newChild.stdin,
      stdoutSource: newChild.stdout,
      sessionId: newRecord.sessionId,
      worktreePath: process.cwd(),
      record: newRecord,
      emitter: newEmitter,
      logger,
      adapter: "mimo",
      pendingPermissions,
      runner: runnerFor("mimo"),
    });

    expect(newConnection.acpSessionId).toMatch(/^compat-/);
    expect(newEvents).toContainEqual(
      expect.objectContaining({
        type: "session.update",
        update: expect.objectContaining({
          sessionUpdate: "model_advisory",
          channel: "advisory",
          configuredModel: "configured-model",
        }),
      }),
    );

    await expectPromptPermission({
      adapter: "mimo",
      acpSessionId: newConnection.acpSessionId,
      connection: newConnection.connection,
      emitter: newEmitter,
      pendingPermissions,
      record: newRecord,
    });

    const resumeChild = spawnFixture();
    const resumeEmitter = new EventEmitter();
    const resumeRecord = recordFor("mimo");
    const resumed = await createAcpConnection({
      stdin: resumeChild.stdin,
      stdoutSource: resumeChild.stdout,
      sessionId: resumeRecord.sessionId,
      worktreePath: process.cwd(),
      record: resumeRecord,
      emitter: resumeEmitter,
      logger,
      adapter: "mimo",
      pendingPermissions,
      resumeSessionId: "existing-mimo-session",
      runner: runnerFor("mimo"),
    });

    expect(resumed.acpSessionId).toBe("existing-mimo-session");
  });

  it("refuses Gemini loadSession-only resume without falling back to newSession", async () => {
    const child = spawnFixture(["--gemini-load-only"]);
    const emitter = new EventEmitter();
    const record = recordFor("gemini");

    await expect(
      createAcpConnection({
        stdin: child.stdin,
        stdoutSource: child.stdout,
        sessionId: record.sessionId,
        worktreePath: process.cwd(),
        record,
        emitter,
        logger,
        adapter: "gemini",
        resumeSessionId: "existing-gemini-session",
        runner: runnerFor("gemini"),
      }),
    ).rejects.toMatchObject({
      code: "CHECKPOINT",
      message: expect.stringContaining("Gemini loadSession"),
    });
  });
});
