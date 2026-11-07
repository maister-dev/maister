import { z } from "zod";

import { delegationTargetSchema } from "./delegation-target";

import { resultProfileNameSchema } from "@/lib/config.schema";

export const delegateBodySchema = z
  .object({
    // ADR-163: the wire shape lives in ONE module, imported by both delegation
    // entry points — exactly one of agentId / flowId, each arm strict.
    target: delegationTargetSchema,
    mode: z.enum(["task", "run"]),
    prompt: z.string().min(1),
    title: z.string().min(1).optional(),
    workspace: z.enum(["none", "repo_read", "worktree"]).optional(),
    // M37 Phase 10 (ADR-099): `own` (default) = per-run worktree; `shared` = N
    // children of this orchestrator tree share one pre-allocated tree (serialized
    // writers via the promote-time guard). Only meaningful for workspace=worktree.
    workspaceMode: z.enum(["own", "shared"]).optional(),
    runnerOverride: z.string().min(1).optional(),
    // M37 Phase 8 (ADR-099): a persistent child parks between turns and is
    // re-addressable by `addressableKey`; the key is REQUIRED when persistent.
    persistent: z.boolean().optional(),
    addressableKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    // ADR-165: a NAME, resolved server-side through the parent's pinned
    // `flow_revisions.result_profiles`. Validated at the SINK's invariant here
    // — it is a body-controlled identifier, and the shape is what keeps it from
    // ever reading as a path.
    resultProfile: resultProfileNameSchema.optional(),
  })
  .strict()
  .refine((b) => !b.persistent || b.addressableKey !== undefined, {
    message: "addressableKey is required when persistent is true",
    path: ["addressableKey"],
  });

export type DelegateBody = z.infer<typeof delegateBodySchema>;
