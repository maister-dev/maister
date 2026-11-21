import type { ReactElement } from "react";
import type { KnowledgePageQuery } from "@/lib/brain/knowledge-page-query";

import { Button } from "@heroui/react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import {
  KnowledgeHeader,
  knowledgeFieldClass,
} from "@/components/brain/knowledge-view";
import { ProposalReviews } from "@/components/inbox/proposal-reviews";
import { requireActiveSession } from "@/lib/authz";
import { knowledgePageParams } from "@/lib/brain/knowledge-page-query";
import {
  knowledgeOwnerChoices,
  knowledgeOwnerSelection,
} from "@/lib/brain/knowledge-ui";
import { getDb } from "@/lib/db/client";
import {
  getProposalReviewCounter,
  listProposalReviews,
  parseReviewFilters,
  parseReviewSelector,
} from "@/lib/queries/knowledge-memory-reviews";

export default async function KnowledgeReviewPage({
  searchParams,
}: {
  searchParams: Promise<KnowledgePageQuery>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("knowledge");
  const params = knowledgePageParams(await searchParams);
  const owner = knowledgeOwnerSelection(params.get("owner") ?? undefined);
  const candidate: Record<string, string> = {};

  for (const key of [
    "kind",
    "projectId",
    "companyId",
    "agentId",
    "cursor",
    "view",
  ]) {
    const value = params.get(key);

    if (value !== null) candidate[key] = value;
  }

  if (owner?.kind === "project") candidate.projectId = owner.projectId;
  if (owner?.kind === "company") candidate.companyId = owner.companyId;
  const { limit, ...filters } = parseReviewFilters(candidate);
  const proposalId = params.get("proposalId");
  const initial = proposalId
    ? parseReviewSelector({
        kind: params.get("proposalKind") ?? params.get("kind"),
        id: proposalId,
      })
    : undefined;
  const db = getDb();
  const [page, owners, count] = await Promise.all([
    listProposalReviews(db, user.id, { ...filters, limit }),
    knowledgeOwnerChoices(
      db,
      { kind: "user", userId: user.id },
      "knowledge:read",
    ),
    getProposalReviewCounter(user.id),
  ]);
  const selectedOwner =
    owners.find(({ owner: choice }) =>
      choice.kind === "project"
        ? choice.projectId === filters.projectId
        : choice.companyId === filters.companyId,
    )?.value ?? "";

  return (
    <>
      <KnowledgeHeader title={t("reviewWorkspace")}>
        <Link href="/knowledge/proposals">{t("proposals")}</Link>
        <Link href="/inbox">{t("inboxLink")}</Link>
      </KnowledgeHeader>
      <form className="mb-4 flex flex-wrap items-end gap-3" method="get">
        {filters.view ? (
          <input name="view" type="hidden" value={filters.view} />
        ) : null}
        {filters.kind ? (
          <input name="kind" type="hidden" value={filters.kind} />
        ) : null}
        <label className="text-sm">
          {t("owner")}
          <select
            className={knowledgeFieldClass}
            defaultValue={selectedOwner}
            name="owner"
          >
            <option value="">{t("allAccessible")}</option>
            {owners.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.projectName ?? t("company")}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          {t("searchAction")}
        </Button>
      </form>
      <ProposalReviews
        key={JSON.stringify(filters)}
        workspace
        filters={filters}
        initial={initial}
        page={page}
        reviewVersion={count.reviewVersion}
      />
    </>
  );
}
