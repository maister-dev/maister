import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";

import { and, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { physicalSetupKey, identifyHistoricalSetups } from "./setup-identity";
import { localDirectoryContentDigest } from "./content-digest";

import {
  projectDependencyAttempts as attempts,
  projectDependencyDeclarations as declarations,
  projectDependencySetupReceipts as receipts,
  projects,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({ name: "project-dependency-setup" });

type SetupContext = {
  db: Db;
  before?: (key: string, member: string) => Promise<void>;
  recoveryOf?: string | null;
  authorize?: (tx: Db) => Promise<void>;
};
const context = new AsyncLocalStorage<SetupContext>();

const settled = new AsyncLocalStorage<boolean>();

/** Native finalization may consume a completed setup receipt, never start a
 * new physical operation while the project write transaction is held. */
export function withSettledSetups<T>(work: () => Promise<T>): Promise<T> {
  return settled.run(true, work);
}

export function withSetupAuthority<T>(
  db: Db,
  authorize: (tx: Db) => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  return context.run({ ...context.getStore(), db, authorize }, work);
}
export function withDependencySetupContext<T>(
  input: SetupContext,
  work: () => Promise<T>,
): Promise<T> {
  return context.run(input, work);
}

export function withSetupDatabase<T>(
  db: Db,
  work: () => Promise<T>,
): Promise<T> {
  return context.getStore() ? work() : context.run({ db }, work);
}

type Receipt = typeof receipts.$inferSelect;
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);

    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ESRCH") return false;
    // EPERM means the process group exists but is owned by another UID.
    if (code === "EPERM") return true;
    throw error;
  }
}
function ownerMayRun(receipt: Receipt): boolean {
  return (
    receipt.ownerHost !== hostname() ||
    (receipt.ownerPid !== null && groupExists(receipt.ownerPid))
  );
}
async function hasReservedOwner(db: Db, receipt: Receipt): Promise<boolean> {
  if (!receipt.claimToken.startsWith("recovery:")) return false;
  const original = receipt.claimToken.slice("recovery:".length);
  const [current] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .innerJoin(
      declarations,
      and(
        eq(declarations.id, attempts.declarationId),
        eq(declarations.generation, attempts.generation),
      ),
    )
    .innerJoin(
      projects,
      and(eq(projects.id, declarations.projectId), isNull(projects.archivedAt)),
    )
    .where(
      and(
        eq(attempts.id, original),
        // Once the reserved recovery attempt reaches a terminal state without
        // dispatching setup, the reservation no longer blocks another project.
        sql`NOT EXISTS (
          SELECT 1 FROM project_dependency_attempts child
          WHERE child.retry_of_attempt_id = ${attempts.id}
            AND child.status NOT IN ('pending', 'running')
        )`,
      ),
    );

  if (!current) {
    log.debug(
      { materialKey: receipt.materialKey, originalAttemptId: original },
      "setup recovery reservation no longer has a live owner",
    );
  }

  return Boolean(current);
}

function conflict(reason: string): never {
  throw new MaisterError(
    "CONFLICT",
    "Setup recovery requires a quiescent physical target and matching execution evidence",
    { details: { reason } },
  );
}

export async function authorizeDependencySetupRecovery(
  db: Db,
  attemptId: string,
): Promise<"completed" | "rerun"> {
  const [attempt] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, attemptId));
  const key = attempt?.checkpoint.setupMaterialKey;

  if (!key || attempt.status !== "recovery_required")
    conflict("setup_evidence_missing");
  const [receipt] = await db
    .select()
    .from(receipts)
    .where(eq(receipts.materialKey, key))
    .for("update");

  if (!receipt) conflict("setup_evidence_missing");
  if (receipt.status === "succeeded") return "completed";
  if (
    receipt.status === "running" &&
    (receipt.claimToken.startsWith("recovery:")
      ? await hasReservedOwner(db, receipt)
      : ownerMayRun(receipt))
  )
    conflict("setup_owner_live");
  // The unique retry-of FK identifies exactly one accepted recovery attempt.
  // Reserve its replay in the same transaction that enqueues it.
  await db
    .update(receipts)
    .set({
      status: "running",
      claimToken: "recovery:" + attemptId,
      ownerHost: null,
      ownerPid: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(receipts.materialKey, key),
        eq(receipts.claimToken, receipt.claimToken),
      ),
    );

  return "rerun";
}

/** Transfer the accepted but unconsumed setup replay when its actor lost
 * authority. A different declaration, target or dispatched replay cannot match. */
export async function inheritSetupRecovery(
  db: Db,
  failed: typeof attempts.$inferSelect,
): Promise<boolean> {
  const key = failed.checkpoint.setupMaterialKey;

  if (!key || !failed.retryOfAttemptId || failed.status !== "failed")
    return false;
  const [reserved] = await db
    .update(receipts)
    .set({ claimToken: "recovery:" + failed.id, updatedAt: new Date() })
    .where(
      and(
        eq(receipts.materialKey, key),
        eq(receipts.status, "running"),
        eq(receipts.claimToken, "recovery:" + failed.retryOfAttemptId),
      ),
    )
    .returning({ key: receipts.materialKey });

  return Boolean(reserved);
}

/** Start the child behind a closed stdin gate. Only the process whose group
 * has a committed dispatch receipt receives permission to execute setup.sh. */
export async function runMaterialSetup(input: {
  db: Db;
  target: string;
  kind: "flow" | "capability";
  revision: string;
  contentWitness?: string;
  signal?: AbortSignal;
}): Promise<"done" | "failed" | "not_required"> {
  const target = await realpath(input.target);
  const ctx = context.getStore();
  const db = ctx?.db ?? input.db;
  const identity = { ...input, target };
  const key = physicalSetupKey(identity);
  const memberRef = input.kind + ":" + basename(target).split("@")[0];
  let script: Buffer | null = null;

  try {
    script = await readFile(join(target, "setup.sh"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  input.signal?.throwIfAborted();
  const scriptDigest =
    script === null ? null : createHash("sha256").update(script).digest("hex");

  // Before v2 the material key included script bytes. Keep the stored key so
  // retained checkpoints and recovery decisions can use the same receipt.
  await identifyHistoricalSetups(db, identity, script);
  const match = eq(receipts.physicalKey, key);
  const [prior] = await db.select().from(receipts).where(match);
  const receiptKey = prior?.materialKey ?? key;

  if (
    prior?.physicalKey &&
    prior.contentWitness !== (input.contentWitness ?? null)
  )
    conflict("revision_mismatch");
  // Callers only dispatch setup that the installed input declared as present.
  if (script === null && !prior)
    throw new MaisterError(
      "CONFLICT",
      "The installed dependency is missing its required setup.sh.",
      {
        details: { reason: "setup_material_changed", memberRef },
      },
    );
  if (settled.getStore()) {
    if (prior?.status !== "succeeded") conflict("setup_material_changed");

    return "done";
  }
  let initialDigest: string | undefined;

  if (input.contentWitness && !prior)
    initialDigest = await localDirectoryContentDigest(
      target,
      new Set([".git"]),
    );
  await ctx?.before?.(receiptKey, memberRef);
  const claimToken = randomUUID();
  // The gate exits on EOF if this process dies before sending a newline.
  const child = spawn(
    "bash",
    ["-c", "IFS= read -r start && exec bash ./setup.sh"],
    { cwd: target, detached: true, stdio: ["pipe", "ignore", "ignore"] },
  );
  const exited = new Promise<{ code: number | null; error?: Error }>(
    (resolve) => {
      child.once("exit", (code) => resolve({ code }));
      child.once("error", (error) => resolve({ code: null, error }));
    },
  );

  child.stdin.on("error", () => {
    /* The child's exit supplies the result. */
  });
  const killGroup = () => {
    if (child.pid)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
  };
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(input.signal ? [input.signal] : []),
  ]);

  signal.addEventListener("abort", killGroup, { once: true });
  try {
    if (!child.pid) {
      const outcome = await exited;

      log.warn(
        { target, err: outcome.error?.message },
        "setup process failed to start",
      );
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "Setup process could not be started",
      );
    }
    const ownership = await db.transaction(async (tx) => {
      await ctx?.authorize?.(tx);
      signal.throwIfAborted();
      // A conflict on the physical key serializes new receipts across projects
      // and the explicit trust APIs. A pre-existing dispatched owner is never
      // reset by an ordinary retry.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(match)
        .for("update");

      await ctx?.authorize?.(tx);
      signal.throwIfAborted();
      if (
        receipt?.physicalKey &&
        receipt.contentWitness !== (input.contentWitness ?? null)
      )
        conflict("revision_mismatch");
      if (receipt?.status === "succeeded") return { acquired: false } as const;
      if (
        !receipt &&
        input.contentWitness &&
        initialDigest !== input.contentWitness
      )
        conflict("revision_mismatch");
      if (receipt?.claimToken.startsWith("recovery:")) {
        if (
          !ctx?.recoveryOf ||
          receipt.claimToken !== "recovery:" + ctx.recoveryOf
        )
          conflict(
            (await hasReservedOwner(tx, receipt))
              ? "setup_owner_live"
              : "setup_uncertain",
          );
      } else if (receipt?.status === "running") {
        conflict(ownerMayRun(receipt) ? "setup_owner_live" : "setup_uncertain");
      }
      if (
        !scriptDigest ||
        (receipt?.scriptDigest && receipt.scriptDigest !== scriptDigest)
      )
        conflict("setup_material_changed");
      await tx
        .insert(receipts)
        .values({
          materialKey: receiptKey,
          physicalKey: key,
          scriptDigest,
          contentWitness: input.contentWitness ?? null,
          status: "running",
          claimToken,
          ownerHost: hostname(),
          ownerPid: child.pid,
        })
        .onConflictDoUpdate({
          target: receipts.materialKey,
          set: {
            status: "running",
            claimToken,
            ownerHost: hostname(),
            ownerPid: child.pid,
            updatedAt: new Date(),
          },
        });

      return { acquired: true, previous: receipt } as const;
    });

    if (!ownership.acquired) return "done";
    if (signal.aborted) {
      // This process still owns the closed stdin gate. Restore the exact
      // predecessor, including any explicit replay reservation, before leaving.
      const ours = and(
        eq(receipts.materialKey, receiptKey),
        eq(receipts.claimToken, claimToken),
      );
      if (ownership.previous)
        await db.update(receipts).set(ownership.previous).where(ours);
      else await db.delete(receipts).where(ours);
      signal.throwIfAborted();
    }
    child.stdin.end("\n");
    const { code } = await exited;

    if (code === null || signal.aborted || groupExists(child.pid))
      conflict("setup_uncertain");
    const status = code === 0 ? "succeeded" : "failed";

    await db
      .update(receipts)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(receipts.materialKey, receiptKey),
          eq(receipts.claimToken, claimToken),
        ),
      );
    if (status === "succeeded") {
      const marker = join(target, ".maister-setup-done");
      const temp = marker + "." + claimToken;

      await writeFile(temp, new Date().toISOString(), { flag: "wx" });
      await rename(temp, marker);
    }

    return status === "succeeded" ? "done" : "failed";
  } finally {
    signal.removeEventListener("abort", killGroup);
    child.stdin.end();
    await exited;
  }
}
