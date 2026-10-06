import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { getContainerRuntimeClient, getReaper } from "testcontainers";

import {
  INVOCATION_CONTAINER_LABEL,
  invocationFromEnvironment,
  registerContainerAllocation,
  registerContainer,
} from "../process-invocation.ts";

const invocation = invocationFromEnvironment();

if (!invocation || !process.send)
  throw new Error("reaper worker requires invocation ownership and IPC");
await registerContainerAllocation(invocation);
const reaper = await getReaper(await getContainerRuntimeClient());
const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
  .withLabels({ [INVOCATION_CONTAINER_LABEL]: invocation.id })
  .start();

await registerContainer(invocation, container.getId());
const pool = new Pool({
  connectionString: container.getConnectionUri(),
  max: 1,
});
const result = await pool.query("SELECT 19::integer AS value");

await pool.end();
process.send({
  event: "ready",
  containerId: container.getId(),
  reaperId: reaper.containerId,
  value: result.rows[0].value,
});
process.once("message", async (message) => {
  if (message !== "stop") throw new Error("unexpected reaper worker command");
  await container.stop();
  process.disconnect();
});
