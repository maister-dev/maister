"use client";

import type { ReactElement } from "react";
import type { MemoryItemView } from "@/lib/librarian/memory";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { useModalA11y } from "@/components/use-modal-a11y";

type MemoryKind = MemoryItemView["kind"];
type MemoryScope = MemoryItemView["scope"];

type MemoryList = {
  items: MemoryItemView[];
  memoryEnabledNextSegment: boolean;
};

export function LibrarianMemoryDialog(input: {
  open: boolean;
  onClose: () => void;
}): ReactElement | null {
  const t = useTranslations("librarian");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [list, setList] = useState<MemoryList | null>(null);
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [scope, setScope] = useState<MemoryScope>("general");
  const [projectSlug, setProjectSlug] = useState("");
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState<MemoryItemView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useModalA11y(dialogRef, input.onClose, input.open);

  const refresh = useCallback(async (): Promise<void> => {
    const response = await fetch("/api/librarian/memory", {
      cache: "no-store",
    });

    if (!response.ok) throw new Error("memory list unavailable");
    setList((await response.json()) as MemoryList);
  }, []);

  useEffect(() => {
    if (input.open) void refresh().catch(() => setError(true));
  }, [input.open, refresh]);

  async function save(): Promise<void> {
    if (!content.trim() || busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch(
        editing
          ? `/api/librarian/memory/${encodeURIComponent(editing.id)}`
          : "/api/librarian/memory",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            editing
              ? {
                  expectedRevision: editing.revision,
                  kind,
                  content: content.trim(),
                }
              : {
                  kind,
                  content: content.trim(),
                  scope,
                  ...(scope === "project"
                    ? { projectSlug: projectSlug.trim() }
                    : {}),
                },
          ),
        },
      );

      if (!response.ok) throw new Error("memory save refused");
      setEditing(null);
      setContent("");
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function forget(itemId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch(
        `/api/librarian/memory/${encodeURIComponent(itemId)}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) throw new Error("memory forget refused");
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function setNextSegmentEnabled(enabled: boolean): Promise<void> {
    setError(false);
    const response = await fetch("/api/librarian/conversation", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memoryEnabledNextSegment: enabled }),
    }).catch(() => null);

    if (!response || !response.ok) setError(true);
    else await refresh().catch(() => setError(true));
  }

  if (!input.open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[70] bg-black/40"
        aria-hidden
        onClick={input.onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("memoryTitle")}
        className="fixed inset-x-4 top-[8vh] z-[71] mx-auto max-h-[84vh] max-w-xl overflow-y-auto rounded-xl border border-line bg-paper p-5 text-ink shadow-2xl"
        data-testid="librarian-memory-dialog"
      >
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="m-0 text-lg font-semibold">{t("memoryTitle")}</h2>
          <button
            type="button"
            className="text-sm underline"
            onClick={input.onClose}
          >
            {t("memoryClose")}
          </button>
        </header>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={list?.memoryEnabledNextSegment ?? true}
            onChange={(event) =>
              void setNextSegmentEnabled(event.target.checked)
            }
          />
          {t("memoryUseNextSegment")}
        </label>
        <ul className="my-4 space-y-2 pl-0" aria-label={t("memoryItemsLabel")}>
          {list?.items.map((item) => (
            <li
              key={item.id}
              className="list-none rounded-lg border border-line p-3 text-sm"
            >
              <p className="m-0">
                {item.excludedReason === "source_unavailable"
                  ? t("messageUnavailable")
                  : item.content}
              </p>
              <p className="mt-1 text-xs text-mute">
                {t(`memoryKind_${item.kind}`)} ·{" "}
                {item.scope === "project"
                  ? item.projectSlug
                  : t("memoryGeneral")}
                {item.excludedReason === "expired"
                  ? ` · ${t("memoryExpired")}`
                  : ""}
              </p>
              <div className="mt-2 flex gap-3">
                <button
                  type="button"
                  className="underline disabled:opacity-50"
                  disabled={
                    busy || item.excludedReason === "source_unavailable"
                  }
                  onClick={() => {
                    setEditing(item);
                    setKind(item.kind);
                    setContent(item.content);
                    setScope(item.scope);
                    setProjectSlug(item.projectSlug ?? "");
                  }}
                >
                  {t("memoryEdit")}
                </button>
                <button
                  type="button"
                  className="underline disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void forget(item.id)}
                >
                  {t("memoryForget")}
                </button>
              </div>
            </li>
          ))}
        </ul>
        <form
          className="space-y-2 border-t border-line pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h3 className="m-0 text-sm font-semibold">
            {editing ? t("memoryEdit") : t("memoryAdd")}
          </h3>
          <textarea
            className="w-full rounded-md border border-line bg-canvas p-2 text-sm"
            maxLength={2000}
            aria-label={t("memoryContent")}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          <div className="flex gap-2">
            <select
              className="rounded-md border border-line bg-canvas p-2 text-sm"
              aria-label={t("memoryKind")}
              value={kind}
              onChange={(event) => setKind(event.target.value as MemoryKind)}
            >
              {(["preference", "goal", "commitment", "fact"] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {t(`memoryKind_${value}`)}
                  </option>
                ),
              )}
            </select>
            {!editing ? (
              <select
                className="rounded-md border border-line bg-canvas p-2 text-sm"
                aria-label={t("memoryScope")}
                value={scope}
                onChange={(event) =>
                  setScope(event.target.value as MemoryScope)
                }
              >
                <option value="general">{t("memoryGeneral")}</option>
                <option value="project">{t("memoryProject")}</option>
              </select>
            ) : null}
          </div>
          {!editing && scope === "project" ? (
            <input
              className="w-full rounded-md border border-line bg-canvas p-2 text-sm"
              aria-label={t("memoryProjectSlug")}
              value={projectSlug}
              onChange={(event) => setProjectSlug(event.target.value)}
            />
          ) : null}
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={busy || !content.trim()}
              className="rounded-md bg-ink px-3 py-1.5 text-sm text-paper disabled:opacity-50"
            >
              {t("memorySave")}
            </button>
            {editing ? (
              <button
                type="button"
                className="text-sm underline"
                onClick={() => {
                  setEditing(null);
                  setContent("");
                }}
              >
                {t("memoryCancelEdit")}
              </button>
            ) : null}
          </div>
        </form>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {t("memoryError")}
          </p>
        ) : null}
      </div>
    </>
  );
}
