import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type {
  McpServerInput,
  RunnerLaunch,
  SessionEvent,
  SessionRecord,
  SupervisorError,
} from "../types";

import { spawn, execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createWriteStream, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { createAcpConnection, sendPromptOnConnection } from "../acp-client";
import { listAdapterRuntimes } from "../adapter-registry";
import { captureAcpFrames } from "../bounded-acp-stream";
import { modelCatalogCache } from "../model-catalog/cache";
import { createPendingPermissions } from "../pending-permissions";
import { SESSION_EVENT_CHANNEL } from "../registry";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/mock-acp-compatibility.mjs",
);
const logger = pino({ level: "silent" });

type FixtureChild = ChildProcessByStdio<Writable, Readable, null>;

const fixtures: Array<{
  child: FixtureChild;
  root: string;
  drained: Promise<void>;
  failures: SupervisorError[];
}> = [];

function spawnFixture(args: readonly string[] = []): {
  stdin: Writable;
  stdout: Readable;
} {
  const root = mkdtempSync(join(tmpdir(), "maister-acp-compat-"));
  const child = spawn(process.execPath, [FIXTURE_PATH, ...args], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let resolveDrained: () => void = () => {};
  const drained = new Promise<void>((resolveP) => {
    resolveDrained = resolveP;
  });
  const failures: SupervisorError[] = [];
  // The ACP client consumes complete frames from the production framer, not
  // arbitrary pipe chunks that can contain several SDK notifications/results.
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

  return { stdin: child.stdin, stdout };
}

function recordFor(adapter: SessionRecord["adapter"]): SessionRecord {
  return {
    sessionId: `compat-${adapter}`,
    adapter,
    runId: `run-${adapter}`,
    projectSlug: "demo",
    stepId: "step-1",
    sessionName: "default",
    status: "live",
    pid: 1,
    startedAt: new Date().toISOString(),
    logPath: `/tmp/compat-${adapter}.log`,
    worktreePath: `/tmp/compat-${adapter}-wt`,
    executionWorkspaceId: "ws_5f3a8a2b7e344f6d9d2c1d4e5f6a7b8c",
    assignmentId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
    assignmentEpoch: 1,
    createdByCommandId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
    monotonicId: 0,
  };
}

function runnerFor(adapter: SessionRecord["adapter"]): RunnerLaunch {
  return {
    version: 1,
    runnerId: `${adapter}-compat`,
    adapter,
    capabilityAgent: adapter,
    model: "configured-model",
    provider:
      adapter === "claude"
        ? { kind: "anthropic" }
        : adapter === "codex"
          ? { kind: "openai" }
          : adapter === "gemini"
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
  modelCatalogCache.clear();
  expect(failures).toEqual([]);
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
          channel: "set_session_model",
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

  async function driveReadOnlyPrompt(
    adapter: SessionRecord["adapter"],
    permissionKind: string,
  ): Promise<{
    events: SessionEvent[];
    result: Awaited<ReturnType<typeof sendPromptOnConnection>>;
    pendingPermissions: ReturnType<typeof createPendingPermissions>;
    sessionId: string;
  }> {
    const pendingPermissions = createPendingPermissions({ timeoutMs: 5_000 });
    const child = spawnFixture(["--permission-kind", permissionKind]);
    const emitter = new EventEmitter();
    const events = eventCollector(emitter);
    const record: SessionRecord = {
      ...recordFor(adapter),
      readOnlySession: true,
    };
    const connection = await createAcpConnection({
      stdin: child.stdin,
      stdoutSource: child.stdout,
      sessionId: record.sessionId,
      worktreePath: process.cwd(),
      record,
      emitter,
      logger,
      adapter,
      pendingPermissions,
      runner: runnerFor(adapter),
    });

    const result = await sendPromptOnConnection(
      connection.connection,
      {
        adapter,
        acpSessionId: connection.acpSessionId,
        stepId: "step-1",
        prompt: "request permission",
      },
      logger,
    );

    return { events, result, pendingPermissions, sessionId: record.sessionId };
  }

  it("IT-UX-20 an operational read-only session asks for its registered MAIster mutation instead of denying or approving it", async () => {
    const child = spawnFixture(["--permission-kind", "other"]);
    const emitter = new EventEmitter();
    const events = eventCollector(emitter);
    const pendingPermissions = createPendingPermissions({ timeoutMs: 5000 });
    const record: SessionRecord & { agentKind: "operational" } = {
      ...recordFor("opencode"),
      readOnlySession: true,
      agentKind: "operational",
      autoApprovePermissions: false,
    };
    const connection = await createAcpConnection({
      stdin: child.stdin,
      stdoutSource: child.stdout,
      sessionId: record.sessionId,
      worktreePath: process.cwd(),
      record,
      emitter,
      logger,
      adapter: "opencode",
      pendingPermissions,
      runner: runnerFor("opencode"),
      mcpServers: [
        {
          name: "maister",
          transport: "stdio" as const,
          command: "node",
          args: [],
          env: {
            MAISTER_PROJECT_TOKEN: "controlled-token",
            MAISTER_API_BASE_URL: "http://fixture.invalid",
          },
        },
      ],
    });
    const prompt = sendPromptOnConnection(
      connection.connection,
      {
        adapter: "opencode",
        acpSessionId: connection.acpSessionId,
        stepId: "qualify",
        prompt: "tool-name:mcp__maister__triage_set",
      },
      logger,
    );
    const permission = await waitForEvent(
      emitter,
      (event) => event.type === "session.permission_request",
    );

    if (permission.type !== "session.permission_request")
      throw new Error("Expected explicit control-plane permission");
    expect(pendingPermissions.size(record.sessionId)).toBe(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "session.update",
        update: expect.objectContaining({
          content: expect.objectContaining({
            text: "permission selected:allow",
          }),
        }),
      }),
    );
    expect(
      pendingPermissions.resolve(
        record.sessionId,
        permission.requestId,
        "allow",
      ),
    ).toBe(true);
    expect(await prompt).toMatchObject({ stopReason: "end_turn" });
    expect(pendingPermissions.size(record.sessionId)).toBe(0);
  });

  it.each([
    {
      kind: "other",
      tool: "mcp__maister__triage_set",
      registered: true,
      operational: true,
      duplicateFacade: true,
    },
    {
      kind: "other",
      tool: "mcp__maister__triage_set",
      registered: true,
      operational: true,
      httpFacade: true,
    },
    {
      kind: "other",
      tool: "mcp__maister__triage_set",
      registered: true,
      operational: true,
      missingFacadeCredential: true,
    },
    {
      kind: "other",
      tool: "mcp__github__issue_write",
      registered: true,
      operational: true,
    },
    {
      kind: "other",
      tool: "mcp__maister__triage_set",
      registered: false,
      operational: true,
    },
    {
      kind: "other",
      tool: "ambiguous_tool",
      registered: true,
      operational: true,
    },
    {
      kind: "edit",
      tool: "mcp__maister__triage_set",
      registered: true,
      operational: true,
      nativePath: true,
    },
    {
      kind: "execute",
      tool: "mcp__maister__triage_set",
      registered: true,
      operational: true,
    },
    {
      kind: "other",
      tool: "mcp__maister__triage_set",
      registered: true,
      operational: false,
    },
  ])(
    "IT-UX-20 preserves read-only refusal for $tool ($kind, registered=$registered, operational=$operational)",
    async ({ kind, tool, registered, operational, ...request }) => {
      const child = spawnFixture(["--permission-kind", kind]);
      const emitter = new EventEmitter();
      const events = eventCollector(emitter);
      const pendingPermissions = createPendingPermissions({ timeoutMs: 5000 });
      const record: SessionRecord = {
        ...recordFor("opencode"),
        readOnlySession: true,
        ...(operational ? { agentKind: "operational" as const } : {}),
      };
      const facade: McpServerInput = {
        name: "maister",
        transport:
          "httpFacade" in request ? ("http" as const) : ("stdio" as const),
        command: "node",
        args: [],
        url: "http://fixture.invalid",
        env:
          "missingFacadeCredential" in request
            ? {}
            : {
                MAISTER_PROJECT_TOKEN: "controlled-token",
                MAISTER_API_BASE_URL: "http://fixture.invalid",
              },
      };
      const connection = await createAcpConnection({
        stdin: child.stdin,
        stdoutSource: child.stdout,
        sessionId: record.sessionId,
        worktreePath: process.cwd(),
        record,
        emitter,
        logger,
        adapter: "opencode",
        pendingPermissions,
        runner: runnerFor("opencode"),
        ...(registered
          ? {
              mcpServers: [
                facade,
                ...("duplicateFacade" in request ? [facade] : []),
              ],
            }
          : {}),
      });

      expect(
        await sendPromptOnConnection(
          connection.connection,
          {
            adapter: "opencode",
            acpSessionId: connection.acpSessionId,
            stepId: "qualify",
            prompt: `tool-name:${tool}${"nativePath" in request ? " native-path" : ""}`,
          },
          logger,
        ),
      ).toMatchObject({ stopReason: "end_turn" });
      expect(pendingPermissions.size(record.sessionId)).toBe(0);
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "session.permission_request" }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.update",
          update: expect.objectContaining({
            content: expect.objectContaining({
              text: "permission selected:deny",
            }),
          }),
        }),
      );
    },
  );

  it("IT-UX-20 native read-only ACP reads the detached evidence SHA after the source branch advances", async () => {
    const reader = spawnFixture([
      "--permission-kind",
      "read",
      "--native-read-file",
    ]);
    const root = fixtures[fixtures.length - 1].root;
    const source = join(root, "source");
    const detached = join(root, "evidence");

    execFileSync("git", ["init", "-b", "main", source]);
    writeFileSync(join(source, "evidence.txt"), "pinned evidence\n");
    execFileSync("git", ["-C", source, "add", "evidence.txt"]);
    execFileSync("git", [
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "Evidence",
    ]);
    const sha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    execFileSync("git", [
      "-C",
      source,
      "worktree",
      "add",
      "--detach",
      detached,
      sha,
    ]);
    writeFileSync(
      join(source, "evidence.txt"),
      "new mutable branch evidence\n",
    );
    // The controlled adapter uses the same native file access as the supported runner.
    execFileSync("git", ["-C", source, "add", "evidence.txt"]);
    execFileSync("git", [
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "Advance source",
    ]);
    const emitter = new EventEmitter();
    const events = eventCollector(emitter);
    const record: SessionRecord = {
      ...recordFor("claude"),
      readOnlySession: true,
    };
    const connection = await createAcpConnection({
      stdin: reader.stdin,
      stdoutSource: reader.stdout,
      sessionId: record.sessionId,
      worktreePath: detached,
      record,
      emitter,
      logger,
      adapter: "claude",
      pendingPermissions: createPendingPermissions({ timeoutMs: 5000 }),
      runner: runnerFor("claude"),
    });

    expect(
      await sendPromptOnConnection(
        connection.connection,
        {
          adapter: "claude",
          acpSessionId: connection.acpSessionId,
          stepId: "qualify",
          prompt: `Read native-file:${encodeURIComponent(join(detached, "evidence.txt"))}`,
        },
        logger,
      ),
    ).toMatchObject({ stopReason: "end_turn" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.update",
        update: expect.objectContaining({
          content: expect.objectContaining({ text: "pinned evidence\n" }),
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "session.permission_request" }),
    );
    expect(
      execFileSync("git", ["-C", detached, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(sha);
  });

  describe("readOnlySession L1 wire arbitration (ADR-090)", () => {
    const capableAdapters = listAdapterRuntimes()
      .filter((runtime) => runtime.readOnlyCapable)
      .map((runtime) => runtime.id);

    async function expectInlineArbitration(
      adapter: SessionRecord["adapter"],
      permissionKind: string,
      decision: "allow" | "deny",
    ): Promise<void> {
      const { events, result, pendingPermissions, sessionId } =
        await driveReadOnlyPrompt(adapter, permissionKind);

      expect(result).toMatchObject({ stopReason: "end_turn" });
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "session.permission_request" }),
      );
      expect(pendingPermissions.size(sessionId)).toBe(0);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.update",
          update: expect.objectContaining({
            sessionUpdate: "agent_message_chunk",
            content: expect.objectContaining({
              text: `permission selected:${decision}`,
            }),
          }),
        }),
      );
    }

    it.each(capableAdapters)(
      "%s reaches the shared read-only arbitration seam",
      async (adapter) => {
        await expectInlineArbitration(adapter, "read", "allow");
      },
    );

    it.each([
      ["edit", "deny"],
      ["execute", "deny"],
      ["other", "deny"],
    ] as const)(
      "shared arbitration answers %s with %s without HITL leakage",
      async (permissionKind, decision) => {
        await expectInlineArbitration("opencode", permissionKind, decision);
      },
    );
  });

  it("does not call ACP authenticate for a Gemini CLI-native runner", async () => {
    const child = spawnFixture(["--gemini-reject-authenticate"]);
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
        runner: runnerFor("gemini"),
      }),
    ).resolves.toMatchObject({
      acpSessionId: expect.stringMatching(/^compat-/),
    });
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
