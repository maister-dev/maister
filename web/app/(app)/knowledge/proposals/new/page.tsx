import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import {
  KnowledgeHeader,
  knowledgePanelClass,
} from "@/components/brain/knowledge-view";
import { KnowledgeProposalForm } from "@/components/brain/knowledge-proposal-form";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { knowledgeOwnerChoices } from "@/lib/brain/knowledge-ui";

export default async function NewKnowledgeProposalPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string }>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("knowledge");
  const owners = await knowledgeOwnerChoices(
    getDb(),
    { kind: "user", userId: user.id },
    "knowledge:propose",
  );
  const { owner } = await searchParams;
  const inherited = owners.find(
    (option) => option.owner.kind === "project" && option.value === owner,
  );

  return (
    <>
      <KnowledgeHeader title={t("newProposal")} />
      {owners.length === 0 ? (
        <p className={`${knowledgePanelClass} text-sm text-mute`}>
          {t("noOwners")}
        </p>
      ) : (
        <KnowledgeProposalForm inheritedOwner={inherited} owners={owners} />
      )}
    </>
  );
}
