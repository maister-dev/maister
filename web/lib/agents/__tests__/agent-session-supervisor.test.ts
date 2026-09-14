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

import { describe, expect, it } from "vitest";

import {
  AGENT_CONSUMER_MAX_ATTEMPTS,
  superviseAgentSession,
} from "@/lib/agents/launch";
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
});
