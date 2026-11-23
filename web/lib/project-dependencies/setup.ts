import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";

import {
  projectDependencyAttempts as attempts,
  projectDependencySetupReceipts as receipts,
} from "@/lib/db/schema";
import { localDirectoryContentDigest } from "./content-digest";
import { MaisterError } from "@/lib/errors";

type SetupContext = {
  db: Db;
  before?: (key: string, member: string) => Promise<void>;
  recoveryOf?: string | null;
};
const context = new AsyncLocalStorage<SetupContext>();

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
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
function ownerMayRun(receipt: Receipt): boolean {
  return (
    receipt.ownerHost !== hostname() ||
    (receipt.ownerPid !== null && groupExists(receipt.ownerPid))
  );
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
  if (receipt.status === "running" && ownerMayRun(receipt))
    conflict("setup_owner_live");
  // The unique retry-of FK identifies exactly one accepted recovery attempt.
  // Reserve its replay in the same transaction that enqueues it.
  await db.update(receipts).set({claimToken:"recovery:"+attemptId,ownerHost:null,ownerPid:null,updatedAt:new Date()})
    .where(and(eq(receipts.materialKey,key),eq(receipts.claimToken,receipt.claimToken)));
  return "rerun";
}

/** Start the child behind a closed stdin gate. Only the process whose group
 * has a committed dispatch receipt receives permission to execute setup.sh. */
export async function runMaterialSetup(input: {
  db: Db;
  target: string;
  kind:"flow"|"capability";
  revision: string;
  contentWitness?: string;
  signal?: AbortSignal;
}): Promise<"done" | "failed" | "not_required"> {
  const target = await realpath(input.target);
  let script: Buffer;
  try {
    script = await readFile(join(target, "setup.sh"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return "not_required";
    throw error;
  }
  input.signal?.throwIfAborted();
  const key = createHash("sha256")
    .update(JSON.stringify([target, input.revision, input.contentWitness ?? input.revision, basename(target)]))
    .update(script)
    .digest("hex");
  const ctx = context.getStore();
  const db = ctx?.db ?? input.db;
  await ctx?.before?.(key, input.kind+":"+basename(target).split("@")[0]);
  const claimToken = randomUUID();
  // The gate exits on EOF if this process dies before sending a newline.
  const child = spawn(
    "bash",
    ["-c", "IFS= read -r start && exec bash ./setup.sh"],
    { cwd: target, detached: true, stdio: ["pipe", "ignore", "ignore"] },
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
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
      await exited;
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "Setup process could not be started",
      );
    }
    const ownership = await db.transaction(async (tx) => {
      // A conflict on the physical key serializes new receipts across projects
      // and the explicit trust APIs. A pre-existing dispatched owner is never
      // reset by an ordinary retry.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.materialKey, key))
        .for("update");
      if (receipt?.status === "succeeded") return false;
      if (!receipt && input.contentWitness && await localDirectoryContentDigest(target,new Set([".git"]))!==input.contentWitness)
        conflict("revision_mismatch");
      if (receipt?.claimToken.startsWith("recovery:")) {
        if (!ctx?.recoveryOf || receipt.claimToken!=="recovery:"+ctx.recoveryOf) conflict("setup_owner_live");
      } else if (receipt?.status === "running") {
        conflict(ownerMayRun(receipt) ? "setup_owner_live" : "setup_uncertain");
      }
      await tx
        .insert(receipts)
        .values({
          materialKey: key,
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
      return true;
    });
    if (!ownership) return "done";
    signal.throwIfAborted();
    child.stdin.end("\n");
    const code = await exited;
    if (groupExists(child.pid)) conflict("setup_uncertain");
    const status = code === 0 ? "succeeded" : "failed";
    await db
      .update(receipts)
      .set({ status, updatedAt: new Date() })
      .where(
        and(eq(receipts.materialKey, key), eq(receipts.claimToken, claimToken)),
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
