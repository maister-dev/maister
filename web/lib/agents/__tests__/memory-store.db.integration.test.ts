// ADR-152 REQ-C7 AC4 — the content-hash CAS under REAL concurrency.
//
// This lives at the STORE layer on purpose. The route-level concurrency case in
// `app/api/v1/ext/agent/memory/__tests__/route.integration.test.ts` cannot prove
// the CAS: both request handlers there run the same sequence of DB round-trips,
// which happens to stagger them so one read lands after the other's write. Strip
// those round-trips — or race the owner PUT against the agent POST, which have
// different await profiles — and an unsynchronized compare-then-write lets BOTH
// callers through. Before the advisory lock landed, this file's first case
// returned `ok` twice and the surviving bytes varied run to run.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const runtimeRootMock = vi.hoisted(() => ({ value: "/tmp/unset" }));

vi.mock("@/lib/runtime-root", () => ({
  runtimeRoot: () => runtimeRootMock.value,
}));

import {
  agentMemoryPath,
  clearAgentMemoryCas,
  hashAgentMemory,
  writeAgentMemoryCas,
  type AgentMemoryCasDb,
} from "@/lib/agents/memory-store";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const SLUG = "cas-proj";
const AGENT_ID = "cas-pkg:keeper";

let testDatabase: StartedPostgresTestDb;
let db: AgentMemoryCasDb;
let root: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "agent_memory_cas_test",
  });
  db = testDatabase.db as unknown as AgentMemoryCasDb;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(root, { force: true, recursive: true });
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "maister-cas-"));
  runtimeRootMock.value = root;
});

describe("REQ-C7 AC4 — writeAgentMemoryCas serializes concurrent writers", () => {
  it("two concurrent FIRST-writer calls: exactly one wins, the loser gets 409 semantics", async () => {
    const [a, b] = await Promise.all([
      writeAgentMemoryCas(db, SLUG, AGENT_ID, "A".repeat(64), null),
      writeAgentMemoryCas(db, SLUG, AGENT_ID, "B".repeat(64), null),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The loser carries the WINNER's bytes so it can merge and retry — an
    // unsynchronized CAS would have reported the absent file it read instead.
    const loser = losers[0] as { ok: false; current: { content: string } };
    const winner = winners[0] as { ok: true; state: { content: string } };

    expect(loser.current.content).toBe(winner.state.content);

    const onDisk = await readFile(agentMemoryPath(SLUG, AGENT_ID), "utf8");

    expect(onDisk).toBe(winner.state.content);
    expect(["A".repeat(64), "B".repeat(64)]).toContain(onDisk);
  });

  it("two concurrent UPDATES holding the SAME current hash: the second loses, no silent clobber", async () => {
    const seed = await writeAgentMemoryCas(db, SLUG, AGENT_ID, "seed", null);

    expect(seed.ok).toBe(true);
    const seedHash = (seed as { ok: true; state: { hash: string } }).state.hash;

    const [a, b] = await Promise.all([
      writeAgentMemoryCas(db, SLUG, AGENT_ID, "X".repeat(32), seedHash),
      writeAgentMemoryCas(db, SLUG, AGENT_ID, "Y".repeat(32), seedHash),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].filter((r) => !r.ok)).toHaveLength(1);

    const onDisk = await readFile(agentMemoryPath(SLUG, AGENT_ID), "utf8");

    // Whichever won, the file is exactly its payload — never interleaved, and
    // never the loser's.
    expect(["X".repeat(32), "Y".repeat(32)]).toContain(onDisk);
    expect(onDisk).not.toBe("seed");
  });

  it("a run of concurrent writers leaves the file equal to the LAST successful write's reported hash", async () => {
    // Ten racers, each passing the hash it was told to expect. Exactly one can
    // win from the absent state; the rest must lose rather than overwrite.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        writeAgentMemoryCas(db, SLUG, AGENT_ID, `writer-${index}`, null),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const winner = results.find((r) => r.ok) as {
      ok: true;
      state: { content: string; hash: string };
    };
    const onDisk = await readFile(agentMemoryPath(SLUG, AGENT_ID), "utf8");

    expect(onDisk).toBe(winner.state.content);
    expect(hashAgentMemory(onDisk)).toBe(winner.state.hash);
  });

  it("D27 — a clear racing a write cannot destroy it: one of the two loses the CAS", async () => {
    const seed = await writeAgentMemoryCas(db, SLUG, AGENT_ID, "seed", null);
    const seedHash = (seed as { ok: true; state: { hash: string } }).state.hash;

    // The operator opened the drawer at `seed` and hit Clear; the agent wrote in
    // the same instant, holding the same hash.
    const [cleared, written] = await Promise.all([
      clearAgentMemoryCas(db, SLUG, AGENT_ID, seedHash),
      writeAgentMemoryCas(db, SLUG, AGENT_ID, "agent's new notes", seedHash),
    ]);

    expect([cleared.ok, written.ok].filter(Boolean)).toHaveLength(1);

    // Which one takes the lock first is genuinely non-deterministic, so assert
    // the invariant for BOTH orderings rather than the ordering that happens to
    // win on an idle machine.
    if (written.ok) {
      // Write first: the clear is refused, and what it reports is the agent's
      // brand-new content — precisely the bytes it would otherwise have
      // destroyed, which is what makes the 409 actionable.
      expect(cleared.ok).toBe(false);
      expect(
        (cleared as { ok: false; current: { content: string } }).current,
      ).toMatchObject({ content: "agent's new notes" });
      await expect(
        readFile(agentMemoryPath(SLUG, AGENT_ID), "utf8"),
      ).resolves.toBe("agent's new notes");
    } else {
      // Clear first: the file is gone, so the agent's write loses the CAS and is
      // told the file is now absent rather than silently recreating it.
      expect(cleared.ok).toBe(true);
      expect(
        (written as { ok: false; current: { hash: string | null } }).current
          .hash,
      ).toBeNull();
      await expect(
        readFile(agentMemoryPath(SLUG, AGENT_ID), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("D27 — clearing an already-absent file with ifHash null stays idempotent", async () => {
    await expect(
      clearAgentMemoryCas(db, SLUG, "cas-pkg:never-written", null),
    ).resolves.toEqual({ ok: true });
  });

  it("the lock is per (project, agent): a different agent is not serialized behind it", async () => {
    const [a, b] = await Promise.all([
      writeAgentMemoryCas(db, SLUG, "cas-pkg:one", "one", null),
      writeAgentMemoryCas(db, SLUG, "cas-pkg:two", "two", null),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    await expect(
      readFile(agentMemoryPath(SLUG, "cas-pkg:one"), "utf8"),
    ).resolves.toBe("one");
    await expect(
      readFile(agentMemoryPath(SLUG, "cas-pkg:two"), "utf8"),
    ).resolves.toBe("two");
  });
});
