import { z } from "zod";

import { STAND_ACTIONS } from "./operation-types";

import {
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import { ownerSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";

const targetIdentity = postgresTextSchema.min(1).max(128);
const componentId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const envReference = z.string().regex(/^env:[A-Z_][A-Z0-9_]{0,127}$/);
const httpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);

    return !url.username && !url.password && !url.hash;
  });
const endpoint = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);

    return (
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  })
  .transform((value) => new URL(value).origin);

export const standComponentSchema = z
  .object({
    id: componentId,
    serviceManager: z.literal("systemd"),
    scope: z.enum(["system", "user"]),
    user: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,9})$/)
      .refine((value) => Number(value) <= 4294967294)
      .nullable(),
    unit: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/),
    actions: z.array(z.enum(STAND_ACTIONS)).min(1).max(4),
    runbook: z
      .object({
        recordId: targetIdentity,
        revision: knowledgeRevisionSchema,
        witnessId: targetIdentity,
      })
      .strict(),
    healthProbe: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("systemd"),
          expectedState: z.literal("active"),
        })
        .strict(),
      z
        .object({
          kind: z.literal("http"),
          url: httpUrl,
          expectedStatus: z.number().int().min(100).max(599),
          expectedIdentity: postgresTextSchema.regex(/^[ -~]{1,256}$/),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine(
    ({ scope, user }) => (scope === "user") === (user !== null),
    "Systemd user scope requires an exact numeric UID",
  )
  .refine(
    ({ actions }) => new Set(actions).size === actions.length,
    "Stand component actions must be distinct",
  );

export const standTargetConnectionSchema = z
  .object({
    endpoint,
    serverIdentity: postgresTextSchema
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9.:[\]-]+$/),
    caEnv: envReference,
    certificateEnv: envReference,
    keyEnv: envReference,
    platformCredentialEnv: envReference,
    helperCredentialEnv: envReference,
    helperCertificateSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const standTargetInputSchema = standTargetConnectionSchema
  .extend({
    helperCertificateSha256: z.string().regex(/^[a-f0-9]{64}$/),
    owner: ownerSchema.options[0],
    incarnationId: z.uuid(),
    enabled: z.boolean(),
    components: z.array(standComponentSchema).min(1).max(32),
  })
  .strict()
  .refine(
    ({ components }) =>
      new Set(components.map(({ id }) => id)).size === components.length,
    "Stand component IDs must be distinct",
  );

export const standTargetUpdateSchema = standTargetInputSchema.safeExtend({
  expectedRevision: knowledgeRevisionSchema,
});
export const standTargetPageInputSchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    enabledOnly: z.literal(true).optional(),
  })
  .strict();

export const standTargetDeliveryKeySchema = knowledgeDeliveryKeySchema;

export type StandTargetInput = z.infer<typeof standTargetInputSchema>;
export type StandComponentConfig = z.infer<typeof standComponentSchema>;
export type StandTargetConnection = z.infer<typeof standTargetConnectionSchema>;
export type StandTarget = Readonly<{
  id: string;
  owner: StandTargetInput["owner"];
  incarnationId: string;
  configRevision: number;
  enabled: boolean;
  componentIds: readonly string[];
}>;
