import type { ExperimentListItemDTO } from "@/lib/experiments/dto";
import type { ReactElement, ReactNode } from "react";

import Link from "next/link";

export {
  CreateExperimentForm,
  CreateExperimentModal,
  type CreateExperimentLabels,
} from "@/components/experiments/create-experiment-modal";

export interface ExperimentListLabels {
  title: string;
  subtitle: string;
  empty: string;
  errorTitle: string;
  create: string;
  columns: {
    title: string;
    task: string;
    status: string;
    variants: string;
    base: string;
    created: string;
    verdict: string;
  };
  verdictPending: string;
  winner: string;
  outcome: {
    winner: string;
    tie: string;
    inconclusive: string;
  };
  status: {
    draft: string;
    running: string;
    comparable: string;
    concluded: string;
    abandoned: string;
  };
}

export interface ExperimentListProps {
  slug: string;
  items: ExperimentListItemDTO[];
  labels: ExperimentListLabels;
  error?: string | null;
  createSlot?: ReactNode;
  taskKeyPrefix?: string;
}

function shortSha(value: string): string {
  return value.slice(0, 7);
}

function createdLabel(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function verdictLabel(
  item: ExperimentListItemDTO,
  labels: ExperimentListLabels,
): string {
  if (item.verdictOutcome === null) return labels.verdictPending;
  if (item.verdictOutcome === "winner") {
    return `${labels.winner}: ${item.winnerVariantKey ?? "-"}`;
  }

  return labels.outcome[item.verdictOutcome];
}

function statusClass(status: ExperimentListItemDTO["status"]): string {
  if (status === "concluded") {
    return "border-amber-line bg-amber-soft text-amber";
  }
  if (status === "abandoned") return "border-line bg-paper text-mute";
  if (status === "comparable") {
    return "border-[color-mix(in_oklab,var(--accent-2)_30%,var(--line))] bg-accent-2-soft text-accent-2";
  }
  if (status === "running") {
    return "border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))] bg-accent-4-soft text-accent-4";
  }

  return "border-line bg-ivory text-mute";
}

export function ExperimentList({
  slug,
  items,
  labels,
  error = null,
  createSlot,
  taskKeyPrefix = "KEY",
}: ExperimentListProps): ReactElement {
  return (
    <section className="w-full">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-mute">
            {labels.title}
          </p>
          <h1 className="m-0 text-[32px] font-semibold leading-[1.08] text-ink">
            {labels.title}
          </h1>
          <p className="mt-2 max-w-[68ch] text-sm leading-6 text-body">
            {labels.subtitle}
          </p>
        </div>
        {createSlot !== undefined ? (
          createSlot
        ) : (
          <button className="rounded-lg border border-line px-3 py-2">
            {labels.create}
          </button>
        )}
      </header>

      {error ? (
        <div
          className="mb-4 rounded-[12px] border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
          role="alert"
        >
          <strong>{labels.errorTitle}</strong>
          <span className="ml-2 font-mono text-[12px]">{error}</span>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-paper p-8 text-center text-sm text-mute">
          {labels.empty}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-line bg-paper">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-ivory">
              <tr className="border-b border-line">
                <Header>{labels.columns.title}</Header>
                <Header>{labels.columns.task}</Header>
                <Header>{labels.columns.status}</Header>
                <Header>{labels.columns.variants}</Header>
                <Header>{labels.columns.base}</Header>
                <Header>{labels.columns.created}</Header>
                <Header>{labels.columns.verdict}</Header>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className="border-b border-line last:border-0"
                  data-testid="experiment-row"
                >
                  <Cell>
                    <Link
                      className="font-semibold text-ink hover:text-amber"
                      href={`/projects/${slug}/experiments/${item.id}`}
                    >
                      {item.title}
                    </Link>
                  </Cell>
                  <Cell>
                    <Link
                      className="font-mono text-[12px] text-ink hover:text-amber"
                      href={`/projects/${slug}/tasks/${item.taskNumber}`}
                    >
                      {taskKeyPrefix}-{item.taskNumber}
                    </Link>
                  </Cell>
                  <Cell>
                    <span
                      className={`rounded-full border px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] ${statusClass(item.status)}`}
                    >
                      {labels.status[item.status]}
                    </span>
                  </Cell>
                  <Cell>{item.variantsCount}</Cell>
                  <Cell>
                    <span className="font-mono text-[12px] text-ink">
                      {shortSha(item.baseCommit)}
                    </span>
                    <span className="ml-2 text-[12px] text-mute">
                      {item.baseBranch}
                    </span>
                  </Cell>
                  <Cell>{createdLabel(item.createdAt)}</Cell>
                  <Cell>{verdictLabel(item, labels)}</Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Header({ children }: { children: ReactNode }): ReactElement {
  return (
    <th className="px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-mute">
      {children}
    </th>
  );
}

function Cell({ children }: { children: ReactNode }): ReactElement {
  return <td className="px-4 py-3 align-top text-body">{children}</td>;
}
