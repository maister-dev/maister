import { describe, expect, it } from "vitest";

import { withRegistrationLock } from "@/lib/registration-lock";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withRegistrationLock", () => {
  it("serializes overlapping critical sections", async () => {
    const events: string[] = [];

    const a = withRegistrationLock(async () => {
      events.push("a-start");
      await delay(25);
      events.push("a-end");

      return "a";
    });
    const b = withRegistrationLock(async () => {
      events.push("b-start");

      return "b";
    });

    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    // b must not start until a finished — no interleaving.
    expect(events).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("a rejection does not wedge the queue", async () => {
    await expect(
      withRegistrationLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(withRegistrationLock(async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });
});
