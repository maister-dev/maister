import "server-only";

import { sql } from "drizzle-orm";

import { executionCommands } from "@/lib/db/schema";

// A successful, durably settled receipt retains the instant the host accepted
// the prompt, even when the acceptance acknowledgement never reached the Web.
export const settledPromptReceiptReceivedAt = sql<string | null>`
  CASE WHEN ${executionCommands.kind} = 'session.prompt'
    AND ${executionCommands.terminalEvidenceSha256} IS NOT NULL
    AND ${executionCommands.receiptEvidence}->>'phase' = 'completed'
  THEN ${executionCommands.receiptEvidence}->>'receivedAt' END
`;

export function promptReceiptAcceptance(
  receivedAt: string | null,
): Date | null {
  if (receivedAt === null) return null;
  const instant = new Date(receivedAt);

  return Number.isFinite(instant.getTime()) ? instant : null;
}
