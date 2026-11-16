import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  NativeDelegationInput,
  NativeDelegationTarget,
} from "./native-input-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import {
  nativeDelegationInputContentSchema,
  nativeDelegationInputSchema,
} from "./native-input-types";

import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { authorizeRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import { unavailableKnowledgeReference } from "@/lib/brain/knowledge-restrictions";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";

const log = pino({
  name: "native-delegation-input",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Capture current source policy and actual origin under the existing parent lock before a carrier can become visible. */
export async function captureNativeDelegationInput(
  tx: Db,
  principal: Readonly<{ kind: "token"; tokenId: string }>,
  input: Readonly<{
    sourceRunId: string;
    target: NativeDelegationTarget;
    title: string;
    prompt: string;
  }>,
): Promise<NativeDelegationInput | null> {
  const row = (
    await tx.execute(
      sql`SELECT project_id,knowledge_access,result_contract->>'nativeContract' AS native_contract FROM runs WHERE id=${input.sourceRunId} FOR NO KEY UPDATE`,
    )
  ).rows[0];

  if (!row) throw unavailableKnowledgeReference();
  if (
    row.knowledge_access === null &&
    row.native_contract !== FINDINGS_CONTRACT
  )
    return null;
  const capture = knowledgeAccessCaptureSchema.safeParse(row.knowledge_access);

  if (!capture.success || capture.data.state !== "complete")
    throw unavailableKnowledgeReference();
  await authorizeRunKnowledgeDisclosure(tx, principal, input.sourceRunId);
  const identity = await resolveKnowledgePrincipal(
    tx,
    principal,
    "knowledge:read",
  );

  if (
    identity.actor.kind !== "agent" ||
    identity.actor.runId !== input.sourceRunId
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Native delegated input requires its actual originating professional execution",
    );
  if (typeof row.project_id !== "string") throw unavailableKnowledgeReference();
  if (input.target.kind === "agent") {
    await resolveEffectiveAgentDefinition(
      { agentId: input.target.id, projectId: row.project_id },
      tx,
    );
  } else {
    const target = (
      await tx.execute(
        sql`SELECT id FROM flows WHERE id=${input.target.id} AND project_id=${row.project_id}`,
      )
    ).rows[0];

    if (!target)
      throw new MaisterError(
        "UNAUTHORIZED",
        "The native delegation target is unavailable in the originating project",
      );
  }
  const content = nativeDelegationInputContentSchema.safeParse({
    schemaVersion: 1,
    sourceRunId: input.sourceRunId,
    sourceGeneration: capture.data.generation,
    sourceActor: identity.actor,
    sourceRestrictions: capture.data.restrictions,
    target: input.target,
    title: input.title,
    prompt: input.prompt,
  });

  if (!content.success)
    throw new MaisterError(
      "CONFIG",
      "Native delegated input exceeds its bounded contract",
    );
  const snapshot: NativeDelegationInput = {
    ...content.data,
    inputDigest: contentDigest(content.data),
  };

  log.debug(
    {
      sourceRunId: input.sourceRunId,
      generation: capture.data.generation,
      targetKind: input.target.kind,
      inputDigest: snapshot.inputDigest,
      promptBytes: Buffer.byteLength(input.prompt),
    },
    "private delegated input captured before shared carrier creation",
  );

  return snapshot;
}

/** Retained input is never reconstructed from a public placeholder or a changed live catalog. */
export function inspectNativeDelegationInput(
  value: unknown,
): NativeDelegationInput {
  const parsed = nativeDelegationInputSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The retained native delegation input is invalid",
    );
  const { inputDigest, ...content } = parsed.data;

  if (
    content.sourceActor.kind !== "agent" ||
    content.sourceActor.runId !== content.sourceRunId ||
    inputDigest !== contentDigest(content)
  )
    throw new MaisterError(
      "CRASH",
      "The retained native delegation input does not match its source witness",
    );

  return parsed.data;
}

/** A shared carrier cannot be launched without its exact retained private intent. */
export function assertNativeFlowInputBinding(
  input: Readonly<{
    taskId: string;
    taskInput: unknown;
    launchInput: unknown;
    parentRunId: string | undefined;
    carrierTaskId: string | undefined;
    target: NativeDelegationTarget | undefined;
  }>,
): NativeDelegationInput | null {
  if (input.taskInput === undefined && input.launchInput === undefined)
    return null;
  if (input.taskInput === undefined || input.launchInput === undefined) {
    throw new MaisterError(
      "PRECONDITION",
      "Continue native delegated work through its originating execution so the retained input remains bound to the launch",
      {
        details: { reason: "native_delegation_input_binding_required" },
      },
    );
  }
  const intent = inspectNativeDelegationInput(input.taskInput);
  const snapshot = inspectNativeDelegationInput(input.launchInput);

  if (
    intent.inputDigest !== snapshot.inputDigest ||
    snapshot.sourceRunId !== input.parentRunId ||
    snapshot.target.kind !== input.target?.kind ||
    snapshot.target.id !== input.target.id ||
    input.carrierTaskId !== input.taskId
  ) {
    throw new MaisterError(
      "PRECONDITION",
      "Native delegated input does not match the originating run, carrier and Flow",
      {
        details: { reason: "native_delegation_input_binding_required" },
      },
    );
  }

  return snapshot;
}

/** Agent launches bind private queued intent, while taskless children bind their direct input. */
export function assertNativeAgentInputBinding(
  input: Readonly<{
    taskId: string | null;
    taskInput: unknown;
    launchInput: unknown;
    parentRunId: string | null;
    agentId: string;
  }>,
): NativeDelegationInput | null {
  if (input.taskInput === undefined && input.launchInput === undefined)
    return null;
  if (
    input.launchInput === undefined ||
    (input.taskId !== null && input.taskInput === undefined)
  )
    throw new MaisterError(
      "PRECONDITION",
      "Native delegated work requires its retained private input binding",
      {
        details: { reason: "native_delegation_input_binding_required" },
      },
    );
  const snapshot = inspectNativeDelegationInput(input.launchInput);
  const intent =
    input.taskInput === undefined
      ? null
      : inspectNativeDelegationInput(input.taskInput);

  if (
    (intent && intent.inputDigest !== snapshot.inputDigest) ||
    snapshot.sourceRunId !== input.parentRunId ||
    snapshot.target.kind !== "agent" ||
    snapshot.target.id !== input.agentId
  )
    throw new MaisterError(
      "PRECONDITION",
      "Native delegated input does not match its retained agent target and originating run",
      {
        details: { reason: "native_delegation_input_binding_required" },
      },
    );

  return snapshot;
}

/** Frozen private bodies can enter execution only with their entire source closure. */
export function nativeDelegationExecutionInput(
  value: unknown,
  binding: Readonly<{
    parentRunId: string | null;
    target: NativeDelegationTarget;
    knowledgeAccess: unknown;
  }>,
): NativeDelegationInput {
  const input = inspectNativeDelegationInput(value);
  const capture = knowledgeAccessCaptureSchema.safeParse(
    binding.knowledgeAccess,
  );

  if (
    !capture.success ||
    capture.data.state !== "complete" ||
    input.sourceRunId !== binding.parentRunId ||
    input.target.kind !== binding.target.kind ||
    input.target.id !== binding.target.id ||
    !input.sourceRestrictions.every((source) =>
      capture.data.restrictions.some(
        (retained) => contentDigest(source) === contentDigest(retained),
      ),
    )
  )
    throw new MaisterError(
      "PRECONDITION",
      "Native execution input does not match its frozen source and target binding",
    );

  return input;
}
