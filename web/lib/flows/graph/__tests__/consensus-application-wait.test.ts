import { describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  FlowPromptContinuationPending,
  waitForConsensusApplication,
} from "@/lib/flows/graph/prompt-owner";

function client(outcome: () => Promise<unknown>) {
  return { waitForPromptOwnerApplication: vi.fn(outcome) } as never;
}

function db(applicationState: string | Error | undefined) {
  const select = vi.fn(() => ({
    from: () => ({
      where: async () => {
        if (applicationState instanceof Error) throw applicationState;

        return applicationState ? [{ applicationState }] : [];
      },
    }),
  }));

  return { handle: { select } as never, select };
}

function ownerRefusal(reason: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "prompt owner cannot apply this command",
    {
      details: { reason, commandId: "cmd-1" },
    },
  );
}

describe("waitForConsensusApplication", () => {
  it("yields while the settled turn's owner application is still owed", async () => {
    const { handle } = db(undefined);

    await expect(
      waitForConsensusApplication(
        handle,
        client(async () => null),
        "cmd-1",
      ),
    ).rejects.toBeInstanceOf(FlowPromptContinuationPending);
  });

  it("returns once the owner applied the turn", async () => {
    const { handle } = db(undefined);

    await expect(
      waitForConsensusApplication(
        handle,
        client(async () => ({ stopReason: "end_turn" })),
        "cmd-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("treats a superseded command as settled without re-reading the ledger", async () => {
    const { handle, select } = db(new Error("must not read"));

    await expect(
      waitForConsensusApplication(
        handle,
        client(async () => {
          throw ownerRefusal("prompt_owner_superseded");
        }),
        "cmd-1",
      ),
    ).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps yielding on a poisoned command so ADR-177 reconcile owns the crash", async () => {
    const { handle } = db("poisoned");

    await expect(
      waitForConsensusApplication(
        handle,
        client(async () => {
          throw ownerRefusal("prompt_owner_poisoned");
        }),
        "cmd-1",
      ),
    ).rejects.toBeInstanceOf(FlowPromptContinuationPending);
  });

  it.each(["applied", "superseded"])(
    "adopts a %s ledger row after a transport failure",
    async (state) => {
      const { handle } = db(state);

      await expect(
        waitForConsensusApplication(
          handle,
          client(async () => {
            throw new MaisterError("EXECUTOR_UNAVAILABLE", "stream lost");
          }),
          "cmd-1",
        ),
      ).resolves.toBeUndefined();
    },
  );

  it("yields when neither the host nor the ledger can answer", async () => {
    const { handle } = db(new Error("database unavailable"));

    await expect(
      waitForConsensusApplication(
        handle,
        client(async () => {
          throw new MaisterError("EXECUTOR_UNAVAILABLE", "stream lost");
        }),
        "cmd-1",
      ),
    ).rejects.toBeInstanceOf(FlowPromptContinuationPending);
  });
});
