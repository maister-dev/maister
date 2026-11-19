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
  agents,
  projects,
  runs,
  users,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

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
export type LegacyMemoryImportCommand =
  "preview" | "import" | "activate" | "cleanup";

function failure(message: string): MaisterError {
  return new MaisterError("PRECONDITION", message);
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
        let agentId: string;

        try {
          agentId = `${decodeURIComponent(pkg)}:${decodeURIComponent(stem)}`;
        } catch (error) {
          throw new MaisterError(
            "PRECONDITION",
            "Legacy memory source has no canonical agent owner",
            { cause: error, details: { relative } },
          );
        }
        const projectId = bySlug.get(slug);

        if (
          !projectId ||
          !knownAgents.has(agentId) ||
          path.relative(root, agentMemoryPath(slug, agentId, root)) !== relative
        )
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
    if (
      !row.hash ||
      path.basename(row.runId) !== row.runId ||
      row.runId === "." ||
      row.runId === ".."
    )
      throw failure("Legacy run snapshot identity is invalid");
    sources.push({
      kind: "run_snapshot",
      relative: path.join(
        ".maister",
        row.slug,
        "runs",
        row.runId,
        "memory-snapshot.md",
      ),
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

  return receipt;
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
    const text = await readLegacyMemoryText(root, source.relative);
    const existing = await receiptFor(tx, source);

    if (existing) {
      ensureSourceMatch(existing, text);

      return;
    }
    if (!text && source.kind === "note")
      throw failure("Legacy memory disappeared after inventory");
    await tx.insert(receipts).values({
      generation: LEGACY_MEMORY_IMPORT_GENERATION,
      sourceKind: source.kind,
      sourceIdentity: source.relative,
      sourceDigest: text?.digest,
      sourceBytes: text?.bytes,
      runId: source.kind === "run_snapshot" ? source.runId : undefined,
      state:
        source.kind === "note"
          ? "inventoried"
          : !text
            ? "missing"
            : text.digest !== source.expectedHash
              ? "mismatched"
              : "inventoried",
    });
  });
  await db.transaction(async (tx) => {
    if (await lockImport(tx))
      throw failure("Memory vault cutover is already active");
    await requireImportAdmin(tx, actor);
    const receipt = await receiptFor(tx, source);

    if (!receipt) throw failure("Legacy memory inventory receipt is missing");
    const text = await readLegacyMemoryText(root, source.relative);

    ensureSourceMatch(receipt, text);
    if (receipt.state !== "inventoried") return;
    if (!text) throw failure("Inventoried legacy memory source is missing");
    const revision =
      source.kind === "note"
        ? await writeVaultLegacyNote(tx, source, text, actor)
        : undefined;

    if (source.kind === "run_snapshot")
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
    const receipt = await receiptFor(tx, source);

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
      const receipt = await receiptFor(tx, source);

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
