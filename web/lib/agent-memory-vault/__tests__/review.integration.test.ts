import type { VaultAccess } from "../store";

import { expect, it } from "vitest";

import { parseAgentMemoryMutation } from "../commands";
import { agentMemoryVaultLimits } from "../limits";
import { prepareHumanProjectVault } from "../project-access";
import { redactMemoryRevision } from "../redaction";
import { decideVaultProposal } from "../review";
import { applyVaultMutation } from "../store";

import { poll } from "@/test-support/durable-workers-ledger";
import {
  seedProject,
  seedProjectRow,
} from "@/test-support/execution-host-seed";
import { holdDatabaseWrite } from "@/test-support/fault-barriers";
import { seedActiveUser } from "@/test-support/librarian-seed";
import {
  startMainAndBrainPostgresTestDb,
  startMainPostgresTestDb,
} from "@/test-support/pg-container";
import {
  decideProposalReviewBatch,
  getProposalReviewDetail,
} from "@/lib/queries/inbox-review-actions";

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
      kind: "vault" as const,
      id: first.proposalId,
      decision: "accept" as const,
      expectedVersion: "1",
      requestKey: "review-accept",
      reason: "Reviewed using the exact note",
    };
    const secondReviewer = await seedActiveUser(fixture.db, { role: "admin" });
    const decide = (userId: string, input: typeof decision) =>
      decideProposalReviewBatch(fixture.db, userId, [input]).then(
        ({ results }) => results[0],
      );
    const otherDecision = { ...decision, requestKey: "other-reviewer" };
    const competing = await Promise.all([
      decide(admin, decision),
      decide(secondReviewer, otherDecision),
    ]);

    expect(competing.map((result) => result?.status).sort()).toEqual([
      "applied",
      "conflict",
    ]);
    const winner = competing[0]?.status === "applied" ? admin : secondReviewer;
    const accepted = competing.find((result) => result?.status === "applied");
    const winningDecision = winner === admin ? decision : otherDecision;
    const replay = await decide(winner, winningDecision);

    expect(replay).toMatchObject({
      receiptId: accepted?.receiptId,
      replayed: true,
      domainState: "accepted",
      outcome: {
        type: "applied_vault_operation",
        operationId: expect.any(String),
        revisionCount: 1,
        revisions: [
          {
            revisionId: expect.any(String),
            path: "/memories/index.md",
            href: expect.stringContaining("memoryRevision="),
          },
        ],
      },
    });
    expect(
      await decide(winner, {
        ...winningDecision,
        reason: "Changed decision reason",
      }),
    ).toMatchObject({ status: "conflict", receiptId: null });
    expect(
      (
        await fixture.pool.query(
          "SELECT review.decision_reason, review.reviewer_id, count(receipt.id)::int AS committed FROM agent_memory_proposals review JOIN inbox_review_receipts receipt ON receipt.user_id=review.reviewer_id AND receipt.request_key=review.decision_key WHERE review.id=$1 GROUP BY review.id",
          [first.proposalId],
        )
      ).rows,
    ).toEqual([
      { decision_reason: decision.reason, reviewer_id: winner, committed: 1 },
    ]);
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
    const another = await applyVaultMutation(
      fixture.db,
      parseAgentMemoryMutation({
        command: "create",
        path: "/memories/reject.md",
        file_text: "Unreviewed note",
        ifHash: null,
        ifRevisionId: null,
        requestKey: "external-reject",
      }),
      async () => access,
      limits,
    );

    if (another.status !== "pending")
      throw new Error("Expected a proposal pending rejection");
    const rejection = {
      kind: "vault" as const,
      id: another.proposalId,
      decision: "reject" as const,
      expectedVersion: "1",
      requestKey: "rollback-review",
      reason: "Unnecessary secondary note",
    };

    await fixture.pool.query(
      "ALTER TABLE inbox_review_receipts ADD CONSTRAINT fixture_reject_receipt CHECK (request_key <> 'rollback-review')",
    );
    const refused = await decideProposalReviewBatch(fixture.db, admin, [
      rejection,
    ]);

    expect(refused.results).toEqual([
      { status: "refused", replayed: false, receiptId: null },
    ]);
    const inspectRejected = () =>
      fixture.pool.query(
        "SELECT state,version,decision_reason,reviewer_id FROM agent_memory_proposals WHERE id=$1",
        [another.proposalId],
      );

    expect((await inspectRejected()).rows).toEqual([
      {
        state: "pending",
        version: 1,
        decision_reason: null,
        reviewer_id: null,
      },
    ]);
    await fixture.pool.query(
      "ALTER TABLE inbox_review_receipts DROP CONSTRAINT fixture_reject_receipt",
    );
    expect(
      (await decideProposalReviewBatch(fixture.db, admin, [rejection]))
        .results[0],
    ).toMatchObject({
      status: "rejected",
      receiptId: expect.any(String),
      outcome: { type: "rejected", proposalId: another.proposalId },
    });
    expect((await inspectRejected()).rows).toEqual([
      {
        state: "rejected",
        version: 2,
        decision_reason: rejection.reason,
        reviewer_id: admin,
      },
    ]);
    expect(
      (
        await fixture.pool.query(
          "SELECT id FROM agent_memory_notes WHERE vault_id=$1 AND path='/memories/reject.md'",
          [access.vaultId],
        )
      ).rows,
    ).toEqual([]);
    const parallel = await applyVaultMutation(
      fixture.db,
      parseAgentMemoryMutation({
        command: "create",
        path: "/memories/competing.md",
        file_text: "Reviewers may disagree.",
        ifHash: null,
        ifRevisionId: null,
        requestKey: "parallel-opposite",
      }),
      async () => access,
      limits,
    );

    if (parallel.status !== "pending")
      throw new Error("Expected a proposal for independent decisions");
    const [approval, refusal] = await Promise.all([
      decideProposalReviewBatch(fixture.db, admin, [
        {
          ...decision,
          id: parallel.proposalId,
          requestKey: "parallel-approval",
        },
      ]),
      decideProposalReviewBatch(fixture.db, secondReviewer, [
        {
          ...rejection,
          id: parallel.proposalId,
          requestKey: "parallel-refusal",
        },
      ]),
    ]);
    const outcomes = [approval.results[0]!, refusal.results[0]!];
    const terminal = outcomes.find(({ receiptId }) => receiptId !== null);

    expect(outcomes.filter(({ status }) => status === "conflict")).toHaveLength(
      1,
    );
    expect(terminal?.domainState).toMatch(/^(accepted|rejected)$/);
    expect(
      (
        await fixture.pool.query(
          "SELECT state,version,(applied_operation_id IS NOT NULL) AS applied FROM agent_memory_proposals WHERE id=$1",
          [parallel.proposalId],
        )
      ).rows,
    ).toEqual([
      {
        state: terminal?.domainState,
        version: 2,
        applied: terminal?.domainState === "accepted",
      },
    ]);

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
        proposalId: followup.proposalId,
        userId: winner,
        expectedVersion: 1,
        requestKey: "followup-review",
        decision: "accept",
      }),
    ).rejects.toMatchObject({
      details: { reason: "agent_memory_unavailable" },
    });
  } finally {
    await fixture.stop();
  }
}, 180_000);

it("K04 K10 conceals settled history when source redaction wins the concurrent read", async () => {
  const fixture = await startMainAndBrainPostgresTestDb({
    databaseName: "vault_history_redaction",
  });

  try {
    const project = await seedProjectRow(fixture.db);
    const admin = await seedActiveUser(fixture.db, { role: "admin" });
    const agentId = "fixture:review-redaction";
    const limits = agentMemoryVaultLimits();

    await fixture.pool.query(
      "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
    );
    await fixture.pool.query(
      `INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
       VALUES ($1,'fixture','v1','git','Reviewer','Fixture','none','session','[]','read_only','/unused/reviewer.md')`,
      [agentId],
    );
    await fixture.pool.query(
      `INSERT INTO agent_project_links(id,project_id,agent_id,memory_enabled)
       VALUES (gen_random_uuid()::text,$1,$2,true)`,
      [project.id, agentId],
    );
    const prepare = prepareHumanProjectVault({
      userId: admin,
      slug: project.slug,
      agentId,
      action: "editSettings",
    });
    const source = await applyVaultMutation(
      fixture.db,
      {
        command: "create",
        path: "/memories/source.md",
        file_text: "Withdrawn source",
        ifRevisionId: null,
        ifHash: null,
        requestKey: "redaction-source",
      },
      prepare,
      limits,
    );

    if (source.status !== "applied" || !source.affected[0]?.hash)
      throw new Error("Expected a retained source revision");
    const { revisionId, noteId, hash } = source.affected[0];
    const pending = await applyVaultMutation(
      fixture.db,
      {
        command: "create",
        path: "/memories/proposed.md",
        file_text: "Derived proposal",
        ifRevisionId: null,
        ifHash: null,
        requestKey: "redaction-dependent",
      },
      async (tx) => {
        const access = await prepare(tx);

        return {
          ...access,
          writeAdmission: "review_required",
          sourceRestrictions: [
            {
              kind: "agent_vault_revision_v1",
              vaultId: access.vaultId,
              noteId,
              revisionId,
              contentSha256: hash,
            },
          ],
        };
      },
      limits,
    );

    if (pending.status !== "pending")
      throw new Error("Expected a pending review");
    await decideVaultProposal(fixture.db, {
      userId: admin,
      proposalId: pending.proposalId,
      decision: "reject",
      expectedVersion: 1,
      requestKey: "redaction-retained-review",
      reason: "Retained rationale based on the source",
    });
    const readHistory = () =>
      getProposalReviewDetail(fixture.db, admin, {
        kind: "vault",
        id: pending.proposalId,
      });

    await expect(readHistory()).resolves.toMatchObject({
      domainState: "rejected",
      decision: { reason: "Retained rationale based on the source" },
    });
    const barrier = await holdDatabaseWrite({
      pool: fixture.pool,
      caseId: "vault-history-redaction",
      table: "agent_memory_proposals",
      matches: { id: pending.proposalId },
    });
    const redaction = Promise.allSettled([
      redactMemoryRevision(fixture.db, admin, revisionId, {
        reason: "Withdraw concurrent history source",
        requestKey: "redaction-concurrent-review",
      }),
    ]);

    try {
      const writerPid = await barrier.awaitReached();
      const history = Promise.allSettled([readHistory()]);

      await poll(
        async () => {
          const { rows } = await fixture.pool.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))",
            [writerPid],
          );

          return rows[0]?.pid;
        },
        10_000,
        "history transaction waiting for redaction",
        25,
      );
      await barrier.release();

      const [[withdrawn], [read]] = await Promise.all([redaction, history]);

      expect(withdrawn).toMatchObject({
        status: "fulfilled",
        value: { revisionId },
      });
      expect(read).toMatchObject({
        status: "rejected",
        reason: { details: { reason: "agent_memory_unavailable" } },
      });
      await expect(readHistory()).rejects.toMatchObject({
        details: { reason: "agent_memory_unavailable" },
      });
    } finally {
      await barrier.close();
    }
  } finally {
    await fixture.stop();
  }
}, 180_000);
