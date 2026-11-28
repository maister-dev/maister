// MEMO-03 / MEMO-05 (docs/system-analytics/identity-access.md §Per-render
// memoization) — verifies `getVisibleProjects` and `getActionableProjectIds`
// memoize on the default-client path, bypass when an explicit client is
// supplied, and return fresh arrays so caller mutations cannot poison the
// render cache.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { defaultSelectSpy, explicitSelectSpy } = vi.hoisted(() => ({
  defaultSelectSpy: vi.fn(),
  explicitSelectSpy: vi.fn(),
}));

vi.mock("react", async (importActual) => {
  const { emulatedReactCache } =
    await import("@/test-support/react-cache-emulation");

  return {
    ...(await importActual<typeof import("react")>()),
    cache: emulatedReactCache,
  };
});

function makeClient(spy: (...args: unknown[]) => void) {
  return {
    select: (...args: unknown[]) => {
      spy(...args);

      return {
        from: () => ({
          where: async () => [
            { id: "proj-1", slug: "p1", name: "Project 1" },
            { id: "proj-2", slug: "p2", name: "Project 2" },
          ],
          innerJoin: () => ({
            where: async () => [{ id: "proj-1" }],
          }),
        }),
      };
    },
  };
}

vi.mock("@/lib/db/client", () => ({
  getDb: () => makeClient(defaultSelectSpy),
}));

import { withEmulatedRender } from "@/test-support/react-cache-emulation";
import {
  getActionableProjectIds,
  getVisibleProjects,
} from "@/lib/queries/visible-projects";

describe("visible-projects per-render memoization (MEMO-03 / MEMO-05)", () => {
  beforeEach(() => {
    defaultSelectSpy.mockClear();
    explicitSelectSpy.mockClear();
  });

  it("MEMO-05 memoizes on the default client and returns fresh arrays immune to caller mutation", async () => {
    await withEmulatedRender(async () => {
      const firstProjects = await getVisibleProjects("user-1", "admin");
      const secondProjects = await getVisibleProjects("user-1", "admin");

      expect(firstProjects).toEqual(secondProjects);
      expect(firstProjects).not.toBe(secondProjects);

      // Mutating the first array MUST NOT affect subsequent reads.
      firstProjects.pop();
      const thirdProjects = await getVisibleProjects("user-1", "admin");

      expect(thirdProjects).toHaveLength(2);
      expect(defaultSelectSpy).toHaveBeenCalledTimes(1);

      const firstActionable = await getActionableProjectIds("user-1", "member");
      const secondActionable = await getActionableProjectIds(
        "user-1",
        "member",
      );

      expect(firstActionable).toEqual(["proj-1"]);
      expect(firstActionable).not.toBe(secondActionable);

      firstActionable.push("poisoned");
      const thirdActionable = await getActionableProjectIds("user-1", "member");

      expect(thirdActionable).toEqual(["proj-1"]);
      expect(defaultSelectSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("MEMO-03 bypasses the render cache when an explicit client is provided", async () => {
    const client = makeClient(explicitSelectSpy);

    await withEmulatedRender(async () => {
      await getVisibleProjects("user-1", "admin", client);
      await getVisibleProjects("user-1", "admin", client);
      await getActionableProjectIds("user-1", "member", client);
      await getActionableProjectIds("user-1", "member", client);
    });

    expect(explicitSelectSpy).toHaveBeenCalledTimes(4);
    expect(defaultSelectSpy).toHaveBeenCalledTimes(0);
  });
});
