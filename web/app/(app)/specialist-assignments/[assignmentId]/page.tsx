import type { ReactElement } from "react";

import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { AssignmentAcceptanceForm } from "@/components/specialist-assignments/assignment-acceptance-form";
import { AssignmentKnowledge } from "@/components/specialist-assignments/assignment-knowledge";
import { AssignmentLifecycle } from "@/components/specialist-assignments/assignment-lifecycle";
import { AssignmentLiveRefresh } from "@/components/specialist-assignments/assignment-live-refresh";
import { StandOperationControls } from "@/components/specialist-assignments/operation-controls";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { getSpecialistAssignmentContext } from "@/lib/specialist-assignments/context";
import { getSpecialistAssignmentAdmission } from "@/lib/specialist-assignments/admission-read";
import {
  getSpecialistAssignment,
  getSpecialistAssignmentInput,
} from "@/lib/specialist-assignments/store";
import {
  assignmentHasLiveWork,
  canChangeAssignment,
  listVisibleAssignmentRunIds,
  readAssignmentReview,
  readAssignmentStandChoices,
} from "@/lib/specialist-assignments/workspace-view";
import { readStandOperationEvidence } from "@/lib/stand-operations/operation-intake";
import { readStandIncidentEpisodes } from "@/lib/stand-operations/incidents";

const receiptTime = { dateStyle: "medium", timeStyle: "short" } as const;

export default async function SpecialistAssignmentPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}): Promise<ReactElement> {
  const { assignmentId } = await params;
  const user = await requireActiveSession();
  const t = await getTranslations("specialistAssignments");
  const format = await getFormatter();

  const {
    assignment,
    recovery,
    context,
    input,
    runs,
    stand,
    review,
    live,
    canChange,
    admission,
    operations,
    incidents,
  } = await readAssignmentPage(user.id, assignmentId);

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <header className="space-y-2">
        <Link className="text-sm text-mute" href="/specialist-assignments">
          {t("title")}
        </Link>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold">{assignment.objective}</h1>
          <span className="rounded-full border border-line px-3 py-1 text-sm">
            {t(`status.${assignment.status}`)}
          </span>
          <AssignmentLiveRefresh
            assignmentId={assignment.id}
            revision={assignment.revision}
            runId={live ? (runs.at(-1) ?? null) : null}
          />
        </div>
        <p className="text-sm text-mute">{assignment.expectedOutcome}</p>
      </header>
      <dl className="grid gap-4 rounded-xl border border-line bg-paper p-5 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-mute">{t("specialist")}</dt>
          <dd>{input.snapshot.standingDefinition.definition.name}</dd>
        </div>
        <div>
          <dt className="text-mute">{t("owner")}</dt>
          <dd>
            {t(assignment.owner.kind === "company" ? "company" : "project")}
          </dd>
        </div>
        <div>
          <dt className="text-mute">{t("revision")}</dt>
          <dd>{assignment.revision}</dd>
        </div>
        <div>
          <dt className="text-mute">{t("inputRevision")}</dt>
          <dd>{assignment.inputRevision}</dd>
        </div>
        <div>
          <dt className="text-mute">{t("contextRevision")}</dt>
          <dd>{assignment.contextRevision}</dd>
        </div>
        <div>
          <dt className="text-mute">{t("assignmentId")}</dt>
          <dd className="break-all">{assignment.id}</dd>
        </div>
      </dl>
      {admission?.carrier ? (
        <Link className="text-sm underline" href={admission.carrier.taskHref}>
          {t("carrierTask")} {admission.carrier.taskNumber}
        </Link>
      ) : null}
      <details className="rounded-xl border border-line bg-paper p-5 text-sm">
        <summary className="cursor-pointer font-semibold">
          {t("configuration")}
        </summary>
        <dl className="mt-3 space-y-2 break-all">
          <div>
            <dt className="text-mute">{t("packageRevision")}</dt>
            <dd>{input.snapshot.standingDefinition.packageRevision}</dd>
          </div>
          <div>
            <dt className="text-mute">{t("definitionDigest")}</dt>
            <dd>{input.snapshot.standingDefinition.definitionSha256}</dd>
          </div>
          <div>
            <dt className="text-mute">{t("observedAt")}</dt>
            <dd>
              {format.dateTime(
                new Date(input.snapshot.authoritySnapshot.capturedAt),
                { dateStyle: "medium", timeStyle: "short" },
              )}
            </dd>
          </div>
        </dl>
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify(input.snapshot.authoritySnapshot, null, 2)}
        </pre>
      </details>
      {assignment.status === "waiting_input" ? (
        <p className="rounded-xl border border-line bg-paper p-4 text-sm">
          {t("pendingInput")}{" "}
          <Link className="underline" href="/inbox">
            {t("openInbox")}
          </Link>
        </p>
      ) : null}
      {assignment.blockers.length ? (
        <div className="rounded-xl border border-line bg-paper p-5">
          <h2 className="font-semibold">{t("blockers")}</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {assignment.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {context.entries.length ? (
        <div className="rounded-xl border border-line bg-paper p-5">
          <h2 className="font-semibold">{t("workingContext")}</h2>
          <ul className="mt-3 divide-y divide-line">
            {context.entries.map(({ entry, actor, introducedRevision }) => (
              <li key={entry.id} className="space-y-1 py-3 text-sm">
                <p>{entry.text}</p>
                <p className="text-xs text-mute">
                  {t(`entry.${entry.kind}`)} · {actor.id} · {t("revision")}{" "}
                  {introducedRevision}
                </p>
                {entry.kind === "accepted" ? (
                  <Link
                    className="underline"
                    href={`/knowledge/results/${entry.acceptedWork.childRunId}/${entry.acceptedWork.resultRevision}`}
                  >
                    {t("acceptedFindings")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {incidents.length ? (
        <section className="space-y-3 rounded-xl border border-line bg-paper p-5">
          <h2 className="font-semibold">{t("incidents")}</h2>
          <ul className="space-y-3 text-sm">
            {incidents.map((incident) => (
              <li key={incident.id}>
                <p>
                  {t(`incidentReason.${incident.reason}`)} ·{" "}
                  {t(`incidentState.${incident.state}`)}
                </p>
                <p className="text-mute">
                  {t("incidentOccurrences", {
                    count: incident.occurrenceCount,
                  })}{" "}
                  ·{" "}
                  {format.dateTime(new Date(incident.lastAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
                {incident.state === "open" ? (
                  <p>{t("incidentRecovery")}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {operations.some(Boolean) ? (
        <div className="space-y-3">
          <h2 className="font-semibold">{t("operations")}</h2>
          {operations
            .flatMap((view) => (view ? [view] : []))
            .map(({ operation, action, approvedAt, effect, verification }) => (
              <article
                key={operation.id}
                className="rounded-xl border border-line bg-paper p-5"
              >
                <h3 className="font-medium">{operation.componentId}</h3>
                <p className="break-all text-xs text-mute">{operation.id}</p>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-mute">{t("effect")}</dt>
                    <dd>{t(`effectState.${operation.effectState}`)}</dd>
                  </div>
                  <div>
                    <dt className="text-mute">{t("verification")}</dt>
                    <dd>{t(`health.${operation.verificationState}`)}</dd>
                  </div>
                  <div>
                    <dt className="text-mute">{t("disposition")}</dt>
                    <dd>{t(`dispositionState.${operation.disposition}`)}</dd>
                  </div>
                </dl>
                {approvedAt ? (
                  <p className="mt-3 text-sm">
                    {t("approvalRecorded")} ·{" "}
                    {format.dateTime(approvedAt, receiptTime)}
                  </p>
                ) : null}
                {effect.length ? (
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer">
                      {t("receipts")} ({effect.length})
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {effect.map(({ id, capturedAt, receipt }) => (
                        <li key={id} className="break-all">
                          <p>
                            {t(`effectState.${receipt.effectState}`)} ·{" "}
                            {format.dateTime(capturedAt, receiptTime)}
                          </p>
                          <p className="text-xs text-mute">{id}</p>
                          {receipt.beforeInvocation ? (
                            <p className="text-xs">
                              {t("beforeInvocation")} {receipt.beforeInvocation}
                            </p>
                          ) : null}
                          {receipt.afterInvocation ? (
                            <p className="text-xs">
                              {t("afterInvocation")} {receipt.afterInvocation}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {verification.length ? (
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer">
                      {t("verificationReceipts")} ({verification.length})
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {verification.map(
                        ({ id, observedAt, state, effectReceiptId }) => (
                          <li key={id} className="break-all">
                            <p>
                              {t(`health.${state}`)} ·{" "}
                              {format.dateTime(observedAt, receiptTime)}
                            </p>
                            <p className="text-xs text-mute">{id}</p>
                            <p className="text-xs">
                              {t("effect")} {effectReceiptId}
                            </p>
                          </li>
                        ),
                      )}
                    </ul>
                  </details>
                ) : null}
                <StandOperationControls
                  canRecover={stand.canRecover}
                  canRestart={stand.canRestart}
                  needsApproval={action === "restart" && !approvedAt}
                  operation={operation}
                />
              </article>
            ))}
        </div>
      ) : null}
      {review && runs.includes(review.result.runId) ? (
        <AssignmentAcceptanceForm assignmentId={assignmentId} review={review} />
      ) : null}
      {assignment.status === "completed" && assignment.acceptedResult ? (
        <AssignmentKnowledge assignmentId={assignment.id} />
      ) : null}
      {!live && canChange ? (
        <AssignmentLifecycle
          action={recovery ? "reopen" : "cancel"}
          assignmentId={assignmentId}
          revision={assignment.revision}
        />
      ) : null}
      {runs.length ? (
        <div className="rounded-xl border border-line bg-paper p-5">
          <h2 className="font-semibold">{t("runs")}</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {runs.map((runId) => (
              <li key={runId}>
                <Link
                  className="underline"
                  href={`/runs/${encodeURIComponent(runId)}`}
                >
                  {runId}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

async function readAssignmentPage(userId: string, assignmentId: string) {
  const db = getDb();

  try {
    const assignment = await getSpecialistAssignment(db, userId, assignmentId);
    const recovery =
      assignment.status === "cancelled" || assignment.status === "failed";
    const [context, input, runs, stand, review, live, canChange, admission] =
      await Promise.all([
        getSpecialistAssignmentContext(db, userId, assignmentId),
        getSpecialistAssignmentInput(
          db,
          userId,
          assignmentId,
          assignment.inputRevision,
        ),
        listVisibleAssignmentRunIds(userId, assignment.runIds),
        readAssignmentStandChoices(db, userId, assignment),
        readAssignmentReview(db, userId, assignmentId),
        assignmentHasLiveWork(db, assignmentId),
        assignment.status === "completed"
          ? false
          : canChangeAssignment(
              db,
              userId,
              assignment,
              recovery ? "assignments:recover" : "assignments:cancel",
            ),
        assignment.owner.kind === "project"
          ? getSpecialistAssignmentAdmission(db, userId, assignmentId)
          : null,
      ]);
    const operations = await Promise.all(
      stand.operationIds.map((id) =>
        readStandOperationEvidence(db, userId, id).catch((error: unknown) => {
          if (
            isMaisterError(error) &&
            ["UNAUTHORIZED", "PRECONDITION"].includes(error.code)
          )
            return null;
          throw error;
        }),
      ),
    );

    const incidents = stand.operationIds.length
      ? await readStandIncidentEpisodes(db, userId, assignmentId)
      : [];

    return {
      assignment,
      recovery,
      context,
      input,
      runs,
      stand,
      review,
      live,
      canChange,
      admission,
      operations,
      incidents,
    };
  } catch (error) {
    if (
      isMaisterError(error) &&
      ["UNAUTHORIZED", "PRECONDITION"].includes(error.code)
    )
      notFound();
    throw error;
  }
}
