"use client";

import type { ReactElement } from "react";
import type { StandOperation } from "@/lib/stand-operations/operation-types";
import type { StandSuccessorChoice } from "@/lib/specialist-assignments/workspace-view";

import {
  ArrowPathIcon,
  ArrowRightCircleIcon,
  CheckBadgeIcon,
  HandRaisedIcon,
  HeartIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/24/outline";
import { useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import {
  knowledgeClientErrorKey,
  knowledgeDeliveryKey,
  type KnowledgeDelivery,
} from "@/components/brain/knowledge-client";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { useFeedback } from "@/components/feedback/feedback-provider";
import { MaisterError, isMaisterErrorCode } from "@/lib/errors-core";

type Action =
  | "approval"
  | "reconcile"
  | "verification"
  | "recovery-inspections"
  | "hold"
  | "successor";
type Inspection = Readonly<{ id: string; state: string }>;
type Decision = "approval" | "hold" | "successor";

const writesDecision = (action: Action): boolean =>
  action === "approval" || action === "hold" || action === "successor";

export function StandOperationControls({
  operation,
  needsApproval,
  canRestart,
  canRecover,
  canVerify,
  successorChoices,
}: {
  operation: StandOperation;
  needsApproval: boolean;
  canRestart: boolean;
  canRecover: boolean;
  canVerify: boolean;
  successorChoices: readonly StandSuccessorChoice[];
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const router = useRouter();
  const feedback = useFeedback();
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [confirming, setConfirming] = useState<Decision | null>(null);
  const [reason, setReason] = useState("");
  const [successorId, setSuccessorId] = useState("");

  async function run(action: Action): Promise<boolean> {
    if (pending) return false;
    const base = { expectedRevision: operation.revision };
    const successor = successorChoices.find(({ id }) => id === successorId);
    const body =
      action === "approval"
        ? { ...base, requestDigest: operation.requestDigest, reason }
        : action === "hold"
          ? { ...base, decision: "hold", inspectionIds: [], reason }
          : action === "successor" && inspection && successor
            ? {
                ...base,
                decision: "authorize_successor",
                inspectionIds: [inspection.id],
                reason,
                successor: {
                  assignmentId: successor.id,
                  expectedRevision: successor.revision,
                  inputRevision: successor.inputRevision,
                },
              }
            : base;

    if (writesDecision(action) && !reason.trim()) {
      setError(knowledge("errorInput"));

      return false;
    }
    if (action === "successor" && !successor) {
      setError(t("successorRequired"));

      return false;
    }
    const endpoint =
      action === "hold" || action === "successor"
        ? "recovery-decisions"
        : action;
    const idempotencyKey = writesDecision(action)
      ? knowledgeDeliveryKey(delivery, body)
      : undefined;

    setPending(action);
    setError(null);
    try {
      const response = await fetch(
        `/api/stand-operations/${encodeURIComponent(operation.id)}/${endpoint}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            idempotencyKey ? { ...body, idempotencyKey } : body,
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
      feedback.success({
        message: t(`actionDone.${action}`),
        mutationId: idempotencyKey ?? `${operation.id}:${action}`,
      });

      return true;
    } catch (failure) {
      const message = knowledge(knowledgeClientErrorKey(failure));

      setError(message);
      feedback.error({
        message,
        mutationId: idempotencyKey ?? `${operation.id}:${action}`,
      });

      return false;
    } finally {
      setPending(null);
    }
  }

  async function confirm(): Promise<void> {
    if (confirming && (await run(confirming))) {
      setConfirming(null);
      setReason("");
    }
  }

  const unknown =
    operation.effectState === "unknown" &&
    operation.disposition !== "authorized_successor";
  const approval =
    canRestart && needsApproval && operation.effectState === "not_dispatched";
  const recovery = canRecover && unknown;
  const verify = canVerify && operation.effectState === "confirmed_applied";
  const successorAvailable =
    recovery && canRestart && inspection?.state === "active";

  if (!approval && !recovery && !verify) return <></>;

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        {approval ? (
          <Button
            isDisabled={pending !== null}
            size="sm"
            onPress={() => setConfirming("approval")}
          >
            <CheckBadgeIcon aria-hidden="true" className="size-4" />
            {t("approveRestart")}
          </Button>
        ) : null}
        {recovery ? (
          <>
            <Button
              isDisabled={pending !== null}
              size="sm"
              variant="secondary"
              onPress={() => void run("reconcile")}
            >
              <ArrowPathIcon aria-hidden="true" className="size-4" />
              {t("reconcile")}
            </Button>
            <Button
              isDisabled={pending !== null}
              size="sm"
              variant="secondary"
              onPress={() => void run("recovery-inspections")}
            >
              <MagnifyingGlassIcon aria-hidden="true" className="size-4" />
              {t("inspect")}
            </Button>
            <Button
              isDisabled={pending !== null}
              size="sm"
              variant="secondary"
              onPress={() => setConfirming("hold")}
            >
              <HandRaisedIcon aria-hidden="true" className="size-4" />
              {t("hold")}
            </Button>
          </>
        ) : null}
        {successorAvailable ? (
          <Button
            isDisabled={pending !== null || successorChoices.length === 0}
            size="sm"
            variant="secondary"
            onPress={() => setConfirming("successor")}
          >
            <ArrowRightCircleIcon aria-hidden="true" className="size-4" />
            {t("authorizeSuccessor")}
          </Button>
        ) : null}
        {verify ? (
          <Button
            isDisabled={pending !== null}
            size="sm"
            variant="secondary"
            onPress={() => void run("verification")}
          >
            <HeartIcon aria-hidden="true" className="size-4" />
            {t("verify")}
          </Button>
        ) : null}
      </div>
      {inspection ? (
        <p className="text-sm" role="status">
          {t("inspection")} {t(`serviceState.${inspection.state}`)}
        </p>
      ) : null}
      {successorAvailable && successorChoices.length === 0 ? (
        <p className="text-sm text-mute">{t("noSuccessorChoices")}</p>
      ) : null}
      {error && !confirming ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          body={t(`confirmBody.${confirming}`)}
          busy={pending !== null}
          cancelLabel={t("dismiss")}
          testId={`stand-confirm-${confirming}-${operation.id}`}
          title={t(`confirmTitle.${confirming}`)}
          titleId={`stand-confirm-title-${operation.id}`}
          onClose={() => setConfirming(null)}
        >
          {confirming === "approval" ? (
            <p className="break-all text-xs text-mute">
              {t("approvalDigest")} {operation.requestDigest}
            </p>
          ) : null}
          {confirming === "successor" ? (
            <label className="block text-sm">
              {t("successor")}
              <select
                className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm"
                disabled={pending !== null}
                value={successorId}
                onChange={(event) => setSuccessorId(event.target.value)}
              >
                <option value="">{t("selectSuccessor")}</option>
                {successorChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.objective}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block text-sm">
            {t("reason")}
            <textarea
              required
              className="mt-1 block w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm"
              disabled={pending !== null}
              maxLength={2000}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            isDisabled={
              pending !== null ||
              !reason.trim() ||
              (confirming === "successor" && !successorId)
            }
            variant={confirming === "approval" ? "primary" : "secondary"}
            onPress={() => void confirm()}
          >
            {t(`confirmAction.${confirming}`)}
          </Button>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
