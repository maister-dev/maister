import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { DecisionSections } from "@/components/inbox/decision-sections";
import { HitlInboxList } from "@/components/inbox/hitl-inbox-list";
import { InboxPanel } from "@/components/portfolio/inbox-panel";
import { requireSession } from "@/lib/authz";
import { getDecisionsQueue } from "@/lib/queries/decisions";
import { getInboxItems, getUnreadInboxCount } from "@/lib/queries/inbox";
import { getCrossProjectHitlInbox } from "@/lib/queries/portfolio";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("inbox");

  return { title: t("title") };
}

export default async function InboxPage(): Promise<ReactElement> {
  const user = await requireSession();
  const t = await getTranslations("inbox");
  const tp = await getTranslations("portfolio");
  const tStage = await getTranslations("workStage");

  // ADR-168 D8/ATN-05: the ONE canonical queue. Its `count` is the number the
  // rail badge shows — React-`cache`d, so this is the same computation, not a
  // second one free to disagree with it.
  const [hitl, inboxItems, unreadInbox, queue] = await Promise.all([
    getCrossProjectHitlInbox(user.id, user.role),
    getInboxItems(user.id, user.role),
    // The notifications panel's own population — unread mentions and comments,
    // which are `updates`, not `decisions`. Keeping them separate is the point.
    getUnreadInboxCount(user.id, user.role),
    getDecisionsQueue(user.id, user.role),
  ]);
  const decisions = queue.count;
  const stageLabels = {
    Triage: tStage("Triage"),
    Held: tStage("Held"),
    Ready: tStage("Ready"),
    Queued: tStage("Queued"),
    Executing: tStage("Executing"),
    WaitingOnHuman: tStage("WaitingOnHuman"),
    Review: tStage("Review"),
    Crashed: tStage("Crashed"),
    Promoted: tStage("Promoted"),
    Abandoned: tStage("Abandoned"),
    blocked: tStage("blocked"),
    promotedResult: tStage("promotedResult"),
  };

  return (
    <div className="w-full">
      <header className="mb-7">
        <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
          {t("eyebrow")}
        </div>
        <h1 className="m-0 text-[32px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {t("title")}
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[13.5px] leading-[1.5] text-mute">
          {t("subtitle", { count: decisions })}
        </p>
      </header>

      {decisions === 0 && unreadInbox === 0 ? (
        <div className="rounded-[14px] border border-line bg-paper px-6 py-12 text-center text-[13.5px] text-mute">
          {t("empty")}
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {hitl.count > 0 ? (
            <section aria-label={tp("inboxAriaLabel")}>
              <h2 className="mb-3.5 inline-flex items-center gap-2.5 font-sans text-sm font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-amber before:content-['']">
                {t("needsActionTitle", { count: hitl.count })}
              </h2>
              <HitlInboxList
                canAct
                currentUserId={user.id}
                items={hitl.items}
              />
            </section>
          ) : null}

          <DecisionSections
            items={queue.items}
            labels={{
              promotableTitle: t("decisions.promotableTitle"),
              crashedTitle: t("decisions.crashedTitle"),
              flaggedTitle: t("decisions.flaggedTitle"),
              review: t("decisions.review"),
              openTask: t("decisions.openTask"),
              stage: stageLabels,
            }}
          />

          {unreadInbox > 0 ? (
            <InboxPanel
              count={unreadInbox}
              items={inboxItems}
              labels={{
                title: tp("notifTitle"),
                ariaLabel: tp("notifAriaLabel"),
                readAll: tp("notifReadAll"),
                readAllBusy: tp("notifReadAllBusy"),
                empty: tp("notifEmpty"),
                eventKind: {
                  comment_added: tp("notifKind.commentAdded"),
                  task_mentioned: tp("notifKind.taskMentioned"),
                },
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
