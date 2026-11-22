import { Pool, type PoolConfig } from "pg";

const CONNECTIONS_CLOSED = Symbol.for(
  "maister.postgres-pool-connections-closed.v1",
);

type TrackedPostgresPool = Pool & {
  readonly [CONNECTIONS_CLOSED]: () => Promise<void>;
};

export function createPostgresPool(options: PoolConfig): TrackedPostgresPool {
  const pool = new Pool(options);
  const connections = new Set<Promise<void>>();

  pool.on("connect", (client) => {
    const closed = new Promise<void>((resolve) => client.once("end", resolve));

    connections.add(closed);
    void closed.then(() => {
      connections.delete(closed);
    });
  });

  return Object.assign(pool, {
    [CONNECTIONS_CLOSED]: async (): Promise<void> => {
      await Promise.all([...connections]);
    },
  });
}

function isTrackedPostgresPool(pool: Pool): pool is TrackedPostgresPool {
  return CONNECTIONS_CLOSED in pool;
}

export async function closePostgresPool(pool: Pool): Promise<void> {
  if (!isTrackedPostgresPool(pool))
    throw new Error("PostgreSQL pool has no connection-retirement owner");
  try {
    await pool.end();
  } finally {
    // pg-pool can resolve end before its client.end callbacks have run.
    await pool[CONNECTIONS_CLOSED]();
  }
}
