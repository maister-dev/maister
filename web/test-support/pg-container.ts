import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pino from "pino";
import { Pool } from "pg";
import { getContainerRuntimeClient } from "testcontainers";

import * as mainSchema from "@/lib/db/schema";

export const PGVECTOR_IMAGE = "pgvector/pgvector:pg16";
export const TEST_DATABASE_DOCKER_MESSAGE =
  "integration/e2e require Docker; build/unit do not";

const dockerProbeTimeoutMs = 3_000;
const logger = pino({ name: "test-database" });

export type TestDatabaseLane = "integration" | "e2e";

export type TestDatabaseOptions = {
  databaseName: string;
  lane?: TestDatabaseLane;
  poolMax?: number;
};

type TestDatabaseClient = NodePgDatabase<Record<string, never>> &
  ReturnType<typeof drizzle<typeof mainSchema>>;

type TestDatabaseResources = {
  container?: StartedPostgreSqlContainer;
  pool?: Pool;
};

export type StartedPostgresTestDb = {
  container: StartedPostgreSqlContainer;
  databaseUrl: string;
  pool: Pool;
  db: TestDatabaseClient;
  stop: () => Promise<void>;
};

export class TestDatabaseDockerUnavailableError extends Error {
  readonly name = "TestDatabaseDockerUnavailableError";

  constructor(
    readonly lane: TestDatabaseLane,
    readonly safeCause: string,
    cause: unknown,
  ) {
    super(`${TEST_DATABASE_DOCKER_MESSAGE}: ${safeCause}`, { cause });
  }
}

function asSafeCause(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message.replaceAll(
      /postgres(?:ql)?:\/\/[^\s]+/giu,
      "<database-url>",
    );
  }

  return "container runtime is unavailable";
}

function maskedEndpoint(databaseUrl: string): string {
  const endpoint = new URL(databaseUrl);

  return `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`;
}

function createDockerUnavailableError(
  lane: TestDatabaseLane,
  phase: "docker-probe" | "container-start",
  startedAt: number,
  cause: unknown,
): TestDatabaseDockerUnavailableError {
  const safeCause = asSafeCause(cause);

  logger.error(
    {
      lane,
      phase,
      durationMs: Date.now() - startedAt,
      safeCause,
    },
    "test database Docker runtime unavailable",
  );

  return new TestDatabaseDockerUnavailableError(lane, safeCause, cause);
}

async function stopTestDatabaseResources(
  resources: TestDatabaseResources,
): Promise<void> {
  const cleanupErrors: unknown[] = [];

  if (resources.pool !== undefined) {
    try {
      await resources.pool.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (resources.container !== undefined) {
    try {
      await resources.container.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }

  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "test database cleanup failed");
  }
}

async function throwAfterCleanup(
  lane: TestDatabaseLane,
  operationError: unknown,
  resources: TestDatabaseResources,
): Promise<never> {
  try {
    await stopTestDatabaseResources(resources);
  } catch (cleanupError) {
    logger.error(
      {
        lane,
        phase: "startup-cleanup",
        safeCause: asSafeCause(cleanupError),
      },
      "test database cleanup failed",
    );
    throw new AggregateError(
      [operationError, cleanupError],
      "test database operation and cleanup failed",
    );
  }

  throw operationError;
}

async function startPostgresContainer(
  options: TestDatabaseOptions,
  lane: TestDatabaseLane,
  startedAt: number,
): Promise<StartedPostgreSqlContainer> {
  try {
    return await new PostgreSqlContainer(PGVECTOR_IMAGE)
      .withDatabase(options.databaseName)
      .withUsername("test")
      .withPassword("test")
      .start();
  } catch (cause) {
    throw createDockerUnavailableError(
      lane,
      "container-start",
      startedAt,
      cause,
    );
  }
}

export async function assertTestDatabaseDockerRuntime(
  lane: TestDatabaseLane,
): Promise<void> {
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      getContainerRuntimeClient(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("container runtime probe timed out")),
          dockerProbeTimeoutMs,
        );
      }),
    ]);
  } catch (cause) {
    throw createDockerUnavailableError(lane, "docker-probe", startedAt, cause);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function startBarePostgresTestDb(
  options: TestDatabaseOptions,
): Promise<StartedPostgresTestDb> {
  const lane = options.lane ?? "integration";
  const startedAt = Date.now();

  await assertTestDatabaseDockerRuntime(lane);

  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;

  try {
    const startedContainer = await startPostgresContainer(
      options,
      lane,
      startedAt,
    );

    container = startedContainer;
    const databaseUrl = startedContainer.getConnectionUri();
    const startedPool = new Pool({
      connectionString: databaseUrl,
      max: options.poolMax,
    });

    pool = startedPool;
    const db = Object.assign(
      drizzle(startedPool),
      drizzle(startedPool, { schema: mainSchema }),
    );

    logger.info(
      {
        lane,
        lineage: "bare",
        phase: "ready",
        durationMs: Date.now() - startedAt,
        containerId: startedContainer.getId(),
        endpoint: maskedEndpoint(databaseUrl),
      },
      "started bare test database",
    );

    return {
      container: startedContainer,
      databaseUrl,
      pool: startedPool,
      db,
      stop: async () => {
        const stopStartedAt = Date.now();

        try {
          await stopTestDatabaseResources({
            container: startedContainer,
            pool: startedPool,
          });
        } catch (error) {
          logger.error(
            {
              lane,
              phase: "stop",
              durationMs: Date.now() - stopStartedAt,
              containerId: startedContainer.getId(),
              endpoint: maskedEndpoint(databaseUrl),
              safeCause: asSafeCause(error),
            },
            "test database cleanup failed",
          );
          throw error;
        }
        logger.info(
          {
            lane,
            phase: "stop",
            durationMs: Date.now() - stopStartedAt,
            containerId: startedContainer.getId(),
            endpoint: maskedEndpoint(databaseUrl),
          },
          "stopped test database",
        );
      },
    };
  } catch (error) {
    return throwAfterCleanup(lane, error, { container, pool });
  }
}

export async function startMainPostgresTestDb(
  options: TestDatabaseOptions,
): Promise<StartedPostgresTestDb> {
  const database = await startBarePostgresTestDb(options);

  try {
    await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
    logger.info(
      {
        lane: options.lane ?? "integration",
        lineage: "main",
        phase: "migrate",
        endpoint: maskedEndpoint(database.databaseUrl),
      },
      "applied main test database migrations",
    );

    return database;
  } catch (error) {
    return throwAfterCleanup(options.lane ?? "integration", error, database);
  }
}

export async function startMainAndBrainPostgresTestDb(
  options: TestDatabaseOptions,
): Promise<StartedPostgresTestDb> {
  const database = await startMainPostgresTestDb(options);

  try {
    await migrate(database.db, {
      migrationsFolder: "./lib/db/brain-migrations",
      migrationsTable: "__drizzle_brain_migrations",
    });
    logger.info(
      {
        lane: options.lane ?? "integration",
        lineage: "main+brain",
        phase: "migrate",
        endpoint: maskedEndpoint(database.databaseUrl),
      },
      "applied Brain test database migrations",
    );

    return database;
  } catch (error) {
    return throwAfterCleanup(options.lane ?? "integration", error, database);
  }
}
