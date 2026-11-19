import type { VaultAccess } from "../store";

import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";

import { parseAgentMemoryMutation } from "../commands";
import { runMemoryIndexSweep } from "../embedding-sweep";
import { agentMemoryVaultLimits } from "../limits";
import { searchMemory } from "../search";
import { applyVaultMutation } from "../store";

import { seedProject } from "@/test-support/execution-host-seed";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { platformAcpRunners } from "@/lib/db/schema";

it("AV-09 reads the active vector generation, fences an in-flight stale head, and bounds a failing job", async () => {
  const fixture = await startMainAndBrainPostgresTestDb({
    databaseName: "memory_vectors",
  });
  let onEmbed: (text: string) => Promise<void> = async () => {};
  const server = createServer(async (request, response) => {
    const received: Buffer[] = [];

    for await (const chunk of request) received.push(Buffer.from(chunk));
    const { input } = JSON.parse(Buffer.concat(received).toString()) as {
      input: string[];
    };

    await onEmbed(input[0]!);
    if (input[0] === "fail") {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        data: [
          { index: 0, embedding: input[0] === "zero" ? [0, 0, 0] : [1, 0, 0] },
        ],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP embedding fixture");
  vi.stubEnv("MAISTER_AGENT_MEMORY_VECTOR_ENABLED", "1");

  try {
    const projectId = await seedProject(fixture.db);
    const { rows } = await fixture.pool.query<{ id: string }>(
      "INSERT INTO agent_memory_vaults(project_id,agent_id) VALUES ($1,'fixture:vector') RETURNING id",
      [projectId],
    );
    const access: VaultAccess = {
      vaultId: rows[0]!.id,
      principalKey: "user:actor",
      actor: { kind: "human", userId: "actor" },
      sourceProjectIds: [projectId],
      sourceRestrictions: [],
      writeAdmission: "apply",
      canRead: async () => true,
      capture: async () => {},
    };
    const prepare = async () => access;
    const path = "/memories/index.md";
    async function apply(input: Record<string, unknown>) {
      const result = await applyVaultMutation(
        fixture.db,
        parseAgentMemoryMutation(input),
        prepare,
        agentMemoryVaultLimits(),
      );
      if (result.status !== "applied")
        throw new Error("Expected applied fixture write");

      return result.affected[0]!;
    }
    const head = await apply({
      command: "create",
      path,
      file_text: "lattice",
      ifRevisionId: null,
      ifHash: null,
      requestKey: "vector-create",
    });

    const runner = testPlatformRunnerRow("vector-runner", "claude");

    await fixture.db.insert(platformAcpRunners).values(runner);
    await fixture.pool.query(
      `INSERT INTO platform_runtime_settings (id,embedding_base_url,embedding_model,embedding_dimensions,default_runner_id)
      VALUES ('singleton',$1,'model-1',3,$2) ON CONFLICT (id) DO UPDATE SET
      embedding_base_url=excluded.embedding_base_url,embedding_model=excluded.embedding_model,embedding_dimensions=excluded.embedding_dimensions`,
      [`http://127.0.0.1:${address.port}`, runner.id],
    );
    expect(await runMemoryIndexSweep(fixture.db)).toMatchObject({
      embedded: 1,
      failed: 0,
    });
    const query = { q: "unrelated", mode: "vector" as const, limit: 20 };

    expect(await searchMemory(fixture.db, query, prepare)).toMatchObject({
      hits: [{ revisionId: head.revisionId }],
    });
    await expect(
      searchMemory(fixture.db, { ...query, q: "zero" }, prepare),
    ).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
    await fixture.pool.query(
      "UPDATE platform_runtime_settings SET embedding_model='model-2'",
    );
    expect(await searchMemory(fixture.db, query, prepare)).toEqual({
      hits: [],
      nextCursor: null,
    });

    onEmbed = async (text) => {
      if (text === "lattice")
        await apply({
          command: "delete",
          path,
          ifHash: head.hash,
          ifRevisionId: head.revisionId,
          requestKey: "delete-in-flight",
        });
    };
    expect(await runMemoryIndexSweep(fixture.db)).toMatchObject({
      embedded: 0,
      failed: 0,
    });
    expect(await searchMemory(fixture.db, query, prepare)).toEqual({
      hits: [],
      nextCursor: null,
    });

    const failing = await apply({
      command: "create",
      path,
      file_text: "fail",
      ifRevisionId: null,
      ifHash: null,
      requestKey: "vector-fails",
    });
    expect(await runMemoryIndexSweep(fixture.db)).toMatchObject({
      embedded: 0,
      failed: 1,
    });
    await fixture.pool.query(
      `UPDATE agent_memory_embeddings SET attempts=4,next_attempt_at=now()
      WHERE revision_id=$1`,
      [failing.revisionId],
    );
    expect(await runMemoryIndexSweep(fixture.db)).toMatchObject({
      embedded: 0,
      failed: 1,
    });
    expect(await runMemoryIndexSweep(fixture.db)).toMatchObject({
      embedded: 0,
      failed: 0,
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT state, attempts FROM agent_memory_embeddings WHERE revision_id=$1",
          [failing.revisionId],
        )
      ).rows,
    ).toEqual([{ state: "poisoned", attempts: 5 }]);
  } finally {
    server.close();
    vi.unstubAllEnvs();
    await fixture.stop();
  }
}, 180_000);
