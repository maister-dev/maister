import "server-only";

import type { VaultRevisionRestriction } from "@/lib/company/types";
import type { Db } from "@/lib/execution-host/db";
import type { VaultRevision } from "./store";

import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { currentVaultNodeAttempt } from "./node-attempt";
import { lockVaultCutover } from "./cutover";
import { agentMemoryVaultLimits } from "./limits";
import { MEMORY_INDEX } from "./paths";
import { ensureProjectVault } from "./project-access";
import {
  MEMORY_PROTOCOL_HASH,
  MEMORY_PROTOCOL_VERSION,
  renderFrozenMemoryProtocol,
  renderMemoryProtocol,
} from "./protocol";
import {
  loadActiveHeads,
  lockVault,
  readVaultPayload,
  readVaultRevision,
} from "./store";

import {
  recordNativeRunSourcesInTransaction,
  resolveRunKnowledgePrincipal,
  usesNativeKnowledgeTransport,
} from "@/lib/brain/knowledge-execution-access";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import {
  agentMemoryInjections as injections,
  agentMemoryVaults,
  agentProjectLinks,
  runs,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-memory-injection",
  level: process.env.LOG_LEVEL ?? "info",
});

type MemoryInjection = typeof injections.$inferSelect;
type ProjectSession = Readonly<{
  runId: string;
  projectId: string;
  agentId: string;
  sessionKey: string;
}>;

type StageResult =
  | Readonly<{ mode: "legacy" }>
  | Readonly<{ mode: "vault"; text: string | null }>;

function digest(value: unknown) {
  return createHash("sha256").update(canonicalCommandJson(value)).digest("hex");
}

async function enabledAttachment(db: Db, projectId: string, agentId: string) {
  const [link] = await db
    .select({
      enabled: agentProjectLinks.enabled,
      memoryEnabled: agentProjectLinks.memoryEnabled,
      policy: agentProjectLinks.memoryWritePolicy,
    })
    .from(agentProjectLinks)
    .where(
      and(
        eq(agentProjectLinks.projectId, projectId),
        eq(agentProjectLinks.agentId, agentId),
      ),
    )
    .for("share");

  return link?.enabled === true && link.memoryEnabled ? link : null;
}

function revisionReference(revision: VaultRevision): VaultRevisionRestriction {
  if (revision.contentSha256 === null)
    throw new MaisterError("CRASH", "Memory head has no content hash");

  return {
    kind: "agent_vault_revision_v1",
    vaultId: revision.vaultId,
    noteId: revision.noteId,
    revisionId: revision.id,
    contentSha256: revision.contentSha256,
  };
}

async function authorizeStagedReferences(
  db: Db,
  runId: string,
  staged: MemoryInjection,
) {
  const native = await usesNativeKnowledgeTransport(db, runId);
  const references = staged.tree.references ?? [];

  if (native) {
    const principal = await resolveRunKnowledgePrincipal(
      db,
      runId,
      staged.nodeAttemptId ?? undefined,
    );

    await authorizeSourceRestrictions(db, principal, references);

    return;
  }

  for (const source of references) {
    const revision = await readVaultRevision(
      db,
      source.vaultId,
      source.noteId,
      source.revisionId,
    );

    if (revision.contentSha256 !== source.contentSha256)
      throw new MaisterError("PRECONDITION", "Staged memory source changed");
    // Exact historical payloads can disappear only through audited redaction.
    await db
      .execute(
        sql`
      SELECT 1 FROM agent_memory_revision_payloads
      WHERE (vault_id,note_id,revision_id) = (${source.vaultId},${source.noteId},${source.revisionId})
      FOR SHARE
    `,
      )
      .then(({ rows }) => {
        if (rows.length === 0)
          throw new MaisterError(
            "PRECONDITION",
            "Staged memory source is unavailable",
          );
      });
  }
}

async function restoreStaged(db: Db, staged: MemoryInjection): Promise<string> {
  if (
    staged.protocolVersion !== MEMORY_PROTOCOL_VERSION ||
    staged.protocolSha256 !== MEMORY_PROTOCOL_HASH ||
    staged.applicationState === "retired"
  )
    throw new MaisterError(
      "PRECONDITION",
      "Stored memory prompt protocol is unavailable",
    );
  await authorizeStagedReferences(db, staged.runId, staged);
  const index =
    staged.indexNoteId && staged.indexRevisionId
      ? await readVaultPayload(
          db,
          await readVaultRevision(
            db,
            staged.vaultId,
            staged.indexNoteId,
            staged.indexRevisionId,
          ),
        )
      : null;
  const text = renderFrozenMemoryProtocol(index, staged.tree);

  if (text.length !== staged.renderedChars)
    throw new MaisterError(
      "PRECONDITION",
      "Stored memory prompt rendering changed",
    );

  return text;
}

export async function stageProjectAgentMemory(
  db: Db,
  session: ProjectSession,
  resuming: boolean,
): Promise<StageResult> {
  return db.transaction(async (tx) => {
    if ((await lockVaultCutover(tx)) === null) return { mode: "legacy" };
    const [run] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.id, session.runId),
          eq(runs.projectId, session.projectId),
          eq(runs.agentId, session.agentId),
          eq(runs.runKind, "agent"),
          eq(runs.executionAssignmentId, session.sessionKey),
        ),
      )
      .for("no key update");

    if (!run)
      throw new MaisterError(
        "PRECONDITION",
        "Current run does not own the project memory session",
      );
    if (resuming) {
      await assertMemorySessionSources(tx, session.runId);

      return { mode: "vault", text: null };
    }

    return stageFreshProjectSession(tx, session, null);
  });
}

export async function stageProjectFlowMemory(
  db: Db,
  session: Readonly<{
    runId: string;
    agentId: string;
    nodeAttemptId: string;
    nodeId: string;
  }>,
): Promise<Readonly<{ text: string; projectId: string }> | null> {
  return db.transaction(async (tx) => {
    if ((await lockVaultCutover(tx)) === null) return null;
    const matching = await currentVaultNodeAttempt(
      tx,
      session.runId,
      session.nodeAttemptId,
    );

    if (!matching || matching.node_id !== session.nodeId)
      throw new MaisterError(
        "PRECONDITION",
        "Current Flow attempt does not own the memory session",
      );
    const staged = await stageFreshProjectSession(
      tx,
      {
        runId: session.runId,
        projectId: matching.project_id,
        agentId: session.agentId,
        sessionKey: session.nodeAttemptId,
      },
      session.nodeAttemptId,
    );

    return staged.text === null
      ? null
      : { text: staged.text, projectId: matching.project_id };
  });
}

async function stageFreshProjectSession(
  tx: Db,
  session: ProjectSession,
  nodeAttemptId: string | null,
): Promise<Extract<StageResult, { mode: "vault" }>> {
  const attachment = await enabledAttachment(
    tx,
    session.projectId,
    session.agentId,
  );

  if (!attachment) return { mode: "vault", text: null };
  const [existing] = await tx
    .select()
    .from(injections)
    .where(
      and(
        eq(injections.runId, session.runId),
        eq(injections.sessionKey, session.sessionKey),
      ),
    );

  const vaultId = await ensureProjectVault(
    tx,
    session.projectId,
    session.agentId,
  );

  if (existing) {
    if (
      existing.vaultId !== vaultId ||
      existing.nodeAttemptId !== nodeAttemptId
    )
      throw new MaisterError("CONFLICT", "Staged memory persona changed");

    return { mode: "vault", text: await restoreStaged(tx, existing) };
  }

  await lockVault(tx, vaultId);
  const limits = agentMemoryVaultLimits();
  const heads = (await loadActiveHeads(tx, vaultId)).map(
    ({ revision }) => revision,
  );
  const visible = heads.filter((head) =>
    head.sourceProjectIds.every((id) => id === session.projectId),
  );
  const indexHead = visible.find((head) => head.path === MEMORY_INDEX);
  const index = indexHead ? await readVaultPayload(tx, indexHead) : null;
  const byPath = new Map(visible.map((entry) => [entry.path, entry]));
  const paths = [...byPath.keys()].sort();
  const rendered = renderMemoryProtocol(index, paths, limits.injectionChars);
  const witnesses = new Set(
    rendered.tree.paths.map((path) => byPath.get(path)!),
  );

  if (indexHead) witnesses.add(indexHead);
  const references = Array.from(witnesses, revisionReference);
  const descriptor = {
    ...session,
    nodeAttemptId,
    vaultId,
    protocolVersion: MEMORY_PROTOCOL_VERSION,
    protocolSha256: MEMORY_PROTOCOL_HASH,
    tree: { ...rendered.tree, references },
    indexNoteId: indexHead?.noteId ?? null,
    indexRevisionId: indexHead?.id ?? null,
    renderedChars: rendered.text.length,
  };

  await recordNativeRunSourcesInTransaction(
    tx,
    session.runId,
    references,
    nodeAttemptId ?? undefined,
  );
  await tx.insert(injections).values({
    ...descriptor,
    descriptorDigest: digest(descriptor),
    requiresReviewAtLaunch: attachment.policy === "review",
  });
  log.debug(
    {
      runId: session.runId,
      sessionKey: session.sessionKey,
      protocolVersion: MEMORY_PROTOCOL_VERSION,
      renderedChars: rendered.text.length,
      paths: paths.length,
      injectedPaths: rendered.tree.paths.length,
    },
    "agent memory injection staged",
  );

  return { mode: "vault", text: rendered.text };
}

/** Revalidate retained disclosures before sending a saved prompt or resuming its context. */
export async function assertMemorySessionSources(
  db: Db,
  runId: string,
  sessionKey?: string,
): Promise<void> {
  const rows = await db
    .select({ injection: injections, owner: agentMemoryVaults })
    .from(injections)
    .innerJoin(agentMemoryVaults, eq(injections.vaultId, agentMemoryVaults.id))
    .where(
      and(
        eq(injections.runId, runId),
        sessionKey === undefined
          ? undefined
          : eq(injections.sessionKey, sessionKey),
        sql`${injections.applicationState} <> 'retired'`,
      ),
    );

  for (const { injection, owner } of rows) {
    if (
      owner.projectId === null ||
      !(await enabledAttachment(db, owner.projectId, owner.agentId))
    )
      throw new MaisterError(
        "PRECONDITION",
        "Memory session attachment is unavailable",
      );
    await authorizeStagedReferences(db, runId, injection);
  }
}

export async function settleMemoryInjection(
  db: Db,
  runId: string,
  sessionKey: string,
  applicationReceiptId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT id FROM runs WHERE id=${runId} FOR NO KEY UPDATE`,
  );
  const [changed] = await db
    .update(injections)
    .set({ applicationState: "applied", applicationReceiptId })
    .where(
      and(
        eq(injections.runId, runId),
        eq(injections.sessionKey, sessionKey),
        eq(injections.applicationState, "staged"),
      ),
    )
    .returning({ id: injections.id });

  if (!changed) return;
  const applied = await db
    .select({
      sessionKey: injections.sessionKey,
      descriptorDigest: injections.descriptorDigest,
    })
    .from(injections)
    .where(
      and(
        eq(injections.runId, runId),
        eq(injections.applicationState, "applied"),
      ),
    )
    .orderBy(injections.sessionKey);

  await db
    .update(runs)
    .set({
      agentMemoryHash: digest({ schemaVersion: 1, applied }),
      agentMemoryHashFormat: "vault-manifest-v1",
    })
    .where(eq(runs.id, runId));
  log.info(
    { runId, sessionKey, applicationReceiptId },
    "agent memory injection applied",
  );
}
