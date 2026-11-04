import { vi } from "vitest";

const writes = vi.hoisted(() => new Set<Promise<void>>());

// Keep the real audit write and its result; fixture reset owns its completion.
vi.mock("@/lib/tokens/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tokens/audit")>();

  return {
    ...actual,
    bumpTokenLastUsed: (
      ...args: Parameters<typeof actual.bumpTokenLastUsed>
    ): Promise<void> => {
      const write = actual.bumpTokenLastUsed(...args);

      writes.add(write);

      return write;
    },
  };
});

/** Await each actual route-owned audit write before truncating its rows or closing its pool. */
export async function awaitTokenAuditWrites(): Promise<void> {
  const failures: unknown[] = [];

  while (writes.size > 0) {
    const admitted = [...writes];
    const outcomes = await Promise.allSettled(admitted);

    for (const write of admitted) writes.delete(write);
    for (const outcome of outcomes)
      if (outcome.status === "rejected") failures.push(outcome.reason);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Fixture token audit writes failed");
}
