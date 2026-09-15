// The agent session consumer rides a DURABLE, replayable event stream
// (`streamCanonicalSessionEvents`), and every failure on its path — host
// content, projection transaction deadline, pool acquisition — surfaces as a
// transient `MaisterError`. A consumer that dies on the first one leaves the
// run with a live session nobody reads: reconcile refuses to reattach a
// non-flow run, so the turn can only end later as a false `agent-session-gone`.
// These cases pin the supervisor's contract: retry the stream, resume AFTER the
// last handled event (so no side effect is replayed), stop on a fence or abort,
// and stay bounded.

import type { AgentExecution } from "@/lib/agents/launch";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_CONSUMER_MAX_ATTEMPTS,
  observeAgentSession,
  superviseAgentSession,
} from "@/lib/agents/launch";
import {
  hasAgentSessionObserver,
  resetAgentSessionObserversForTests,
  takeAgentObserverFailure,
} from "@/lib/agents/session-observer-registry";
import { MaisterError } from "@/lib/errors";

type StreamAttempt = (sessionId: string) => AsyncGenerator<SupervisorEvent>;

const db = {} as never;

function transientFailure(): MaisterError {
  return new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "projection database connection acquisition timed out",
    { details: { reason: "projection_connection_timeout" } },
  );
}

function fencedFailure(): MaisterError {
  return new MaisterError("CONFLICT", "assignment fenced", {
    details: { reason: "assignment_fenced" },
  });
}

/** Records every `lastEventId` the consumer re-enters the stream with. */
function streamingExecution(attempts: StreamAttempt[]): {
  execution: AgentExecution;
  resumedFrom: (number | undefined)[];
} {
  const resumedFrom: (number | undefined)[] = [];
  let index = 0;

  return {
    resumedFrom,
    execution: {
      client: {} as never,
      admin: {
        streamSession(
          sessionId: string,
          opts?: { lastEventId?: number },
        ): AsyncGenerator<SupervisorEvent> {
          resumedFrom.push(opts?.lastEventId);
          const attempt = attempts[Math.min(index, attempts.length - 1)];

          index += 1;

          return attempt(sessionId);
        },
      },
    } as unknown as AgentExecution,
  };
}

async function* failing(): AsyncGenerator<SupervisorEvent> {
  throw transientFailure();
}

async function* silent(): AsyncGenerator<SupervisorEvent> {
  // An empty stream that ends cleanly.
}

beforeEach(() => {
  resetAgentSessionObserversForTests();
});

describe("superviseAgentSession", () => {
  it("re-enters the durable stream after a transient failure", async () => {
    const { execution, resumedFrom } = streamingExecution([failing, silent]);

    await superviseAgentSession({
      db,
      execution,
      runId: "run-1",
      sessionId: "session-1",
      sleep: async () => {},
    });

    expect(resumedFrom).toHaveLength(2);
  });

  it("resumes after the last handled event so no side effect is replayed", async () => {
    async function* oneLineThenFail(
      sessionId: string,
    ): AsyncGenerator<SupervisorEvent> {
      yield { type: "session.line", sessionId, monotonicId: 41, line: "plan" };
      throw transientFailure();
    }
    const { execution, resumedFrom } = streamingExecution([
      oneLineThenFail,
      silent,
    ]);

    await superviseAgentSession({
      db,
      execution,
      runId: "run-1",
      sessionId: "session-1",
      sleep: async () => {},
    });

    expect(resumedFrom).toEqual([undefined, 41]);
  });

  it("yields to a newer generation without retrying a fenced stream", async () => {
    async function* fenced(): AsyncGenerator<SupervisorEvent> {
      throw fencedFailure();
    }
    const { execution, resumedFrom } = streamingExecution([fenced, silent]);

    await superviseAgentSession({
      db,
      execution,
      runId: "run-1",
      sessionId: "session-1",
      sleep: async () => {},
    });

    expect(resumedFrom).toHaveLength(1);
  });

  it("stops retrying once the run's own abort signal is raised", async () => {
    const controller = new AbortController();

    async function* abortThenFail(): AsyncGenerator<SupervisorEvent> {
      controller.abort();
      throw transientFailure();
    }
    const { execution, resumedFrom } = streamingExecution([
      abortThenFail,
      silent,
    ]);

    await superviseAgentSession({
      db,
      execution,
      runId: "run-1",
      sessionId: "session-1",
      signal: controller.signal,
      sleep: async () => {},
    });

    expect(resumedFrom).toHaveLength(1);
  });

  it("gives up after a bounded number of attempts", async () => {
    const { execution, resumedFrom } = streamingExecution([failing]);

    await superviseAgentSession({
      db,
      execution,
      runId: "run-1",
      sessionId: "session-1",
      sleep: async () => {},
    });

    expect(resumedFrom).toHaveLength(AGENT_CONSUMER_MAX_ATTEMPTS);
  });

  // The sweep that eventually crashes this run names the failure, not just its
  // own classification: the give-up is recorded where the sweep can read it.
  it("records the typed give-up so the sweep's terminal status can name it", async () => {
    const { execution } = streamingExecution([failing]);

    await superviseAgentSession({
      db,
      execution,
      runId: "run-give-up",
      sessionId: "session-give-up",
      sleep: async () => {},
    });

    expect(takeAgentObserverFailure("run-give-up")).toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      message: "projection database connection acquisition timed out",
      attempts: AGENT_CONSUMER_MAX_ATTEMPTS,
      sessionId: "session-give-up",
    });
  });

  it("records nothing when the stream ends cleanly", async () => {
    const { execution } = streamingExecution([silent]);

    await superviseAgentSession({
      db,
      execution,
      runId: "run-clean",
      sessionId: "session-clean",
      sleep: async () => {},
    });

    expect(takeAgentObserverFailure("run-clean")).toBeNull();
  });
});

// An observer is the run's ONLY reader of its canonical stream; two of them on
// one session double every side effect on that path (a permission HITL row, an
// input delivery). Nothing prevented it before — every entry into
// `startAgentSession`/`dispatchStoredAgentTurn` started its own.
describe("observeAgentSession — one observer per session per process", () => {
  function pendingExecution(): AgentExecution {
    return {
      client: {} as never,
      admin: {
        async *streamSession(): AsyncGenerator<SupervisorEvent> {
          await new Promise<void>(() => {});
        },
      },
    } as unknown as AgentExecution;
  }

  it("refuses a second observer for a session this process already observes", () => {
    const args = {
      db,
      execution: pendingExecution(),
      runId: "run-dup",
      sessionId: "session-dup",
    };

    expect(observeAgentSession(args)).toBe(true);
    expect(observeAgentSession(args)).toBe(false);
    expect(hasAgentSessionObserver("session-dup")).toBe(true);
  });

  it("releases the session once its observer returns, so a later sweep can re-observe", async () => {
    const { execution } = streamingExecution([silent]);

    expect(
      observeAgentSession({
        db,
        execution,
        runId: "run-release",
        sessionId: "session-release",
      }),
    ).toBe(true);
    await expect
      .poll(() => hasAgentSessionObserver("session-release"), {
        timeout: 1_000,
        interval: 5,
      })
      .toBe(false);
  });
});
