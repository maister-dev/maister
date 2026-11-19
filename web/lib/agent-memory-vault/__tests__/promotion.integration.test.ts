import { expect, it } from "vitest";

import { parseAgentMemoryMutation } from "../commands";
import { agentMemoryVaultLimits } from "../limits";
import { prepareHumanProjectVault } from "../project-access";
import { parseMemoryPromotion, promoteMemory } from "../promotion";
import { redactMemoryRevision } from "../redaction";
import { applyVaultMutation } from "../store";

import { reviewKnowledgeProposal } from "@/lib/brain/knowledge-proposals";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { getKnowledgeWitness } from "@/lib/brain/knowledge-witnesses";
import { concludeBrainProposal } from "@/lib/brain/proposals";
import {
  decideProposalReviewBatch,
  getProposalReviewDetail,
} from "@/lib/queries/inbox-review-actions";
import {
  listProposalReviews,
  readProposalReviewCounter,
} from "@/lib/queries/knowledge-memory-reviews";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { seedActiveUser } from "@/test-support/librarian-seed";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

it("AV-16 promotes an exact vault revision, requires review, and revokes derived reads on redaction", async () => {
  const db = await startMainAndBrainPostgresTestDb({
    databaseName: "memory_promotion",
  });

  try {
    const project = await seedProjectRow(db.db);
    const admin = await seedActiveUser(db.db, { role: "admin" });
    const principal = { kind: "user" as const, userId: admin };
    const agentId = "fixture:evidence";
    const path = "/memories/index.md";
    const prepare = prepareHumanProjectVault({
      userId: admin,
      slug: project.slug,
      agentId,
      action: "editSettings",
    });

    await db.pool.query(
      "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
    );
    await db.pool.query("UPDATE projects SET brain_enabled=true WHERE id=$1", [
      project.id,
    ]);
    await db.pool.query(
      `INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
      VALUES ($1,'fixture','v1','git','Evidence author','Fixture','none','session','[]','read_only','/unused/evidence.md')`,
      [agentId],
    );
    await db.pool.query(
      `INSERT INTO agent_project_links(id,project_id,agent_id,memory_enabled)
      VALUES (gen_random_uuid()::text,$1,$2,true)`,
      [project.id, agentId],
    );
    const saved = await applyVaultMutation(
      db.db,
      parseAgentMemoryMutation({
        command: "create",
        path,
        file_text: "Restricted witness",
        ifHash: null,
        ifRevisionId: null,
        requestKey: "promote-source",
      }),
      prepare,
      agentMemoryVaultLimits(),
    );
    if (saved.status !== "applied")
      throw new Error("Expected project vault source to apply");
    const note = saved.affected[0]!;
    const input = {
      path,
      ifRevisionId: note.revisionId,
      ifHash: note.hash,
      requestKey: "promote-brain",
      target: { kind: "brain", ownerKind: "project", ownerId: project.id },
    };
    const brain = await promoteMemory(
      db.db,
      principal,
      parseMemoryPromotion(input),
      prepare,
    );
    expect(
      await promoteMemory(
        db.db,
        principal,
        parseMemoryPromotion(input),
        prepare,
      ),
    ).toEqual(brain);
    const structured = await promoteMemory(
      db.db,
      principal,
      parseMemoryPromotion({
        ...input,
        requestKey: "promote-knowledge",
        target: { ...input.target, kind: "knowledge" },
      }),
      prepare,
    );

    const initial = await db.pool.query<{ status: string; origin: string }>(
      `SELECT status,autonomy_decision AS origin FROM brain_proposals
      WHERE id IN ($1,$2) ORDER BY id`,
      [brain.proposalId, structured.proposalId],
    );

    expect(initial.rows.map(({ status }) => status)).toEqual([
      "pending",
      "pending",
    ]);
    const pending = await applyVaultMutation(
      db.db,
      parseAgentMemoryMutation({
        command: "create",
        path: "/memories/notes/proposed.md",
        file_text: "Pending vault assertion",
        ifRevisionId: null,
        ifHash: null,
        requestKey: "promote-pending",
      }),
      async (tx) => ({
        ...(await prepare(tx)),
        writeAdmission: "review_required",
      }),
      agentMemoryVaultLimits(),
    );
    if (pending.status !== "pending")
      throw new Error("Expected a vault review proposal");
    const reviewPage = await listProposalReviews(db.db, admin, { limit: 20 });
    const reviewCounter = await readProposalReviewCounter(db.db, admin);

    expect(new Set(reviewPage.items.map(({ kind }) => kind))).toEqual(
      new Set(["vault", "brain", "knowledge"]),
    );
    expect(reviewCounter.reviews).toBe(3);
    expect(
      (
        await getProposalReviewDetail(db.db, admin, {
          kind: "vault",
          id: pending.proposalId,
        })
      ).summary,
    ).toContain("+Pending vault assertion");
    const vaultDecision = {
      kind: "vault",
      id: pending.proposalId,
      expectedVersion: "1",
      decision: "accept",
      requestKey: "inbox-vault-decision",
    } as const;
    const batch = await decideProposalReviewBatch(db.db, admin, [
      vaultDecision,
      { ...vaultDecision, id: "missing-proposal", requestKey: "inbox-missing" },
    ]);
    expect(batch.results).toMatchObject([
      { status: "applied", replayed: false },
      { status: "unavailable", receiptId: null },
    ]);
    expect(
      (await decideProposalReviewBatch(db.db, admin, [vaultDecision]))
        .results[0],
    ).toMatchObject({
      status: "applied",
      replayed: true,
      receiptId: batch.results[0]?.receiptId,
    });
    expect((await readProposalReviewCounter(db.db, admin)).reviews).toBe(2);
    const witness = (
      await db.pool.query<{ id: string }>(
        "SELECT id FROM brain_evidence_witnesses WHERE selector='vault:revision'",
      )
    ).rows[0]!;

    expect(
      await getKnowledgeWitness(db.db, principal, witness.id),
    ).toMatchObject({ excerpt: "Restricted witness" });
    const decision = await reviewKnowledgeProposal(db.db, {
      proposalId: structured.proposalId,
      principal,
      expectedRevision: 1,
      decision: "accept",
      reason: "Read exact witness",
      idempotencyKey: "promote-accept",
    });

    expect(decision.acceptedRecordId).toEqual(expect.any(String));
    const selector = { recordId: decision.acceptedRecordId! };

    expect(await getKnowledgeRecord(db.db, principal, selector)).toMatchObject({
      assertion: "Restricted witness",
    });
    await redactMemoryRevision(db.db, admin, note.revisionId, {
      reason: "Withdraw source",
      requestKey: "promote-redact",
    });
    await expect(
      getKnowledgeRecord(db.db, principal, selector),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    await expect(
      getKnowledgeWitness(db.db, principal, witness.id),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    await expect(
      concludeBrainProposal(db.db, {
        projectId: project.id,
        projectSlug: project.slug,
        proposalId: brain.proposalId,
        action: "accept",
        actor: { type: "user", id: admin },
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  } finally {
    await db.stop();
  }
}, 180_000);
