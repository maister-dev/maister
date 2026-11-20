"use client";

import type { ReactElement } from "react";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useState } from "react";

async function postJson(url: string, body: unknown = {}): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;

    throw new Error(payload?.message ?? `request failed: ${response.status}`);
  }
}

interface SourceActionProps {
  slug: string;
  sourceId: string;
  label: string;
}

interface SourceAllActionProps {
  slug: string;
  label: string;
  disabled: boolean;
}

const actionClass =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] text-ink transition-colors hover:bg-ivory disabled:cursor-not-allowed disabled:opacity-50";

export function BrainSourceReindexAction({
  slug,
  sourceId,
  label,
}: SourceActionProps): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setPending(true);
    setError(null);

    try {
      await postJson(
        `/api/projects/${encodeURIComponent(slug)}/brain/sources/${encodeURIComponent(sourceId)}/reindex`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        className={actionClass}
        data-testid={`brain-source-reindex-${sourceId}`}
        disabled={pending}
        type="button"
        onClick={() => void run()}
      >
        <ArrowPathIcon className="h-3.5 w-3.5" />
        {label}
      </button>
      {error ? (
        <span className="text-[11px] text-red-700" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function BrainSourceReindexAllAction({
  slug,
  label,
  disabled,
}: SourceAllActionProps): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setPending(true);
    setError(null);

    try {
      await postJson(
        `/api/projects/${encodeURIComponent(slug)}/brain/sources/reindex`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        className={actionClass}
        data-testid="brain-source-reindex-all"
        disabled={disabled || pending}
        type="button"
        onClick={() => void run()}
      >
        <ArrowPathIcon className="h-3.5 w-3.5" />
        {label}
      </button>
      {error ? (
        <span className="text-[11px] text-red-700" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
