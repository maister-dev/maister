import type { AgentTerminalOutcome } from "@/lib/agents/finalization";
import type { AgentResultDecision } from "@/lib/run-results/agent-result";
import type { OperationalIntegrityResult } from "@/lib/agents/operational-integrity";
import type { OperationalTerminal } from "@/lib/run-results/operational-types";

import { parseOperationalResult } from "@/lib/run-results/operational-schema";

export function operationalTerminalDecision(input: {
  requested: AgentTerminalOutcome;
  result: AgentResultDecision;
  integrity: OperationalIntegrityResult;
}): Omit<
  OperationalTerminal,
  "resultRevision" | "baselineGeneration" | "evidenceIds"
> {
  const reported =
    input.result.kind === "valid"
      ? parseOperationalResult(input.result.value)
      : null;
  const validation =
    input.result.kind === "valid" && reported
      ? "valid"
      : input.result.kind === "invalid"
        ? "invalid"
        : "unchecked";
  const reasons = [
    ...input.integrity.reasonCodes,
    ...(input.result.kind === "invalid" ? [input.result.reason] : []),
  ];

  if (input.requested === "Abandoned" || input.requested === "Crashed")
    return {
      version: 1,
      status: input.requested,
      cause:
        input.requested === "Abandoned"
          ? "operational_cancelled"
          : "operational_crashed",
      effectiveOutcome:
        input.requested === "Abandoned" ? "cancelled" : "crashed",
      successful: false,
      validation,
      integrity: input.integrity.verdict,
      reasonCodes: [...new Set(reasons)],
    };
  const clean =
    input.requested === "Done" &&
    validation === "valid" &&
    input.integrity.verdict === "clean";
  const effectiveOutcome = clean && reported ? reported.outcome : "failed";
  const successful = effectiveOutcome === "success";
  const cause =
    input.requested === "Failed"
      ? "operational_execution_failed"
      : validation !== "valid"
        ? "operational_result_invalid"
        : input.integrity.verdict !== "clean"
          ? "operational_integrity_refused"
          : `operational_${effectiveOutcome}`;

  return {
    version: 1,
    status: successful ? "Done" : "Failed",
    cause,
    effectiveOutcome,
    successful,
    validation,
    integrity: input.integrity.verdict,
    reasonCodes: [...new Set([...reasons, ...(successful ? [] : [cause])])],
  };
}
