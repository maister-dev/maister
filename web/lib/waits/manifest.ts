import { z } from "zod";

import {
  MAX_WAIT_SECONDS,
  RESERVED_SIGNAL_OUTCOMES,
} from "@/lib/waits/contracts";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .refine(
    (value) => !["constructor", "prototype", "__proto__"].includes(value),
  );

// Match the provider label exactly. Provider job names may contain spaces and
// punctuation, while control characters are unsuitable for reports.
const providerCheckLabel = z
  .string()
  .min(1)
  .max(256)
  .refine((label) => label.trim().length > 0 && !/\p{Cc}/u.test(label));

export const waitSeconds = z.number().int().positive().max(MAX_WAIT_SECONDS);
const outcomeLabel = identifier.refine(
  (value) => !RESERVED_SIGNAL_OUTCOMES.includes(value),
  "signal outcome is reserved by the wait engine",
);

function boundedSchema(value: z.infer<ReturnType<typeof z.json>>): boolean {
  const pending = [{ value, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.pop()!;

    if (current.depth > 16) return false;
    if (current.value === null || typeof current.value !== "object") continue;

    for (const [key, child] of Object.entries(current.value)) {
      if (
        key === "$ref" &&
        (typeof child !== "string" || !child.startsWith("#"))
      ) {
        return false;
      }

      pending.push({ value: child, depth: current.depth + 1 });
    }
  }

  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16 * 1024
  );
}

const payloadSchema = z
  .union([z.boolean(), z.record(z.string(), z.json())])
  .refine(
    boundedSchema,
    "payload_schema must be bounded and may only use local references",
  );

export const waitConditionSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("timer"),
      after: waitSeconds.optional(),
      until: z.iso.datetime({ offset: true }).optional(),
    })
    .refine(
      ({ after, until }) => (after === undefined) !== (until === undefined),
      {
        message: "timer requires exactly one of after or until",
      },
    ),
  z.strictObject({
    kind: z.literal("comment"),
    actor: z
      .strictObject({ type: z.enum(["user", "agent"]), id: identifier })
      .optional(),
  }),
  z
    .strictObject({
      kind: z.literal("run"),
      run_id: identifier,
      relation: z.enum(["parent", "child"]).optional(),
      relation_id: identifier.optional(),
    })
    .refine(
      ({ relation, relation_id }) =>
        (relation === undefined) !== (relation_id === undefined),
      {
        message: "run wait requires one direct or task relation selector",
      },
    ),
  z.strictObject({
    kind: z.literal("signal"),
    name: identifier,
    outcomes: z
      .array(outcomeLabel)
      .min(1)
      .max(32)
      .refine(
        (labels) => new Set(labels).size === labels.length,
        "signal outcomes must be unique",
      ),
    payload_schema: payloadSchema.optional(),
    bind: z.literal("head_sha").optional(),
  }),
  z
    .strictObject({
      kind: z.literal("ci"),
      publication: identifier,
      transport: z.enum(["push", "pull"]),
      name: identifier.optional(),
      checks: z
        .array(providerCheckLabel)
        .min(1)
        .max(32)
        .refine((items) => new Set(items).size === items.length),
      issuer: identifier,
      provider_issuer: identifier.optional(),
    })
    .refine(
      (condition) =>
        (condition.transport === "push") === (condition.name !== undefined),
      "CI push requires a signal name",
    )
    .refine(
      (condition) =>
        condition.provider_issuer === undefined ||
        condition.transport === "push",
      "provider_issuer applies only to push CI",
    ),
  z.strictObject({ kind: z.literal("pr"), publication: identifier }),
]);

export type WaitCondition = z.infer<typeof waitConditionSchema>;

export function waitOutcomes(condition: WaitCondition): readonly string[] {
  switch (condition.kind) {
    case "timer":
      return ["elapsed", "timeout", "cancelled"];
    case "comment":
      return ["commented", "timeout", "cancelled"];
    case "run":
      return [
        "done",
        "failed",
        "review",
        "crashed",
        "abandoned",
        "timeout",
        "cancelled",
      ];
    case "signal":
      return [
        ...condition.outcomes,
        "timeout",
        "cancelled",
        ...(condition.bind === "head_sha" ? ["stale"] : []),
      ];
    case "ci":
      return ["success", "failure", "cancelled", "timeout", "stale"];
    case "pr":
      return ["merged", "closed", "conflict", "timeout", "cancelled", "stale"];
  }
}

export function waitTransitionError(
  condition: WaitCondition,
  transitions: Readonly<Record<string, unknown>>,
  exhaustion: string | undefined,
): string | null {
  const outcomes = waitOutcomes(condition);

  for (const outcome of outcomes) {
    if (!Object.hasOwn(transitions, outcome)) return `must route "${outcome}"`;
  }

  for (const key of Object.keys(transitions)) {
    if (!outcomes.includes(key) && key !== exhaustion)
      return `cannot produce "${key}"`;
  }

  return null;
}
