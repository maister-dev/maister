"use client";

import type { HitlItem } from "@/lib/queries/hitl";
import type { ReactElement } from "react";

import {
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardDocumentListIcon,
  CommandLineIcon,
  CpuChipIcon,
  ScaleIcon,
  ShieldCheckIcon,
  UserGroupIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { Chip, HitlPanel } from "@/components/inbox/hitl-panel";
import { buildWorkStageLabels } from "@/lib/work/work-row-labels";
import { WorkStageChip } from "@/components/work/work-stage-chip";

// A request whose run session carries no recorded adapter keeps its card and
// renders a muted avatar (queries/runner-agent.ts).
const AVATAR_UNKNOWN = "bg-mute";

const AVATAR: Record<NonNullable<HitlItem["agent"]>, string> = {
  claude: "bg-amber",
  codex: "bg-accent-3",
  gemini: "bg-accent-2",
  opencode: "bg-ink-2",
  mimo: "bg-ink",
};

function avatarInitials(agent: HitlItem["agent"]): string {
  if (agent === null) return "—";
  if (agent === "claude") return "cl";
  if (agent === "codex") return "cx";
  if (agent === "gemini") return "gm";
  if (agent === "mimo") return "mi";

  return "oc";
}

const CRITICALITY_PILL: Record<string, string> = {
  critical:
    "border-[color-mix(in_oklab,var(--status-red)_35%,var(--line))] bg-[color-mix(in_oklab,var(--status-red)_12%,var(--paper))] text-[var(--status-red)]",
  high: "border-amber-line bg-amber-soft text-amber",
  medium:
    "border-[color-mix(in_oklab,var(--accent-2)_30%,var(--line))] bg-[color-mix(in_oklab,var(--accent-2)_10%,var(--paper))] text-accent-2",
  low: "border-line bg-ivory text-mute",
};

// Per-card criticality accent (left border): critical red, high amber, medium
// info, low/none neutral. Replaces the prior block-level amber alarm chrome.
const CRITICALITY_ACCENT: Record<string, string> = {
  critical: "border-l-[var(--status-red)]",
  high: "border-l-amber",
  medium: "border-l-accent-2",
  low: "border-l-line",
};

const STAGE_ICON: Record<string, typeof UserIcon> = {
  ai_coding: CpuChipIcon,
  consensus: UserGroupIcon,
  judge: ScaleIcon,
  cli: CommandLineIcon,
  check: ShieldCheckIcon,
  human: UserIcon,
  form: ClipboardDocumentListIcon,
  guard: ShieldCheckIcon,
};

export interface HitlCardProps {
  item: HitlItem;
  canAct: boolean;
  canReadRepoFiles?: boolean;
  currentUserId: string;
}

export function HitlCard({
  item,
  canAct,
  canReadRepoFiles = false,
  currentUserId,
}: HitlCardProps): ReactElement {
  const t = useTranslations("inbox");
  const tcrit = useTranslations("run");
  const tStage = useTranslations("workStage");
  // The card owns ONLY the disclosure; the fetch, the actions and the context
  // region moved to `HitlPanel`, which the Desk renders too (`REQ-D17`).
  const [expanded, setExpanded] = useState(false);
  const crit = item.criticality ?? "low";
  const StageIcon = item.stage.type ? STAGE_ICON[item.stage.type] : null;
  const isAgentQuestion = item.kind === "agent_question";

  return (
    <article
      className={clsx(
        "overflow-hidden rounded-[14px] border border-l-[3px] border-line bg-paper",
        CRITICALITY_ACCENT[crit],
      )}
      data-criticality={item.criticality ?? "none"}
      data-kind={item.kind}
      data-testid="hitl-card"
    >
      <button
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 px-4 pt-3.5 text-left"
        type="button"
        onClick={() => setExpanded((open) => !open)}
      >
        <span
          className={clsx(
            "inline-flex h-8 w-8 flex-none items-center justify-center rounded-[9px] font-mono text-[10px] font-extrabold tracking-[0.02em] text-white",
            item.agent ? AVATAR[item.agent] : AVATAR_UNKNOWN,
          )}
        >
          {avatarInitials(item.agent)}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <b className="text-sm font-semibold tracking-[-0.005em] text-ink">
              {item.taskTitle ?? item.prompt}
            </b>
            {item.taskRef ? (
              <span className="rounded border border-line bg-paper px-1 py-px font-mono text-[10px] font-bold tracking-[0.05em] text-ink-2">
                {item.taskRef}
              </span>
            ) : null}
            {item.criticality !== null ? (
              <span
                className={clsx(
                  "rounded border px-1.5 py-px text-[9.5px] font-bold uppercase tracking-[0.04em]",
                  CRITICALITY_PILL[item.criticality] ??
                    "border-line bg-ivory text-mute",
                )}
              >
                {tcrit(`criticality.${item.criticality}`)}
              </span>
            ) : null}
          </span>

          <span className="mt-1 flex flex-wrap items-center gap-2 text-mute">
            {/* ADR-170: the same stage vocabulary the /work table and the three
                decision sections use. On THIS page it varies — WaitingOnHuman
                beside Review, Crashed and Held — which is what makes the four
                populations comparable at a glance. */}
            <WorkStageChip
              blocked={false}
              labels={buildWorkStageLabels(tStage)}
              progress={null}
              promotedKind={null}
              stage="WaitingOnHuman"
            />
            <Chip className="border-line bg-ivory text-ink-2">
              {StageIcon ? <StageIcon className="h-3 w-3" /> : null}
              {item.stage.label}
            </Chip>
            <Chip className="border-line bg-paper text-ink-2">
              {item.branch}
            </Chip>
            {isAgentQuestion ? (
              <Chip className="border-amber-line bg-amber-soft text-amber">
                {t("agentQuestion")}
              </Chip>
            ) : null}
            <span className="font-mono text-[10.5px] font-bold text-amber">
              {item.time}
            </span>
          </span>

          {item.taskTitle ? (
            <span className="mt-1.5 block text-[13px] leading-[1.45] text-ink-2">
              {item.prompt}
            </span>
          ) : null}
        </span>

        <span className="flex-none pt-0.5 text-mute">
          {expanded ? (
            <ChevronUpIcon className="h-4 w-4" />
          ) : (
            <ChevronDownIcon className="h-4 w-4" />
          )}
        </span>
      </button>

      <HitlPanel
        canAct={canAct}
        canReadRepoFiles={canReadRepoFiles}
        currentUserId={currentUserId}
        expanded={expanded}
        item={item}
        onRequestExpand={() => setExpanded(true)}
      />
    </article>
  );
}
