import type { OperationalCleanup } from "@/lib/run-results/operational-types";

/** Initial state of the existing bounded resource disposition protocol. */
export function initialResourceCleanup(
  input: Pick<
    OperationalCleanup,
    "resourceKind" | "workspace" | "armedAt" | "dueAt"
  > & { state: "armed" | "retained" },
): OperationalCleanup {
  return {
    ...input,
    version: 1,
    revision: 1,
    attempts: 0,
    errorCode: null,
    evidenceIds: [],
    removedAt: null,
    releasedAt: null,
    lease: null,
    rearmReceipt: null,
  };
}
