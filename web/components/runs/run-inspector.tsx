"use client";

import type { ComponentType, ReactElement } from "react";

import { useState } from "react";
import {
  ArchiveBoxIcon,
  ArrowPathIcon,
  ArrowRightCircleIcon,
  ArrowsRightLeftIcon,
  ArrowUpTrayIcon,
  CameraIcon,
  ChatBubbleLeftRightIcon,
  ChevronRightIcon,
  DocumentTextIcon,
  EyeIcon,
  RocketLaunchIcon,
  StopIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";

import {
  RunInspectorChildRunsList,
  type RunInspectorChildRun,
  type RunInspectorChildRunsLabels,
} from "@/components/runs/run-inspector-child-runs-list";
import {
  buildRunDiffFileHref,
  buildRunFileHref,
} from "@/lib/runs/run-query-state";

export type {
  RunInspectorChildRun,
  RunInspectorChildRunsLabels,
} from "@/components/runs/run-inspector-child-runs-list";

type InspectorIcon = ComponentType<{ className?: string }>;

const ACTION_ICONS: Record<string, InspectorIcon> = {
  stop: StopIcon,
  recover: ArrowPathIcon,
  snapshotCommit: CameraIcon,
  exportBranch: ArrowUpTrayIcon,
  handoffBranch: ArrowRightCircleIcon,
  promote: RocketLaunchIcon,
  promotePullRequest: ArrowsRightLeftIcon,
  archive: ArchiveBoxIcon,
  drop: TrashIcon,
  discard: TrashIcon,
  reviewChanges: EyeIcon,
  viewUncommittedDiff: DocumentTextIcon,
  openPendingInput: ChatBubbleLeftRightIcon,
  openAgentChat: ChatBubbleLeftRightIcon,
};

// Cleanup actions that destroy or detach work — rendered in a separate,
// danger-toned group below the divider (T5.1).
const DANGER_ACTIONS: ReadonlySet<string> = new Set([
  "drop",
  "discard",
  "archive",
]);

function actionIcon(id: string): InspectorIcon {
  return ACTION_ICONS[id] ?? ChevronRightIcon;
}

export type RunInspectorTab = "overview" | "changes" | "flow" | "actions";

export interface RunInspectorFact {
  label: string;
  value: string;
}

export interface RunInspectorChangeFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface RunInspectorChangeSummary {
  fileCount: number;
  additions: number;
  deletions: number;
  dirty?: boolean;
  unavailable?: boolean;
  unavailableReason?: string;
  files: RunInspectorChangeFile[];
}

export interface RunInspectorFlowNode {
  id: string;
  label: string;
  status: string;
  current?: boolean;
  durationLabel?: string | null;
  tokenLabel?: string | null;
}

export interface RunInspectorFlowSummary {
  title: string;
  subtitle?: string | null;
  nodes: RunInspectorFlowNode[];
}

export interface RunInspectorAction {
  id: string;
  label: string;
  description?: string | null;
  href?: string | null;
  disabled?: boolean;
  disabledReason?: string | null;
}

export interface RunInspectorLabels {
  overview: string;
  changes: string;
  flow: string;
  actions: string;
  noChanges: string;
  unavailable: string;
  viewDiff: string;
  viewSource: string;
  binary: string;
  disabled: string;
  stale: string;
}

export interface RunInspectorProps {
  runId: string;
  labels: RunInspectorLabels;
  facts: RunInspectorFact[];
  changeSummary: RunInspectorChangeSummary | null;
  flowSummary?: RunInspectorFlowSummary | null;
  actions: RunInspectorAction[];
  pathname?: string;
  search?: string;
  // T5.4: the live wrapper sets this when a change-summary re-fetch failed; the
  // changes tab then shows a "may be stale" badge over the last good snapshot.
  stale?: boolean;
  // M36 Phase 6 (ADR-095): an orchestrator run's spawned run-tree children. The
  // expandable "Spawned runs (N)" section renders only when non-empty.
  childRuns?: RunInspectorChildRun[];
  childRunsLabels?: RunInspectorChildRunsLabels;
}

const TABS: readonly RunInspectorTab[] = [
  "overview",
  "changes",
  "flow",
  "actions",
];

function changeStatusClass(status: string): string {
  if (status === "A") return "text-emerald-700";
  if (status === "D") return "text-red-700";
  if (status === "R") return "text-blue-700";

  return "text-ink-2";
}

function summaryText(summary: RunInspectorChangeSummary | null): string {
  if (!summary || summary.unavailable) return "";

  return `${summary.fileCount} files | +${summary.additions} -${summary.deletions}`;
}

function InspectorActionItem({
  action,
  labels,
  danger = false,
}: {
  action: RunInspectorAction;
  labels: RunInspectorLabels;
  danger?: boolean;
}): ReactElement {
  const Icon = actionIcon(action.id);

  return (
    <li
      className={clsx(
        "flex items-start gap-2 rounded-[6px] border bg-paper p-2",
        danger ? "border-[#d9534f]/40" : "border-line",
      )}
      data-disabled={action.disabled ? "true" : "false"}
      data-testid="run-inspector-action"
    >
      <Icon
        className={clsx(
          "mt-0.5 h-3.5 w-3.5 shrink-0",
          danger ? "text-[#d9534f]" : "text-mute",
        )}
      />
      <div className="min-w-0">
        {action.href && !action.disabled ? (
          <a
            className={clsx(
              "text-[13px] font-semibold hover:underline",
              danger ? "text-[#d9534f]" : "text-ink",
            )}
            href={action.href}
          >
            {action.label}
          </a>
        ) : (
          <span
            className={clsx(
              "text-[13px] font-semibold",
              danger ? "text-[#d9534f]" : "text-ink",
            )}
          >
            {action.label}
          </span>
        )}
        {action.description ? (
          <p className="m-0 mt-1 text-[12px] text-mute">{action.description}</p>
        ) : null}
        {action.disabled ? (
          <p className="m-0 mt-1 font-mono text-[10px] text-mute">
            {action.disabledReason ?? labels.disabled}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function RunInspector({
  runId,
  labels,
  facts,
  changeSummary,
  flowSummary,
  actions,
  pathname = `/runs/${runId}`,
  search = "",
  stale = false,
  childRuns,
  childRunsLabels,
}: RunInspectorProps): ReactElement {
  const [activeTab, setActiveTab] = useState<RunInspectorTab>("overview");
  const changeText = summaryText(changeSummary);
  const dangerActions = actions.filter((action) =>
    DANGER_ACTIONS.has(action.id),
  );
  const normalActions = actions.filter(
    (action) => !DANGER_ACTIONS.has(action.id),
  );

  return (
    <section
      aria-label="Run inspector"
      className="flex flex-col gap-3"
      data-testid="run-inspector"
    >
      <div
        className="grid grid-cols-4 gap-1 rounded-[8px] border border-line bg-ivory p-1"
        role="tablist"
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            aria-selected={activeTab === tab}
            className={clsx(
              "rounded-[6px] px-2 py-1.5 text-center font-mono text-[10px] font-semibold uppercase leading-none",
              activeTab === tab
                ? "bg-paper text-ink shadow-[var(--shadow-sm)]"
                : "text-mute hover:text-ink",
            )}
            role="tab"
            type="button"
            onClick={() => setActiveTab(tab)}
          >
            {labels[tab]}
          </button>
        ))}
      </div>

      {childRuns && childRuns.length > 0 && childRunsLabels ? (
        <RunInspectorChildRunsList
          childRuns={childRuns}
          labels={childRunsLabels}
        />
      ) : null}

      <div hidden={activeTab !== "overview"} role="tabpanel">
        <dl className="m-0 flex flex-col gap-2">
          {facts.map((fact) => (
            <div
              key={fact.label}
              className="rounded-[6px] border border-line bg-paper p-2"
              data-testid="run-inspector-fact"
            >
              <dt className="font-mono text-[10px] uppercase text-mute">
                {fact.label}
              </dt>
              <dd className="m-0 truncate text-[13px] text-ink">
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div hidden={activeTab !== "changes"} role="tabpanel">
        {stale ? (
          <p
            className="mb-2 rounded-[6px] border border-amber-line bg-amber-soft px-2 py-1 font-mono text-[10px] text-amber"
            data-testid="run-inspector-stale"
            role="status"
          >
            {labels.stale}
          </p>
        ) : null}
        {!changeSummary || changeSummary.unavailable ? (
          <p
            className="rounded-[6px] border border-line bg-paper p-3 text-[12px] text-mute"
            data-testid="run-inspector-changes-unavailable"
          >
            {changeSummary?.unavailableReason ?? labels.unavailable}
          </p>
        ) : changeSummary.files.length === 0 ? (
          <p
            className="rounded-[6px] border border-line bg-paper p-3 text-[12px] text-mute"
            data-testid="run-inspector-changes-empty"
          >
            {labels.noChanges}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p
              className="m-0 font-mono text-[11px] text-ink-2"
              data-dirty={changeSummary.dirty ? "true" : "false"}
              data-testid="run-inspector-change-total"
            >
              {changeText}
            </p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {changeSummary.files.map((file) => {
                const diffHref = buildRunDiffFileHref(
                  pathname,
                  search,
                  file.path,
                );
                const detailHref = changeSummary.dirty
                  ? diffHref
                  : buildRunFileHref(pathname, search, file.path);
                const detailLabel = changeSummary.dirty
                  ? labels.viewDiff
                  : labels.viewSource;

                return (
                  <li
                    key={`${file.status}-${file.path}`}
                    className="rounded-[6px] border border-line bg-paper p-2"
                    data-testid="run-inspector-change-file"
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span
                        className={clsx(
                          "w-4 shrink-0 text-center font-mono text-[11px] font-bold",
                          changeStatusClass(file.status),
                        )}
                      >
                        {file.status}
                      </span>
                      <a
                        className="min-w-0 grow truncate text-[12px] font-semibold text-ink hover:underline"
                        href={diffHref}
                      >
                        {file.path}
                      </a>
                    </div>
                    <div className="flex items-center gap-2 pl-6 font-mono text-[10px] text-mute">
                      <span>+{file.additions}</span>
                      <span>-{file.deletions}</span>
                      {file.binary ? <span>{labels.binary}</span> : null}
                      <a
                        className="ml-auto text-ink-2 hover:underline"
                        href={detailHref}
                      >
                        {detailLabel}
                      </a>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <div hidden={activeTab !== "flow"} role="tabpanel">
        {flowSummary ? (
          <div className="rounded-[6px] border border-line bg-paper p-3">
            <h2 className="m-0 text-[13px] font-semibold text-ink">
              {flowSummary.title}
            </h2>
            {flowSummary.subtitle ? (
              <p className="mt-1 text-[12px] text-mute">
                {flowSummary.subtitle}
              </p>
            ) : null}
            <ol className="mt-3 flex list-none flex-col gap-1 p-0">
              {flowSummary.nodes.map((node) => (
                <li
                  key={node.id}
                  className="grid grid-cols-[1fr_auto] gap-2 rounded-[6px] bg-ivory px-2 py-1.5"
                  data-current={node.current ? "true" : "false"}
                  data-testid="run-inspector-flow-node"
                >
                  <span className="truncate text-[12px] text-ink">
                    {node.label}
                  </span>
                  <span className="font-mono text-[10px] text-mute">
                    {node.status}
                  </span>
                  {node.durationLabel || node.tokenLabel ? (
                    <span className="col-span-2 font-mono text-[10px] text-mute">
                      {[node.durationLabel, node.tokenLabel]
                        .filter(Boolean)
                        .join(" | ")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="rounded-[6px] border border-line bg-paper p-3 text-[12px] text-mute">
            {labels.unavailable}
          </p>
        )}
      </div>

      <div hidden={activeTab !== "actions"} role="tabpanel">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {normalActions.map((action) => (
            <InspectorActionItem
              key={action.id}
              action={action}
              labels={labels}
            />
          ))}
        </ul>
        {dangerActions.length > 0 ? (
          <ul
            className="m-0 mt-2 flex list-none flex-col gap-2 border-t border-dashed border-line p-0 pt-2"
            data-testid="run-inspector-danger-actions"
          >
            {dangerActions.map((action) => (
              <InspectorActionItem
                key={action.id}
                danger
                action={action}
                labels={labels}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
