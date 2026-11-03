import type { ReactElement } from "react";
import type { KnowledgePageQuery } from "@/lib/brain/knowledge-page-query";

import Link from "next/link";
import { getTranslations } from "next-intl/server";

import {
  KnowledgeActor,
  KnowledgeDate,
  KnowledgeEvidence,
  KnowledgeHeader,
  KnowledgeOwner,
  KnowledgeUnavailable,
  knowledgePanelClass,
} from "@/components/brain/knowledge-view";
import { KnowledgeConfirmation } from "@/components/brain/knowledge-decision-controls";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { getKnowledgeConflictsPage } from "@/lib/brain/knowledge-conflicts";
import { knowledgeRecordActions } from "@/lib/brain/knowledge-ui";
import {
  knowledgeRecordSelector,
  requireKnowledgeQueryKeys,
} from "@/lib/brain/knowledge-url";
import { knowledgePageParams } from "@/lib/brain/knowledge-page-query";
import { knowledgeReferenceView } from "@/lib/brain/knowledge-ui";

export default async function KnowledgeRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ recordId: string }>;
  searchParams: Promise<KnowledgePageQuery>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("knowledge");
  const { recordId } = await params;
  const query = knowledgePageParams(await searchParams);

  requireKnowledgeQueryKeys(query, ["revision", "conflictCursor"]);
  const selector = knowledgeRecordSelector(recordId, query.get("revision"));
  const principal = { kind: "user" as const, userId: user.id };
  const db = getDb();

  const view = await knowledgeReferenceView(async () => {
    const record = await getKnowledgeRecord(db, principal, selector);
    const [actions, conflicts] = await Promise.all([
      knowledgeRecordActions(db, principal, record.owner, recordId),
      getKnowledgeConflictsPage(
        db,
        principal,
        { recordId, revision: record.revision },
        { limit: 20, cursor: query.get("conflictCursor") ?? undefined },
      ),
    ]);

    return { record, actions, conflicts };
  });

  if (view.state === "unavailable") return <KnowledgeUnavailable />;
  const { record, actions, conflicts } = view.value;
  const conflictParams = new URLSearchParams(query);

  if (conflicts.nextCursor !== null)
    conflictParams.set("conflictCursor", conflicts.nextCursor);

  return (
    <>
      <KnowledgeHeader title={record.title}>
        {actions.propose &&
        !record.assertionTruncated &&
        !query.has("revision") ? (
          <Link href={`/knowledge/${encodeURIComponent(recordId)}/correct`}>
            {t("correct")}
          </Link>
        ) : null}
      </KnowledgeHeader>
      {query.has("revision") ? (
        <p className={`${knowledgePanelClass} mb-5 text-sm`}>
          {t("historical")}{" "}
          <Link
            className="underline"
            href={`/knowledge/${encodeURIComponent(recordId)}`}
          >
            {t("currentRecord")}
          </Link>
        </p>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <section className={knowledgePanelClass}>
            <h2 className="mb-3 font-semibold text-ink">{t("assertion")}</h2>
            <p className="whitespace-pre-wrap break-words text-[14px] leading-7 text-ink">
              {record.assertion}
            </p>
            {record.assertionTruncated ? (
              <p className="mt-2 text-sm text-mute">{t("previewTruncated")}</p>
            ) : null}
            <dl className="mt-5 grid gap-4 border-t border-line pt-4 text-sm sm:grid-cols-2">
              {[
                ["kind", t(`kindValue.${record.kind}`)],
                ["basis", t(`state.${record.basis}`)],
                ["confirmation", t(`state.${record.confirmation.state}`)],
                ["freshness", t(`state.${record.freshness.state}`)],
                [
                  "applicability",
                  record.freshness.applicability === "known"
                    ? t("known")
                    : t("unknown"),
                ],
                ["visibility", t(record.visibility)],
                ["lifecycle", t(`state.${record.lifecycle}`)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-mute">{t(label)}</dt>
                  <dd className="mt-1 font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <KnowledgeEvidence evidence={record.evidence} />
          <section className={knowledgePanelClass}>
            <h2 className="mb-3 font-semibold text-ink">{t("limitations")}</h2>
            {record.limitations.length === 0 &&
            record.missingEvidence.length === 0 ? (
              <p className="text-sm text-mute">{t("noLimitations")}</p>
            ) : (
              <ul className="list-inside list-disc space-y-2 text-sm text-mute">
                {record.limitations.map((item, index) => (
                  <li key={`limitation:${index}`}>{item}</li>
                ))}
                {record.missingEvidence.map((item, index) => (
                  <li key={`missing:${index}`}>
                    {t(`state.${item.state}`)}: {item.reason}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className={knowledgePanelClass}>
            <h2 className="mb-3 font-semibold text-ink">{t("conflicts")}</h2>
            {conflicts.items.length === 0 ? (
              <p className="text-sm text-mute">{t("noConflicts")}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {conflicts.items.map((conflict) => (
                  <li key={conflict.edgeId}>
                    <Link
                      className="break-all underline"
                      href={`/knowledge/${encodeURIComponent(conflict.reference.id)}?revision=${conflict.reference.revision}`}
                    >
                      {conflict.reference.id} · {t("revision")}{" "}
                      {conflict.reference.revision}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-mute">{t("conflictLimited")}</p>
            {conflicts.nextCursor ? (
              <Link
                className="mt-3 inline-block text-sm underline"
                href={`/knowledge/${encodeURIComponent(recordId)}?${conflictParams.toString()}`}
              >
                {t("next")}
              </Link>
            ) : null}
          </section>
          {actions.confirm && !query.has("revision") ? (
            <section className={knowledgePanelClass}>
              <h2 className="mb-3 font-semibold text-ink">
                {t("confirmation")}
              </h2>
              <KnowledgeConfirmation
                key={`${record.revision}:${record.confirmation.decisionId}`}
                record={record}
              />
            </section>
          ) : null}
        </div>
        <aside className="min-w-0 space-y-5">
          <section className={knowledgePanelClass}>
            <h2 className="mb-3 font-semibold text-ink">{t("attribution")}</h2>
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="text-mute">{t("owner")}</dt>
                <dd className="mt-1">
                  <KnowledgeOwner owner={record.owner} />
                </dd>
              </div>
              <div>
                <dt className="text-mute">{t("identity")}</dt>
                <dd className="break-all font-mono text-xs">{record.id}</dd>
              </div>
              <div>
                <dt className="text-mute">{t("revision")}</dt>
                <dd>{record.revision}</dd>
              </div>
              <div>
                <dt className="text-mute">{t("submittedBy")}</dt>
                <dd className="mt-1">
                  <KnowledgeActor actor={record.attribution} />
                </dd>
              </div>
              {record.confirmation.confirmer ? (
                <div>
                  <dt className="text-mute">{t("confirmedBy")}</dt>
                  <dd className="mt-1">
                    <KnowledgeActor actor={record.confirmation.confirmer} />
                  </dd>
                  <dt className="mt-2 text-mute">{t("policyVersion")}</dt>
                  <dd>{record.confirmation.policyVersion}</dd>
                </div>
              ) : null}
              <div>
                <dt className="text-mute">{t("capturedAt")}</dt>
                <dd>
                  <KnowledgeDate value={record.freshness.capturedAt} />
                </dd>
              </div>
              <div>
                <dt className="text-mute">{t("observedAt")}</dt>
                <dd>
                  <KnowledgeDate value={record.freshness.observedAt} />
                </dd>
              </div>
              <div>
                <dt className="text-mute">{t("sourceAt")}</dt>
                <dd>
                  <KnowledgeDate value={record.freshness.sourceAt} />
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}
