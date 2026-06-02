"use client";

import type { Assignment } from "@/lib/db/schema";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import clsx from "clsx";

export interface AssignmentActionLabels {
  claim: string;
  release: string;
  takeOver: string;
}

export interface AssignmentActionsProps {
  assignmentId: string | null;
  status: Assignment["status"] | null;
  assigneeUserId: string | null;
  currentUserId: string;
  canAct: boolean;
  labels: AssignmentActionLabels;
}

type AssignmentAction = "claim" | "release" | "take-over";

function actionForStatus(args: {
  status: Assignment["status"] | null;
  assigneeUserId: string | null;
  currentUserId: string;
}): AssignmentAction | null {
  if (args.status === "open") return "claim";
  if (args.status !== "claimed") return null;

  return args.assigneeUserId === args.currentUserId ? "release" : "take-over";
}

function labelForAction(
  action: AssignmentAction,
  labels: AssignmentActionLabels,
): string {
  if (action === "claim") return labels.claim;
  if (action === "release") return labels.release;

  return labels.takeOver;
}

export function AssignmentActions({
  assignmentId,
  status,
  assigneeUserId,
  currentUserId,
  canAct,
  labels,
}: AssignmentActionsProps): ReactElement | null {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (assignmentId === null) return null;

  const action = actionForStatus({ status, assigneeUserId, currentUserId });

  if (action === null) return null;

  async function postAction(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/assignments/${assignmentId}/${action}`, {
        method: "POST",
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(data?.code ?? "CRASH");

        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setError("EXECUTOR_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || pending || !canAct;

  return (
    <div className="flex flex-none items-center gap-1.5">
      {error ? (
        <span className="self-center font-mono text-[10px] font-bold uppercase text-amber">
          {error}
        </span>
      ) : null}
      <button
        className={clsx(
          "rounded-lg border px-3 py-[7px] font-mono text-[10.5px] font-bold uppercase leading-none tracking-[0.06em]",
          action === "take-over"
            ? "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2"
            : "border-line bg-paper text-mute hover:border-mute hover:text-ink-2",
          disabled && "opacity-60",
        )}
        disabled={disabled}
        type="button"
        onClick={() => void postAction()}
      >
        {labelForAction(action, labels)}
      </button>
    </div>
  );
}
