"use client";

import type { ReactNode } from "react";
import type { RunPeekSnapshot } from "@/lib/runs/peek-types";
import type { ResultStatus } from "@/lib/run-results/types";
import type { RunPublicResultLabels } from "@/components/runs/run-public-result-panel";

import { useTranslations } from "next-intl";

import { Tabs } from "@/components/navigation/tabs";
import { FlowNodeDetails } from "@/components/runs/flow-node-details";
import { OperationalOutcomeDetails } from "@/components/runs/operational-run-result";
import { RunPublicResultPanel } from "@/components/runs/run-public-result-panel";
import {
  TerminalCauseNotice,
  type TerminalCauseLabels,
} from "@/components/runs/terminal-cause-notice";
import { RunPeekTranscript } from "@/components/runs/run-peek-transcript";
import { useRunPeek } from "@/components/runs/run-peek-controller";
import { RunStreamValueProvider } from "@/components/runs/run-stream-provider";
import { useWorkbenchStream } from "@/components/runs/run-workbench-stream-provider";

export function RunPeekContent({
  snapshot,
}: {
  snapshot: RunPeekSnapshot;
}): ReactNode {
  const peek = useRunPeek()!;
  const stream = useWorkbenchStream()!;
  const t = peek.t;
  const runT = useTranslations("run");
  const view =
    peek.view ??
    (snapshot.content.kind === "flow" ? "execution" : "conversation");
  const statuses: Record<ResultStatus, string> = {
    valid: runT("publicResultStatusValid"),
    pending: runT("publicResultStatusPending"),
    absent: runT("publicResultStatusAbsent"),
    missing: runT("publicResultStatusMissing"),
    stale: runT("publicResultStatusStale"),
    invalid: runT("publicResultStatusInvalid"),
    unavailable: runT("publicResultStatusUnavailable"),
  };
  const resultLabels: RunPublicResultLabels = {
    title: runT("publicResultTitle"),
    schemaRef: runT("publicResultSchemaRef"),
    revision: runT("publicResultRevision"),
    superseded: runT("publicResultSuperseded"),
    collected: runT("publicResultCollected"),
    notCollected: runT("publicResultNotCollected"),
    value: runT("publicResultValue"),
    noValue: runT("publicResultNoValue"),
    completedWithoutPromotion: runT("publicResultNoPromotion"),
    failureReason: runT("publicResultFailureReason"),
    status: statuses,
  };
  const terminalCauseLabels: TerminalCauseLabels = {
    ...(runT.raw("terminalCause") as Omit<TerminalCauseLabels, "codes">),
    codes: (runT.raw("failure") as Pick<TerminalCauseLabels, "codes">).codes,
  };
  const content = snapshot.content;
  const node =
    content.kind === "flow"
      ? content.nodes.find((item) => item.id === content.selectedNodeId)
      : null;
  const nodePicker =
    content.kind === "flow" && content.compatible ? (
      <label className="block text-sm">
        {t("node")}
        <select
          aria-label={t("node")}
          className="my-2 block w-full rounded border border-line bg-paper p-2"
          value={content.selectedNodeId ?? ""}
          onChange={(event) => peek.setNode(event.currentTarget.value)}
        >
          {content.nodes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    ) : null;
  const conversation = !snapshot.capabilities.canReadTranscript ? (
    <p role="status">{t("forbidden")}</p>
  ) : content.kind === "flow" && !content.compatible ? (
    <p role="status">{t("incompatible")}</p>
  ) : content.kind === "flow" && !node ? (
    <p>{t("emptyTranscript")}</p>
  ) : (
    <RunPeekTranscript
      key={`${snapshot.selectedRunId}:${node?.id ?? ""}`}
      nodeId={node?.id ?? null}
      runId={snapshot.selectedRunId}
    />
  );

  return (
    <RunStreamValueProvider
      runId={snapshot.selectedRunId}
      stream={stream.child}
    >
      <TerminalCauseNotice
        cause={snapshot.terminalCause}
        labels={terminalCauseLabels}
        status={snapshot.summary.status}
      />
      <Tabs
        activeKey={view}
        className="flex-wrap"
        items={[
          { key: "conversation", label: t("conversation") },
          { key: "execution", label: t("execution") },
          { key: "result", label: t("result") },
        ]}
        layout="fill"
        onSelect={(key) =>
          peek.setView(key as "conversation" | "execution" | "result")
        }
      />
      <div className="min-w-0 space-y-3 pt-3" data-testid="run-peek-content">
        {view === "conversation" ? (
          <>
            {nodePicker}
            {conversation}
          </>
        ) : null}
        {view === "execution" ? (
          <>
            {nodePicker}
            {content.kind === "flow" ? (
              content.compatible ? (
                node ? (
                  <FlowNodeDetails node={node} />
                ) : (
                  <p>{t("noNodes")}</p>
                )
              ) : (
                <p role="status">{t("incompatible")}</p>
              )
            ) : null}
            {snapshot.publicResult?.operationalOutcome ? (
              <OperationalOutcomeDetails
                outcome={snapshot.publicResult.operationalOutcome}
              />
            ) : null}
            {content.kind !== "flow"
              ? conversation
              : node
                ? conversation
                : null}
          </>
        ) : null}
        {view === "result" ? (
          snapshot.publicResult ? (
            <RunPublicResultPanel
              labels={resultLabels}
              result={snapshot.publicResult}
            />
          ) : (
            <p>{t("noResult")}</p>
          )
        ) : null}
      </div>
    </RunStreamValueProvider>
  );
}
