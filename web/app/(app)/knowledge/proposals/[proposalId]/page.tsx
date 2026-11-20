import type { ReactElement } from "react";

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
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getKnowledgeProposal } from "@/lib/brain/knowledge-proposal-read";
import {
  knowledgeOwnerActions,
  knowledgeRecordActions,
} from "@/lib/brain/knowledge-ui";
import { knowledgeReferenceView } from "@/lib/brain/knowledge-ui";

export default async function KnowledgeProposalPage({
  params,
}: {
  params: Promise<{ proposalId: string }>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("knowledge");
  const tReviews = await getTranslations("inbox.reviews");
  const { proposalId } = await params;
  const principal = { kind: "user" as const, userId: user.id };
  const db = getDb();

  const view = await knowledgeReferenceView(async () => {
    const proposal = await getKnowledgeProposal(db, principal, proposalId);
    const { content } = proposal;
    const actions =
      content.change === "correct"
        ? await knowledgeRecordActions(
            db,
            principal,
            proposal.owner,
            content.recordId,
          )
        : await knowledgeOwnerActions(db, principal, proposal.owner);

    return { proposal, content, actions };
  });

  if (view.state === "unavailable") return <KnowledgeUnavailable />;
  const { proposal, content, actions } = view.value;

  return (
    <>
      <KnowledgeHeader title={content.title} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <section className={knowledgePanelClass}>
            <p className="mb-3 text-sm font-semibold">
              {t(`state.${proposal.status}`)}
            </p>
            <p className="whitespace-pre-wrap break-words text-[14px] leading-7 text-ink">
              {content.assertion}
            </p>
            <p className="mt-4 text-sm text-mute">
              {t("basis")}: {t(`state.${content.basis}`)} · {t("kind")}:{" "}
              {t(`kindValue.${content.kind}`)}
            </p>
            <p className="mt-3 text-sm text-mute">{t("publicationSeparate")}</p>
            {content.change === "correct" ? (
              <Link
                className="mt-3 inline-block text-sm underline"
                href={`/knowledge/${encodeURIComponent(content.recordId)}?revision=${content.expectedRevision}`}
              >
                {t("originalClaim")} · {t("revision")}{" "}
                {content.expectedRevision}
              </Link>
            ) : null}
            {proposal.acceptedRecordId ? (
              <Link
                className="mt-3 block text-sm underline"
                href={
                  proposal.acceptedRecordRevision === null
                    ? `/knowledge/${encodeURIComponent(proposal.acceptedRecordId)}`
                    : `/knowledge/${encodeURIComponent(proposal.acceptedRecordId)}?revision=${proposal.acceptedRecordRevision}`
                }
              >
                {t(
                  proposal.acceptedRecordRevision === null
                    ? "publicationRevisionUnknown"
                    : "publishedRecord",
                )}
              </Link>
            ) : null}
          </section>
          <KnowledgeEvidence evidence={proposal.evidence} />
          {content.limitations.length > 0 ||
          content.missingEvidence.length > 0 ? (
            <section className={knowledgePanelClass}>
              <h2 className="mb-3 font-semibold">{t("limitations")}</h2>
              <ul className="list-inside list-disc space-y-2 text-sm text-mute">
                {content.limitations.map((item, index) => (
                  <li key={`limitation:${index}`}>{item}</li>
                ))}
                {content.missingEvidence.map((item, index) => (
                  <li key={`missing:${index}`}>
                    {t(`state.${item.state}`)}: {item.reason}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {proposal.status === "pending" ? (
            <section className={knowledgePanelClass}>
              {actions.review ? (
                <Link
                  href={`/inbox?${new URLSearchParams({ kind: "knowledge", proposalId: proposal.id })}#knowledge-memory`}
                >
                  {tReviews("link")}
                </Link>
              ) : (
                <p className="text-sm text-mute">{t("reviewUnavailable")}</p>
              )}
            </section>
          ) : null}
        </div>
        <aside className={`${knowledgePanelClass} h-fit min-w-0`}>
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="text-mute">{t("owner")}</dt>
              <dd className="mt-1">
                <KnowledgeOwner owner={proposal.owner} />
              </dd>
            </div>
            <div>
              <dt className="text-mute">{t("submittedBy")}</dt>
              <dd className="mt-1">
                <KnowledgeActor actor={proposal.attribution} />
              </dd>
            </div>
            <div>
              <dt className="text-mute">{t("proposalRevision")}</dt>
              <dd>{proposal.revision}</dd>
            </div>
            <div>
              <dt className="text-mute">{t("createdAt")}</dt>
              <dd>
                <KnowledgeDate value={proposal.createdAt} />
              </dd>
            </div>
            <div>
              <dt className="text-mute">{t("identity")}</dt>
              <dd className="break-all font-mono text-xs">{proposal.id}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </>
  );
}
