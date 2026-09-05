import type * as acp from "@agentclientprotocol/sdk";

import { pathToFileURL } from "node:url";

export type PromptRuntimeObjectBlock = {
  type: "runtime_object";
  objectId: string;
  name: string;
  mimeType?: string;
  description?: string;
};

export type PromptObjectResolver = {
  resolvePromptReference(input: {
    objectId: string;
    runId: string;
    assignmentId: string;
    assignmentEpoch: number;
  }): Promise<{ metadata: { mimeType: string }; path: string }>;
};

function isRuntimeObjectBlock(
  value: unknown,
): value is PromptRuntimeObjectBlock {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "runtime_object"
  );
}

// The object ID is resolved at the host trust boundary. The manager never sees
// the host-private path and ACP never receives the custom wrapper type.
export async function resolvePromptRuntimeObjects(input: {
  blocks: readonly unknown[] | undefined;
  resolver: PromptObjectResolver;
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
}): Promise<acp.ContentBlock[] | undefined> {
  if (!input.blocks || input.blocks.length === 0) return undefined;

  return Promise.all(
    input.blocks.map(async (block): Promise<acp.ContentBlock> => {
      if (!isRuntimeObjectBlock(block)) return block as acp.ContentBlock;
      const resolved = await input.resolver.resolvePromptReference({
        objectId: block.objectId,
        runId: input.runId,
        assignmentId: input.assignmentId,
        assignmentEpoch: input.assignmentEpoch,
      });

      return {
        type: "resource_link",
        uri: pathToFileURL(resolved.path).href,
        name: block.name,
        mimeType: block.mimeType ?? resolved.metadata.mimeType,
        ...(block.description ? { description: block.description } : {}),
      } as acp.ContentBlock;
    }),
  );
}
