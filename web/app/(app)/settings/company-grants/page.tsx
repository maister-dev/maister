import type { ReactElement } from "react";
import type { KnowledgePageQuery } from "@/lib/brain/knowledge-page-query";

import Link from "next/link";
import { getTranslations } from "next-intl/server";

import {
  KnowledgeDate,
  knowledgePanelClass,
} from "@/components/brain/knowledge-view";
import { CompanyGrantRevoke } from "@/components/brain/company-grant-revoke";
import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { listCompanyGrants } from "@/lib/company/grants";
import { companyGrantPageInputSchema } from "@/lib/company/grant-types";
import {
  knowledgePageParams,
  knowledgeContinuationHref,
} from "@/lib/brain/knowledge-page-query";
import { requireKnowledgeQueryKeys } from "@/lib/brain/knowledge-url";
import { MaisterError } from "@/lib/errors";

export default async function CompanyGrantsPage({
  searchParams,
}: {
  searchParams: Promise<KnowledgePageQuery>;
}): Promise<ReactElement> {
  const user = await requireGlobalRole("admin");
  const t = await getTranslations("knowledge");
  const params = knowledgePageParams(await searchParams);

  requireKnowledgeQueryKeys(params, ["limit", "cursor"]);
  const limit = params.get("limit");

  if (limit !== null && !/^[1-9][0-9]*$/.test(limit))
    throw new MaisterError("CONFIG", "Invalid company policy page size");
  const parsed = companyGrantPageInputSchema.safeParse({
    limit: limit === null ? undefined : Number(limit),
    cursor: params.get("cursor") ?? undefined,
  });

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid company authority page selector");
  const page = await listCompanyGrants(getDb(), user.id, parsed.data);

  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold tracking-[-0.025em] text-ink">
            {t("grantTitle")}
          </h1>
          <p className="mt-2 max-w-[70ch] text-sm text-mute">
            {t("grantSubtitle")}
          </p>
        </div>
        <nav className="flex gap-4 text-sm">
          <Link className="underline" href="/knowledge">
            {t("records")}
          </Link>
          <Link className="underline" href="/settings/company-grants/new">
            {t("grantAccess")}
          </Link>
        </nav>
      </header>
      {page.items.length === 0 ? (
        <p className={`${knowledgePanelClass} text-sm text-mute`}>
          {t("noGrants")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t("grantHistory")}</caption>
            <thead className="border-b border-line bg-ivory text-xs text-mute">
              <tr>
                {[
                  "principal",
                  "permission",
                  "createdBy",
                  "createdAt",
                  "revokedAt",
                  "actions",
                ].map((key) => (
                  <th key={key} className="p-3" scope="col">
                    {t(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.items.map((grant) => (
                <tr
                  key={grant.id}
                  className="border-b border-line last:border-0"
                >
                  <td className="p-3 align-top">
                    {t(`actor.${grant.principalKind}`)}
                    <span className="mt-1 block max-w-[24ch] break-all font-mono text-xs text-mute">
                      {grant.principalId}
                    </span>
                  </td>
                  <td className="p-3 align-top">
                    {t(`action.${grant.action}`)}
                    {grant.confirmationClasses.length > 0 ? (
                      <p className="mt-2 text-xs text-mute">
                        {grant.confirmationClasses
                          .map((kind) => t(`kindValue.${kind}`))
                          .join(", ")}
                      </p>
                    ) : null}
                    <p className="mt-2 text-xs text-mute">
                      {t("revision")} {grant.revision}
                    </p>
                  </td>
                  <td className="max-w-[20ch] break-all p-3 align-top font-mono text-xs">
                    {grant.createdBy}
                  </td>
                  <td className="p-3 align-top text-xs">
                    <KnowledgeDate value={grant.createdAt} />
                  </td>
                  <td className="max-w-[30ch] p-3 align-top text-xs">
                    {grant.revokedAt === null ? (
                      t("active")
                    ) : (
                      <>
                        <KnowledgeDate value={grant.revokedAt} />
                        <p className="mt-2 whitespace-pre-wrap break-words text-mute">
                          {grant.revocationReason}
                        </p>
                        <p className="mt-2 break-all font-mono text-mute">
                          {grant.revokedBy}
                        </p>
                      </>
                    )}
                  </td>
                  <td className="p-3 align-top">
                    {grant.revokedAt === null ? (
                      <CompanyGrantRevoke
                        grantId={grant.id}
                        revision={grant.revision}
                      />
                    ) : (
                      t("revoked")
                    )}
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
            "/settings/company-grants",
            params,
            page.nextCursor,
          )}
        >
          {t("next")}
        </Link>
      ) : null}
    </>
  );
}
