import { startBarePostgresTestDb } from "../../pg-container";

const startedAt = Date.now();

startBarePostgresTestDb({ databaseName: "test_support_docker_discovery" }).then(
  async (database) => {
    try {
      const result = await database.pool.query<{ value: number }>(
        "SELECT 1::int AS value",
      );

      process.stdout.write(
        `${JSON.stringify({ name: "ready", value: result.rows[0]?.value, containerId: database.container.getId(), durationMs: Date.now() - startedAt })}\n`,
      );
    } finally {
      await database.stop();
    }
  },
  (error: unknown) => {
    const result =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            durationMs: Date.now() - startedAt,
          }
        : { name: "unknown" };

    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
);
