// ADR-156 D7: the counter that bounds agent→agent trigger chains. The
// fail-closed arms matter most — a NULL run_id seeded as 0 reopens exactly the
// loop this exists to close.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAgentChainDepth } from "@/lib/agents/chain-depth";

type EventRow = { actorType: string | null; runId: string | null };

function stubDb(opts: { event?: EventRow; parentDepth?: number | null }) {
  let call = 0;

  return {
    select: () => ({
      from: () => ({
        where: () => {
          call += 1;
          if (call === 1) return opts.event ? [opts.event] : [];

          return opts.parentDepth === undefined
            ? []
            : [{ depth: opts.parentDepth }];
        },
      }),
    }),
  };
}

let original: string | undefined;

beforeEach(() => {
  original = process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH;
});

afterEach(() => {
  if (original === undefined) delete process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH;
  else process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH = original;
});

describe("resolveAgentChainDepth (ADR-156 D7)", () => {
  it.each(["manual", "cron", "webhook", "flow_node"])(
    "seeds 0 for a %s trigger — a fresh chain, not a continuation",
    async (source) => {
      await expect(
        resolveAgentChainDepth({ trigger: { source }, db: stubDb({}) as never }),
      ).resolves.toEqual({ depth: 0, atCap: false });
    },
  );

  it("seeds 0 for a domain event authored by a USER, not an agent", async () => {
    await expect(
      resolveAgentChainDepth({
        trigger: { source: "domain_event", eventId: 5 },
        db: stubDb({ event: { actorType: "user", runId: "run-x" } }) as never,
      }),
    ).resolves.toEqual({ depth: 0, atCap: false });
  });

  it("inherits parentDepth + 1 from an agent-authored event", async () => {
    await expect(
      resolveAgentChainDepth({
        trigger: { source: "domain_event", eventId: 5 },
        db: stubDb({
          event: { actorType: "agent", runId: "run-parent" },
          parentDepth: 0,
        }) as never,
      }),
    ).resolves.toEqual({ depth: 1, atCap: false });
  });

  it("flags atCap once the inherited depth would exceed the budget", async () => {
    await expect(
      resolveAgentChainDepth({
        trigger: { source: "domain_event", eventId: 5 },
        db: stubDb({
          event: { actorType: "agent", runId: "run-parent" },
          parentDepth: 2,
        }) as never,
      }),
    ).resolves.toEqual({ depth: 3, atCap: true });
  });

  // The hole T21a exists to close: without a producing run there is nothing to
  // count against, and seeding 0 would let an A↔B pair loop forever.
  it("fails CLOSED for an agent-authored event with a NULL run_id", async () => {
    const result = await resolveAgentChainDepth({
      trigger: { source: "domain_event", eventId: 5 },
      db: stubDb({ event: { actorType: "agent", runId: null } }) as never,
    });

    expect(result.atCap).toBe(true);
    expect(result.depth).toBeGreaterThan(0);
  });

  it("fails CLOSED when the producing run row is gone", async () => {
    const result = await resolveAgentChainDepth({
      trigger: { source: "domain_event", eventId: 5 },
      db: stubDb({
        event: { actorType: "agent", runId: "run-vanished" },
      }) as never,
    });

    expect(result.atCap).toBe(true);
  });

  it("honours a 0 cap as 'no agent-triggered agent launches at all'", async () => {
    process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH = "0";

    await expect(
      resolveAgentChainDepth({
        trigger: { source: "manual" },
        db: stubDb({}) as never,
      }),
    ).resolves.toEqual({ depth: 0, atCap: true });
  });

  // Both loops D7 bounds terminate: the chain is strictly increasing and the
  // cap is finite, so an A→B→A ping-pong (cross-project OR same-project, which
  // self-exclusion cannot see) runs out of budget rather than forever.
  it("terminates a mutual A<->B chain at the cap", async () => {
    process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH = "2";

    const depths: number[] = [];
    let parentDepth = 0;

    for (let hop = 0; hop < 10; hop++) {
      const result = await resolveAgentChainDepth({
        trigger: { source: "domain_event", eventId: hop + 1 },
        db: stubDb({
          event: { actorType: "agent", runId: `run-${hop}` },
          parentDepth,
        }) as never,
      });

      if (result.atCap) break;
      depths.push(result.depth);
      parentDepth = result.depth;
    }

    expect(depths).toEqual([1, 2]);
  });
});
