import { assertTestDatabaseDockerRuntime } from "../../pg-container";

assertTestDatabaseDockerRuntime("integration").then(
  () => process.stdout.write(`${JSON.stringify({ name: "ready" })}\n`),
  (error: unknown) => {
    const result =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "unknown" };

    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
);
