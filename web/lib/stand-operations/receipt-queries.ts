import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { asc, eq } from "drizzle-orm";

import { standOperationReceipts } from "@/lib/db/schema";

export async function readStandReceiptIds(
  tx: Pick<Db, "select">,
  operationId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: standOperationReceipts.id })
    .from(standOperationReceipts)
    .where(eq(standOperationReceipts.operationId, operationId))
    .orderBy(asc(standOperationReceipts.targetReceiptRevision));

  return rows.map(({ id }) => id);
}
