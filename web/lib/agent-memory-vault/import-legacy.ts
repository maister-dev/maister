import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LegacyMemoryText } from "./legacy-source";

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { parseAgentMemoryMutation } from "./commands";
import { vaultCutoverLock } from "./cutover";
import {
  cleanupLegacyMemoryText,
  legacyDirectories,
  readLegacyMemoryText,
} from "./legacy-source";
import { agentMemoryVaultLimits } from "./limits";
import { MEMORY_INDEX } from "./paths";
import { ensureProjectVault } from "./project-access";
import {
  applyVaultMutationInTransaction,
  readVaultPayload,
  readVaultRevision,
} from "./store";

import { agentMemoryPath, hashAgentMemory } from "@/lib/agents/memory-store";
import {
  agentMemoryCutover as cutover,
  agentMemoryImportPayloads as payloads,
  agentMemoryImportReceipts as receipts,
  agentMemoryVaults as vaults,
  agents,
  projects,
  runs,
  users,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { projectSlugSchema } from "@/lib/flow-paths";

export const LEGACY_MEMORY_IMPORT_GENERATION = 1n;
const LEGACY_NOTE = "/memories/notes/legacy.md";
const OVERFLOW_INDEX =
  "# Imported agent memory\n\nThe original text is in [[notes/legacy]].\n";
const log = pino({
  name: "agent-memory-import",
  level: process.env.LOG_LEVEL ?? "info",
});

type Source =
  | Readonly<{
      kind: "note";
      relative: string;
      projectId: string;
      agentId: string;
    }>
  | Readonly<{
      kind: "run_snapshot";
      relative: string;
      runId: string;
      expectedHash: string;
    }>;
type Receipt = typeof receipts.$inferSelect;
type SourceSelector =
  | Pick<Extract<Source, { kind: "note" }>, "kind" | "relative">
  | Pick<
      Extract<Source, { kind: "run_snapshot" }>,
      "kind" | "relative" | "runId"
    >;
export type LegacyMemoryImportCommand =
  "preview" | "import" | "activate" | "cleanup";

function failure(message: string): MaisterError {
  return new MaisterError("PRECONDITION", message);
}

function notePathIdentity(root: string, relative: string) {
  const [namespace, slug, folder, pkg, stem, name, ...extra] = relative.split(
    path.sep,
  );

  if (
    namespace !== ".maister" ||
    folder !== "agents" ||
    name !== "memory.md" ||
    !slug ||
    !pkg ||
    !stem ||
    extra.length
  )
    throw failure("Legacy memory source path is invalid");
  let agentId: string;

  try {
    agentId = `${decodeURIComponent(pkg)}:${decodeURIComponent(stem)}`;
  } catch (error) {
    throw new MaisterError(
      "PRECONDITION",
      "Legacy memory source has no canonical agent owner",
      { cause: error },
    );
  }
  if (path.relative(root, agentMemoryPath(slug, agentId, root)) !== relative)
    throw failure("Legacy memory source owner is unresolved");

  return { slug, agentId };
}

function snapshotRelative(slug: string, runId: string) {
  if (
    !projectSlugSchema.safeParse(slug).success ||
    path.basename(runId) !== runId ||
    runId === "." ||
    runId === ".."
  )
    throw failure("Legacy run snapshot identity is invalid");

  return path.join(".maister", slug, "runs", runId, "memory-snapshot.md");
}

async function lockLegacySource(
  tx: Db,
  root: string,
  selector: SourceSelector,
): Promise<Source> {
  if (selector.kind === "note") {
    const { slug, agentId } = notePathIdentity(root, selector.relative);
    const [owner] = (
      await tx.execute<{ id: string }>(sql`
        SELECT p.id FROM projects p JOIN agents a ON a.id=${agentId}
        WHERE p.slug=${slug} FOR SHARE OF p,a
      `)
    ).rows;

    if (!owner) throw failure("Legacy memory source owner is unresolved");

    return { ...selector, projectId: owner.id, agentId };
  }
  const [run] = (
    await tx.execute<{ slug: string; hash: string }>(sql`
      SELECT p.slug,r.agent_memory_hash AS hash FROM runs r
        JOIN projects p ON p.id=r.project_id
      WHERE r.id=${selector.runId} AND r.agent_memory_hash_format='legacy-file-v1'
      FOR SHARE OF p,r
    `)
  ).rows;

  if (
    !run?.hash ||
    snapshotRelative(run.slug, selector.runId) !== selector.relative
  )
    throw failure("Legacy run snapshot owner is unresolved");

  return { ...selector, expectedHash: run.hash };
}

async function inventory(db: Db, root: string): Promise<Source[]> {
  const projectRows = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects);
  const bySlug = new Map(projectRows.map((row) => [row.slug, row.id]));
  const knownAgents = new Set(
    (await db.select({ id: agents.id }).from(agents)).map(({ id }) => id),
  );
  const sources: Source[] = [];

  for (const slug of await legacyDirectories(root, ".maister")) {
    const agentRoot = path.join(".maister", slug, "agents");

    for (const pkg of await legacyDirectories(root, agentRoot)) {
      for (const stem of await legacyDirectories(
        root,
        path.join(agentRoot, pkg),
      )) {
        const relative = path.join(agentRoot, pkg, stem, "memory.md");
        const original = await readLegacyMemoryText(root, relative);

        if (!original) continue;
        const { agentId } = notePathIdentity(root, relative);
        const projectId = bySlug.get(slug);

        if (!projectId || !knownAgents.has(agentId))
          throw new MaisterError(
            "PRECONDITION",
            "Legacy memory source owner is unresolved",
            { details: { relative } },
          );
        sources.push({ kind: "note", relative, projectId, agentId });
      }
    }
  }
  const history = await db
    .select({
      runId: runs.id,
      slug: projects.slug,
      hash: runs.agentMemoryHash,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.agentMemoryHashFormat, "legacy-file-v1"));

  for (const row of history) {
    if (!row.hash) throw failure("Legacy run snapshot identity is invalid");
    sources.push({
      kind: "run_snapshot",
      relative: snapshotRelative(row.slug, row.runId),
      runId: row.runId,
      expectedHash: row.hash,
    });
  }

  return sources;
}

async function lockImport(tx: Db): Promise<boolean> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${vaultCutoverLock})`);

  return (
    (await tx.select({ generation: cutover.generation }).from(cutover)).length >
    0
  );
}

async function requireImportAdmin(db: Db, userId: string): Promise<void> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        eq(users.role, "admin"),
        eq(users.accountStatus, "active"),
        eq(users.mustChangePassword, false),
      ),
    )
    .for("share");

  if (!admin)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current administrator required for memory import",
    );
}

async function receiptFor(
  db: Db,
  source: Source,
): Promise<Receipt | undefined> {
  const [receipt] = await db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.generation, LEGACY_MEMORY_IMPORT_GENERATION),
        eq(receipts.sourceKind, source.kind),
        eq(receipts.sourceIdentity, source.relative),
      ),
    );

  if (receipt) assertReceiptOwner(receipt, source);

  return receipt;
}

function assertReceiptOwner(receipt: Receipt, source: Source): void {
  const matches =
    source.kind === "note"
      ? receipt.sourceProjectId === source.projectId &&
        receipt.sourceAgentId === source.agentId
      : receipt.runId === source.runId &&
        (receipt.state === "missing" ||
          receipt.state === "mismatched" ||
          receipt.sourceDigest === source.expectedHash);

  if (!matches) {
    log.warn(
      { receiptId: receipt.id, sourceKind: receipt.sourceKind },
      "[FIX] Legacy memory source no longer has its recorded owner",
    );
    throw failure("Legacy memory source owner changed after inventory");
  }
}

function assertInventoryOwner(source: Source, current: Source): void {
  const matches =
    source.kind === "note"
      ? current.kind === "note" &&
        source.projectId === current.projectId &&
        source.agentId === current.agentId
      : current.kind === "run_snapshot" &&
        source.runId === current.runId &&
        source.expectedHash === current.expectedHash;

  if (!matches) throw failure("Legacy memory source changed during inventory");
}

function receiptSelector(receipt: Receipt): SourceSelector {
  if (receipt.sourceKind === "note")
    return { kind: "note", relative: receipt.sourceIdentity };
  if (!receipt.runId) throw failure("Legacy run snapshot identity is missing");

  return {
    kind: "run_snapshot",
    relative: receipt.sourceIdentity,
    runId: receipt.runId,
  };
}

function ensureSourceMatch(
  receipt: Receipt,
  text: LegacyMemoryText | null,
): void {
  if (
    receipt.sourceDigest !== (text?.digest ?? null) ||
    receipt.sourceBytes !== (text?.bytes ?? null)
  )
    throw failure("Legacy memory source changed after inventory");
}

function assureImportCapacity(
  text: LegacyMemoryText,
  limits = agentMemoryVaultLimits(),
): void {
  if (
    text.text.length > limits.noteChars ||
    (text.text.length > limits.indexChars &&
      (OVERFLOW_INDEX.length > limits.indexChars ||
        limits.notes < 2 ||
        text.text.length + OVERFLOW_INDEX.length > limits.vaultChars))
  )
    throw new MaisterError(
      "CONFIG",
      "Legacy text does not fit the configured vault bounds",
    );
}

async function writeVaultLegacyNote(
  tx: Db,
  source: Extract<Source, { kind: "note" }>,
  text: LegacyMemoryText,
  actorUserId: string,
) {
  const limits = agentMemoryVaultLimits();

  assureImportCapacity(text, limits);
  const vaultId = await ensureProjectVault(
    tx,
    source.projectId,
    source.agentId,
  );
  const scope = createHash("sha256").update(source.relative).digest("hex");
  const write = async (target: string, body: string, suffix: string) => {
    const result = await applyVaultMutationInTransaction(
      tx,
      parseAgentMemoryMutation({
        command: "create",
        path: target,
        file_text: body,
        ifRevisionId: null,
        ifHash: null,
        requestKey: `${scope}:${suffix}`,
      }),
      async () => ({
        vaultId,
        principalKey: "operator:legacy-import-v1",
        actor: { kind: "operator_import", userId: actorUserId },
        sourceProjectIds: [source.projectId],
        sourceRestrictions: [
          { kind: "legacy_project_private", projectId: source.projectId },
        ],
        writeAdmission: "apply",
        canRead: async () => true,
        capture: async () => {},
      }),
      limits,
    );

    if (result.status !== "applied" || result.affected.length !== 1)
      throw failure(
        "Legacy memory import conflicts with an existing vault head",
      );

    return result.affected[0]!;
  };
  const overflow = text.text.length > limits.indexChars;
  const original = await write(
    overflow ? LEGACY_NOTE : MEMORY_INDEX,
    text.text,
    "original",
  );

  if (overflow) await write(MEMORY_INDEX, OVERFLOW_INDEX, "index");

  return { vaultId, noteId: original.noteId, revisionId: original.revisionId };
}

async function verifyRetainedImport(db: Db, receipt: Receipt): Promise<void> {
  let content: string | undefined;

  if (receipt.sourceKind === "run_snapshot") {
    const [payload] = await db
      .select({ content: payloads.content })
      .from(payloads)
      .where(eq(payloads.receiptId, receipt.id));

    content = payload?.content;
  } else if (receipt.vaultId && receipt.noteId && receipt.revisionId) {
    const [owner] = await db
      .select({ projectId: vaults.projectId, agentId: vaults.agentId })
      .from(vaults)
      .where(eq(vaults.id, receipt.vaultId))
      .for("share");

    if (
      !receipt.sourceProjectId ||
      !receipt.sourceAgentId ||
      owner?.projectId !== receipt.sourceProjectId ||
      owner.agentId !== receipt.sourceAgentId
    )
      throw failure("Retained legacy memory has a different vault owner");
    content = await readVaultPayload(
      db,
      await readVaultRevision(
        db,
        receipt.vaultId,
        receipt.noteId,
        receipt.revisionId,
      ),
    );
  }
  if (
    content === undefined ||
    hashAgentMemory(content) !== receipt.sourceDigest ||
    Buffer.byteLength(content) !== receipt.sourceBytes
  )
    throw failure("Retained legacy memory failed verification");
}

async function importSource(
  db: Db,
  root: string,
  source: Source,
  actor: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (await lockImport(tx))
      throw failure("Memory vault cutover is already active");
    await requireImportAdmin(tx, actor);
    const current = await lockLegacySource(tx, root, source);

    assertInventoryOwner(source, current);
    const text = await readLegacyMemoryText(root, current.relative);
    const existing = await receiptFor(tx, current);

    if (existing) {
      ensureSourceMatch(existing, text);

      return;
    }
    if (!text && source.kind === "note")
      throw failure("Legacy memory disappeared after inventory");
    await tx.insert(receipts).values({
      generation: LEGACY_MEMORY_IMPORT_GENERATION,
      sourceKind: current.kind,
      sourceIdentity: current.relative,
      sourceProjectId: current.kind === "note" ? current.projectId : null,
      sourceAgentId: current.kind === "note" ? current.agentId : null,
      sourceDigest: text?.digest,
      sourceBytes: text?.bytes,
      runId: current.kind === "run_snapshot" ? current.runId : undefined,
      state:
        current.kind === "note"
          ? "inventoried"
          : !text
            ? "missing"
            : text.digest !== current.expectedHash
              ? "mismatched"
              : "inventoried",
    });
  });
  await db.transaction(async (tx) => {
    if (await lockImport(tx))
      throw failure("Memory vault cutover is already active");
    await requireImportAdmin(tx, actor);
    const current = await lockLegacySource(tx, root, source);
    const receipt = await receiptFor(tx, current);

    if (!receipt) throw failure("Legacy memory inventory receipt is missing");
    const text = await readLegacyMemoryText(root, source.relative);

    ensureSourceMatch(receipt, text);
    if (receipt.state !== "inventoried") return;
    if (!text) throw failure("Inventoried legacy memory source is missing");
    const revision =
      current.kind === "note"
        ? await writeVaultLegacyNote(tx, current, text, actor)
        : undefined;

    if (current.kind === "run_snapshot")
      await tx
        .insert(payloads)
        .values({ receiptId: receipt.id, content: text.text });
    await tx
      .update(receipts)
      .set({ ...revision, state: "imported", updatedAt: new Date() })
      .where(eq(receipts.id, receipt.id));
  });
  await db.transaction(async (tx) => {
    if (await lockImport(tx))
      throw failure("Memory vault cutover is already active");
    await requireImportAdmin(tx, actor);
    const current = await lockLegacySource(tx, root, source);
    const receipt = await receiptFor(tx, current);

    if (!receipt) throw failure("Legacy memory inventory receipt is missing");
    if (receipt.state !== "imported" && receipt.state !== "verified") return;
    await verifyRetainedImport(tx, receipt);
    await tx
      .update(receipts)
      .set({ state: "verified", updatedAt: new Date() })
      .where(eq(receipts.id, receipt.id));
  });
}

async function activate(db: Db, root: string, actor: string) {
  return db.transaction(async (tx) => {
    await requireImportAdmin(tx, actor);
    if (await lockImport(tx)) return;
    const stillRunning = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        inArray(runs.status, [
          "Running",
          "NeedsInput",
          "NeedsInputIdle",
          "WaitingOnChildren",
        ]),
      )
      .limit(1);

    if (stillRunning.length)
      throw failure(
        "Drain legacy execution contexts before activating the memory vault",
      );
    const sources = await inventory(tx, root);
    const prior = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.generation, LEGACY_MEMORY_IMPORT_GENERATION));
    const found = new Set(sources.map((source) => source.relative));

    if (prior.some((row) => !found.has(row.sourceIdentity)))
      throw failure("An inventoried source disappeared before activation");
    for (const source of sources) {
      const current = await lockLegacySource(tx, root, source);

      assertInventoryOwner(source, current);
      const receipt = await receiptFor(tx, current);

      if (
        !receipt ||
        !["verified", "missing", "mismatched"].includes(receipt.state)
      )
        throw failure("Complete legacy memory verification before activation");
      ensureSourceMatch(
        receipt,
        await readLegacyMemoryText(root, source.relative),
      );
      if (receipt.state === "verified") await verifyRetainedImport(tx, receipt);
    }
    await tx
      .insert(cutover)
      .values({ generation: LEGACY_MEMORY_IMPORT_GENERATION });
  });
}

async function cleanup(db: Db, root: string, actor: string) {
  const ready = await db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.generation, LEGACY_MEMORY_IMPORT_GENERATION),
        eq(receipts.state, "verified"),
      ),
    );

  for (const candidate of ready) {
    await db.transaction(async (tx) => {
      if (!(await lockImport(tx)))
        throw failure("Activate the memory vault before cleanup");
      await requireImportAdmin(tx, actor);
      const [current] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, candidate.id))
        .for("update");

      if (!current || current.state !== "verified" || !current.sourceDigest)
        return;
      const source = await lockLegacySource(tx, root, receiptSelector(current));

      assertReceiptOwner(current, source);
      await verifyRetainedImport(tx, current);
      await cleanupLegacyMemoryText(
        root,
        current.sourceIdentity,
        current.sourceDigest,
      );
      await tx
        .update(receipts)
        .set({ state: "cleaned", updatedAt: new Date() })
        .where(eq(receipts.id, candidate.id));
    });
  }
}

export async function importLegacyAgentMemory(
  db: Db,
  request: Readonly<{
    root: string;
    command: LegacyMemoryImportCommand;
    actorUserId: string;
  }>,
): Promise<void> {
  const root = await realpath(request.root);

  switch (request.command) {
    case "activate":
      await activate(db, root, request.actorUserId);
      break;
    case "cleanup":
      await cleanup(db, root, request.actorUserId);
      break;
    case "preview":
    case "import": {
      const sources = await inventory(db, root);

      for (const source of sources) {
        const text = await readLegacyMemoryText(root, source.relative);

        if (source.kind === "note" && text) assureImportCapacity(text);
        if (request.command === "import")
          await importSource(db, root, source, request.actorUserId);
      }
      log.info(
        { command: request.command, files: sources.length },
        "legacy memory inventory checked",
      );
      break;
    }
  }
  log.info(
    {
      command: request.command,
      generation: String(LEGACY_MEMORY_IMPORT_GENERATION),
    },
    "legacy memory command finished",
  );
}
