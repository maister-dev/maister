import type { KnowledgeSearch } from "./knowledge-read-types";
import type { KnowledgeProposalList } from "./knowledge-write-types";

import { knowledgeOwnerSelection } from "./knowledge-ui";
import {
  knowledgeSearchFromUrl,
  knowledgeProposalsFromUrl,
} from "./knowledge-url";

import { MaisterError } from "@/lib/errors";

export type KnowledgePageQuery = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export function knowledgePageParams(
  query: KnowledgePageQuery,
): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value))
      throw new MaisterError("CONFIG", "Repeated knowledge filter");
    if (typeof value === "string" && value !== "") params.set(key, value);
  }

  return params;
}

function nativeParams(query: KnowledgePageQuery): URLSearchParams {
  const params = knowledgePageParams(query);
  const owner = knowledgeOwnerSelection(params.get("owner") ?? undefined);

  params.delete("owner");
  if (params.has("ownerKind") || params.has("ownerId"))
    throw new MaisterError("CONFIG", "Use the knowledge owner selector");
  if (owner !== undefined) {
    params.set("ownerKind", owner.kind);
    params.set(
      "ownerId",
      owner.kind === "company" ? owner.companyId : owner.projectId,
    );
  }

  return params;
}

export function knowledgeSearchPageQuery(
  query: KnowledgePageQuery,
): KnowledgeSearch {
  return knowledgeSearchFromUrl(nativeParams(query));
}
export function knowledgeReviewPageQuery(
  query: KnowledgePageQuery,
): KnowledgeProposalList {
  return knowledgeProposalsFromUrl(nativeParams(query));
}

export function knowledgeContinuationHref(
  path: string,
  params: URLSearchParams,
  cursor: string,
): string {
  const next = new URLSearchParams(params);

  next.set("cursor", cursor);

  return `${path}?${next.toString()}`;
}
