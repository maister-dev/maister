import { z } from "zod";

import { FINDINGS_CONTRACT, FINDINGS_ENGINE_MIN } from "./findings-contract";

import {
  OPERATIONAL_EVIDENCE_CONTRACT,
  OPERATIONAL_EVIDENCE_ENGINE_MIN,
} from "@/lib/agents/kind";

export const flowNativeContractSchema = z.enum([
  FINDINGS_CONTRACT,
  OPERATIONAL_EVIDENCE_CONTRACT,
]);
export type FlowNativeContract = z.infer<typeof flowNativeContractSchema>;

export const FLOW_NATIVE_CONTRACT_ENGINE_MIN: Readonly<
  Record<FlowNativeContract, string>
> = {
  [FINDINGS_CONTRACT]: FINDINGS_ENGINE_MIN,
  [OPERATIONAL_EVIDENCE_CONTRACT]: OPERATIONAL_EVIDENCE_ENGINE_MIN,
};
