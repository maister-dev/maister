"use client";

import type { HitlItem } from "@/lib/queries/hitl";
import type {
  InboxCardContext,
  InboxGateChip,
} from "@/lib/queries/inbox-context";
import type { ReactElement, ReactNode } from "react";

import {
  ArrowTopRightOnSquareIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CheckIcon,
  ClockIcon,
  CommandLineIcon,
  CpuChipIcon,
  ExclamationTriangleIcon,
  MinusIcon,
  ScaleIcon,
  ShieldCheckIcon,
  UserGroupIcon,
  UserIcon,
  XMarkIcon,
  ClipboardDocumentListIcon,
} from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { AssignmentActions } from "@/components/board/assignment-actions";
import { RunHitlResponse } from "@/components/board/run-hitl-response";

const AVATAR: Record<HitlItem["agent"], string> = {
  claude: "bg-amber",
  codex: "bg-accent-3",
  gemini: "bg-accent-2",
  opencode: "bg-ink-2",
  mimo: "bg-ink",
};

function avatarInitials(agent: HitlItem["agent"]): string {
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

type GateTone = "ok" | "warn" | "bad" | "muted";

const GATE_TONE: Record<string, GateTone> = {
  passed: "ok",
  failed: "bad",
  stale: "warn",
  pending: "warn",
  running: "warn",
  skipped: "muted",
  overridden: "muted",
};

const GATE_TONE_CLASS: Record<GateTone, string> = {
  ok: "border-[color-mix(in_oklab,var(--accent-2)_30%,var(--line))] bg-[color-mix(in_oklab,var(--accent-2)_10%,var(--paper))] text-accent-2",
  warn: "border-amber-line bg-amber-soft text-amber",
  bad: "border-[color-mix(in_oklab,var(--status-red)_35%,var(--line))] bg-[color-mix(in_oklab,var(--status-red)_12%,var(--paper))] text-[var(--status-red)]",
  muted: "border-line bg-ivory text-mute",
};

function GateIcon({ tone }: { tone: GateTone }): ReactElement {
  const cls = "h-3 w-3";

  if (tone === "ok") return <CheckIcon className={cls} />;
  if (tone === "bad") return <XMarkIcon className={cls} />;
  if (tone === "warn") return <ClockIcon className={cls} />;

  return <MinusIcon className={cls} />;
}

const MAX_GATE_CHIPS = 5;

function Chip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] tracking-[0.02em]",
        className,
      )}
    >
      {children}
    </span>
  );
}

function staleCount(summary: Record<string, unknown> | null): number {
  if (summary === null) return 0;
  const count = summary.count;

  return typeof count === "number" && count > 0 ? count : 0;
}

export interface HitlCardProps {
  item: HitlItem;
  canAct: boolean;
  currentUserId: string;
}

export function HitlCard({
  item,
  canAct,
  currentUserId,
}: HitlCardProps): ReactElement {
  const t = useTranslations("inbox");
  const tb = useTranslations("board");
  const tcrit = useTranslations("run");
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState<InboxCardContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function loadContext(): Promise<void> {
    setLoading(true);
    setError(false);

    try {
      const res = await fetch(`/api/runs/${item.runId}/inbox-context`);

      if (!res.ok) throw new Error("inbox-context");
      setContext((await res.json()) as InboxCardContext);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  function toggle(): void {
    const next = !expanded;

    setExpanded(next);
    if (next && context === null && !loading) void loadContext();
  }

  const crit = item.criticality ?? "low";
  const StageIcon = item.stage.type ? STAGE_ICON[item.stage.type] : null;
  const stale = staleCount(item.assignmentStaleEvidenceSummary);
  const isPermission = item.kind === "permission";

  return (
    <article
      className={clsx(
        "overflow-hidden rounded-[14px] border border-l-[3px] border-line bg-paper",
        CRITICALITY_ACCENT[crit],
      )}
      data-criticality={item.criticality ?? "none"}
      data-testid="hitl-card"
    >
      <button
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 px-4 pt-3.5 text-left"
        type="button"
        onClick={toggle}
      >
        <span
          className={clsx(
            "inline-flex h-8 w-8 flex-none items-center justify-center rounded-[9px] font-mono text-[10px] font-extrabold tracking-[0.02em] text-white",
            AVATAR[item.agent],
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
            <Chip className="border-line bg-ivory text-ink-2">
              {StageIcon ? <StageIcon className="h-3 w-3" /> : null}
              {item.stage.label}
            </Chip>
            <Chip className="border-line bg-paper text-ink-2">
              {item.branch}
            </Chip>
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

      <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-2.5">
        {isPermission && canAct ? (
          <RunHitlResponse
            compact
            canAct={canAct}
            criticality={item.criticality}
            hitlRequestId={item.hitlRequestId}
            kind={item.kind}
            options={item.options}
            runId={item.runId}
            schema={item.schema}
            onRespond={() => window.location.reload()}
          />
        ) : !isPermission && canAct ? (
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-ivory px-2.5 py-1 font-mono text-[11px] font-semibold text-ink-2 transition-colors hover:bg-paper"
            type="button"
            onClick={() => {
              if (!expanded) toggle();
            }}
          >
            {t("respond")}
          </button>
        ) : null}

        <AssignmentActions
          assigneeUserId={item.assigneeUserId}
          assignmentId={item.assignmentId}
          canAct={canAct}
          currentUserId={currentUserId}
          labels={{
            claim: tb("assignmentClaim"),
            release: tb("assignmentRelease"),
            takeOver: tb("assignmentTakeOver"),
          }}
          status={item.assignmentStatus}
        />

        <a
          className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-accent-2 hover:underline"
          href={`/runs/${item.runId}`}
        >
          {t("viewRun")}
          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
        </a>
      </div>

      {expanded ? (
        <div className="border-t border-line bg-[color-mix(in_oklab,var(--ivory)_50%,var(--paper))] px-4 py-3.5">
          {loading ? (
            <div className="font-mono text-[11px] text-mute" role="status">
              {t("contextLoading")}
            </div>
          ) : error ? (
            <div
              className="flex items-center gap-3 font-mono text-[11px] text-[var(--status-red)]"
              role="alert"
            >
              {t("contextError")}
              <button
                className="rounded border border-line bg-paper px-2 py-0.5 text-ink-2 hover:bg-ivory"
                type="button"
                onClick={() => void loadContext()}
              >
                {t("retry")}
              </button>
            </div>
          ) : context ? (
            <ExpandedContext context={context} stale={stale} t={t} />
          ) : null}

          {!isPermission && canAct ? (
            <div className="mt-3.5 border-t border-line pt-3.5">
              <RunHitlResponse
                compact
                canAct={canAct}
                criticality={item.criticality}
                hitlRequestId={item.hitlRequestId}
                kind={item.kind}
                options={item.options}
                runId={item.runId}
                schema={item.schema}
                onRespond={() => router.refresh()}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
        {label}
      </div>
      {children}
    </div>
  );
}

function ExpandedContext({
  context,
  stale,
  t,
}: {
  context: InboxCardContext;
  stale: number;
  t: ReturnType<typeof useTranslations>;
}): ReactElement {
  // Blocking gates first, then advisory; cap the chips and roll the rest into
  // a "+k more" chip.
  const ordered = [...context.gates].sort(
    (a, b) => Number(b.mode === "blocking") - Number(a.mode === "blocking"),
  );
  const shown = ordered.slice(0, MAX_GATE_CHIPS);
  const overflow = ordered.length - shown.length;

  return (
    <>
      {context.gates.length > 0 || stale > 0 ? (
        <Section label={t("gatesEvidence")}>
          <div className="flex flex-wrap gap-1.5">
            {shown.map((gate: InboxGateChip) => {
              const tone = GATE_TONE[gate.status] ?? "muted";

              return (
                <Chip key={gate.gateId} className={GATE_TONE_CLASS[tone]}>
                  <GateIcon tone={tone} />
                  {gate.gateId}
                </Chip>
              );
            })}
            {overflow > 0 ? (
              <Chip className="border-line bg-ivory text-mute">
                {t("moreGates", { count: overflow })}
              </Chip>
            ) : null}
            {stale > 0 ? (
              <Chip className="border-line bg-ivory text-mute">
                <ExclamationTriangleIcon className="h-3 w-3" />
                {t("staleEvidence", { count: stale })}
              </Chip>
            ) : null}
          </div>
        </Section>
      ) : null}

      {context.lastAgentMessage ? (
        <Section label={t("lastAgentMessage")}>
          <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-paper px-3 py-2 text-[12.5px] leading-[1.5] text-ink-2">
            {context.lastAgentMessage.text}
          </div>
        </Section>
      ) : null}

      {context.progress ? (
        <Section label={t("stageProgress")}>
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-line">
              <div
                className="h-full bg-accent-2"
                style={{
                  width: `${Math.round(
                    (context.progress.done / context.progress.total) * 100,
                  )}%`,
                }}
              />
            </div>
            <span className="font-mono text-[11px] text-ink-2">
              {context.progress.done} / {context.progress.total}
            </span>
          </div>
        </Section>
      ) : null}

      {context.diff ? (
        <Section label={t("changes")}>
          <span className="font-mono text-[11.5px] text-ink-2">
            {t("changesSummary", {
              files: context.diff.files,
              additions: context.diff.additions,
              deletions: context.diff.deletions,
            })}
          </span>
        </Section>
      ) : null}
    </>
  );
}
