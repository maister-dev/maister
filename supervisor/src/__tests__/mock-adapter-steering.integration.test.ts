import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { SessionEvent, SessionRecord, SupervisorError } from "../types";

import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createWriteStream, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAcpConnection,
  sendPromptOnConnection,
  steerOnConnection,
} from "../acp-client";
import { captureAcpFrames } from "../bounded-acp-stream";
import { createPendingPermissions } from "../pending-permissions";
import { SESSION_EVENT_CHANNEL } from "../registry";

// ADR-182 D-A4: the steering flags of the lifecycle mock, driven through the
// production ACP client. This pins the extension mechanism the host relies on
// (the SDK registers `_session/steering` only when the agent defines
// `extMethod`) and the answers every host test scripts.

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/mock-acp-lifecycle.mjs",
);
const logger = pino({ level: "silent" });

type FixtureChild = ChildProcessByStdio<Writable, Readable, null>;

const fixtures: Array<{
  child: FixtureChild;
  root: string;
  drained: Promise<void>;
  failures: SupervisorError[];
}> = [];

function spawnFixture(args: readonly string[]): {
  child: FixtureChild;
  stdin: Writable;
  stdout: Readable;
  log: string;
} {
  const root = mkdtempSync(join(tmpdir(), "maister-steer-mock-"));
  const log = join(root, "invocations.ndjson");
  const child = spawn(
    process.execPath,
    [FIXTURE_PATH, "--hang", "--invocation-log", log, ...args],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  let resolveDrained: () => void = () => {};
  const drained = new Promise<void>((resolveP) => {
    resolveDrained = resolveP;
  });
  const failures: SupervisorError[] = [];
  const stdout = captureAcpFrames({
    source: child.stdout,
    directory: root,
    log: createWriteStream(join(root, "stdout.log")),
    onLine: () => {},
    onFailure: (error) => {
      failures.push(error);
      child.kill("SIGKILL");
    },
    onDrained: resolveDrained,
  });

  fixtures.push({ child, root, drained, failures });

  return { child, stdin: child.stdin, stdout, log };
}

function record(): SessionRecord {
  return {
    sessionId: "steer-mock",
    adapter: "claude",
    runId: "run-steer-mock",
    projectSlug: "demo",
    stepId: "step-1",
    sessionName: "default",
    status: "live",
    pid: 1,
    startedAt: new Date().toISOString(),
    logPath: "/tmp/steer-mock.log",
    worktreePath: "/tmp/steer-mock-wt",
    executionWorkspaceId: "ws_5f3a8a2b7e344f6d9d2c1d4e5f6a7b8c",
    assignmentId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
    assignmentEpoch: 1,
    createdByCommandId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
    monotonicId: 0,
  };
}

async function connect(args: readonly string[]) {
  const fixture = spawnFixture(args);
  const emitter = new EventEmitter();
  const events: SessionEvent[] = [];

  emitter.on(SESSION_EVENT_CHANNEL, (event: SessionEvent) => {
    events.push(event);
  });
  const connected = await createAcpConnection({
    stdin: fixture.stdin,
    stdoutSource: fixture.stdout,
    sessionId: "steer-mock",
    worktreePath: process.cwd(),
    record: record(),
    emitter,
    logger,
    adapter: "claude",
    pendingPermissions: createPendingPermissions({ timeoutMs: 5_000 }),
  });

  return { ...fixture, ...connected, events };
}

async function invocations(
  log: string,
): Promise<Array<Record<string, unknown>>> {
  return (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function agentText(events: SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== "session.update") return [];
    const update = event.update as {
      sessionUpdate?: string;
      content?: { text?: string };
    };

    return update.sessionUpdate === "agent_message_chunk" &&
      typeof update.content?.text === "string"
      ? [update.content.text]
      : [];
  });
}

async function waitForInvocation(log: string, method: string): Promise<void> {
  const startedAt = Date.now();

  for (;;) {
    const rows = await invocations(log).catch(() => []);

    if (rows.some((row) => row.method === method)) return;
    if (Date.now() - startedAt > 5_000)
      throw new Error(`no ${method} invocation within 5 s`);
    await new Promise((resolveP) => setTimeout(resolveP, 20));
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > 5_000) throw new Error("waitUntil timed out");
    await new Promise((resolveP) => setTimeout(resolveP, 20));
  }
}

afterEach(async () => {
  const failures: SupervisorError[] = [];

  for (const fixture of fixtures.splice(0)) {
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
      const exited = once(fixture.child, "exit");

      fixture.child.kill("SIGKILL");
      await exited;
    }
    await fixture.drained;
    await rm(fixture.root, { recursive: true, force: true });
    failures.push(...fixture.failures);
  }
  expect(failures).toEqual([]);
});

describe("lifecycle mock steering flags (ADR-182)", () => {
  it("advertises steering and injects into the running prompt only", async () => {
    const acp = await connect(["--steering", "--controlled-prompt"]);

    expect(acp.capabilities).toEqual({ steering: { supported: true } });

    const idle = await steerOnConnection(
      acp.connection,
      {
        adapter: "claude",
        acpSessionId: acp.acpSessionId,
        contentBlocks: [{ type: "text", text: "too early" }],
      },
      logger,
    );

    expect(idle).toEqual({ kind: "refused", adapterOutcome: "promptRequired" });

    const prompt = sendPromptOnConnection(
      acp.connection,
      {
        adapter: "claude",
        acpSessionId: acp.acpSessionId,
        stepId: "step-1",
        prompt: "work",
      },
      logger,
    );

    await waitForInvocation(acp.log, "session/prompt");
    await expect(
      steerOnConnection(
        acp.connection,
        {
          adapter: "claude",
          acpSessionId: acp.acpSessionId,
          contentBlocks: [{ type: "text", text: "also X" }],
        },
        logger,
      ),
    ).resolves.toEqual({ kind: "injected" });
    acp.child.kill("SIGUSR1");
    await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });

    expect(agentText(acp.events)).toContain("steered:also X");
    expect(
      agentText(acp.events).filter((t) => t.startsWith("steered:")),
    ).toEqual(["steered:also X"]);
    const log = await invocations(acp.log);

    expect(log).toContainEqual(
      expect.objectContaining({
        method: "_session/steering",
        idleBehavior: "promptRequired",
        outcome: "promptRequired",
      }),
    );
    expect(log).toContainEqual(
      expect.objectContaining({
        method: "_session/steering",
        outcome: "injected",
      }),
    );
  });

  it("does not register the extension without --steering", async () => {
    const acp = await connect(["--controlled-prompt"]);

    expect(acp.capabilities).toEqual({ steering: { supported: false } });
    await expect(
      steerOnConnection(
        acp.connection,
        {
          adapter: "claude",
          acpSessionId: acp.acpSessionId,
          contentBlocks: [{ type: "text", text: "x" }],
        },
        logger,
      ),
    ).resolves.toEqual({ kind: "refused", adapterOutcome: "error" });
  });

  it("answers the scripted outcome and times out on a hung steer", async () => {
    const failed = await connect(["--steering", "--steer-outcome", "failed"]);

    await expect(
      steerOnConnection(
        failed.connection,
        {
          adapter: "claude",
          acpSessionId: failed.acpSessionId,
          contentBlocks: [{ type: "text", text: "x" }],
        },
        logger,
      ),
    ).resolves.toEqual({ kind: "refused", adapterOutcome: "failed" });

    const hung = await connect(["--steering", "--steer-outcome", "hang"]);

    await expect(
      steerOnConnection(
        hung.connection,
        {
          adapter: "claude",
          acpSessionId: hung.acpSessionId,
          contentBlocks: [{ type: "text", text: "x" }],
          timeoutMs: 200,
        },
        logger,
      ),
    ).resolves.toEqual({ kind: "timeout" });
  });

  it("starts an unowned turn on startedNewTurn and stops it on cancel", async () => {
    const acp = await connect([
      "--steering",
      "--steer-outcome",
      "startedNewTurn",
    ]);

    await expect(
      steerOnConnection(
        acp.connection,
        {
          adapter: "claude",
          acpSessionId: acp.acpSessionId,
          contentBlocks: [{ type: "text", text: "x" }],
        },
        logger,
      ),
    ).resolves.toEqual({ kind: "refused", adapterOutcome: "startedNewTurn" });
    await waitUntil(() =>
      agentText(acp.events).some((text) => text.startsWith("unowned:")),
    );
    await acp.connection.cancel({ sessionId: acp.acpSessionId });
    await waitForInvocation(acp.log, "unowned/stopped");
    const produced = Number(
      (await invocations(acp.log)).find(
        (row) => row.method === "unowned/stopped",
      )?.count,
    );

    await waitUntil(() => agentText(acp.events).length === produced);
    expect(agentText(acp.events)).toEqual(
      Array.from({ length: produced }, (_, i) => `unowned:${i + 1}`),
    );
    expect(await invocations(acp.log)).toContainEqual(
      expect.objectContaining({ method: "session/cancel", unowned: true }),
    );
  });
});
