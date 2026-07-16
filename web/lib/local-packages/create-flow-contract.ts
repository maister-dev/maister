import { z } from "zod";

import {
  flowMetadataLinkSchema,
  flowMetadataSourceSchema,
} from "@/lib/config.schema";

// This module intentionally stays client-safe: the Studio wizard and the API
// routes parse the exact same request shape, while filesystem work remains in
// the server-only local-package service.
const flowIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "Flow ID may contain letters, numbers, ., _ and -")
  .refine(
    (id) => id !== "." && id !== ".." && !id.includes(".."),
    "Flow ID cannot contain a traversal segment",
  );

export const localPackageNameSchema = z.string().trim().min(1).max(120);

export const createFlowInputSchema = z
  .object({
    id: flowIdSchema,
    metadata: z
      .object({
        title: z.string().trim().min(1).max(200),
        summary: z.string().trim().min(1).max(2_000),
        route_when: z.string().trim().min(1).max(2_000),
        labels: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
        links: z.array(flowMetadataLinkSchema).max(50).optional(),
        sources: z.array(flowMetadataSourceSchema).max(50).optional(),
      })
      .strict(),
  })
  .strict();

export const createLocalPackageWithFlowSchema = z
  .object({
    name: localPackageNameSchema,
    flow: createFlowInputSchema,
  })
  .strict();

export const createFlowInPackageSchema = z
  .object({ flow: createFlowInputSchema })
  .strict();

export type CreateFlowInput = z.infer<typeof createFlowInputSchema>;
export type CreateLocalPackageWithFlowInput = z.infer<
  typeof createLocalPackageWithFlowSchema
>;

export type StarterFlowManifest = {
  schemaVersion: 1;
  name: string;
  metadata: {
    title: string;
    summary: string;
    route_when: string;
    labels?: string[];
    links?: z.infer<typeof flowMetadataLinkSchema>[];
    sources?: z.infer<typeof flowMetadataSourceSchema>[];
  };
  compat: { engine_min: string };
  capabilities: string[];
  artifacts: string[];
  nodes: Array<{
    id: "start";
    type: "ai_coding";
    action: { prompt: string };
    transitions: { success: "done" };
  }>;
};

// A single terminal graph is deliberately useful without defining any runtime
// capability or setup command. It is valid at the current graph-only engine
// floor and performs no package code during creation.
export function buildStarterFlowManifest(
  input: CreateFlowInput,
): StarterFlowManifest {
  const metadata: StarterFlowManifest["metadata"] = {
    title: input.metadata.title,
    summary: input.metadata.summary,
    route_when: input.metadata.route_when,
  };

  if (input.metadata.labels && input.metadata.labels.length > 0) {
    metadata.labels = input.metadata.labels;
  }
  if (input.metadata.links && input.metadata.links.length > 0) {
    metadata.links = input.metadata.links;
  }
  if (input.metadata.sources && input.metadata.sources.length > 0) {
    metadata.sources = input.metadata.sources;
  }

  return {
    schemaVersion: 1,
    name: input.id,
    metadata,
    compat: { engine_min: "3.0.0" },
    capabilities: [],
    artifacts: [],
    nodes: [
      {
        id: "start",
        type: "ai_coding",
        action: {
          prompt: "Describe the work this Flow should perform.",
        },
        transitions: { success: "done" },
      },
    ],
  };
}
