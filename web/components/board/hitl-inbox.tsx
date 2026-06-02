import type { HitlInbox as HitlInboxData, HitlItem } from "@/lib/queries/hitl";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import clsx from "clsx";

import { AssignmentActions } from "@/components/board/assignment-actions";
import { HitlActions } from "@/components/board/hitl-actions";

export interface HitlInboxProps {
  inbox: HitlInboxData;
  canAct: boolean;
  currentUserId: string;
}

const AVATAR: Record<HitlItem["agent"], string> = {
  claude: "bg-amber",
  codex: "bg-accent-3",
};

function avatarInitials(agent: HitlItem["agent"]): string {
  return agent === "claude" ? "cl" : "cx";
}

function staleSummaryText(
  summary: Record<string, unknown> | null,
): string | null {
  if (summary === null) return null;
  const count = summary.count;

  if (typeof count === "number" && count > 0) {
    return String(count);
  }

  return "!";
}

export async function HitlInbox({
  inbox,
  canAct,
  currentUserId,
}: HitlInboxProps): Promise<ReactElement | null> {
  if (inbox.count === 0) return null;
  const t = await getTranslations("board");
  const tHitl = await getTranslations("hitl");

  return (
    <section
      aria-label="Human-in-the-loop inbox"
      className="relative mb-7 overflow-hidden rounded-[14px] border border-amber-line bg-[linear-gradient(180deg,color-mix(in_oklab,var(--amber-soft)_95%,transparent)_0%,color-mix(in_oklab,var(--amber-soft)_50%,var(--paper))_100%)] before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-[linear-gradient(90deg,var(--amber)_0%,color-mix(in_oklab,var(--amber)_50%,transparent)_100%)] before:content-['']"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 pb-2.5 pt-3.5">
        <div className="flex items-center gap-3.5">
          <h2 className="m-0 inline-flex items-center gap-2.5 font-sans text-sm font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-amber before:content-[''] before:animate-[pulse-dot_2.2s_ease-out_infinite]">
            {t("hitlInbox")}
          </h2>
          <span className="rounded-full border border-amber-line bg-paper px-2.5 py-[3px] font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-amber">
            {t("paused", { count: inbox.count })}
          </span>
          {inbox.oldest ? (
            <span className="font-mono text-[11px] tracking-[0.02em] text-mute">
              {t("oldest")}{" "}
              <b className="font-semibold text-ink-2">{inbox.oldest}</b>
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-px border-t border-amber-line bg-amber-line">
        {inbox.items.map((item) => {
          const staleText = staleSummaryText(
            item.assignmentStaleEvidenceSummary,
          );

          return (
            <article
              key={item.hitlRequestId}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-[18px] bg-paper px-5 py-4 transition-colors hover:bg-[color-mix(in_oklab,var(--amber-soft)_35%,var(--paper))]"
            >
              <div
                className={clsx(
                  "relative inline-flex h-9 w-9 flex-none items-center justify-center rounded-[10px] font-mono text-[10.5px] font-extrabold tracking-[0.02em] text-white",
                  AVATAR[item.agent],
                )}
              >
                {avatarInitials(item.agent)}
              </div>

              <div className="min-w-0">
                <div className="mb-1 text-sm font-semibold leading-[1.4] tracking-[-0.005em] text-ink">
                  {item.prompt}
                  {item.kind === "form" && item.options.length > 0 ? (
                    <span className="mt-2 flex flex-wrap gap-1.5">
                      {item.options.map((opt) => (
                        <span
                          key={opt.optionId}
                          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-ivory px-2 py-1 font-mono text-[10.5px] tracking-[0.02em] text-ink-2"
                        >
                          {opt.label}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2.5 font-mono text-[10.5px] tracking-[0.02em] text-mute">
                  <span className="font-semibold text-ink-2">
                    {item.branch}
                  </span>
                  <span className="text-mute-2">·</span>
                  <span className="font-semibold text-amber">
                    {item.flowRef}
                  </span>
                  {item.assignmentActionKind ? (
                    <>
                      <span className="text-mute-2">·</span>
                      <span className="font-semibold text-ink-2">
                        {t("assignmentAction", {
                          action: item.assignmentActionKind,
                        })}
                      </span>
                    </>
                  ) : null}
                  {item.assignmentRoleRefs.length > 0 ? (
                    <>
                      <span className="text-mute-2">·</span>
                      <span className="font-semibold text-ink-2">
                        {t("assignmentRoles", {
                          roles: item.assignmentRoleRefs.join(", "),
                        })}
                      </span>
                    </>
                  ) : null}
                  {staleText ? (
                    <>
                      <span className="text-mute-2">·</span>
                      <span className="font-semibold text-amber">
                        {t("assignmentStaleEvidence", {
                          count: staleText,
                        })}
                      </span>
                    </>
                  ) : null}
                  <span className="text-mute-2">·</span>
                  <span className="font-semibold text-ink-2">
                    {item.assigneeLabel
                      ? t("assignmentClaimedBy", {
                          actor: item.assigneeLabel,
                        })
                      : t("assignmentUnclaimed")}
                  </span>
                  <span className="text-mute-2">·</span>
                  <span className="inline-flex items-center gap-1 font-bold text-amber before:text-[11px] before:content-['‖']">
                    {item.time}
                  </span>
                </div>
              </div>

              <div className="flex flex-none flex-wrap justify-end gap-1.5">
                <AssignmentActions
                  assigneeUserId={item.assigneeUserId}
                  assignmentId={item.assignmentId}
                  canAct={canAct}
                  currentUserId={currentUserId}
                  labels={{
                    claim: t("assignmentClaim"),
                    release: t("assignmentRelease"),
                    takeOver: t("assignmentTakeOver"),
                  }}
                  status={item.assignmentStatus}
                />
                <HitlActions
                  canAct={canAct}
                  hitlRequestId={item.hitlRequestId}
                  kind={item.kind}
                  options={item.options}
                  reviewLabel={
                    item.kind === "human"
                      ? tHitl("reviewDiff")
                      : tHitl("review")
                  }
                  runId={item.runId}
                  snoozeLabel={
                    item.kind === "form"
                      ? tHitl("defer")
                      : item.kind === "human"
                        ? tHitl("later")
                        : tHitl("snooze")
                  }
                />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
