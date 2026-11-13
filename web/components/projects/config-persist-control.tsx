"use client";

import type { ReactElement } from "react";
import type { ConfigWorkflow } from "@/lib/project-config-persistence/contracts";

import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";

import { ConfigPersistDialog } from "./config-persist-dialog";
import {
  useConfigPersistence,
  useConfigStatus,
} from "./use-config-persistence";

type AvailableOperation = Extract<
  ConfigWorkflow["operation"],
  { state: "available" }
>;

function requiresResolution(operation: AvailableOperation): boolean {
  return (
    operation.localState === "recovery_required" ||
    operation.pushState === "unknown" ||
    operation.cleanupState === "retained"
  );
}

function inProgress(operation: AvailableOperation): boolean {
  return (
    ["preparing", "prepared", "publishing"].includes(operation.localState) ||
    operation.pushState === "pending"
  );
}

export function ConfigPersistControl({
  slug,
  actorUserId,
  exportRevision,
  dismissible = false,
}: {
  slug: string;
  actorUserId: string;
  exportRevision: string;
  dismissible?: boolean;
}): ReactElement {
  const t = useTranslations("projects.configPersistence");
  const { status, workflow, refresh, error } = useConfigStatus(
    slug,
    exportRevision,
  );
  const controller = useConfigPersistence(slug, actorUserId, refresh);
  const operation =
    workflow?.operation.state === "available" ? workflow.operation : null;
  const unresolved =
    operation && (requiresResolution(operation) || inProgress(operation));
  const checkoutActionable =
    status &&
    (status.exportState !== "in_sync" || status.repositoryState !== "ready");
  const observationUnavailable =
    error || workflow?.checkout.state === "unavailable";
  const operationUnavailable = workflow?.operation.state === "unavailable";
  const settledLocal =
    operation?.localState === "committed" && Boolean(operation.commitSha);
  const settledLabel =
    settledLocal && operation?.pushState === "succeeded"
      ? t("workflow.published")
      : settledLocal
        ? t("workflow.localCommit")
        : null;
  const summary = observationUnavailable
    ? t(
        error && status?.observedAt
          ? "workflow.lastChecked"
          : "workflow.unavailable",
      )
    : unresolved
      ? t(
          requiresResolution(operation)
            ? "workflow.blocked"
            : "workflow.inProgress",
        )
      : checkoutActionable
        ? t(
            status.repositoryState === "ready" &&
              ["missing", "pending"].includes(status.exportState)
              ? "workflow.changes"
              : "workflow.blocked",
          )
        : (settledLabel ??
          (status
            ? t(`exportStates.${status.exportState}`)
            : t("workflow.checking")));
  const key = `maister.config-status-dismissed.${actorUserId}.${slug}`;
  const condition = JSON.stringify([
    status?.exportRevision ?? exportRevision,
    status?.exportState,
    status?.repositoryState,
    status?.reason,
    operation?.operationId,
    operation?.localState,
    operation?.reason,
    operation?.pushState,
    operation?.cleanupState,
    operation?.cleanupReason,
    observationUnavailable,
    operationUnavailable,
  ]);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(key);

    void Promise.resolve().then(() => setDismissed(saved));
  }, [key]);

  const isVisible =
    !dismissible ||
    ((checkoutActionable ||
      unresolved ||
      observationUnavailable ||
      operationUnavailable ||
      settledLocal ||
      controller.open) &&
      (dismissed !== condition || controller.open));
  const inspectFirst = operation && (unresolved || !checkoutActionable);
  const label =
    unresolved && requiresResolution(operation)
      ? t("workflow.resolve")
      : inspectFirst
        ? t("workflow.viewOperation")
        : t("open");

  return (
    <>
      {isVisible ? (
        <section
          aria-label={t("title")}
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-paper px-3 py-2"
          data-testid="config-persist-status"
        >
          <p aria-live="polite" className="min-w-0 flex-1 text-xs">
            <strong>{t("title")}</strong>
            {" · "}
            {summary}
            {operationUnavailable
              ? ` · ${t("workflow.operationUnavailable")}`
              : ""}
          </p>
          <Button
            className="rounded border border-line px-2.5 py-1 text-xs font-semibold"
            data-testid="config-persist-open"
            type="button"
            onPress={() =>
              void controller.show(
                inspectFirst ? operation.operationId : undefined,
              )
            }
          >
            {label}
          </Button>
          {dismissible ? (
            <Button
              aria-label={t("workflow.dismiss")}
              className="rounded border border-line px-2 py-1 text-xs"
              type="button"
              onPress={() => {
                window.localStorage.setItem(key, condition);
                setDismissed(condition);
              }}
            >
              {t("workflow.dismiss")}
            </Button>
          ) : null}
        </section>
      ) : null}
      <ConfigPersistDialog
        controller={controller}
        error={observationUnavailable}
        operation={operation}
        refreshStatus={refresh}
        status={status}
      />
    </>
  );
}
