// ADR-166 — host parity: the in-memory fake transport and a REAL supervisor
// child answer the same scenario table identically, normalized to the
// `{code, httpStatus, reason, rule, epochs}` a caller can observe through the
// local-direct wire. The fake is only as good as this table: a rule the real
// host adds without a scenario here is a rule the fake may silently miss.

import type {
  CreateSessionPayload,
  ExecutionHostTransport,
} from "@/lib/execution-host/contracts";
import type { CommandKind } from "@/lib/execution-host/types";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors";
import { checkSupervisorHealth } from "@/lib/supervisor-client";
import { buildEnvelope } from "@/lib/execution-host/ledger";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { asExecutionWorkspaceId } from "@/lib/execution-host/types";
import { createFakeExecutionHost } from "@/test-support/fake-execution-host";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

type Lab = {
  name: "fake" | "real";
  transport: ExecutionHostTransport;
  hostKey: string;
  root: string;
  // Makes the host emit at least two events; answers its current stream and
  // highest emitted sequence.
  emit: () => Promise<{ streamId: string; head: bigint }>;
  // ACKs and prunes the stream through `sequence`: the real host prunes an
  // ACKed prefix past its grace at boot.
  prune: (streamId: string, sequence: bigint) => Promise<void>;
  // Emits like `emit`, then loses the retained row just below the head — rows
  // the host still promises to retain.
  emitWithHole: () => Promise<{ streamId: string; hole: bigint }>;
};

type Normalized =
  | { ok: true; body?: Record<string, unknown> }
  | {
      ok: false;
      code: string;
      httpStatus: number | null;
      reason?: unknown;
      rule?: unknown;
      hostEpoch?: unknown;
      commandEpoch?: unknown;
    };

async function normalize<T>(
  fn: () => Promise<T>,
  project?: (value: T) => Record<string, unknown>,
): Promise<Normalized> {
  try {
    const value = await fn();

    return project ? { ok: true, body: project(value) } : { ok: true };
  } catch (err) {
    if (!isMaisterError(err)) throw err;
    const details = err.details ?? {};

    return {
      ok: false,
      code: err.code,
      httpStatus:
        typeof details.httpStatus === "number" ? details.httpStatus : null,
      reason: details.reason,
      rule: details.rule,
      hostEpoch: details.hostEpoch,
      commandEpoch: details.commandEpoch,
    };
  }
}

type Fence = {
  runId: string;
  assignmentId?: string;
  assignmentEpoch?: number;
  hostKey?: string;
};

function envelope<TPayload>(
  lab: Lab,
  kind: CommandKind,
  fence: Fence,
  payload: TPayload,
  commandId: string = randomUUID(),
) {
  return buildEnvelope({
    commandId,
    kind,
    hostKey: fence.hostKey ?? lab.hostKey,
    assignmentId: fence.assignmentId ?? randomUUID(),
    assignmentEpoch: fence.assignmentEpoch ?? 1,
    runId: fence.runId,
    payload,
  });
}

// A plain directory under the child's adoption roots — the one workspace
// kind that needs no git state.
async function directory(lab: Lab, runId: string): Promise<string> {
  const dir = path.join(lab.root, "parity", runId);

  await mkdir(dir, { recursive: true });

  return dir;
}

async function adopt(
  lab: Lab,
  fence: Fence,
  opts: { payloadRunId?: string; commandId?: string } = {},
) {
  return lab.transport.adoptWorkspace(
    envelope(
      lab,
      "workspace.adopt",
      fence,
      {
        runId: opts.payloadRunId ?? fence.runId,
        projectSlug: "parity",
        kind: "directory",
        path: await directory(lab, fence.runId),
      },
      opts.commandId,
    ),
  );
}

const CREATE = {
  stepId: "s1",
  executor: { agent: "claude" as const, model: "mock" },
};

function createPayload(executionWorkspaceId: string): CreateSessionPayload {
  return {
    ...CREATE,
    executionWorkspaceId: asExecutionWorkspaceId(executionWorkspaceId),
  };
}

function newRun(): { runId: string; assignmentId: string } {
  return { runId: `run-${randomUUID()}`, assignmentId: randomUUID() };
}

async function liveSession(lab: Lab, fence: Fence) {
  const adopted = await adopt(lab, fence);

  return lab.transport.createSession(
    envelope(
      lab,
      "session.create",
      fence,
      createPayload(adopted.executionWorkspaceId),
    ),
  );
}

const SCENARIOS: Array<{
  name: string;
  expected: Normalized;
  run: (lab: Lab) => Promise<Normalized>;
}> = [
  {
    name: "create ok",
    expected: { ok: true, body: { session: true, acp: true } },
    run: async (lab) => {
      const fence = newRun();
      const adopted = await adopt(lab, fence);

      return normalize(
        () =>
          lab.transport.createSession(
            envelope(
              lab,
              "session.create",
              fence,
              createPayload(adopted.executionWorkspaceId),
            ),
          ),
        (r) => ({
          session: typeof r.sessionId === "string" && r.sessionId.length > 0,
          acp: typeof r.acpSessionId === "string" && r.acpSessionId.length > 0,
        }),
      );
    },
  },
  {
    name: "create with a foreign hostKey → host_mismatch",
    expected: {
      ok: false,
      code: "PRECONDITION",
      httpStatus: 409,
      reason: "host_mismatch",
    },
    run: async (lab) => {
      const fence = newRun();
      const adopted = await adopt(lab, fence);

      return normalize(() =>
        lab.transport.createSession(
          envelope(
            lab,
            "session.create",
            { ...fence, hostKey: "eh_not_this_host_0" },
            createPayload(adopted.executionWorkspaceId),
          ),
        ),
      );
    },
  },
  {
    name: "adopt whose fence names another run than its payload → run_mismatch",
    expected: {
      ok: false,
      code: "PRECONDITION",
      httpStatus: 409,
      reason: "run_mismatch",
    },
    run: async (lab) =>
      normalize(() =>
        adopt(lab, newRun(), { payloadRunId: `run-${randomUUID()}` }),
      ),
  },
  {
    name: "create at a lower epoch after a higher one → assignment_fenced with the host epoch",
    expected: {
      ok: false,
      code: "CONFLICT",
      httpStatus: 409,
      reason: "assignment_fenced",
      commandEpoch: 1,
      hostEpoch: 2,
    },
    run: async (lab) => {
      const { runId } = newRun();
      const adopted = await adopt(lab, { runId, assignmentEpoch: 2 });

      return normalize(() =>
        lab.transport.createSession(
          envelope(
            lab,
            "session.create",
            { runId, assignmentEpoch: 1 },
            createPayload(adopted.executionWorkspaceId),
          ),
        ),
      );
    },
  },
  {
    name: "same epoch under a different assignment id → assignment_mismatch",
    expected: {
      ok: false,
      code: "PRECONDITION",
      httpStatus: 409,
      reason: "assignment_mismatch",
      commandEpoch: 1,
      hostEpoch: 1,
    },
    run: async (lab) => {
      const fence = newRun();
      const adopted = await adopt(lab, fence);

      return normalize(() =>
        lab.transport.createSession(
          envelope(
            lab,
            "session.create",
            { ...fence, assignmentId: randomUUID() },
            createPayload(adopted.executionWorkspaceId),
          ),
        ),
      );
    },
  },
  {
    name: "duplicate create id → verbatim replay of the same body",
    expected: { ok: true, body: { same: true } },
    run: async (lab) => {
      const fence = newRun();
      const adopted = await adopt(lab, fence);
      const body = envelope(
        lab,
        "session.create",
        fence,
        createPayload(adopted.executionWorkspaceId),
      );
      const first = await lab.transport.createSession(body);

      return normalize(
        () => lab.transport.createSession(body),
        (second) => ({
          same:
            second.sessionId === first.sessionId &&
            second.acpSessionId === first.acpSessionId &&
            second.pid === first.pid,
        }),
      );
    },
  },
  {
    name: "checkpoint of an unknown session → 404",
    expected: { ok: false, code: "PRECONDITION", httpStatus: 404 },
    run: async (lab) =>
      normalize(() =>
        lab.transport.checkpointSession(
          `sess-${randomUUID()}`,
          envelope(lab, "session.checkpoint", newRun(), {}),
        ),
      ),
  },
  {
    name: "cancel of an unknown session → 404",
    expected: { ok: false, code: "PRECONDITION", httpStatus: 404 },
    run: async (lab) =>
      normalize(() =>
        lab.transport.cancelPrompt(
          `sess-${randomUUID()}`,
          envelope(lab, "session.cancel", newRun(), {}),
        ),
      ),
  },
  {
    name: "input to an unknown session → 503 (retryable, definitive)",
    expected: { ok: false, code: "EXECUTOR_UNAVAILABLE", httpStatus: 503 },
    run: async (lab) =>
      normalize(() =>
        lab.transport.deliverInput(
          `sess-${randomUUID()}`,
          envelope(lab, "session.input", newRun(), {
            kind: "permission",
            action: "select",
            requestId: randomUUID(),
            optionId: "allow",
          }),
        ),
      ),
  },
  {
    name: "input with an unknown requestId on a live session → 410 HITL_TIMEOUT",
    expected: { ok: false, code: "HITL_TIMEOUT", httpStatus: 410 },
    run: async (lab) => {
      const fence = newRun();
      const created = await liveSession(lab, fence);

      return normalize(() =>
        lab.transport.deliverInput(
          created.sessionId,
          envelope(lab, "session.input", fence, {
            kind: "permission",
            action: "select",
            requestId: randomUUID(),
            optionId: "allow",
          }),
        ),
      );
    },
  },
  {
    name: "create with a released handle → workspace_released",
    expected: {
      ok: false,
      code: "PRECONDITION",
      httpStatus: 409,
      reason: "workspace_released",
    },
    run: async (lab) => {
      const fence = newRun();
      const adopted = await adopt(lab, fence);

      await lab.transport.releaseWorkspace(
        adopted.executionWorkspaceId,
        envelope(lab, "workspace.release", fence, {}),
      );

      return normalize(() =>
        lab.transport.createSession(
          envelope(
            lab,
            "session.create",
            fence,
            createPayload(adopted.executionWorkspaceId),
          ),
        ),
      );
    },
  },
  {
    name: "re-adopt after release → a NEW handle (replayed:false)",
    expected: { ok: true, body: { newHandle: true, replayed: false } },
    run: async (lab) => {
      const fence = newRun();
      const first = await adopt(lab, fence);

      await lab.transport.releaseWorkspace(
        first.executionWorkspaceId,
        envelope(lab, "workspace.release", fence, {}),
      );

      return normalize(
        () => adopt(lab, fence),
        (second) => ({
          newHandle: second.executionWorkspaceId !== first.executionWorkspaceId,
          replayed: second.replayed,
        }),
      );
    },
  },
  // ADR-167 D5 amendment: a span read never throws — both hosts answer an
  // unreadable range as a typed unavailable page, which the manager treats as
  // "settle canonically instead".
  // `request_failed` is what ANY failure reads as, so the same stream's valid
  // range must read — the refusal is the range's, not a broken transport's.
  {
    name: "span with after >= through → request_failed, while the same stream's valid range reads complete",
    expected: {
      ok: true,
      body: { refused: "request_failed", valid: "complete", rows: 1 },
    },
    run: async (lab) => {
      const { streamId, head } = await lab.emit();

      return normalize(
        async () => ({
          refused: await lab.transport.readRuntimeEventSpan({
            streamId,
            after: head.toString(),
            through: head.toString(),
          }),
          valid: await lab.transport.readRuntimeEventSpan({
            streamId,
            after: (head - 1n).toString(),
            through: head.toString(),
          }),
        }),
        ({ refused, valid }) => ({
          refused: refused.state === "unavailable" ? refused.reason : null,
          valid: valid.state,
          rows: valid.state === "unavailable" ? null : valid.events.length,
        }),
      );
    },
  },
  {
    name: "span past the highest emitted sequence → beyond_emitted",
    expected: {
      ok: true,
      body: { state: "unavailable", reason: "beyond_emitted" },
    },
    run: async (lab) => {
      const { streamId, head } = await lab.emit();

      return normalize(
        () =>
          lab.transport.readRuntimeEventSpan({
            streamId,
            after: head.toString(),
            through: (head + 1_000n).toString(),
          }),
        (page) => ({ ...page }),
      );
    },
  },
  {
    name: "span on a stream the host does not own → stream_identity_changed",
    expected: {
      ok: true,
      body: { state: "unavailable", reason: "stream_identity_changed" },
    },
    run: async (lab) => {
      await liveSession(lab, newRun());

      return normalize(
        () =>
          lab.transport.readRuntimeEventSpan({
            streamId: randomUUID(),
            after: "0",
            through: "1",
          }),
        (page) => ({ ...page }),
      );
    },
  },
  // Restarts the real host, so only the corrupting case follows it.
  {
    name: "span below the replay floor → replay_floor_lost",
    expected: {
      ok: true,
      body: { state: "unavailable", reason: "replay_floor_lost" },
    },
    run: async (lab) => {
      const { streamId, head } = await lab.emit();

      await lab.prune(streamId, head);

      return normalize(
        () =>
          lab.transport.readRuntimeEventSpan({
            streamId,
            after: (head - 1n).toString(),
            through: head.toString(),
          }),
        (page) => ({ ...page }),
      );
    },
  },
  // Corrupts the real host's outbox (an ACK can no longer cross the hole), so
  // it runs last. The route answers 503; the transport, request_failed.
  {
    name: "span over rows the host lost → request_failed",
    expected: {
      ok: true,
      body: { state: "unavailable", reason: "request_failed" },
    },
    run: async (lab) => {
      const { streamId, hole } = await lab.emitWithHole();

      return normalize(
        () =>
          lab.transport.readRuntimeEventSpan({
            streamId,
            after: (hole - 1n).toString(),
            through: hole.toString(),
          }),
        (page) => ({ ...page }),
      );
    },
  },
];

let sup: RealSupervisor;
let restoreUrl: () => void = () => {};
let labs: { fake: Lab; real: Lab };

beforeAll(async () => {
  sup = await startRealSupervisor({ fixtureArgs: ["--hang"] });
  restoreUrl = useRealSupervisorUrl(sup.url);
  const real = createLocalDirectTransport();
  const health = await real.health();

  if (health.kind !== "ready" || !health.identity) {
    throw new Error("real supervisor not ready");
  }
  const fake = createFakeExecutionHost();
  const fakeStreamId = randomUUID();
  let fakeHead = -1n;
  const fakeEvent = async (sequence: bigint) =>
    fake.deliverCanonical(
      {
        envelopeVersion: 1,
        eventId: randomUUID(),
        hostKey: fake.identity.hostKey,
        hostBootId: fake.identity.bootId,
        streamId: fakeStreamId,
        sequence: sequence.toString(),
        runId: "run-parity-span",
        assignmentId: randomUUID(),
        assignmentEpoch: 1,
        hostSessionId: null,
        eventType: "session.created",
        occurredAt: new Date().toISOString(),
        payloadSchema: "maister.session.created.v1",
        payload: { sourceMonotonicId: Number(sequence) },
      },
      async () => {},
    );

  labs = {
    fake: {
      name: "fake",
      transport: fake.transport,
      hostKey: fake.identity.hostKey,
      root: sup.runtimeRoot,
      emit: async () => {
        for (let index = 0; index < 2; index += 1) {
          fakeHead += 1n;
          await fakeEvent(fakeHead);
        }

        return { streamId: fakeStreamId, head: fakeHead };
      },
      prune: async (_streamId, sequence) =>
        fake.setPrunedFloor(sequence.toString()),
      emitWithHole: async () => {
        const hole = fakeHead + 2n;

        await fakeEvent(fakeHead + 1n);
        fakeHead += 3n;
        await fakeEvent(fakeHead);

        return { streamId: fakeStreamId, hole };
      },
    },
    real: {
      name: "real",
      transport: real,
      hostKey: health.identity.hostKey,
      root: sup.runtimeRoot,
      emit: async () => {
        await liveSession(labs.real, newRun());
        const status = await checkSupervisorHealth({ includeStream: true });
        const stream =
          status.kind === "ready" ? status.health.stream : undefined;

        if (!stream?.headSequence) throw new Error("real host emitted nothing");

        return {
          streamId: stream.streamId,
          head: BigInt(stream.headSequence),
        };
      },
      prune: async (streamId, sequence) => {
        await real.acknowledgeRuntimeEvents({
          streamId,
          throughSequence: sequence.toString(),
        });
        sup = await sup.restart({
          env: { ...sup.options.env, MAISTER_EVENT_ACK_GRACE_MS: "1" },
        });
      },
      emitWithHole: async () => {
        const { streamId, head } = await labs.real.emit();
        const state = new DatabaseSync(path.join(sup.stateDir, "state.sqlite"));

        try {
          state.exec("PRAGMA busy_timeout = 5000");
          state
            .prepare(
              "DELETE FROM runtime_event_outbox WHERE stream_id = ? AND sequence = ?",
            )
            .run(streamId, (head - 1n).toString());
        } finally {
          state.close();
        }

        return { streamId, hole: head - 1n };
      },
    },
  };
}, 180_000);

afterAll(async () => {
  restoreUrl();
  await sup?.kill();
});

describe("fake ↔ real host parity", () => {
  for (const scenario of SCENARIOS) {
    it(
      scenario.name,
      async () => {
        const [fromFake, fromReal] = await Promise.all([
          scenario.run(labs.fake),
          scenario.run(labs.real),
        ]);

        expect(fromFake, "fake").toEqual(scenario.expected);
        expect(fromReal, "real").toEqual(scenario.expected);
        expect(fromFake).toEqual(fromReal);
      },
      60_000,
    );
  }
});
