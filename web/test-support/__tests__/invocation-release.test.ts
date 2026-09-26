import { describe, expect, it, vi } from "vitest";

import {
  releaseInvocation,
  type InvocationReclaimers,
  type ProcessIdentity,
} from "@/test-support/process-invocation";

const invocation = { id: "inv", directory: "/tmp/ledger/processes/inv" };

function reclaimers(overrides: Partial<InvocationReclaimers> = {}) {
  const order: string[] = [];
  const stubs: InvocationReclaimers = {
    sweepInvocation: vi.fn(async () => {
      order.push("processes");

      return [];
    }),
    removeInvocationContainers: vi.fn(async () => {
      order.push("containers");

      return [];
    }),
    removeInvocationRoots: vi.fn(async () => {
      order.push("roots");
    }),
    ...overrides,
  };

  return { order, stubs };
}

describe("releaseInvocation", () => {
  it("reclaims processes, then containers, then roots, and reports nothing when all are clean", async () => {
    const { order, stubs } = reclaimers();

    await expect(releaseInvocation(invocation, "lane", stubs)).resolves.toEqual(
      [],
    );
    expect(order).toEqual(["processes", "containers", "roots"]);
  });

  it("runs the container and root reclaimers when the process sweep throws, and returns that error", async () => {
    const failure = new Error("ownership unverifiable");
    const { order, stubs } = reclaimers({
      sweepInvocation: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(releaseInvocation(invocation, "lane", stubs)).resolves.toEqual(
      [failure],
    );
    expect(order).toEqual(["containers", "roots"]);
  });

  it("runs the root reclaimer when the container reclaimer throws", async () => {
    const failure = new Error("docker unavailable");
    const { order, stubs } = reclaimers({
      removeInvocationContainers: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(releaseInvocation(invocation, "lane", stubs)).resolves.toEqual(
      [failure],
    );
    expect(order).toEqual(["processes", "roots"]);
  });

  it("reports reaped processes as an error even though the sweep succeeded", async () => {
    const { stubs } = reclaimers({
      sweepInvocation: vi.fn(async () => [
        { pid: 41 } as ProcessIdentity,
        { pid: 42 } as ProcessIdentity,
      ]),
    });

    const errors = await releaseInvocation(invocation, "e2e invocation", stubs);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe(
      "e2e invocation leaked 2 process(es); the final sweep reaped them (ledger /tmp/ledger/processes/inv)",
    );
  });

  it("reports removed containers as an error and keeps step errors first", async () => {
    const rootFailure = new Error("root ownership changed");
    const { stubs } = reclaimers({
      removeInvocationContainers: vi.fn(async () => ["a".repeat(64)]),
      removeInvocationRoots: vi.fn(async () => {
        throw rootFailure;
      }),
    });

    const errors = await releaseInvocation(invocation, "A/B invocation", stubs);

    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(rootFailure);
    expect((errors[1] as Error).message).toBe(
      "A/B invocation leaked 1 container(s); terminal cleanup removed them (ledger /tmp/ledger/processes/inv)",
    );
  });
});
