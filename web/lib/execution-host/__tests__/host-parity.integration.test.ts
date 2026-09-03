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

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors";
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

  labs = {
    fake: {
      name: "fake",
      transport: fake.transport,
      hostKey: fake.identity.hostKey,
      root: sup.runtimeRoot,
    },
    real: {
      name: "real",
      transport: real,
      hostKey: health.identity.hostKey,
      root: sup.runtimeRoot,
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
