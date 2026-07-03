"use client";

import type { ReactElement } from "react";

import {
  ArrowPathIcon,
  CheckIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
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

interface ProposalActionProps {
  slug: string;
  proposalId: string;
  labels: {
    accept: string;
    reject: string;
    rejectReason: string;
  };
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

export function BrainProposalReviewActions({
  slug,
  proposalId,
  labels,
}: ProposalActionProps): ReactElement {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function conclude(action: "accept" | "reject"): Promise<void> {
    setPending(action);
    setError(null);

    try {
      await postJson(
        `/api/projects/${encodeURIComponent(slug)}/brain/proposals/${encodeURIComponent(proposalId)}/conclusion`,
        {
          action,
          ...(action === "reject" && reason.trim().length > 0
            ? { reason: reason.trim() }
            : {}),
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex min-w-[220px] flex-col gap-1">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {labels.rejectReason}
        </span>
        <input
          className="h-9 rounded-md border border-line bg-canvas px-2.5 text-[12px] text-ink outline-none"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          className={actionClass}
          data-testid={`brain-proposal-accept-${proposalId}`}
          disabled={pending !== null}
          type="button"
          onClick={() => void conclude("accept")}
        >
          <CheckIcon className="h-3.5 w-3.5" />
          {labels.accept}
        </button>
        <button
          className={actionClass}
          data-testid={`brain-proposal-reject-${proposalId}`}
          disabled={pending !== null}
          type="button"
          onClick={() => void conclude("reject")}
        >
          <XMarkIcon className="h-3.5 w-3.5" />
          {labels.reject}
        </button>
      </div>
      {error ? (
        <span className="text-[11px] text-red-700" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
