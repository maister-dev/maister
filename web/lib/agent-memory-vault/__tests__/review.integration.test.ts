import type { VaultAccess } from "../store";

import { expect, it } from "vitest";

import { parseAgentMemoryMutation } from "../commands";
import { agentMemoryVaultLimits } from "../limits";
import { redactMemoryRevision } from "../redaction";
import { decideVaultProposal } from "../review";
import { applyVaultMutation } from "../store";

import { seedProject } from "@/test-support/execution-host-seed";
import { seedActiveUser } from "@/test-support/librarian-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

it("AV-04 holds external input as one pending proposal across retries and a later policy change", async () => {
  const fixture = await startMainPostgresTestDb({
    databaseName: "vault_reviews",
  });

  try {
    const projectId = await seedProject(fixture.db);
    const admin = await seedActiveUser(fixture.db, { role: "admin" });
    const member = await seedActiveUser(fixture.db, { role: "member" });

    await fixture.pool.query(
      "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
    );
    await fixture.pool
      .query(`INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
      VALUES ('fixture:review','fixture','v1','git','Reviewer','Fixture','none','session','[]','read_only','/unused/reviewer.md')`);
    await fixture.pool.query(
      `INSERT INTO agent_project_links(id,project_id,agent_id,memory_enabled)
      VALUES (gen_random_uuid()::text,$1,'fixture:review',true)`,
      [projectId],
    );
    const { rows } = await fixture.pool.query<{ id: string }>(
      "INSERT INTO agent_memory_vaults(project_id,agent_id) VALUES ($1,'fixture:review') RETURNING id",
      [projectId],
    );
    const access: VaultAccess = {
      vaultId: rows[0]!.id,
      principalKey: "agent:run:node",
      actor: {
        kind: "agent_session",
        agentId: "fixture:review",
        sessionKey: "node",
        runId: "run",
        nodeAttemptId: null,
      },
      sourceProjectIds: [projectId],
      sourceRestrictions: [],
      writeAdmission: "review_required",
      canRead: async () => true,
      capture: async () => {},
    };
    const command = parseAgentMemoryMutation({
      command: "create",
      path: "/memories/index.md",
      file_text: "External candidate",
      ifRevisionId: null,
      ifHash: null,
      requestKey: "external-candidate",
    });
    const limits = agentMemoryVaultLimits();
    const [first, second] = await Promise.all([
      applyVaultMutation(fixture.db, command, async () => access, limits),
      applyVaultMutation(fixture.db, command, async () => access, limits),
    ]);

    expect(first).toMatchObject({
      status: "pending",
      operationId: expect.any(String),
      proposalId: expect.any(String),
    });
    expect(second).toEqual(first);
    expect(
      await applyVaultMutation(
        fixture.db,
        command,
        async () => ({ ...access, writeAdmission: "apply" }),
        limits,
      ),
    ).toEqual(first);
    expect(
      (
        await fixture.pool.query(
          "SELECT id FROM agent_memory_notes WHERE vault_id=$1",
          [access.vaultId],
        )
      ).rows,
    ).toEqual([]);
    await expect(
      applyVaultMutation(
        fixture.db,
        { ...command, file_text: "Changed payload" } as typeof command,
        async () => access,
        limits,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    if (first.status !== "pending")
      throw new Error("Expected a pending vault proposal");
    const decision = {
      userId: admin,
      proposalId: first.proposalId,
      decision: "accept" as const,
      expectedVersion: 1,
      requestKey: "review-accept",
    };
    const results = await Promise.all([
      decideVaultProposal(fixture.db, decision),
      decideVaultProposal(fixture.db, decision),
    ]);

    expect(results[0]).toMatchObject({
      state: "accepted",
      version: 2,
      operationId: expect.any(String),
    });
    expect(results[0]).toEqual(results[1]);
    await expect(
      decideVaultProposal(fixture.db, { ...decision, decision: "reject" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const { rows: heads } = await fixture.pool.query<{
      id: string;
      content_sha256: string;
      author: { runId: string };
    }>(
      `SELECT r.id,r.content_sha256,r.author FROM agent_memory_notes n
      JOIN agent_memory_revisions r ON (r.vault_id,r.note_id,r.id)=(n.vault_id,n.id,n.head_revision_id) WHERE n.vault_id=$1`,
      [access.vaultId],
    );
    const head = heads[0]!;

    expect(head.author.runId).toEqual("run");
    const followup = await applyVaultMutation(
      fixture.db,
      parseAgentMemoryMutation({
        command: "str_replace",
        path: "/memories/index.md",
        old_str: "candidate",
        new_str: "proposal",
        requestKey: "external-followup",
        ifHash: head.content_sha256,
        ifRevisionId: head.id,
      }),
      async () => access,
      limits,
    );

    if (followup.status !== "pending")
      throw new Error("Expected a dependent proposal");
    const redact = {
      reason: "Remove withdrawn source",
      requestKey: "review-redaction",
    };

    await expect(
      redactMemoryRevision(fixture.db, member, head.id, redact),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const removed = await redactMemoryRevision(
      fixture.db,
      admin,
      head.id,
      redact,
    );

    expect(
      await redactMemoryRevision(fixture.db, admin, head.id, redact),
    ).toEqual(removed);
    expect(
      (
        await fixture.pool.query(
          "SELECT 1 FROM agent_memory_revision_payloads WHERE revision_id=$1",
          [head.id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await fixture.pool.query(
          "SELECT 1 FROM agent_memory_proposal_payloads WHERE proposal_id IN ($1,$2)",
          [first.proposalId, followup.proposalId],
        )
      ).rows,
    ).toEqual([]);
    await expect(
      decideVaultProposal(fixture.db, {
        ...decision,
        proposalId: followup.proposalId,
      }),
    ).rejects.toMatchObject({
      details: { reason: "agent_memory_unavailable" },
    });
  } finally {
    await fixture.stop();
  }
}, 180_000);
