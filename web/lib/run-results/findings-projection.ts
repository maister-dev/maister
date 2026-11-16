import type { EvidenceFindingsV1 } from "./findings-types";
import type { RunResultContract } from "./types";

import { evidenceFindingsV1Schema } from "./findings-types";
import {
  isNativeFindingsContract,
  isOperationalEvidenceContract,
} from "./contract";

import { MaisterError } from "@/lib/errors";

export function parseNativeFindings(
  contract: RunResultContract,
  value: unknown,
) {
  if (isOperationalEvidenceContract(contract))
    return evidenceFindingsV1Schema.safeParse(
      typeof value === "object" && value !== null && "findings" in value
        ? value.findings
        : undefined,
    );

  return isNativeFindingsContract(contract)
    ? evidenceFindingsV1Schema.safeParse(value)
    : null;
}

/** Only the frozen native discriminator can upgrade a validated payload into findings. */
export function projectNativeFindings(
  contract: RunResultContract | null,
  value: unknown,
): EvidenceFindingsV1 | undefined {
  if (value === null || contract === null) return undefined;
  const parsed = parseNativeFindings(contract, value);

  if (parsed === null) return undefined;

  if (!parsed.success)
    throw new MaisterError(
      "CRASH",
      "The retained native result does not match its frozen findings contract",
      { details: { reason: "stored_findings_contract_mismatch" } },
    );

  return parsed.data;
}
