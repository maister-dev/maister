"use client";

import type { ReactElement } from "react";
import type {
  TaskRelationKind,
  TaskRelationView,
} from "@/lib/social/relations";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface RelationsEditorLabels {
  title: string;
  empty: string;
  add: string;
  adding: string;
  numberPlaceholder: string;
  remove: string;
  kindOut: Record<string, string>;
  kindIn: Record<string, string>;
  errorConfig: string;
  errorNotFound: string;
  errorForbidden: string;
  errorGeneric: string;
}

const KINDS: TaskRelationKind[] = [
  "blocks",
  "depends_on",
  "parent_of",
  "requires",
];

export function RelationsEditor({
  slug,
  taskNumber,
  relations,
  canEdit,
  labels,
}: {
  slug: string;
  taskNumber: number;
  relations: TaskRelationView[];
  canEdit: boolean;
  labels: RelationsEditorLabels;
}): ReactElement {
  const router = useRouter();
  const [kind, setKind] = useState<TaskRelationKind>("blocks");
  const [toNumber, setToNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <div className="flex items-center gap-1.5">
          <select
            aria-label={labels.title}
            className="rounded-lg border border-line bg-paper px-2 py-1 text-[12px] text-ink"
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
          <input
            aria-label={labels.numberPlaceholder}
            className="w-24 rounded-lg border border-line bg-paper px-2 py-1 font-mono text-[12px] text-ink"
            disabled={busy}
            inputMode="numeric"
            placeholder={labels.numberPlaceholder}
            value={toNumber}
            onChange={(e) => setToNumber(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <button
            className="rounded-lg border border-line bg-paper px-2.5 py-1 text-[12px] font-semibold text-ink transition hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || toNumber.length === 0}
            type="button"
            onClick={() =>
              void mutate(
                "POST",
                { kind, toNumber: Number.parseInt(toNumber, 10) },
                taskNumber,
              )
            }
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
