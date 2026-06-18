import type {
  AdapterReadinessCause,
  AdapterReadinessSummary,
  RailRunnerDTO,
} from "@/lib/acp-runners/readiness-summary";
import type { ReactElement } from "react";

import { CheckCircleIcon, NoSymbolIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import clsx from "clsx";

// Resolved (already-translated) strings the async LeftRail passes down so this
// view stays a pure, sync, renderToStaticMarkup-testable Server Component.
export type RunnersReadinessLabels = {
  readonly heading: string;
  readonly none: string;
  readonly noneConfigured: string;
  readonly enabledLabel: string;
  readonly disabledLabel: string;
  readonly configureCta: string;
  readonly readiness: Record<RailRunnerDTO["readinessStatus"], string>;
};

export interface RunnersReadinessRailViewProps {
  readonly adapters: readonly AdapterReadinessSummary[];
  readonly causeLabels: Record<AdapterReadinessCause, string>;
  readonly isAdmin: boolean;
  readonly labels: RunnersReadinessLabels;
}

function readinessDotClass(status: RailRunnerDTO["readinessStatus"]): string {
  if (status === "Ready") return "bg-accent-4";
  if (status === "NotReady") return "bg-amber";

  return "bg-mute-2";
}

// One configured runner. `enabled` + `readiness` are icon/colour indicators
// (each aria-labelled) to keep the footprint minimal; identity stays as text.
function RunnerRow({
  labels,
  runner,
}: {
  labels: RunnersReadinessLabels;
  runner: RailRunnerDTO;
}): ReactElement {
  const readinessLabel = labels.readiness[runner.readinessStatus];
  const enabledLabel = runner.enabled
    ? labels.enabledLabel
    : labels.disabledLabel;

  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span
          aria-label={readinessLabel}
          className={clsx(
            "h-[6px] w-[6px] shrink-0 rounded-full",
            readinessDotClass(runner.readinessStatus),
          )}
          title={readinessLabel}
        />
        <span
          aria-label={enabledLabel}
          className="inline-flex shrink-0"
          title={enabledLabel}
        >
          {runner.enabled ? (
            <CheckCircleIcon
              aria-hidden="true"
              className="h-3 w-3 text-accent-4"
            />
          ) : (
            <NoSymbolIcon aria-hidden="true" className="h-3 w-3 text-mute-2" />
          )}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-2"
          title={runner.model}
        >
          {runner.model}
        </span>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.04em] text-mute">
          {runner.providerKind}
        </span>
      </div>
      {runner.firstReason ? (
        <span className="pl-[20px] font-mono text-[9.5px] leading-tight text-amber">
          {runner.firstReason}
        </span>
      ) : null}
    </li>
  );
}

// Hover/focus popover listing the adapter's configured runners. Positioned
// against the (relative) chips container — NOT the chip — so it anchors to the
// rail's left edge and never clips against the expanded rail's overflow-x-hidden,
// regardless of which wrapped chip is hovered.
function RunnerPopover({
  adapter,
  causeLabel,
  id,
  isAdmin,
  labels,
}: {
  adapter: AdapterReadinessSummary;
  causeLabel: string;
  id: string;
  isAdmin: boolean;
  labels: RunnersReadinessLabels;
}): ReactElement {
  return (
    // `invisible` (not just `opacity-0`) keeps the hidden popover OUT of the
    // accessibility tree, so the trigger's accessible name is not polluted by
    // the runner rows while the tooltip is closed; it is referenced via
    // `aria-describedby={id}` on the chip.
    <div
      className="pointer-events-none invisible absolute bottom-full left-0 z-[140] mb-1.5 w-[220px] rounded-[12px] border border-line bg-paper p-2.5 opacity-0 shadow-[var(--shadow-lg)] transition-opacity duration-100 group-hover/runner:visible group-hover/runner:pointer-events-auto group-hover/runner:opacity-100 group-focus-within/runner:visible group-focus-within/runner:pointer-events-auto group-focus-within/runner:opacity-100"
      id={id}
      role="tooltip"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-line pb-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-2">
          {adapter.adapter}
        </span>
        <span className="truncate font-mono text-[9.5px] text-mute">
          {causeLabel}
        </span>
      </div>
      {adapter.runners.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {adapter.runners.map((runner) => (
            <RunnerRow key={runner.id} labels={labels} runner={runner} />
          ))}
        </ul>
      ) : (
        <p className="m-0 font-mono text-[10px] text-mute-2">
          {labels.noneConfigured}
        </p>
      )}
      {isAdmin ? (
        <div className="mt-1.5 border-t border-line pt-1.5 font-mono text-[9.5px] font-semibold tracking-[0.02em] text-accent-4">
          {labels.configureCta} →
        </div>
      ) : null}
    </div>
  );
}

function RunnerChip({
  adapter,
  causeLabel,
  isAdmin,
  labels,
}: {
  adapter: AdapterReadinessSummary;
  causeLabel: string;
  isAdmin: boolean;
  labels: RunnersReadinessLabels;
}): ReactElement {
  const title = adapter.detail
    ? `${causeLabel}: ${adapter.detail}`
    : causeLabel;
  // Deterministic accessible name + tooltip wiring. The explicit `aria-label`
  // fixes the trigger's name (adapter + status) instead of letting it derive
  // from the popover subtree; `aria-describedby` points at the popover tooltip.
  const tooltipId = `runners-readiness-tip-${adapter.adapter}`;
  const accessibleName = `${adapter.adapter}: ${title}`;
  const pill = (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-ivory py-[3px] pl-[7px] pr-2 font-mono text-[10.5px] tracking-[0.02em] text-mute">
      <span
        className={clsx(
          "h-[5px] w-[5px] rounded-full",
          adapter.state === "green" ? "bg-accent-4" : "bg-amber",
        )}
      />
      {adapter.adapter}
    </span>
  );
  const popover = (
    <RunnerPopover
      adapter={adapter}
      causeLabel={causeLabel}
      id={tooltipId}
      isAdmin={isAdmin}
      labels={labels}
    />
  );

  // Admin chips navigate to the runner catalog; the Link is also focusable, so
  // keyboard focus reveals the popover via group-focus-within. Non-admin chips
  // are not links (and intentionally not focusable) — the `title` is the
  // always-available fallback.
  if (isAdmin) {
    return (
      <Link
        aria-describedby={tooltipId}
        aria-label={accessibleName}
        className="group/runner inline-flex cursor-pointer"
        href="/settings"
        title={title}
      >
        {pill}
        {popover}
      </Link>
    );
  }

  return (
    <span
      aria-describedby={tooltipId}
      aria-label={accessibleName}
      className="group/runner inline-flex"
      title={title}
    >
      {pill}
      {popover}
    </span>
  );
}

export function RunnersReadinessRailView({
  adapters,
  causeLabels,
  isAdmin,
  labels,
}: RunnersReadinessRailViewProps): ReactElement {
  return (
    <div className="flex flex-col gap-1.5 px-0.5 pb-0.5">
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-mute">
        {labels.heading}
      </div>
      <div className="relative flex flex-wrap gap-1">
        {adapters.length > 0 ? (
          adapters.map((adapter) => (
            <RunnerChip
              key={adapter.adapter}
              adapter={adapter}
              causeLabel={causeLabels[adapter.cause]}
              isAdmin={isAdmin}
              labels={labels}
            />
          ))
        ) : (
          <span className="font-mono text-[10.5px] text-mute-2">
            {labels.none}
          </span>
        )}
      </div>
    </div>
  );
}
