import type {
  StudySummary,
  TaskOption,
} from "@/components/evaluations/study-list";
import type { ReactElement } from "react";

import { notFound } from "next/navigation";

import { ProjectTabs } from "@/components/board/project-tabs";
import { StudyList } from "@/components/evaluations/study-list";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { isProjectBrainIndexingAvailable } from "@/lib/brain/availability";
import { listStudies } from "@/lib/evaluations/studies";
import { getBoardData } from "@/lib/queries/board";
import { getProjectBySlug } from "@/lib/queries/project";
import { listTaskDTOs } from "@/lib/services/tasks";

interface PageProps {
  params: Promise<{ slug: string }>;
}

function canManage(role: string): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

export default async function ProjectEvaluationsPage({
  params,
}: PageProps): Promise<ReactElement> {
  const { slug } = await params;
  const user = await getSessionUser();

  if (!user) notFound();

  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) notFound();

  const role =
    user.role === "admin" ? "owner" : await getProjectRole(user.id, project.id);

  if (role === null) notFound();

  const [studyRows, tasks, board, showBrain] = await Promise.all([
    listStudies(project.id),
    listTaskDTOs(project.id),
    getBoardData(project.id),
    isProjectBrainIndexingAvailable(project),
  ]);

  const studies: StudySummary[] = studyRows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    status: row.status as string,
    taskId: row.taskId as string,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
    legacyExperimentId: (row.legacyExperimentId as string | null) ?? null,
  }));

  const taskOptions: TaskOption[] = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    number: task.number,
  }));

  return (
    <div className="w-full px-6 py-8">
      <ProjectTabs
        active="evaluations"
        boardCount={board.totalTasks}
        showBrain={showBrain}
        slug={slug}
      />
      <StudyList
        canManage={canManage(role)}
        slug={slug}
        studies={studies}
        tasks={taskOptions}
      />
    </div>
  );
}
