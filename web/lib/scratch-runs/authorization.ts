import "server-only";

import { assertUserHoldsLock } from "@/lib/local-packages/lock";
import { MaisterError } from "@/lib/errors";

export async function assertLocalPackageAssistantActor(
  run: { createdByUserId: string | null; localPackageId: string | null },
  userId: string,
  options: { requireLock: boolean },
  db?: Parameters<typeof assertUserHoldsLock>[2],
): Promise<void> {
  if (run.createdByUserId !== userId) {
    throw new MaisterError(
      "UNAUTHORIZED",
      "this assistant run belongs to another user",
    );
  }
  if (!options.requireLock) return;
  if (!run.localPackageId) {
    throw new MaisterError(
      "PRECONDITION",
      "assistant run has no local package to lock",
    );
  }
  await assertUserHoldsLock(run.localPackageId, userId, db);
}

/** Answering a PARKED assistant permission respawns its session into the
 * locked working dir, so it passes Recover's gate (ADR-097): the launching
 * user, holding the live edit lock. A live permission stays answerable by any
 * member (ADR-096) — only the resume writes. `userId` is null for a machine
 * actor, which never drives an assistant's resume. */
export async function assertParkedAssistantAnswerable(
  scratch: { createdByUserId: string | null; localPackageId: string | null },
  userId: string | null,
  db?: Parameters<typeof assertUserHoldsLock>[2],
): Promise<void> {
  if (userId === null)
    throw new MaisterError(
      "UNAUTHORIZED",
      "a parked assistant run resumes only for its launching user",
    );
  await assertLocalPackageAssistantActor(
    scratch,
    userId,
    { requireLock: true },
    db,
  );
}
