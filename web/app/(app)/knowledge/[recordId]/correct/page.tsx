import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import {
  KnowledgeHeader,
  KnowledgeUnavailable,
  knowledgePanelClass,
} from "@/components/brain/knowledge-view";
import { KnowledgeProposalForm } from "@/components/brain/knowledge-proposal-form";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { knowledgeRecordActions } from "@/lib/brain/knowledge-ui";
import { knowledgeReferenceView } from "@/lib/brain/knowledge-ui";

export default async function KnowledgeCorrectionPage({
  params,
}: {
  params: Promise<{ recordId: string }>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("knowledge");
  const { recordId } = await params;
  const principal = { kind: "user" as const, userId: user.id };
  const db = getDb();

  const view = await knowledgeReferenceView(async () => {
    const record = await getKnowledgeRecord(db, principal, { recordId });
    const actions = await knowledgeRecordActions(
      db,
      principal,
      record.owner,
      recordId,
    );

    return { record, actions };
  });

  if (view.state === "unavailable" || !view.value.actions.propose)
    return <KnowledgeUnavailable />;
  const { record } = view.value;

  return (
    <>
      <KnowledgeHeader title={t("correctionTitle")} />
      {record.assertionTruncated ? (
        <p className={`${knowledgePanelClass} text-sm text-mute`}>
          {t("truncatedCorrection")}
        </p>
      ) : (
        <KnowledgeProposalForm owners={[]} record={record} />
      )}
    </>
  );
}
