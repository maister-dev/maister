import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  dispatchDomainEvents,
  type DomainEventConsumer,
} from "@/lib/domain-events/dispatch";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches emit-run-status.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";

// =============================================================================
// T7 — per-consumer cursor dispatcher (ADR-085 DD3/DD5).
//
//   T-D1  cursor isolation between consumers
//   T-D2  no double-claim under concurrent dispatch passes
//   T-D3  catch-up: a backlog drains in one dispatch run via the batch loop
//   T-D4  at-least-once: handler failure → no advance, failure accounting,
//         redelivery; success resets the counter
//   T-D5  xid8 horizon: an open earlier tx holds back later committed events
//   T-D6  zombie advance after lease expiry + reclaim no-ops (cursor CAS)
//   T-D7  startFrom "now" seeds the cursor at MAX(id)
// =============================================================================

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.domainEvents);
  await db.delete(schema.domainEventConsumers);
});

async function insertEvents(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await db.insert(schema.domainEvents).values({
      kind: "task.created",
      projectId,
      payload: { n: i },
      occurredAt: new Date(),
    });
  }
}

function recorder(
  id: string,
  opts: {
    startFrom?: "beginning" | "now";
    failTimes?: number;
    delayMs?: number;
  } = {},
): DomainEventConsumer & {
  received: Record<string, unknown>[];
  calls: number;
} {
  const state = {
    received: [] as Record<string, unknown>[],
    calls: 0,
    failures: opts.failTimes ?? 0,
  };

  return {
    id,
    startFrom: opts.startFrom ?? "beginning",
    received: state.received,
    get calls() {
      return state.calls;
    },
    async handle(events) {
      state.calls += 1;
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (state.failures > 0) {
        state.failures -= 1;
        throw new Error(`injected consumer failure (${id})`);
      }
      state.received.push(...(events as Record<string, unknown>[]));
    },
  };
}

async function cursorRow(consumerId: string): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(schema.domainEventConsumers)
    .where(eq(schema.domainEventConsumers.consumerId, consumerId));

  return rows[0] as Record<string, unknown>;
}

describe("T-D1 — cursor isolation between consumers", () => {
  it("each consumer advances independently and sees every event", async () => {
    await insertEvents(3);

    const a = recorder("iso-a");
    const b = recorder("iso-b");

    await dispatchDomainEvents({ db, consumers: [a] });

    expect(a.received).toHaveLength(3);

    await dispatchDomainEvents({ db, consumers: [a, b] });

    expect(a.received).toHaveLength(3); // nothing new for A
    expect(b.received).toHaveLength(3); // B catches up independently

    const aRow = await cursorRow("iso-a");
    const bRow = await cursorRow("iso-b");

    expect(aRow.cursorEventId).toBe(bRow.cursorEventId);
  });
});

describe("T-D2 — no double-claim under concurrent dispatch passes", () => {
  it("concurrent passes deliver every event exactly once per consumer", async () => {
    await insertEvents(5);

    const x = recorder("conc-x", { delayMs: 50 });

    await Promise.all([
      dispatchDomainEvents({ db, consumers: [x] }),
      dispatchDomainEvents({ db, consumers: [x] }),
    ]);

    expect(x.received).toHaveLength(5);
  });
});

describe("T-D3 — catch-up drains a backlog via the batch loop", () => {
  it("250 backlog events drain in one dispatch run", async () => {
    await insertEvents(250);

    const c = recorder("catchup");

    const summary = await dispatchDomainEvents({ db, consumers: [c] });

    expect(c.received).toHaveLength(250);
    expect(summary.totalDispatched).toBe(250);

    const events = await db
      .select({ id: schema.domainEvents.id })
      .from(schema.domainEvents)
      .orderBy(asc(schema.domainEvents.id));
    const maxId = (events.at(-1) as { id: number }).id;

    expect((await cursorRow("catchup")).cursorEventId).toBe(maxId);
  });
});

describe("T-D4 — at-least-once with failure accounting", () => {
  it("a throwing handler leaves the cursor, counts the failure, then redelivers", async () => {
    await insertEvents(2);

    const f = recorder("flaky", { failTimes: 1 });

    await dispatchDomainEvents({ db, consumers: [f] });

    let row = await cursorRow("flaky");

    expect(f.received).toHaveLength(0);
    expect(row.cursorEventId).toBe(0);
    expect(row.consecutiveFailures).toBe(1);
    expect(String(row.lastError)).toContain("injected consumer failure");

    await dispatchDomainEvents({ db, consumers: [f] });

    row = await cursorRow("flaky");

    expect(f.received).toHaveLength(2); // same window redelivered
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastError).toBeNull();
  });
});

describe("T-D5 — xid8 commit horizon", () => {
  it("an open earlier tx holds back later committed events until it resolves", async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `insert into domain_events (kind, project_id, payload, occurred_at)
         values ('task.created', $1, '{"open":true}', now())`,
        [projectId],
      );

      // A later event commits while the earlier tx is still open.
      await insertEvents(1);

      const h = recorder("horizon");

      await dispatchDomainEvents({ db, consumers: [h] });

      // Horizon holds EVERYTHING back behind the open tx.
      expect(h.received).toHaveLength(0);

      await client.query("COMMIT");

      await dispatchDomainEvents({ db, consumers: [h] });

      expect(h.received).toHaveLength(2);
      const ids = h.received.map((e) => e.id as number);

      expect(ids).toEqual([...ids].sort((x, y) => x - y));
    } finally {
      client.release();
    }
  });
});

describe("T-D6 — zombie advance after lease expiry + reclaim no-ops", () => {
  it("a reclaiming pass that moved the cursor wins over the zombie's late advance", async () => {
    await insertEvents(3);

    // Zombie pass: tiny lease, slow handler — its lease expires mid-handle.
    const zombie = recorder("fence", { delayMs: 400 });
    const fresh = recorder("fence");

    const zombiePass = dispatchDomainEvents({
      db,
      consumers: [zombie],
      leaseMs: 50,
    });

    // Give the zombie time to claim + start handling, then let the lease lapse,
    // append more events, and reclaim with a fast pass.
    await new Promise((r) => setTimeout(r, 150));
    await insertEvents(2);

    await dispatchDomainEvents({ db, consumers: [fresh] });

    expect(fresh.received).toHaveLength(5); // reclaimed from cursor 0

    await zombiePass;

    const events = await db
      .select({ id: schema.domainEvents.id })
      .from(schema.domainEvents)
      .orderBy(asc(schema.domainEvents.id));
    const maxId = (events.at(-1) as { id: number }).id;

    // The zombie saw only the first 3 events; its fenced advance must NOT
    // pull the cursor back below the reclaimer's position.
    expect((await cursorRow("fence")).cursorEventId).toBe(maxId);
  });
});

describe("T-D7 — startFrom 'now' seeds at MAX(id)", () => {
  it("a 'now' consumer skips the backlog and receives only later events", async () => {
    await insertEvents(3);

    const n = recorder("from-now", { startFrom: "now" });

    await dispatchDomainEvents({ db, consumers: [n] });

    expect(n.received).toHaveLength(0);

    await insertEvents(2);

    await dispatchDomainEvents({ db, consumers: [n] });

    expect(n.received).toHaveLength(2);
  });
});
