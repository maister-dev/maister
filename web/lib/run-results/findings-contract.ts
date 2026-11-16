import { z } from "zod";

export const FINDINGS_ENGINE_MIN = "3.11.0";
export const FINDINGS_CONTRACT = "evidence_findings_v1";
export const findingsContractSchema = z.literal(FINDINGS_CONTRACT);
export type FindingsContract = z.infer<typeof findingsContractSchema>;
