"use client";

import type { FormEvent, ReactElement } from "react";
import type { StandOperation } from "@/lib/stand-operations/operation-types";

import { useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import {
  knowledgeClientErrorKey,
  knowledgeDeliveryKey,
  type KnowledgeDelivery,
} from "@/components/brain/knowledge-client";
import { MaisterError, isMaisterErrorCode } from "@/lib/errors-core";

type Action =
  | "approval"
  | "reconcile"
  | "verification"
  | "recovery-inspections"
  | "hold"
  | "successor";
type Inspection = Readonly<{ id: string; state: string }>;

export function StandOperationControls({
  operation,
  needsApproval,
  canRestart,
  canRecover,
}: {
  operation: StandOperation;
  needsApproval: boolean;
  canRestart: boolean;
  canRecover: boolean;
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const router = useRouter();
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "value",
    ) as Action | undefined;

    if (!action) return;
    const form = new FormData(event.currentTarget);
    const base = { expectedRevision: operation.revision };
    const reason = String(form.get("reason") ?? "");
    const body =
      action === "approval"
        ? { ...base, requestDigest: operation.requestDigest, reason }
        : action === "hold"
          ? { ...base, decision: "hold", inspectionIds: [], reason }
          : action === "successor" && inspection
            ? {
                ...base,
                decision: "authorize_successor",
                inspectionIds: [inspection.id],
                reason,
                successor: {
                  assignmentId: String(form.get("successorAssignment") ?? ""),
                  expectedRevision: Number(form.get("successorRevision")),
                  inputRevision: Number(form.get("successorInputRevision")),
                },
              }
            : base;
    const writesDecision =
      action === "approval" || action === "hold" || action === "successor";

    if (writesDecision && !reason.trim()) {
      setError(knowledge("errorInput"));

      return;
    }
    const endpoint =
      action === "hold" || action === "successor"
        ? "recovery-decisions"
        : action;

    setPending(action);
    setError(null);
    try {
      const response = await fetch(
        `/api/stand-operations/${encodeURIComponent(operation.id)}/${endpoint}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            writesDecision
              ? {
                  ...body,
                  idempotencyKey: knowledgeDeliveryKey(delivery, body),
                }
              : body,
          ),
        },
      );
      const value: unknown = await response.json();

      if (!response.ok) {
        const code =
          value && typeof value === "object" && "code" in value
            ? value.code
            : null;

        throw new MaisterError(
          isMaisterErrorCode(code) ? code : "CRASH",
          "The stand action was refused",
        );
      }
      if (
        action === "recovery-inspections" &&
        value &&
        typeof value === "object" &&
        "id" in value &&
        typeof value.id === "string" &&
        "observedState" in value &&
        typeof value.observedState === "string"
      ) {
        setInspection({ id: value.id, state: value.observedState });
      } else {
        setInspection(null);
        router.refresh();
      }
    } catch (error) {
      setError(knowledge(knowledgeClientErrorKey(error)));
    } finally {
      setPending(null);
    }
  }

  const unknown =
    operation.effectState === "unknown" &&
    operation.disposition !== "authorized_successor";
  const approval =
    canRestart && needsApproval && operation.effectState === "not_dispatched";
  const recovery = canRecover && unknown;
  const verify = operation.effectState === "confirmed_applied";

  if (!approval && !recovery && !verify) return <></>;

  return (
    <form className="mt-4 space-y-3" onSubmit={submit}>
      {approval || recovery ? (
        <label className="block text-sm">
          {t("reason")}
          <input
            className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2"
            maxLength={2000}
            name="reason"
          />
        </label>
      ) : null}
      {approval ? (
        <p className="break-all text-xs text-mute">
          {t("approvalDigest")} {operation.requestDigest}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {approval ? (
          <Button
            isDisabled={pending !== null}
            size="sm"
            type="submit"
            value="approval"
          >
            {t("approveRestart")}
          </Button>
        ) : null}
        {recovery ? (
          <>
            <Button
              isDisabled={pending !== null}
              size="sm"
              type="submit"
              value="reconcile"
              variant="secondary"
            >
              {t("reconcile")}
            </Button>
            <Button
              isDisabled={pending !== null}
              size="sm"
              type="submit"
              value="recovery-inspections"
              variant="secondary"
            >
              {t("inspect")}
            </Button>
            <Button
              isDisabled={pending !== null}
              size="sm"
              type="submit"
              value="hold"
              variant="secondary"
            >
              {t("hold")}
            </Button>
          </>
        ) : null}
        {verify ? (
          <Button
            isDisabled={pending !== null}
            size="sm"
            type="submit"
            value="verification"
            variant="secondary"
          >
            {t("verify")}
          </Button>
        ) : null}
      </div>
      {inspection ? (
        <p className="text-sm" role="status">
          {t("inspection")} {t(`serviceState.${inspection.state}`)} ·{" "}
          {inspection.id}
        </p>
      ) : null}
      {recovery && canRestart && inspection?.state === "active" ? (
        <fieldset className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm">{t("successor")}</legend>
          <label className="text-sm">
            {t("assignmentId")}
            <input
              className="block w-full rounded border border-line px-2 py-1"
              name="successorAssignment"
            />
          </label>
          <label className="text-sm">
            {t("revision")}
            <input
              className="block w-full rounded border border-line px-2 py-1"
              min={1}
              name="successorRevision"
              type="number"
            />
          </label>
          <label className="text-sm">
            {t("inputRevision")}
            <input
              className="block w-full rounded border border-line px-2 py-1"
              min={1}
              name="successorInputRevision"
              type="number"
            />
          </label>
          <Button
            isDisabled={pending !== null}
            size="sm"
            type="submit"
            value="successor"
            variant="secondary"
          >
            {t("authorizeSuccessor")}
          </Button>
        </fieldset>
      ) : null}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
