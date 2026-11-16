import type { ReactElement } from "react";
import type { KnowledgePageQuery } from "@/lib/brain/knowledge-page-query";

import Link from "next/link";
import { Button, Input } from "@heroui/react";
import { getTranslations } from "next-intl/server";

import { CompanyGrantForm } from "@/components/brain/company-grant-form";
import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { listCompanyPrincipalOptions } from "@/lib/company/principal-options";
import { knowledgePageParams } from "@/lib/brain/knowledge-page-query";
import { requireKnowledgeQueryKeys } from "@/lib/brain/knowledge-url";

export default async function NewCompanyGrantPage({
  searchParams,
}: {
  searchParams: Promise<KnowledgePageQuery>;
}): Promise<ReactElement> {
  const user = await requireGlobalRole("admin");
  const t = await getTranslations("knowledge");
  const params = knowledgePageParams(await searchParams);

  requireKnowledgeQueryKeys(params, ["q"]);
  const q = params.get("q") ?? "";
  const principals = await listCompanyPrincipalOptions(getDb(), user.id, q);

  return (
    <>
      <header className="mb-6">
        <Link className="text-sm underline" href="/settings/company-grants">
          {t("grantsBack")}
        </Link>
        <h1 className="mt-4 text-[28px] font-semibold tracking-[-0.025em] text-ink">
          {t("grantAccess")}
        </h1>
        <p className="mt-2 max-w-[70ch] text-sm text-mute">
          {t("grantSubtitle")}
        </p>
      </header>
      <form
        action="/settings/company-grants/new"
        className="mb-5 flex max-w-4xl items-end gap-3"
        method="get"
      >
        <label className="flex-1 text-sm">
          {t("searchPrincipal")}
          <Input defaultValue={q} maxLength={200} name="q" type="search" />
        </label>
        <Button type="submit" variant="secondary">
          {t("searchAction")}
        </Button>
      </form>
      <CompanyGrantForm key={q} principals={principals} />
    </>
  );
}
