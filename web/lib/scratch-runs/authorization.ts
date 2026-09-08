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
