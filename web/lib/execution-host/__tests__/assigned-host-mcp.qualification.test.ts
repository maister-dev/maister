import type { Db } from "../db";
import type { ExecutionHost } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import pino from "pino";
import { expect, it, vi } from "vitest";

import { EXECUTION_HOST_KEY_HEADER } from "../../../../runtime/execution-host-address";
import { mintAssignment } from "../assignments";
import { createExecutionHosts } from "../client";
import { listCommandsForRun } from "../commands";
import {
  ensureAdditionalExecutionDataPlane,
  ensureLocalExecutionDataPlane,
} from "../event-plane";
import { stopRuntimeEventConsumers } from "../events/consumer";
import { projectExecutionEvents } from "../events/projector";
import { canonicalLifecycleProjector } from "../events/lifecycle-projector";
import { configuredAdditionalExecutionEndpoints } from "../selected-endpoint";
import {
  advanceAddressedWorkspaceAdmission,
  dispatchQueuedWorkspaceCommand,
} from "../workspace-dispatch";
import { reserveHostWorkspace } from "../workspace-preparation";

import { mcpTransportFromMaterial } from "@/lib/capabilities/agent-map";
import { closeDb } from "@/lib/db/client";
import { projects, workspaces } from "@/lib/db/schema";
import { mcpAdminForProject } from "@/lib/mcp/readiness-host";
import { tryStartRun } from "@/lib/scheduler";
import { withAssignedMcpHosts } from "@/test-support/assigned-mcp-containers";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

const logger = pino({ name: "assigned-mcp-qualification" });

it("E2E-HST-01 binds real ACP tool calls and preparation receipts to B then clean C with B stopped", async () => {
  const database = await startMainPostgresTestDb({
    databaseName: "mcp_relocation",
  });

  try {
    const { pool } = database;
    const db = database.db as unknown as Db;
    const hosts = createExecutionHosts({ db });
    const project = await seedProjectRow(database.db);

    vi.stubEnv("DB_URL", database.databaseUrl);

    await withAssignedMcpHosts(async (lab) => {
      for (const [index, key] of ["supervisor-b", "supervisor-c"].entries()) {
        const { url, publicReceipt } = await lab.start(key);
        let host: ExecutionHost;

        if (index === 0) {
          vi.stubEnv("MAISTER_SUPERVISOR_URL", url);
          vi.stubEnv("MAISTER_SELECTED_EXECUTION_HOST_KEY", key);
          const registration = await ensureLocalExecutionDataPlane({ db });

          if (registration.status !== "registered")
            throw new Error(
              "Qualification default supervisor failed registration",
            );
          host = registration.host;
        } else {
          vi.stubEnv(
            "MAISTER_ADDITIONAL_EXECUTION_HOSTS",
            JSON.stringify([
              { url, hostKey: key, displayName: "Independent C" },
            ]),
          );
          const registration = await ensureAdditionalExecutionDataPlane(
            configuredAdditionalExecutionEndpoints()[0],
            { db },
          );

          if (registration.status !== "registered")
            throw new Error(
              "Qualification peer supervisor failed registration",
            );
          host = registration.host;
          await db
            .update(projects)
            .set({ defaultExecutionHostId: host.id })
            .where(eq(projects.id, project.id));
          const projectAdmin = await mcpAdminForProject(project.id);

          await expect(
            projectAdmin.checkEnvRefs(["MAISTER_MCP_SECRET_HTTP"]),
          ).resolves.toEqual([
            { name: "MAISTER_MCP_SECRET_HTTP", present: true },
          ]);
        }

        const runId = await seedRun(database.db, {
          projectId: project.id,
          runKind: "flow",
          status: "Pending",
        });
        const assignment = await db.transaction(async (tx) => {
          const owner = await mintAssignment(tx, {
            runId,
            hostId: host.id,
            reason: "launch",
          });

          await reserveHostWorkspace(
            tx,
            { host, assignment: owner },
            {
              projectId: project.id,
              branch: key,
              baseBranch: "main",
              baseCommit: "0".repeat(40),
            },
            {
              mode: "directory",
              directoryProfileId: "qualification",
              inputDigest: "a".repeat(64),
            },
          );

          return owner;
        });
        const [prepare] = await listCommandsForRun(db, runId);

        await dispatchQueuedWorkspaceCommand(db, {
          runId,
          commandId: prepare.id,
        });
        await vi.waitFor(
          async () => {
            await projectExecutionEvents({
              db,
              projector: canonicalLifecycleProjector,
              runId,
            });
            await advanceAddressedWorkspaceAdmission(db, runId);
            const [workspace] = await db
              .select()
              .from(workspaces)
              .where(eq(workspaces.runId, runId));

            expect(workspace).toMatchObject({
              executionHostId: host.id,
              workspaceMaterializationGeneration: 1,
              worktreePath: null,
            });
          },
          { timeout: 20_000 },
        );
        await expect(tryStartRun(runId, { db })).resolves.toMatchObject({
          started: true,
        });

        expect(assignment.epoch).toBe(1);
        const { client, admin } = await hosts.executionFor(runId);

        expect(client.host.hostKey).toBe(key);
        expect(client.assignment.id).toBe(assignment.id);
        if (publicReceipt) {
          expect(publicReceipt.httpStatus).toBe(200);
          expect(publicReceipt.responseBytes).toBeGreaterThan(0);
          logger.info(
            {
              executionHostId: client.host.id,
              assignmentId: assignment.id,
              assignmentEpoch: assignment.epoch,
              hostKey: key,
              publicReceipt,
            },
            "Public MCP probe belongs to this assigned supervisor container",
          );
        }
        const stdio = mcpTransportFromMaterial("fixture-stdio", {
          transport: "stdio",
          distribution: lab.descriptor,
        });
        const http = mcpTransportFromMaterial("fixture-http", {
          transport: "http",
          url: "https://qual-web/mcp",
          bearerTokenEnv: "env:MAISTER_MCP_SECRET_HTTP",
        });

        expect(await admin.probeMcp(http)).toMatchObject({
          ok: true,
          serverInfo: { name: "private-http" },
        });
        const launchSession = (
          payload: Parameters<typeof client.createSession>[0],
        ) =>
          client.createSession(payload).catch(async (error: unknown) => {
            const diagnostic = await lab.receipt(key);

            throw new Error(JSON.stringify(diagnostic), { cause: error });
          });
        const run = async (stepId: string) => {
          const session = await launchSession({
            stepId,
            executor: {
              agent: "claude",
              model: "claude-sonnet-4-6",
              env: { NODE_EXTRA_CA_CERTS: "/ca.pem" },
            },
            mcpServers: [
              { name: "fixture-stdio", ...stdio },
              { name: "fixture-http", ...http },
              {
                name: "maister",
                transport: "stdio",
                platformOrigin: "maister_facade",
                env: {
                  MAISTER_API_BASE_URL: "https://qual-web",
                  MAISTER_PROJECT_TOKEN: "mai_" + "q".repeat(43),
                },
              },
            ],
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
          const proof = await admin.getCommandReceipt(command.id);

          if (!proof)
            throw new Error(
              "Assigned supervisor has no MCP preparation receipt",
            );
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
          const httpOnly = await launchSession({
            stepId: "http-only",
            executor: {
              agent: "claude",
              model: "claude-sonnet-4-6",
              env: {
                NODE_EXTRA_CA_CERTS: "/ca.pem",
                QUALIFICATION_ONLY_HTTP: "1",
              },
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
            fetch(url + "/health", { signal: AbortSignal.timeout(1000) }),
          ).rejects.toThrow();
          await lab.setOnline(true);
        } else {
          const refused = await fetch(url + "/mcp/prepare", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [EXECUTION_HOST_KEY_HEADER]: key,
            },
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
          expect(await refused.json()).toMatchObject({
            code: "PRECONDITION",
            details: {
              reason: "assignment_mismatch",
              runId,
              commandEpoch: assignment.epoch,
              hostEpoch: assignment.epoch,
            },
          });
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
    await closeDb();
    vi.unstubAllEnvs();
    await database.stop();
  }
}, 300_000);
