import type {
  ExecutionView,
  ParticipantView,
  VerdictView,
} from "@/components/evaluations/study-lab";
import type { ReactElement } from "react";

import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ProjectTabs } from "@/components/board/project-tabs";
import { StudyLab } from "@/components/evaluations/study-lab";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { isProjectBrainIndexingAvailable } from "@/lib/brain/availability";
import { getBoardData } from "@/lib/queries/board";
import {
  listComparableTaskRuns,
  listEnabledProfiles,
  listStudyExecutions,
} from "@/lib/evaluations/lab-queries";
import {
  getStudyForProject,
  listParticipants,
} from "@/lib/evaluations/studies";
import { listVerdicts } from "@/lib/evaluations/verdicts";
import { MaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";

interface PageProps {
  params: Promise<{ slug: string; studyId: string }>;
}

function canManage(role: string): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

export default async function StudyDetailPage({
  params,
}: PageProps): Promise<ReactElement> {
  const { slug, studyId } = await params;
  const user = await getSessionUser();

  if (!user) notFound();

  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) notFound();

  const role =
    user.role === "admin" ? "owner" : await getProjectRole(user.id, project.id);

  if (role === null) notFound();

  let study: Record<string, unknown>;

  try {
    study = await getStudyForProject({ studyId, projectId: project.id });
  } catch (err) {
    // A cross-project or unknown study id is hidden as 404 (ownership guard).
    if (err instanceof MaisterError && err.code === "PRECONDITION") notFound();
    throw err;
  }

  const t = await getTranslations("evaluationsLab");
  const [
    participantRows,
    executions,
    profiles,
    comparableRuns,
    verdictRows,
    board,
    showBrain,
  ] = await Promise.all([
    listParticipants(studyId),
    listStudyExecutions(studyId),
    listEnabledProfiles(),
    listComparableTaskRuns(study.taskId as string),
    listVerdicts(studyId),
    getBoardData(project.id),
    isProjectBrainIndexingAvailable(project),
  ]);

  const participants: ParticipantView[] = participantRows
    .filter((row) => !row.removedAt)
    .map((row) => ({
      id: row.id as string,
      label: row.label as string,
      sourceType: row.sourceType as "observed" | "launched",
      runId: (row.runId as string | null) ?? null,
      runStatus:
        ((row.runIdentity as { status?: string } | null)?.status as
          | string
          | undefined) ?? null,
    }));

  const verdicts: VerdictView[] = verdictRows.map((row) => ({
    id: row.id as string,
    outcome: row.outcome as string,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : null,
  }));

  return (
    <div className="w-full px-6 py-8">
      <ProjectTabs
        active="evaluations"
        boardCount={board.totalTasks}
        showBrain={showBrain}
        slug={slug}
      />
      <div className="mb-2">
        <Link
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-mute hover:text-ink"
          href={`/projects/${slug}/evaluations`}
        >
          <ArrowLeftIcon aria-hidden="true" className="h-3.5 w-3.5" />
          {t("backToStudies")}
        </Link>
      </div>

      <StudyLab
        canConclude={canManage(role)}
        canManage={canManage(role)}
        comparableRuns={comparableRuns}
        executions={executions as ExecutionView[]}
        participants={participants}
        profiles={profiles}
        slug={slug}
        study={{
          id: study.id as string,
          title: study.title as string,
          status: study.status as string,
          version: study.version as number,
        }}
        verdicts={verdicts}
      />
    </div>
  );
}
