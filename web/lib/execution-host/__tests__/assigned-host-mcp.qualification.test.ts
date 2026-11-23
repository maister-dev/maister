import type { Db } from "../db";

import { randomUUID } from "node:crypto";

import pino from "pino";
import { fetch as tlsFetch } from "undici";
import { expect, it, vi } from "vitest";

import { assignedTlsDispatcher } from "../remote-tls";
import { createExecutionHosts } from "../client";
import { mintPlacement } from "../placement";
import { stopRuntimeEventConsumers } from "../events/consumer";

import { mcpTransportFromMaterial } from "@/lib/capabilities/agent-map";
import { withAssignedMcpHosts } from "@/test-support/assigned-mcp-containers";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

const logger = pino({ name: "assigned-mcp-qualification" });

it("E2E-HST-01 binds real ACP tool calls and preparation receipts to B then clean C with B stopped", async () => {
  const database = await startMainPostgresTestDb({
    databaseName: "mcp_relocation",
  });

  try {
    const { db, pool } = database;
    const hosts = createExecutionHosts({ db });
    const project = await seedProjectRow(db);
    const runId = await seedRun(db, { projectId: project.id });

    await withAssignedMcpHosts(async (lab) => {
      vi.stubEnv("MAISTER_EXECUTION_HOST_TLS_CA_FILE", lab.certFile);
      vi.stubEnv("MAISTER_EXECUTION_HOST_TLS_CERT_FILE", lab.certFile);
      vi.stubEnv("MAISTER_EXECUTION_HOST_TLS_KEY_FILE", lab.keyFile);
      const endpoints: Record<string, string> = {};

      for (const [index, key] of ["supervisor-b", "supervisor-c"].entries()) {
        const url = await lab.start(key);

        endpoints[key] = url;
        const dispatcher = assignedTlsDispatcher(url, 1000);

        vi.stubEnv(
          "MAISTER_EXECUTION_HOST_ENDPOINTS",
          JSON.stringify(endpoints),
        );
        vi.stubEnv("MAISTER_EXECUTION_HOST_PREFERRED_KEY", key);
        const assignment = await db.transaction((tx) =>
          mintPlacement(tx as unknown as Db, {
            runId,
            reason: index === 0 ? "launch" : "recover",
          }),
        );

        expect(assignment.epoch).toBe(index + 1);
        const client = await hosts.forRun(runId);

        expect(client.host.hostKey).toBe(key);
        expect(client.assignment.id).toBe(assignment.id);
        await client.adoptWorkspace({
          runId,
          projectSlug: project.slug,
          kind: "directory",
          path: "/state/work",
        });
        const stdio = mcpTransportFromMaterial("fixture-stdio", {
          transport: "stdio",
          distribution: lab.descriptor,
        });
        const http = mcpTransportFromMaterial("fixture-http", {
          transport: "http",
          url: "https://qual-web/mcp",
          bearerTokenEnv: "env:MAISTER_MCP_SECRET_HTTP",
        });
        const admin = await hosts.preferred();

        expect(await admin.probeMcp(http)).toMatchObject({
          ok: true,
          serverInfo: { name: "private-http" },
        });
        const run = async (stepId: string) => {
          const session = await client
            .createSession({
              stepId,
              executor: { agent: "claude", model: "claude-sonnet-4-6" },
              mcpServers: [
                { name: "fixture-stdio", ...stdio },
                { name: "fixture-http", ...http },
                {
                  name: "maister",
                  transport: "stdio",
                  platformOrigin: "maister_facade",
                  command: "maister:host-facade",
                  env: {
                    MAISTER_PROJECT_TOKEN: "mai_qualification_only",
                    MAISTER_MCP_TOOLSET: "librarian",
                  },
                },
              ],
            })
            .catch(async (error: unknown) => {
              const diagnostic = await lab.receipt(key);

              throw new Error(JSON.stringify(diagnostic), { cause: error });
            });
          const receipt = await lab.receipt(key);

          expect(receipt).toMatchObject({
            host: key,
            inventory: ["fixture-http", "fixture-stdio", "maister"],
            stdioExited: true,
          });
          await client.deleteSession(session.hostSessionId);
          const [command] = (
            await pool.query(
              "SELECT id FROM execution_commands WHERE kind='mcp.prepare' AND execution_assignment_id=$1 ORDER BY created_at DESC LIMIT 1",
              [assignment.id],
            )
          ).rows;
          const proof = (await (
            await tlsFetch(url + "/commands/" + command.id, { dispatcher })
          ).json()) as { body: Record<string, unknown> };

          expect(proof.body).toMatchObject({
            commandId: command.id,
            artifactDigest: lab.descriptor.artifactDigest,
            hostId: key,
            assignmentEpoch: assignment.epoch,
            cacheHit: stepId === "offline",
          });
          logger.info(
            {
              executionHostId: client.host.id,
              assignmentId: assignment.id,
              ...proof.body,
              toolReceipt: receipt,
            },
            "assigned-mcp-qualification",
          );
        };

        if (index === 0) {
          const httpOnly = await client.createSession({
            stepId: "http-only",
            executor: {
              agent: "claude",
              model: "claude-sonnet-4-6",
              env: { QUALIFICATION_ONLY_HTTP: "1" },
            },
            mcpServers: [{ name: "fixture-http", ...http }],
          });
          expect(await lab.receipt(key)).toMatchObject({
            host: key,
            inventory: ["fixture-http"],
            stdioExited: false,
          });
          expect(await lab.counts()).toEqual({
            downloads: 0,
            facadeCalls: 0,
            httpCalls: 1,
          });
          expect(
            (
              await pool.query(
                "SELECT id FROM execution_commands WHERE kind='mcp.prepare' AND run_id=$1",
                [runId],
              )
            ).rows,
          ).toHaveLength(0);
          await client.deleteSession(httpOnly.hostSessionId);
        }
        await run("online");
        if (index === 0) {
          await lab.setOnline(false);
          await run("offline");
          await lab.stop(key);
          await expect(
            tlsFetch(url + "/health", {
              dispatcher,
              signal: AbortSignal.timeout(1000),
            }),
          ).rejects.toThrow();
          await lab.setOnline(true);
        } else {
          const refused = await tlsFetch(url + "/mcp/prepare", {
            dispatcher,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              command: {
                id: randomUUID(),
                kind: "mcp.prepare",
                issuedAt: new Date().toISOString(),
              },
              fence: {
                hostKey: key,
                runId,
                assignmentId: randomUUID(),
                assignmentEpoch: 1,
              },
              payload: { ...lab.descriptor, refId: "stale" },
            }),
          });

          expect(refused.status).toBe(409);
          expect(await refused.json()).toMatchObject({ code: "FENCED" });
        }
      }
      expect(await lab.counts()).toEqual({
        downloads: 2,
        httpCalls: 4,
        facadeCalls: 3,
      });
    });
  } finally {
    await stopRuntimeEventConsumers();
    vi.unstubAllEnvs();
    await database.stop();
  }
}, 300_000);
