import type { ReactElement } from "react";
import type { KnowledgePageQuery } from "@/lib/brain/knowledge-page-query";

import Link from "next/link";
import { Button } from "@heroui/react";
import { getTranslations } from "next-intl/server";

import {
  KnowledgeHeader,
  KnowledgeOwner,
  knowledgeFieldClass,
  knowledgePanelClass,
} from "@/components/brain/knowledge-view";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { listKnowledgeProposals } from "@/lib/brain/knowledge-proposal-read";
import {
  knowledgeOwnerChoices,
  knowledgeOwnerValue,
} from "@/lib/brain/knowledge-ui";
import {
  knowledgeReviewPageQuery,
  knowledgePageParams,
  knowledgeContinuationHref,
} from "@/lib/brain/knowledge-page-query";

export default async function KnowledgeProposalsPage({
  searchParams,
}: {
  searchParams: Promise<KnowledgePageQuery>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("knowledge");
  const query = await searchParams;
  const input = knowledgeReviewPageQuery(query);
  const principal = { kind: "user" as const, userId: user.id };
  const db = getDb();
  const [page, owners, proposalOwners] = await Promise.all([
    listKnowledgeProposals(db, principal, input),
    knowledgeOwnerChoices(db, principal, "knowledge:review"),
    knowledgeOwnerChoices(db, principal, "knowledge:propose"),
  ]);

  return (
    <>
      <KnowledgeHeader title={t("proposals")}>
        {proposalOwners.length > 0 ? (
          <Link href="/knowledge/proposals/new">{t("propose")}</Link>
        ) : null}
      </KnowledgeHeader>
      <form
        action="/knowledge/proposals"
        className={`${knowledgePanelClass} mb-5 flex flex-wrap items-end gap-3`}
        method="get"
      >
        <label className="text-sm">
          {t("owner")}
          <select
            aria-label={t("owner")}
            className={`${knowledgeFieldClass} mt-1`}
            defaultValue={input.owner ? knowledgeOwnerValue(input.owner) : ""}
            name="owner"
          >
            <option value="">{t("allAccessible")}</option>
            {owners.map((owner) => (
              <option key={owner.value} value={owner.value}>
                {owner.projectName ?? t("company")}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {t("publication")}
          <select
            aria-label={t("publication")}
            className={`${knowledgeFieldClass} mt-1`}
            defaultValue={input.status ?? ""}
            name="status"
          >
            <option value="">{t("allStates")}</option>
            {["pending", "accepted", "rejected"].map((state) => (
              <option key={state} value={state}>
                {t(`state.${state}`)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          {t("filter")}
        </Button>
      </form>
      {page.items.length === 0 ? (
        <p className={`${knowledgePanelClass} text-sm text-mute`} role="status">
          {t("emptyProposals")}
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper">
          {page.items.map((proposal) => (
            <li key={proposal.id} className="p-5">
              <div className="flex flex-wrap justify-between gap-3">
                <Link
                  className="font-semibold text-ink underline"
                  href={`/knowledge/proposals/${encodeURIComponent(proposal.id)}`}
                >
                  {proposal.title}
                </Link>
                <span className="text-sm">{t(`state.${proposal.status}`)}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-mute">
                {proposal.assertionPreview}
              </p>
              <p className="mt-3 text-xs">
                <KnowledgeOwner owner={proposal.owner} /> ·{" "}
                {t(`state.${proposal.basis}`)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor ? (
        <Link
          className="mt-5 inline-block text-sm underline"
          href={knowledgeContinuationHref(
            "/knowledge/proposals",
            knowledgePageParams(query),
            page.nextCursor,
          )}
        >
          {t("next")}
        </Link>
      ) : null}
    </>
  );
}
