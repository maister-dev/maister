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
import { searchKnowledge } from "@/lib/brain/knowledge-search";
import {
  knowledgeOwnerChoices,
  knowledgeOwnerValue,
} from "@/lib/brain/knowledge-ui";
import {
  knowledgeSearchPageQuery,
  knowledgePageParams,
  knowledgeContinuationHref,
} from "@/lib/brain/knowledge-page-query";
import { KNOWLEDGE_KINDS } from "@/lib/brain/record-types";

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<KnowledgePageQuery>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("knowledge");
  const query = await searchParams;
  const input = knowledgeSearchPageQuery(query);
  const principal = { kind: "user" as const, userId: user.id };
  const db = getDb();
  const [page, owners, proposalOwners] = await Promise.all([
    searchKnowledge(db, principal, input),
    knowledgeOwnerChoices(db, principal, "knowledge:read"),
    knowledgeOwnerChoices(db, principal, "knowledge:propose"),
  ]);

  return (
    <>
      <KnowledgeHeader>
        {proposalOwners.length > 0 ? (
          <Link
            href={
              input.owner?.kind === "project"
                ? `/knowledge/proposals/new?${new URLSearchParams({ owner: knowledgeOwnerValue(input.owner) })}`
                : "/knowledge/proposals/new"
            }
          >
            {t("propose")}
          </Link>
        ) : null}
        {user.role === "admin" ? (
          <Link href="/settings/company-grants">{t("companyAccess")}</Link>
        ) : null}
      </KnowledgeHeader>
      <form
        action="/knowledge"
        className={`${knowledgePanelClass} mb-5 grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-4`}
        method="get"
      >
        <label className="text-sm sm:col-span-2">
          {t("search")}
          <input
            className={`${knowledgeFieldClass} mt-1`}
            defaultValue={input.q}
            maxLength={2000}
            name="q"
            type="search"
          />
        </label>
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
          {t("kind")}
          <select
            aria-label={t("kind")}
            className={`${knowledgeFieldClass} mt-1`}
            defaultValue={input.kind ?? ""}
            name="kind"
          >
            <option value="">{t("allKinds")}</option>
            {KNOWLEDGE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kindValue.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {t("confirmation")}
          <select
            aria-label={t("confirmation")}
            className={`${knowledgeFieldClass} mt-1`}
            defaultValue={input.confirmation ?? ""}
            name="confirmation"
          >
            <option value="">{t("allStates")}</option>
            {["unconfirmed", "confirmed", "revoked"].map((state) => (
              <option key={state} value={state}>
                {t(`state.${state}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {t("freshness")}
          <select
            aria-label={t("freshness")}
            className={`${knowledgeFieldClass} mt-1`}
            defaultValue={input.freshness ?? ""}
            name="freshness"
          >
            <option value="">{t("allStates")}</option>
            {["current", "stale", "unknown"].map((state) => (
              <option key={state} value={state}>
                {t(`state.${state}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {t("conflicts")}
          <select
            aria-label={t("conflicts")}
            className={`${knowledgeFieldClass} mt-1`}
            defaultValue={input.conflict ?? ""}
            name="conflict"
          >
            <option value="">{t("allStates")}</option>
            {["unresolved", "resolved"].map((state) => (
              <option key={state} value={state}>
                {t(`state.${state}`)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          {t("searchAction")}
        </Button>
      </form>
      {page.items.length === 0 ? (
        <p className={`${knowledgePanelClass} text-sm text-mute`} role="status">
          {t("empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t("records")}</caption>
            <thead className="border-b border-line bg-ivory text-xs text-mute">
              <tr>
                {[
                  "titleLabel",
                  "owner",
                  "basis",
                  "confirmation",
                  "freshness",
                ].map((key) => (
                  <th key={key} className="p-3" scope="col">
                    {t(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.items.map((record) => (
                <tr
                  key={record.id}
                  className="border-b border-line last:border-0"
                >
                  <td className="max-w-[44ch] p-3 align-top">
                    <Link
                      className="font-semibold text-ink underline"
                      href={`/knowledge/${encodeURIComponent(record.id)}`}
                    >
                      {record.title}
                    </Link>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-mute">
                      {record.assertionPreview}
                    </p>
                    {record.assertionTruncated ? (
                      <span className="text-xs text-mute">
                        {t("previewTruncated")}
                      </span>
                    ) : null}
                    {record.conflict.state !== "none_known" ? (
                      <p className="mt-2 text-xs text-amber">
                        {t("conflicts")}: {t(`state.${record.conflict.state}`)}
                      </p>
                    ) : null}
                  </td>
                  <td className="p-3 align-top">
                    <KnowledgeOwner owner={record.owner} />
                  </td>
                  <td className="p-3 align-top">
                    {t(`state.${record.basis}`)}
                  </td>
                  <td className="p-3 align-top">
                    {t(`state.${record.confirmationState}`)}
                  </td>
                  <td className="p-3 align-top">
                    {t(`state.${record.freshnessState}`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.nextCursor ? (
        <Link
          className="mt-5 inline-block text-sm underline"
          href={knowledgeContinuationHref(
            "/knowledge",
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
