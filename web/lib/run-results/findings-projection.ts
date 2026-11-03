import type { EvidenceFindingsV1 } from "./findings-types";
import type { RunResultContract } from "./types";

import { FINDINGS_CONTRACT } from "./findings-contract";
import { evidenceFindingsV1Schema } from "./findings-types";

import { MaisterError } from "@/lib/errors";

/** Only the frozen native discriminator can upgrade a validated payload into findings. */
export function projectNativeFindings(
  contract: RunResultContract | null,
  value: unknown,
): EvidenceFindingsV1 | undefined {
  if (
    value === null ||
    contract === null ||
    contract.kind === "agent_operational" ||
    contract.nativeContract !== FINDINGS_CONTRACT
  )
    return undefined;
  const parsed = evidenceFindingsV1Schema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CRASH",
      "The retained native result does not match its frozen findings contract",
      { details: { reason: "stored_findings_contract_mismatch" } },
    );

  return parsed.data;
}
