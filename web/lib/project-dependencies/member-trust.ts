import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { eq } from "drizzle-orm";

import { packageInstalls } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

/** A member's local cache URL never grants trust to its originating package. */
export async function requireParentPackageTrust(
  db: Db,
  installId: string | null,
): Promise<void> {
  if (!installId) return;
  const [parent] = await db
    .select({ trust: packageInstalls.trustStatus })
    .from(packageInstalls)
    .where(eq(packageInstalls.id, installId));
  if (!parent || parent.trust === "untrusted")
    throw new MaisterError(
      "PRECONDITION",
      "Confirm trust for the originating package revision before running its members.",
      { details: { reason: "package_trust_required" } },
    );
}
