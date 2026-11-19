import "server-only";

import type { ProjectVaultRoute } from "./project-route";
import type { PrepareVaultAccess } from "./store";

import { z } from "zod";

import { vaultErrorResponse } from "./http";
import { listMemoryBacklinks, listMemoryTags } from "./index-queries";
import { MAX_PAGE_ENTRIES } from "./limits";
import { memoryNotePath } from "./paths";
import { prepareProjectExecutionVault } from "./project-access";
import { withProjectVault } from "./project-route";
import { searchMemory } from "./search";
import { memoryLookupKey } from "./structure";

import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

const paging = {
  cursor: z.string().min(1).max(2048).optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(z.number().int().max(MAX_PAGE_ENTRIES))
    .prefault("20"),
};
const searchQuery = z
  .strictObject({
    ...paging,
    q: z
      .string()
      .max(2000)
      .refine((q) => !q.includes("\0") && q.isWellFormed())
      .trim()
      .min(1)
      .optional(),
    tag: z
      .string()
      .max(128)
      .transform(memoryLookupKey)
      .pipe(z.string().min(1).max(128))
      .optional(),
    mode: z.enum(["lexical", "vector"]).default("lexical"),
  })
  .refine(
    ({ q, mode, tag }) =>
      q !== undefined || (mode === "lexical" && tag !== undefined),
  );
const backlinksQuery = z.strictObject({
  ...paging,
  path: z.string().min(1).max(512),
});
const tagsQuery = z.strictObject(paging);

function parseQuery<T>(request: Request, schema: z.ZodType<T>): T {
  const params = new URL(request.url).searchParams;
  const query = Object.fromEntries(params);
  if (Object.keys(query).length !== params.size)
    throw new MaisterError("CONFIG", "Repeated memory query parameter");
  const parsed = schema.safeParse(query);
  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid memory index query");

  return parsed.data;
}

const readers = {
  search: (request: Request, prepare: PrepareVaultAccess) => {
    const query = parseQuery(request, searchQuery);

    return searchMemory(getDb(), { ...query, q: query.q ?? "" }, prepare);
  },
  backlinks: (
    request: Request,
    prepare: PrepareVaultAccess,
    includeStructure?: true,
  ) => {
    const query = parseQuery(request, backlinksQuery);

    return listMemoryBacklinks(
      getDb(),
      { ...query, path: memoryNotePath(query.path), includeStructure },
      prepare,
    );
  },
  tags: (request: Request, prepare: PrepareVaultAccess) =>
    listMemoryTags(getDb(), parseQuery(request, tagsQuery), prepare),
};

type VaultIndexResource = keyof typeof readers;

export function projectMemoryIndex(resource: VaultIndexResource) {
  return (request: Request, route: ProjectVaultRoute) =>
    withProjectVault(route, "readRepoFiles", async (prepare) =>
      privateJson(await readers[resource](request, prepare, true)),
    );
}

export function executionMemoryIndex(resource: VaultIndexResource) {
  const endpoint = `GET /api/v1/ext/agent/memory/${resource}`;

  return (request: Request) =>
    handleOwnedExt(
      request,
      { endpoint, method: "GET", scopeLabel: "agent_memory:read" },
      async ({ actor }) => {
        if (!actor.projectId)
          throw new MaisterError(
            "UNAUTHORIZED",
            "Project-bound agent credential required",
          );

        return privateJson(
          await readers[resource](
            request,
            prepareProjectExecutionVault(
              actor,
              actor.projectId,
              "agent_memory:read",
            ),
          ),
        );
      },
      (error) => vaultErrorResponse(error, endpoint),
    );
}
