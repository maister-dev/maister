"use client";

import type { ReactElement } from "react";
import type {
  ConfigStatus,
  ConfigWorkflow,
} from "@/lib/project-config-persistence/contracts";
import type { ConfigPersistenceController } from "./use-config-persistence";

import { useMemo, useState } from "react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { Button, TextArea } from "@heroui/react";
import { useTranslations } from "next-intl";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { useTheme } from "@/lib/theme";

import "@git-diff-view/react/styles/diff-view.css";

const buttonClass =
  "rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50";

export function ConfigPersistDialog({
  controller: c,
  status,
  error,
  refreshStatus,
  operation,
}: {
  controller: ConfigPersistenceController;
  status: ConfigStatus | null;
  error: boolean;
  refreshStatus: () => Promise<void>;
  operation: Extract<
    ConfigWorkflow["operation"],
    { state: "available" }
  > | null;
}): ReactElement | null {
  const t = useTranslations("projects.configPersistence");

  if (!c.open) return null;
  const active =
    c.receipt &&
    ["preparing", "prepared", "publishing", "recovery_required"].includes(
      c.receipt.state,
    );
  const pushState =
    (c.pushResult?.operationId === c.receipt?.operationId
      ? c.pushResult?.state
      : undefined) ?? c.receipt?.pushState;
  const uncertainPush = pushState && ["pending", "unknown"].includes(pushState);
  const localNeedsRecovery =
    c.receipt?.state === "recovery_required" ||
    c.receipt?.cleanupState === "retained" ||
    (c.uncertainId && !c.receipt);
  const needsRecovery = localNeedsRecovery || pushState === "unknown";

  return (
    <ConfirmDialog
      body={t("reviewBody")}
      busy={c.busy}
      cancelLabel={t("cancel")}
      testId="config-persist-dialog"
      title={t("reviewTitle")}
      titleId="config-persist-title"
      onClose={c.close}
    >
      <p aria-live="polite" className="text-sm text-mute">
        {c.busy ? t("working") : t("excluded")}
      </p>
      <details
        className="rounded border border-line p-2"
        data-testid="config-observation-details"
      >
        <summary className="cursor-pointer text-sm font-semibold">
          {t("workflow.details")}
        </summary>
        <div className="mt-2 grid gap-1 text-sm text-mute">
          {status ? (
            <>
              <p>{t(`exportStates.${status.exportState}`)}</p>
              <p>{t(`repositoryStates.${status.repositoryState}`)}</p>
              {status.reason ? <p>{t(`reasons.${status.reason}`)}</p> : null}
              {status.observedAt ? (
                <p>
                  {t("observedAt")}{" "}
                  <time dateTime={status.observedAt}>
                    {new Date(status.observedAt).toLocaleString()}
                  </time>
                </p>
              ) : null}
            </>
          ) : null}
          {error ? <p>{t("statusUnavailable")}</p> : null}
          <Button
            className={buttonClass}
            isDisabled={c.busy}
            type="button"
            onPress={() => void refreshStatus()}
          >
            {t("refreshStatus")}
          </Button>
          {operation && c.receipt?.operationId !== operation.operationId ? (
            <Button
              className={buttonClass}
              isDisabled={c.busy}
              type="button"
              onPress={() => void c.readReceipt(operation.operationId)}
            >
              {t("previousReceipt")}
            </Button>
          ) : null}
        </div>
      </details>
      {c.error ? (
        <p className="text-danger" role="alert">
          {c.error}
        </p>
      ) : null}
      {c.preview?.kind === "ready" ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-2 text-sm">
            <dt>{t("branch")}</dt>
            <dd className="break-all font-mono">{c.preview.targetBranch}</dd>
            <dt>{t("message")}</dt>
            <dd className="break-all font-mono">{c.preview.message}</dd>
            <dt>{t("file")}</dt>
            <dd>maister.yaml</dd>
          </dl>
          {c.preview.usedDefaultAuthor ? (
            <p className="text-sm text-amber">{t("defaultAuthor")}</p>
          ) : null}
          <ConfigPersistDiff diff={c.preview.diff} label={t("diff")} />
          <Button
            className={buttonClass}
            data-testid="config-persist-confirm"
            isDisabled={c.busy}
            type="button"
            onPress={() => void c.confirm()}
          >
            {t("confirm")}
          </Button>
        </>
      ) : null}
      {c.preview?.kind === "noop" ? (
        <p data-testid="config-persist-noop" role="status">
          {t("noop")}
        </p>
      ) : null}
      {c.preview?.kind === "blocked" ? (
        <div role="status">
          <p>{t(`reasons.${c.preview.reason}`)}</p>
          {c.preview.paths.length ? (
            <pre className="overflow-auto text-xs">
              {c.preview.paths.join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}
      {c.receipt ? (
        <div className="space-y-2 text-sm" role="status">
          {c.receipt.state === "committed" && c.receipt.commitSha ? (
            <div data-testid="config-commit-success">
              <strong>{t("committed")}</strong>
              <p className="break-all font-mono">{c.receipt.commitSha}</p>
              <p>{t("localCommitPreserved")}</p>
            </div>
          ) : (
            <p>{t(`states.${c.receipt.state}`)}</p>
          )}
          {c.receipt.state === "noop" ? (
            <p data-testid="config-persist-noop">{t("noop")}</p>
          ) : null}
          {c.receipt.reason ? <p>{t(`reasons.${c.receipt.reason}`)}</p> : null}
          {c.receipt.cleanupState === "retained" ? (
            <p>{t("cleanupRetained")}</p>
          ) : null}
          <p className="break-all font-mono">
            {t("operation")}: {c.receipt.operationId}
          </p>
          {pushState && pushState !== "not_requested" ? (
            <p data-testid="config-push-state">
              {t(`pushStates.${pushState}`)}
            </p>
          ) : null}
        </div>
      ) : null}
      {c.uncertainId && !c.receipt ? (
        <p className="break-all text-sm">
          {t("operation")}: {c.uncertainId}
        </p>
      ) : null}
      {needsRecovery ? (
        <Button
          className={buttonClass}
          isDisabled={c.busy}
          type="button"
          onPress={() => void c.recover()}
        >
          {t("recover")}
        </Button>
      ) : null}
      {c.receipt?.state === "committed" &&
      c.receipt.commitSha &&
      !uncertainPush &&
      !c.pushReview ? (
        <Button
          className={buttonClass}
          data-testid="config-push-review"
          isDisabled={c.busy}
          type="button"
          onPress={() => void c.reviewPush()}
        >
          {t("reviewPush")}
        </Button>
      ) : null}
      {c.pushReview ? (
        <section
          aria-label={t("pushTitle")}
          className="space-y-3 border-t border-line pt-3"
        >
          <h3>{t("pushTitle")}</h3>
          <p className="break-all font-mono text-xs">
            origin · {c.pushReview.url} · {c.pushReview.destination}
          </p>
          <p className="break-all font-mono text-xs">
            {c.pushReview.commitSha}
          </p>
          <p className="break-all font-mono text-xs">
            {t("remoteBase")}: {c.pushReview.remoteBase ?? t("unborn")}
          </p>
          <TextArea
            readOnly
            aria-label={t("outgoing")}
            className="w-full font-mono text-xs"
            value={c.pushReview.outgoingShas.join("\n") || t("pushUpToDate")}
          />
          <Button
            className={buttonClass}
            data-testid="config-push-confirm"
            isDisabled={c.busy}
            type="button"
            onPress={() => void c.confirmPush()}
          >
            {t("confirmPush")}
          </Button>
        </section>
      ) : null}
      {!c.busy &&
      !active &&
      !localNeedsRecovery &&
      !uncertainPush &&
      c.preview?.kind !== "ready" ? (
        <Button
          className={buttonClass}
          data-testid="config-persist-refresh"
          type="button"
          onPress={() => void c.freshPreview()}
        >
          {t("freshPreview")}
        </Button>
      ) : null}
      <Button
        className={buttonClass}
        data-testid="config-persist-close"
        isDisabled={c.busy}
        type="button"
        onPress={c.close}
      >
        {c.receipt || c.preview?.kind === "noop" ? t("close") : t("cancel")}
      </Button>
    </ConfirmDialog>
  );
}

function ConfigPersistDiff({
  diff,
  label,
}: {
  diff: string;
  label: string;
}): ReactElement {
  const [showExact, setShowExact] = useState(false);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "light" ? "light" : "dark";
  const data = useMemo(
    () => ({
      oldFile: { fileName: "maister.yaml" },
      newFile: { fileName: "maister.yaml" },
      hunks: [diff],
    }),
    [diff],
  );

  return (
    <>
      <div
        className="max-h-96 overflow-auto rounded border border-line"
        data-testid="config-persist-diff-view"
      >
        <DiffView
          key={theme}
          diffViewWrap
          data={data}
          diffViewHighlight={false}
          diffViewMode={DiffModeEnum.Unified}
          diffViewTheme={theme}
        />
      </div>
      <details onToggle={(event) => setShowExact(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm">{label}</summary>
        {showExact ? (
          <TextArea
            readOnly
            aria-label={label}
            className="min-h-64 w-full resize-y rounded border border-line p-3 font-mono text-xs"
            data-testid="config-persist-diff"
            value={diff}
          />
        ) : null}
      </details>
    </>
  );
}
