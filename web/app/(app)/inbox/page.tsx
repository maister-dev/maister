import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { HitlInboxList } from "@/components/inbox/hitl-inbox-list";
import { InboxPanel } from "@/components/portfolio/inbox-panel";
import { requireSession } from "@/lib/authz";
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

  const [hitl, inboxItems, unreadInbox] = await Promise.all([
    getCrossProjectHitlInbox(user.id, user.role),
    getInboxItems(user.id, user.role),
    getUnreadInboxCount(user.id, user.role),
  ]);
  const needsYou = hitl.count + unreadInbox;

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
          {t("subtitle", { count: needsYou })}
        </p>
      </header>

      {needsYou === 0 ? (
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
