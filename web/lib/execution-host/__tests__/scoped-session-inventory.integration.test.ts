import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { buildEnvelope } from "@/lib/execution-host/ledger";
import { asExecutionWorkspaceId } from "@/lib/execution-host/types";

let server: Server;
let previousUrl: string | undefined;
let ownershipVersion: string | undefined;
let inventoryStatus = 200;
let inventory: unknown = [];
let posts = 0;
const requestedRunIds: string[] = [];
const runId = randomUUID();
const transport = createLocalDirectTransport();

beforeAll(async () => {
  previousUrl = process.env.MAISTER_SUPERVISOR_URL;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/sessions") {
      requestedRunIds.push(url.searchParams.get("runId") ?? "");
      if (ownershipVersion)
        response.setHeader(
          "X-Maister-Session-Ownership-Version",
          ownershipVersion,
        );
      response.writeHead(inventoryStatus, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(inventory));

      return;
    }
    if (request.method === "POST" && url.pathname === "/sessions") {
      posts += 1;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sessionId: "session-1",
          acpSessionId: "acp-1",
          pid: 1234,
        }),
      );

      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("Inventory fixture has no port");
  process.env.MAISTER_SUPERVISOR_URL = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.MAISTER_SUPERVISOR_URL;
  else process.env.MAISTER_SUPERVISOR_URL = previousUrl;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

it("requires an attested exact-run inventory before any actual create, and refuses old hosts without posting", async () => {
  ownershipVersion = undefined;
  inventoryStatus = 200;
  inventory = [];
  const envelope = buildEnvelope({
    commandId: randomUUID(),
    kind: "session.create",
    hostKey: "host-1",
    runId,
    assignmentId: randomUUID(),
    assignmentEpoch: 1,
    payload: {
      executionWorkspaceId: asExecutionWorkspaceId(
        `ws_${randomUUID().replaceAll("-", "")}`,
      ),
      stepId: "agent",
      executor: { agent: "claude" as const, model: "mock" },
    },
  });

  await expect(transport.createSession(envelope)).rejects.toMatchObject({
    code: "EXECUTOR_UNAVAILABLE",
  });
  expect(posts).toBe(0);
  expect(requestedRunIds.at(-1)).toBe(runId);
  ownershipVersion = "1";
  await expect(transport.createSession(envelope)).resolves.toMatchObject({
    sessionId: "session-1",
  });
  expect(posts).toBe(1);
});

it("does not interpret a scoped unresolved owner or malformed inventory as an empty proof", async () => {
  ownershipVersion = "1";
  inventoryStatus = 503;
  inventory = {
    code: "EXECUTOR_UNAVAILABLE",
    message: "Original process is unconfirmed",
    details: { reason: "session_process_owner_unconfirmed" },
  };

  await expect(transport.listSessionsForRun(runId)).rejects.toMatchObject({
    code: "EXECUTOR_UNAVAILABLE",
    details: { reason: "session_process_owner_unconfirmed" },
  });
  inventoryStatus = 200;
  inventory = [
    { runId: "another-run", sessionId: "session-1", status: "live", pid: 1234 },
  ];
  await expect(transport.listSessionsForRun(runId)).rejects.toMatchObject({
    code: "EXECUTOR_UNAVAILABLE",
    details: { reason: "session_inventory_invalid" },
  });
  inventory = [];
  await expect(transport.listSessionsForRun(runId)).resolves.toEqual([]);
});
