"use client";

import type { getProposalReviewDetail } from "@/lib/queries/inbox-review-actions";
import type { ReactElement } from "react";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { MarkdownRichView } from "@/components/workbench/markdown-rich-view";

type Detail = Awaited<ReturnType<typeof getProposalReviewDetail>>;

function acceptanceEffect(proposal: Detail) {
  if (proposal.kind === "brain") return proposal.detail.expectedEffect;
  if (proposal.kind === "knowledge") return "published_revision";

  return "applied_vault_operation";
}

export function ProposalReviewDetails({
  proposal,
}: {
  proposal: Detail;
}): ReactElement {
  const t = useTranslations("inbox.reviews");
  const knowledge = useTranslations("knowledge");
  const format = useFormatter();
  const { decision, domainState, version } = proposal;
  const pending = domainState === "pending";
  const date = decision.at ? new Date(decision.at) : null;
  const reviewedVersion = pending ? version : decision.reviewedVersion;
  const canAccept = pending && proposal.allowed.includes("accept");

  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 break-words text-sm [&_dt]:text-mute">
        <div>
          <dt>{t("owner")}</dt>
          <dd>
            {proposal.owner.kind === "company"
              ? knowledge("company")
              : proposal.owner.label}
          </dd>
        </div>
        <div>
          <dt>{t("filter")}</dt>
          <dd>{t(`kind.${proposal.kind}`)}</dd>
        </div>
        <div>
          <dt>{t("author")}</dt>
          <dd>{proposal.author ?? t("legacyUnknown")}</dd>
        </div>
        <div>
          <dt>{t("observedVersion")}</dt>
          <dd>{reviewedVersion ?? t("legacyUnknown")}</dd>
        </div>
        {!pending ? (
          <>
            <div>
              <dt>{t("disposition")}</dt>
              <dd>{t(`dispositions.${domainState}`)}</dd>
            </div>
            <div>
              <dt>{t("reviewer")}</dt>
              <dd>{decision.by ?? t("legacyUnknown")}</dd>
            </div>
            <div>
              <dt>{t("decidedAt")}</dt>
              <dd>
                {date ? (
                  <time dateTime={decision.at ?? undefined}>
                    {format.dateTime(date, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                ) : (
                  t("legacyUnknown")
                )}
              </dd>
            </div>
            <div>
              <dt>{t("recordedReason")}</dt>
              <dd className="whitespace-pre-wrap">
                {decision.reason ?? t("legacyUnknown")}
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      {proposal.kind === "knowledge" ? (
        <div className="flex flex-wrap gap-3 text-sm">
          <Link className="underline" href={proposal.detail.proposalHref}>
            {t("evidence")}
          </Link>
          {proposal.detail.sourceHref ? (
            <Link className="underline" href={proposal.detail.sourceHref}>
              {t("baseRevision")} · {proposal.detail.baseRevision}
            </Link>
          ) : null}
        </div>
      ) : null}
      {proposal.kind === "vault" ? (
        <div className="flex flex-wrap gap-3 break-words text-sm">
          {proposal.detail.vaultHref ? (
            <Link className="underline" href={proposal.detail.vaultHref}>
              {t("sourceVault")}
            </Link>
          ) : null}
          {proposal.sourceRevisionId ? (
            <span>
              {t("sourceRevision")} · <code>{proposal.sourceRevisionId}</code>
            </span>
          ) : null}
          <span>
            {t("vaultChanges", { count: proposal.detail.changeCount })}
          </span>
          {proposal.agentId ? <span>{proposal.agentId}</span> : null}
        </div>
      ) : null}
      {proposal.kind === "brain" ? (
        <div className="flex flex-wrap gap-3 break-words text-sm">
          <span>{t(`brainOrigin.${proposal.detail.origin}`)}</span>
          <span>{t(`brainKind.${proposal.detail.proposalKind}`)}</span>
          {proposal.detail.sourceHref ? (
            <Link className="underline" href={proposal.detail.sourceHref}>
              {t("sourceWitness")}
            </Link>
          ) : null}
          {proposal.detail.draftPath ? (
            <code>{proposal.detail.draftPath}</code>
          ) : null}
        </div>
      ) : null}
      {canAccept ? (
        <p className="text-sm">
          {t(`acceptanceEffect.${acceptanceEffect(proposal)}`)}
        </p>
      ) : null}
      {proposal.kind === "brain" &&
      proposal.detail.contentFormat === "markdown" ? (
        <MarkdownRichView
          images="omit"
          path={proposal.detail.draftPath ?? proposal.title}
          source={proposal.summary}
        />
      ) : (
        <pre className="m-0 max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-canvas p-3 text-sm">
          {proposal.summary}
        </pre>
      )}
    </>
  );
}
