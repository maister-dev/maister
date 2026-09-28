import type { Logger } from "pino";
import type { CommandEnvelope, CommandKind } from "../types";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RUNTIME_LIMITS,
  validateRuntimeLimits,
  type RuntimeLimits,
} from "../runtime-limits";

import {
  adoptDirectory,
  bootHost,
  cleanupRuntimeRoot,
  createEnvelope,
  createSession,
  envelope,
  postJson,
  waitFor,
  type BootedHost,
} from "./_fixtures/boot-host";

// ADR-183 D-D1: one admission table. Soft (unACKed pressure) refuses new work
// only; hard (retained capacity) also refuses answers; physical headroom
// refuses everything but a teardown; nothing refuses a teardown.
type PressureState = "soft" | "hard" | "physical";
type Outcome = "refused" | "admitted";

// ADR-183 amendment 2026-09-28: the refusal names its cause on the wire and
// health names what refuses new work — the manager's fence follows these.
const LIMIT_BY_STATE = {
  soft: "unacknowledged",
  hard: "retained",
  physical: "physical",
} as const satisfies Record<PressureState, string>;

type Case = {
  label: string;
  kind: CommandKind;
  expected: Record<PressureState, Outcome | "skip">;
};

const CASES: Case[] = [
  {
    label: "session.create",
    kind: "session.create",
    expected: { soft: "refused", hard: "refused", physical: "refused" },
  },
  {
    label: "session.prompt",
    kind: "session.prompt",
    expected: { soft: "refused", hard: "refused", physical: "refused" },
  },
  {
    label: "workspace.adopt",
    kind: "workspace.adopt",
    expected: { soft: "refused", hard: "refused", physical: "skip" },
  },
  {
    label: "runtime_object.reserve",
    kind: "runtime_object.reserve",
    expected: { soft: "refused", hard: "refused", physical: "skip" },
  },
  {
    label: "runtime_object.upload",
    kind: "runtime_object.upload",
    expected: { soft: "refused", hard: "refused", physical: "skip" },
  },
  {
    label: "session.input",
    kind: "session.input",
    expected: { soft: "admitted", hard: "refused", physical: "refused" },
  },
  {
    label: "session.steer",
    kind: "session.steer",
    expected: { soft: "admitted", hard: "refused", physical: "skip" },
  },
  {
    label: "session.cancel (live)",
    kind: "session.cancel",
    expected: { soft: "admitted", hard: "admitted", physical: "admitted" },
  },
  {
    label: "session.checkpoint (live)",
    kind: "session.checkpoint",
    expected: { soft: "admitted", hard: "admitted", physical: "skip" },
  },
  {
    label: "session.delete (live)",
    kind: "session.delete",
    expected: { soft: "admitted", hard: "admitted", physical: "skip" },
  },
  {
    label: "session.cancel (not live)",
    kind: "session.cancel",
    expected: { soft: "admitted", hard: "admitted", physical: "skip" },
  },
  {
    label: "session.checkpoint (not live)",
    kind: "session.checkpoint",
    expected: { soft: "admitted", hard: "admitted", physical: "skip" },
  },
  {
    label: "session.delete (not live)",
    kind: "session.delete",
    expected: { soft: "admitted", hard: "admitted", physical: "skip" },
  },
  {
    label: "workspace.release",
    kind: "workspace.release",
    expected: { soft: "admitted", hard: "admitted", physical: "admitted" },
  },
  {
    label: "runtime_object.delete",
    kind: "runtime_object.delete",
    expected: { soft: "admitted", hard: "admitted", physical: "skip" },
  },
];

const ROW_LIMITS = validateRuntimeLimits({
  ...DEFAULT_RUNTIME_LIMITS,
  eventLowRows: 40,
  eventSoftRows: 50,
  eventHardRows: 200,
});
// The runtime-storage suite's pinned-WAL profile: one producer wallet fits.
const PHYSICAL_LIMITS = validateRuntimeLimits({
  ...DEFAULT_RUNTIME_LIMITS,
  eventLowBytes: 48 * 1024 * 1024,
  eventSoftBytes: 60 * 1024 * 1024,
  eventHardBytes: 64 * 1024 * 1024,
  eventControlRows: 82,
  eventControlBytes: 82 * 16 * 1024,
  stateMaxBytes: 96 * 1024 * 1024,
});

const OBJECT_BYTES = Buffer.from('{"ok":true}', "utf8");
const OBJECT_SHA = createHash("sha256").update(OBJECT_BYTES).digest("hex");

type LogLine = Record<string, unknown> & { msg: string };

const hosts: BootedHost[] = [];
const observers: DatabaseSync[] = [];

afterEach(async () => {
  for (const observer of observers.splice(0)) {
    if (observer.isTransaction) observer.exec("ROLLBACK");
    observer.close();
  }
  for (const host of hosts.splice(0)) {
    await host.stop();
    await cleanupRuntimeRoot(host.runtimeRoot);
  }
});

function draft(runId: string) {
  return {
    draft: {
      runId,
      assignmentId: "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a",
      assignmentEpoch: 1,
      hostSessionId: null,
      eventType: "session.created" as const,
      occurredAt: new Date().toISOString(),
      payload: { sourceMonotonicId: 1 },
    },
  };
}

async function reserveObject(
  host: BootedHost,
  fence: Parameters<typeof envelope>[1],
): Promise<string> {
  const objectId = randomUUID();
  const reserved = await postJson(
    `${host.url}/runtime-objects`,
    envelope("runtime_object.reserve", fence, reservePayload(objectId)),
  );

  expect(reserved.status).toBe(201);

  return objectId;
}

function reservePayload(objectId: string): Record<string, unknown> {
  return {
    objectId,
    kind: "evidence",
    logicalName: "verification.json",
    mimeType: "application/json",
    sizeBytes: OBJECT_BYTES.byteLength,
    sha256: OBJECT_SHA,
    generation: 1,
    retentionClass: "run",
  };
}

function uploadObject(
  host: BootedHost,
  objectId: string,
  fence: { assignmentId?: string; assignmentEpoch?: number },
  commandId: string,
): Promise<Response> {
  return fetch(`${host.url}/runtime-objects/${objectId}/content`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(OBJECT_BYTES.byteLength),
      "content-digest": `sha-256=:${Buffer.from(OBJECT_SHA, "hex").toString("base64")}:`,
      "x-maister-command-id": commandId,
      "x-maister-command-issued-at": new Date().toISOString(),
      "x-maister-assignment-id": fence.assignmentId ?? "",
      "x-maister-assignment-epoch": String(fence.assignmentEpoch ?? 1),
      "x-maister-object-generation": "1",
      "x-maister-sha256": OBJECT_SHA,
    },
    body: OBJECT_BYTES,
  });
}

type Fixtures = {
  host: BootedHost;
  lines: LogLine[];
  live: { runId: string; sessionId: string };
  liveCheckpoint?: { runId: string; sessionId: string };
  liveDelete?: { runId: string; sessionId: string };
  notLive?: { runId: string; sessionId: string };
  createTarget: CommandEnvelope;
  releaseTarget: { runId: string; workspaceId: string };
  objectFence?: {
    hostKey: string;
    runId: string;
    assignmentId: string;
    assignmentEpoch: number;
  };
  uploadObjectId?: string;
  deleteObjectId?: string;
  adoptDir: string;
};

async function setUp(state: PressureState): Promise<Fixtures> {
  const lines: LogLine[] = [];
  const logger: Logger = pino(
    { level: "info" },
    { write: (line: string) => lines.push(JSON.parse(line) as LogLine) },
  );
  const limits: RuntimeLimits =
    state === "physical" ? PHYSICAL_LIMITS : ROW_LIMITS;
  const host = await bootHost({
    limits,
    logger,
    runtimeRoot: await mkdtemp(join(tmpdir(), "eh-admission-")),
  });

  hosts.push(host);
  const fence = (runId: string) => ({ hostKey: host.hostState.hostKey, runId });
  const live = { runId: `live-${randomUUID()}`, sessionId: "" };

  live.sessionId = (await createSession(host, fence(live.runId))).sessionId;
  const releaseRun = `release-${randomUUID()}`;
  const releaseTarget = {
    runId: releaseRun,
    workspaceId: await adoptDirectory(host, fence(releaseRun)),
  };
  const createTarget = await createEnvelope(
    host,
    fence(`create-${randomUUID()}`),
  );
  const adoptDir = join(
    host.runtimeRoot,
    "workspaces",
    `adopt-${randomUUID()}`,
  );

  await mkdir(adoptDir, { recursive: true });
  const fixtures: Fixtures = {
    host,
    lines,
    live,
    createTarget,
    releaseTarget,
    adoptDir,
  };

  if (state !== "physical") {
    const liveCheckpoint = { runId: `ckpt-${randomUUID()}`, sessionId: "" };
    const liveDelete = { runId: `del-${randomUUID()}`, sessionId: "" };
    const notLive = { runId: `gone-${randomUUID()}`, sessionId: "" };

    liveCheckpoint.sessionId = (
      await createSession(host, fence(liveCheckpoint.runId))
    ).sessionId;
    liveDelete.sessionId = (
      await createSession(host, fence(liveDelete.runId))
    ).sessionId;
    notLive.sessionId = (
      await createSession(host, fence(notLive.runId))
    ).sessionId;
    // Exited but still registered (terminal grace): a record that is not live.
    expect(
      (
        await postJson(
          `${host.url}/sessions/${notLive.sessionId}`,
          envelope("session.delete", fence(notLive.runId)),
          "DELETE",
        )
      ).status,
    ).toBe(204);
    await waitFor(
      () => host.registry.get(notLive.sessionId)?.record.status !== "live",
    );
    const objectFence = {
      ...fence(`object-${randomUUID()}`),
      assignmentId: randomUUID(),
      assignmentEpoch: 1,
    };
    const uploadObjectId = await reserveObject(host, objectFence);
    const deleteObjectId = await reserveObject(host, objectFence);

    expect(
      (await uploadObject(host, deleteObjectId, objectFence, randomUUID()))
        .status,
    ).toBe(200);
    Object.assign(fixtures, {
      liveCheckpoint,
      liveDelete,
      notLive,
      objectFence,
      uploadObjectId,
      deleteObjectId,
    });
  }

  await induce(host, state);

  return fixtures;
}

async function induce(host: BootedHost, state: PressureState): Promise<void> {
  const streamId = host.hostState.getRuntimeEventStreamId();
  const runId = `filler-${randomUUID()}`;

  if (state === "soft") {
    while (!host.hostState.runtimeEventHealthSnapshot().pressured)
      host.hostState.appendRuntimeEvent(draft(runId));

    return;
  }
  if (state === "hard") {
    for (;;) {
      let last: string | null = null;

      try {
        for (let index = 0; index < 20; index += 1)
          last = host.hostState.appendRuntimeEvent(draft(runId)).sequence;
      } catch (error) {
        expect(String(error)).toMatch(/regular partition is full/);
        if (last) host.hostState.ackRuntimeEvents(streamId, last);
        break;
      }
      if (last) host.hostState.ackRuntimeEvents(streamId, last);
    }
    host.hostState.ackRuntimeEvents(
      streamId,
      String(BigInt(host.hostState.nextRuntimeEventPosition().sequence) - 1n),
    );
    expect(host.hostState.runtimeEventHealthSnapshot().pressured).toBe(false);
    expect(
      host.hostState.runtimeEventOutboxStats().budget.regular.retainedCount,
    ).toBe(ROW_LIMITS.eventHardRows);

    return;
  }
  // Physical: a pinned WAL reader keeps every write in the WAL until the
  // SQLite footprint crosses the physical high-water.
  const observer = new DatabaseSync(join(host.stateDir, "state.sqlite"));

  observers.push(observer);
  observer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  observer.exec("BEGIN");
  observer.prepare("SELECT COUNT(*) FROM runtime_event_outbox").get();
  for (let index = 0; index < 2_000; index += 1) {
    try {
      host.hostState.appendRuntimeEvent({
        draft: {
          ...draft(runId).draft,
          eventType: "session.line" as never,
          payload: { line: "x".repeat(60 * 1024) },
        },
      });
    } catch (error) {
      expect(error).toMatchObject({ reason: "event_outbox_physical_limit" });
      break;
    }
  }
  expect(host.hostState.runtimeEventHealthSnapshot().pressured).toBe(false);
  expect(host.hostState.runtimeEventOutboxStats().budget.pressured).toBe(true);
}

async function newWorkRefusedBy(host: BootedHost): Promise<unknown> {
  const response = await fetch(`${host.url}/health?includeStream=true`);

  expect(response.status).toBe(200);

  return ((await response.json()) as { stream?: Record<string, unknown> })
    .stream?.newWorkRefusedBy;
}

async function issue(
  fixtures: Fixtures,
  testCase: Case,
): Promise<{
  status: number;
  reason: unknown;
  outboxLimit: unknown;
  commandId: string;
}> {
  const { host } = fixtures;
  const fence = (runId: string) => ({ hostKey: host.hostState.hostKey, runId });
  const post = async (
    path: string,
    body: CommandEnvelope,
    method: "POST" | "DELETE" = "POST",
  ) => {
    const response = await postJson(`${host.url}${path}`, body, method);

    return {
      status: response.status,
      reason: response.body?.details?.reason,
      outboxLimit: response.body?.details?.outboxLimit,
      commandId: body.command.id,
    };
  };

  switch (testCase.label) {
    case "session.create":
      return post("/sessions", fixtures.createTarget);
    case "session.prompt":
      return post(
        `/sessions/${fixtures.live.sessionId}/prompts`,
        envelope("session.prompt", fence(fixtures.live.runId), {
          stepId: "pressure",
          prompt: "hello",
        }),
      );
    case "workspace.adopt": {
      const runId = `adopt-${randomUUID()}`;

      return post(
        "/workspaces/adopt",
        envelope("workspace.adopt", fence(runId), {
          runId,
          projectSlug: "demo",
          kind: "directory",
          path: fixtures.adoptDir,
        }),
      );
    }
    case "runtime_object.reserve":
      return post(
        "/runtime-objects",
        envelope(
          "runtime_object.reserve",
          fixtures.objectFence!,
          reservePayload(randomUUID()),
        ),
      );
    case "runtime_object.upload": {
      const commandId = randomUUID();
      const response = await uploadObject(
        host,
        fixtures.uploadObjectId!,
        fixtures.objectFence!,
        commandId,
      );
      const text = await response.text();
      const details = text ? JSON.parse(text)?.details : undefined;

      return {
        status: response.status,
        reason: details?.reason,
        outboxLimit: details?.outboxLimit,
        commandId,
      };
    }
    case "session.input":
      return post(
        `/sessions/${fixtures.live.sessionId}/input`,
        envelope("session.input", fence(fixtures.live.runId), {
          kind: "permission",
          action: "cancel",
          requestId: randomUUID(),
        }),
      );
    case "session.steer":
      return post(
        `/sessions/${fixtures.live.sessionId}/steer`,
        envelope("session.steer", fence(fixtures.live.runId), {
          contentBlocks: [{ type: "text", text: "steer" }],
          parentCommandId: randomUUID(),
        }),
      );
    case "session.cancel (live)":
      return post(
        `/sessions/${fixtures.live.sessionId}/cancel`,
        envelope("session.cancel", fence(fixtures.live.runId)),
      );
    case "session.checkpoint (live)":
      return post(
        `/sessions/${fixtures.liveCheckpoint!.sessionId}/checkpoint`,
        envelope("session.checkpoint", fence(fixtures.liveCheckpoint!.runId)),
      );
    case "session.delete (live)":
      return post(
        `/sessions/${fixtures.liveDelete!.sessionId}`,
        envelope("session.delete", fence(fixtures.liveDelete!.runId)),
        "DELETE",
      );
    case "session.cancel (not live)":
      return post(
        `/sessions/${fixtures.notLive!.sessionId}/cancel`,
        envelope("session.cancel", fence(fixtures.notLive!.runId)),
      );
    case "session.checkpoint (not live)":
      return post(
        `/sessions/${fixtures.notLive!.sessionId}/checkpoint`,
        envelope("session.checkpoint", fence(fixtures.notLive!.runId)),
      );
    case "session.delete (not live)":
      return post(
        `/sessions/${fixtures.notLive!.sessionId}`,
        envelope("session.delete", fence(fixtures.notLive!.runId)),
        "DELETE",
      );
    case "workspace.release":
      return post(
        `/workspaces/${fixtures.releaseTarget.workspaceId}`,
        envelope("workspace.release", fence(fixtures.releaseTarget.runId)),
        "DELETE",
      );
    case "runtime_object.delete":
      return post(
        `/runtime-objects/${fixtures.deleteObjectId!}`,
        envelope("runtime_object.delete", fixtures.objectFence!, {
          generation: 1,
        }),
        "DELETE",
      );
    default:
      throw new Error(`no issuer for ${testCase.label}`);
  }
}

describe("ADR-183 admission table: soft refuses new work, never an answer or a teardown", () => {
  it.each(["soft", "hard", "physical"] as const)(
    "%s pressure",
    async (state) => {
      const fixtures = await setUp(state);
      const refused: string[] = [];

      expect(await newWorkRefusedBy(fixtures.host)).toBe(LIMIT_BY_STATE[state]);

      for (const testCase of CASES) {
        const expected = testCase.expected[state];

        if (expected === "skip") continue;
        const result = await issue(fixtures, testCase);
        const receipt = fixtures.host.hostState.getReceipt(result.commandId);

        if (expected === "refused") {
          refused.push(testCase.label);
          expect({
            label: testCase.label,
            status: result.status,
            reason: result.reason,
            outboxLimit: result.outboxLimit,
          }).toEqual({
            label: testCase.label,
            status: 409,
            reason: "event_outbox_backpressure",
            outboxLimit: LIMIT_BY_STATE[state],
          });
          expect(receipt, testCase.label).toBeNull();
        } else {
          expect({ label: testCase.label, reason: result.reason }).not.toEqual({
            label: testCase.label,
            reason: "event_outbox_backpressure",
          });
          expect(receipt, testCase.label).not.toBeNull();
          expect(receipt?.phase, testCase.label).not.toBe("accepted");
        }
      }
      const logged = fixtures.lines.filter(
        (line) => line.msg === "outbox-admission-refused",
      );

      expect(logged).toHaveLength(refused.length);
      expect(logged.map((line) => line.kind).sort()).toEqual(
        refused
          .map((label) => CASES.find((c) => c.label === label)!.kind)
          .sort(),
      );
      for (const line of logged) {
        expect(line).toMatchObject({
          admission: expect.stringMatching(/^(new_work|producer|resolve)$/),
          reason: expect.stringMatching(/^event_outbox_/),
          outboxLimit: LIMIT_BY_STATE[state],
          unacknowledgedCount: expect.any(Number),
          retainedCount: expect.any(Number),
        });
      }
    },
    120_000,
  );

  it("a healthy host admits new work: newWorkRefusedBy is null", async () => {
    const host = await bootHost({
      limits: ROW_LIMITS,
      runtimeRoot: await mkdtemp(join(tmpdir(), "eh-admission-")),
    });

    hosts.push(host);
    expect(await newWorkRefusedBy(host)).toBeNull();
  }, 60_000);

  it("control: a create the control partition cannot fund is refused `control`, and health names it", async () => {
    const lines: LogLine[] = [];
    const logger: Logger = pino(
      { level: "info" },
      { write: (line: string) => lines.push(JSON.parse(line) as LogLine) },
    );
    // PHYSICAL_LIMITS' control budget funds exactly one producer wallet.
    const host = await bootHost({
      limits: PHYSICAL_LIMITS,
      logger,
      runtimeRoot: await mkdtemp(join(tmpdir(), "eh-admission-")),
    });

    hosts.push(host);
    const fence = (runId: string) => ({
      hostKey: host.hostState.hostKey,
      runId,
    });

    expect(await newWorkRefusedBy(host)).toBeNull();
    await createSession(host, fence(`live-${randomUUID()}`));
    expect(await newWorkRefusedBy(host)).toBe("control");
    const target = await createEnvelope(host, fence(`create-${randomUUID()}`));
    const refused = await postJson(`${host.url}/sessions`, target);

    expect({
      status: refused.status,
      details: refused.body?.details,
    }).toEqual({
      status: 409,
      details: { reason: "event_outbox_backpressure", outboxLimit: "control" },
    });
    expect(host.hostState.getReceipt(target.command.id)).toBeNull();
    expect(
      lines.filter((line) => line.msg === "outbox-admission-refused"),
    ).toEqual([
      expect.objectContaining({
        admission: "producer",
        reason: "event_outbox_terminal_reserve_exhausted",
        outboxLimit: "control",
      }),
    ]);
  }, 60_000);

  it("answers do not spend the producer wallet under soft pressure", async () => {
    const fixtures = await setUp("soft");
    const { host, live } = fixtures;
    const walletRows = () =>
      host.hostState.runtimeEventOutboxStats().budget.reservedControlRows;
    const before = walletRows();

    for (let index = 0; index < 5; index += 1) {
      const response = await postJson(
        `${host.url}/sessions/${live.sessionId}/input`,
        envelope(
          "session.input",
          {
            hostKey: host.hostState.hostKey,
            runId: live.runId,
          },
          {
            kind: "permission",
            action: "cancel",
            requestId: randomUUID(),
          },
        ),
      );

      expect(response.body?.details?.reason).not.toBe(
        "event_outbox_backpressure",
      );
    }
    expect(walletRows()).toBe(before);
  }, 60_000);
});
