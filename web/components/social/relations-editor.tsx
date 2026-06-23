"use client";

import type { ReactElement } from "react";
import type {
  TaskRelationKind,
  TaskRelationView,
} from "@/lib/social/relations";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export interface RelationsEditorLabels {
  title: string;
  empty: string;
  add: string;
  adding: string;
  numberPlaceholder: string;
  searchPlaceholder: string;
  searchNoResults: string;
  remove: string;
  kindOut: Record<string, string>;
  kindIn: Record<string, string>;
  errorConfig: string;
  errorNotFound: string;
  errorForbidden: string;
  errorGeneric: string;
}

export type RelationCandidate = {
  taskId: string;
  key: string;
  number: number;
  title: string;
  prompt: string;
  status: string;
};

type IndexedRelationCandidate = RelationCandidate & {
  ref: string;
  numberText: string;
  searchText: string;
};

const KINDS: TaskRelationKind[] = [
  "blocks",
  "depends_on",
  "parent_of",
  "requires",
];

function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase();
}

function parseCandidateNumber(value: string): number | null {
  const trimmed = value.trim();
  const numberOnly = trimmed.match(/^\d+$/);
  const keyed = trimmed.match(/^[\p{L}\d]+-(\d+)$/iu);
  const parsed = numberOnly?.[0] ?? keyed?.[1] ?? null;

  if (!parsed) return null;

  const number = Number.parseInt(parsed, 10);

  return Number.isInteger(number) && number > 0 ? number : null;
}

function indexRelationCandidates(
  candidates: RelationCandidate[],
): IndexedRelationCandidate[] {
  return candidates.map((candidate) => {
    const ref = `${candidate.key}-${candidate.number}`;

    return {
      ...candidate,
      ref,
      numberText: String(candidate.number),
      searchText: normalizeSearchValue(
        `${ref} ${candidate.title} ${candidate.number} ${candidate.prompt}`,
      ),
    };
  });
}

function candidateMatches(
  candidate: IndexedRelationCandidate,
  query: string,
): boolean {
  if (candidate.searchText.includes(query)) return true;

  return candidate.numberText.startsWith(query);
}

export function RelationsEditor({
  slug,
  taskNumber,
  relations,
  relationCandidates,
  canEdit,
  labels,
}: {
  slug: string;
  taskNumber: number;
  relations: TaskRelationView[];
  relationCandidates: RelationCandidate[];
  canEdit: boolean;
  labels: RelationsEditorLabels;
}): ReactElement {
  const router = useRouter();
  const [kind, setKind] = useState<TaskRelationKind>("blocks");
  const [toNumber, setToNumber] = useState("");
  const [taskSearch, setTaskSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const indexedCandidates = useMemo(
    () =>
      indexRelationCandidates(
        relationCandidates.filter(
          (candidate) => candidate.number !== taskNumber,
        ),
      ),
    [relationCandidates, taskNumber],
  );
  const searchQuery = normalizeSearchValue(taskSearch);
  const searchMatches = useMemo(
    () =>
      searchQuery.length === 0
        ? []
        : indexedCandidates
            .filter((candidate) => candidateMatches(candidate, searchQuery))
            .slice(0, 6),
    [indexedCandidates, searchQuery],
  );
  const typedNumber = parseCandidateNumber(taskSearch);
  const targetNumber =
    toNumber.length > 0 ? Number.parseInt(toNumber, 10) : typedNumber;

  async function mutate(
    method: "POST" | "DELETE",
    payload: { kind: string; toNumber: number },
    fromNumber: number,
  ): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${slug}/tasks/${fromNumber}/relations`,
        {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(
          res.status === 404
            ? labels.errorNotFound
            : body?.code === "CONFIG"
              ? labels.errorConfig
              : body?.code === "UNAUTHORIZED"
                ? labels.errorForbidden
                : labels.errorGeneric,
        );

        return;
      }

      setToNumber("");
      setTaskSearch("");
      router.refresh();
    } catch {
      setError(labels.errorGeneric);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-mute">
        {labels.title}
      </h2>
      {relations.length === 0 ? (
        <p className="text-[12px] text-mute">{labels.empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {relations.map((relation) => {
            const kindLabel =
              relation.direction === "out"
                ? (labels.kindOut[relation.kind] ?? relation.kind)
                : (labels.kindIn[relation.kind] ?? relation.kind);
            const ref = `${relation.other.key}-${relation.other.number}`;

            return (
              <li
                key={relation.id}
                className="flex items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 py-1 text-[12px]"
              >
                <span className="text-mute">{kindLabel}</span>
                <Link
                  className="font-mono font-semibold text-amber hover:underline"
                  href={`/projects/${slug}/tasks/${relation.other.number}`}
                  title={relation.other.title}
                >
                  {ref}
                </Link>
                {canEdit ? (
                  <button
                    aria-label={`${labels.remove} ${ref}`}
                    className="text-mute transition hover:text-danger"
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void mutate(
                        "DELETE",
                        relation.direction === "out"
                          ? {
                              kind: relation.kind,
                              toNumber: relation.other.number,
                            }
                          : { kind: relation.kind, toNumber: taskNumber },
                        relation.direction === "out"
                          ? taskNumber
                          : relation.other.number,
                      )
                    }
                  >
                    ×
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit ? (
        <div className="grid grid-cols-1 items-start gap-1.5 sm:grid-cols-[8.75rem_minmax(0,1fr)_auto]">
          <select
            aria-label={labels.title}
            className="h-8 w-full rounded-lg border border-line bg-paper px-2 py-1 text-[12px] text-ink"
            disabled={busy}
            value={kind}
            onChange={(e) => setKind(e.target.value as TaskRelationKind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {labels.kindOut[k] ?? k}
              </option>
            ))}
          </select>
          <div className="group/search relative min-w-0">
            <input
              aria-label={labels.searchPlaceholder}
              autoComplete="off"
              className="h-8 w-full rounded-lg border border-line bg-paper px-2 py-1 font-mono text-[12px] text-ink placeholder:text-mute"
              disabled={busy}
              placeholder={labels.searchPlaceholder}
              value={taskSearch}
              onChange={(e) => {
                const value = e.target.value;

                setTaskSearch(value);
                setToNumber(String(parseCandidateNumber(value) ?? ""));
              }}
            />
            {searchQuery.length > 0 ? (
              <div
                className="absolute left-0 right-0 top-full z-[120] mt-1 hidden max-h-56 overflow-y-auto rounded-lg border border-line bg-paper p-1 shadow-[var(--shadow-lg)] group-focus-within/search:block"
                role="listbox"
              >
                {searchMatches.length > 0 ? (
                  searchMatches.map((candidate) => (
                    <button
                      key={candidate.taskId}
                      aria-selected={targetNumber === candidate.number}
                      className="flex w-full flex-col rounded-md px-2 py-1.5 text-left transition hover:bg-ivory focus:bg-ivory focus:outline-none"
                      role="option"
                      type="button"
                      onClick={() => {
                        setToNumber(String(candidate.number));
                        setTaskSearch(`${candidate.ref} ${candidate.title}`);
                      }}
                    >
                      <span className="flex w-full min-w-0 items-center gap-2">
                        <span className="flex-none font-mono text-[11px] font-semibold text-amber">
                          {candidate.ref}
                        </span>
                        <span className="min-w-0 truncate text-[12px] font-medium text-ink">
                          {candidate.title}
                        </span>
                      </span>
                      {candidate.prompt.length > 0 ? (
                        <span className="mt-0.5 w-full truncate text-[10.5px] text-mute">
                          {candidate.prompt}
                        </span>
                      ) : null}
                    </button>
                  ))
                ) : (
                  <div className="px-2 py-1.5 text-[12px] text-mute">
                    {labels.searchNoResults}
                  </div>
                )}
              </div>
            ) : null}
          </div>
          <button
            className="h-8 whitespace-nowrap rounded-lg border border-line bg-paper px-2 py-1 text-[12px] font-semibold text-ink transition hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || targetNumber === null}
            type="button"
            onClick={() => {
              if (targetNumber === null) return;

              void mutate("POST", { kind, toNumber: targetNumber }, taskNumber);
            }}
          >
            {busy ? labels.adding : labels.add}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
