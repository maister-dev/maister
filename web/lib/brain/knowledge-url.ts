import type { KnowledgeSearch } from "./knowledge-read-types";
import type { KnowledgeProposalList } from "./knowledge-write-types";
import type { Owner } from "@/lib/company/types";
import type { KnowledgeRecordSelector } from "./knowledge-records";
import type { KnowledgePageInput } from "./knowledge-read-types";

import { knowledgeSearchSchema } from "./knowledge-read-types";
import { knowledgeProposalListSchema } from "./knowledge-write-types";
import { knowledgeRevisionSchema } from "./knowledge-types";
import { knowledgePageInputSchema } from "./knowledge-read-types";

import { MaisterError } from "@/lib/errors";
import { postgresTextSchema } from "@/lib/text-schema";
import { ownerSchema } from "@/lib/company/types";

function ownerFromUrl(params: URLSearchParams): Owner | undefined {
  const kind = params.get("ownerKind");
  const id = params.get("ownerId");

  if (kind === null && id === null) return undefined;
  const parsed = ownerSchema.safeParse(
    kind === "company" ? { kind, companyId: id } : { kind, projectId: id },
  );

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Knowledge owner kind and bounded identity must be supplied together",
    );

  return parsed.data;
}

export function knowledgeProposalsFromUrl(
  params: URLSearchParams,
): KnowledgeProposalList {
  requireKnowledgeQueryKeys(params, [
    "ownerKind",
    "ownerId",
    "status",
    "limit",
    "cursor",
  ]);
  const limit = params.get("limit");

  if (limit !== null && !/^[1-9][0-9]*$/.test(limit))
    throw new MaisterError(
      "CONFIG",
      "Knowledge proposal page limit must be a bounded positive integer",
    );
  const parsed = knowledgeProposalListSchema.safeParse({
    owner: ownerFromUrl(params),
    status: params.get("status") ?? undefined,
    limit: limit === null ? undefined : Number(limit),
    cursor: params.get("cursor") ?? undefined,
  });

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid knowledge proposal list filters");

  return parsed.data;
}

export function knowledgeRecordSelector(
  recordId: string,
  revision: string | null,
): KnowledgeRecordSelector {
  if (
    !postgresTextSchema.min(1).max(128).safeParse(recordId).success ||
    (revision !== null &&
      (!/^[1-9][0-9]*$/.test(revision) ||
        !knowledgeRevisionSchema.safeParse(Number(revision)).success))
  )
    throw new MaisterError(
      "CONFIG",
      "Invalid native knowledge record selector",
    );

  return {
    recordId,
    revision: revision === null ? undefined : Number(revision),
  };
}

export function knowledgePageFromUrl(
  params: URLSearchParams,
): KnowledgePageInput {
  requireKnowledgeQueryKeys(params, ["revision", "limit", "cursor"]);
  const limit = params.get("limit");

  if (limit !== null && !/^[1-9][0-9]*$/.test(limit))
    throw new MaisterError(
      "CONFIG",
      "Knowledge page limit must be a bounded positive integer",
    );
  const parsed = knowledgePageInputSchema.safeParse({
    limit: limit === null ? undefined : Number(limit),
    cursor: params.get("cursor") ?? undefined,
  });

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid knowledge page selector");

  return parsed.data;
}

export function requireKnowledgeQueryKeys(
  params: URLSearchParams,
  keys: readonly string[],
): void {
  const present = [...params.keys()];

  if (
    present.some((key) => !keys.includes(key)) ||
    new Set(present).size !== present.length
  )
    throw new MaisterError(
      "CONFIG",
      "Unknown or repeated knowledge query parameter",
    );
}

export function knowledgeSearchFromUrl(
  params: URLSearchParams,
): KnowledgeSearch {
  requireKnowledgeQueryKeys(params, [
    "ownerKind",
    "ownerId",
    "q",
    "kind",
    "confirmation",
    "conflict",
    "freshness",
    "limit",
    "cursor",
  ]);
  const owner = ownerFromUrl(params);
  const rawLimit = params.get("limit");

  if (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit))
    throw new MaisterError(
      "CONFIG",
      "Knowledge page limit must be a bounded positive integer",
    );
  const parsed = knowledgeSearchSchema.safeParse({
    owner,
    q: params.get("q") ?? undefined,
    kind: params.get("kind") ?? undefined,
    confirmation: params.get("confirmation") ?? undefined,
    conflict: params.get("conflict") ?? undefined,
    freshness: params.get("freshness") ?? undefined,
    limit: rawLimit === null ? undefined : Number(rawLimit),
    cursor: params.get("cursor") ?? undefined,
  });

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid structured knowledge search");

  return parsed.data;
}
