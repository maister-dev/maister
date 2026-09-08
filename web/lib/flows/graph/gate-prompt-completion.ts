import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { GateVerdict } from "@/lib/db/schema";
import type { PromptOwnerOutcome } from "@/lib/execution-host/prompt-owners";
import type { FlowOwnerRef } from "./prompt-owner-authority";

import { eq } from "drizzle-orm";

import { compileManifest } from "./compile";
import { loadRun } from "./runner-core";
import {
  appendGateOutput,
  emptyGateOutput,
  calibrateVerdict,
  isPassVerdict,
} from "./gate-verdict";

import { nodeAttempts } from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

export type GatePromptCompletion = Readonly<{
  flowRevisionId: string | null;
  gateKind: "ai_judgment" | "skill_check";
  status: "passed" | "failed";
  verdict: GateVerdict;
}>;

/** Decode the full verified output with the evaluation's manifest and
 * calibration. Ordinary application and an explicit handoff share this path.
 */
export async function decodeGatePromptCompletion(input: {
  db: Db;
  ref: Extract<FlowOwnerRef, { variant: "gate_ai" | "gate_skill" }>;
  outcome: PromptOwnerOutcome;
}): Promise<GatePromptCompletion> {
  const { db, ref, outcome } = input;
  const loaded = await loadRun(db, ref.runId);
  const [attempt] = await db
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, ref.nodeAttemptId))
    .limit(1);

  if (!attempt || attempt.runId !== ref.runId)
    throw new PromptOwnerInvariantError("gate_owner_attempt_missing");
  const node = compileManifest(loaded.manifest).nodes.get(attempt.nodeId);
  const gate = node?.gates.find((candidate) => candidate.id === ref.gateId);
  const gateKind = ref.variant === "gate_skill" ? "skill_check" : "ai_judgment";

  if (!node || !gate || gate.kind !== gateKind)
    throw new PromptOwnerInvariantError("gate_owner_definition_missing");
  let output = emptyGateOutput();

  if (outcome.state === "succeeded") {
    for await (const event of outcome.events) {
      const update = event.payload?.update;

      if (
        event.eventType !== "session.update" ||
        typeof update !== "object" ||
        update === null ||
        !("sessionUpdate" in update) ||
        update.sessionUpdate !== "agent_message_chunk" ||
        !("content" in update)
      )
        continue;
      const content = update.content;

      if (
        typeof content === "object" &&
        content !== null &&
        "type" in content &&
        content.type === "text" &&
        "text" in content &&
        typeof content.text === "string"
      )
        output = appendGateOutput(output, content.text);
    }
  }
  const parsed =
    outcome.state === "succeeded" && outcome.response.stopReason === "end_turn"
      ? output.verdict
      : null;
  let verdict: GateVerdict = parsed ?? {
    verdict: "unparseable",
    reasons: [output.evidence],
  };
  let passed = parsed !== null && node.decide?.from === "verdict";

  if (parsed && !passed && isPassVerdict(parsed.verdict ?? "")) {
    const calibrated = calibrateVerdict(parsed, gate.calibration);

    passed = calibrated.pass;
    if (calibrated.calibration)
      verdict = { ...parsed, calibration: calibrated.calibration };
  }

  return {
    flowRevisionId: loaded.run.flowRevisionId,
    gateKind,
    status: passed ? "passed" : "failed",
    verdict,
  };
}
