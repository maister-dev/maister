import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { ProjectTabs } from "@/components/board/project-tabs";
import {
  CreateExperimentModal,
  ExperimentList,
  type CreateExperimentLabels,
  type ExperimentListLabels,
} from "@/components/experiments/experiment-list";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { getBoardData } from "@/lib/queries/board";
import { getProjectBySlug } from "@/lib/queries/project";
import { listTaskDTOs } from "@/lib/services/tasks";
import { listProjectExperiments } from "@/lib/experiments/service";
import { DEFAULT_EXPERIMENT_RUBRIC } from "@/lib/experiments/rubric";

interface PageProps {
  params: Promise<{ slug: string }>;
}

function canManage(role: string): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

export default async function ProjectExperimentsPage({
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

  const [t, board, experiments, tasks] = await Promise.all([
    getTranslations("experiments"),
    getBoardData(project.id),
    listProjectExperiments(project.id),
    listTaskDTOs(project.id),
  ]);
  const listLabels: ExperimentListLabels = {
    title: t("list.title"),
    subtitle: t("list.subtitle"),
    empty: t("list.empty"),
    errorTitle: t("list.errorTitle"),
    create: t("create.trigger"),
    columns: {
      title: t("list.columns.title"),
      task: t("list.columns.task"),
      status: t("list.columns.status"),
      variants: t("list.columns.variants"),
      base: t("list.columns.base"),
      created: t("list.columns.created"),
      verdict: t("list.columns.verdict"),
    },
    verdictPending: t("list.verdictPending"),
    winner: t("list.winner"),
    outcome: {
      winner: t("outcome.winner"),
      tie: t("outcome.tie"),
      inconclusive: t("outcome.inconclusive"),
    },
    status: {
      draft: t("status.draft"),
      running: t("status.running"),
      comparable: t("status.comparable"),
      concluded: t("status.concluded"),
      abandoned: t("status.abandoned"),
    },
  };
  const createLabels: CreateExperimentLabels = {
    trigger: t("create.trigger"),
    title: t("create.title"),
    close: t("create.close"),
    experimentTitle: t("create.experimentTitle"),
    experimentDescription: t("create.experimentDescription"),
    taskMode: t("create.taskMode"),
    existingTask: t("create.existingTask"),
    newTask: t("create.newTask"),
    task: t("create.task"),
    taskTitle: t("create.taskTitle"),
    taskPrompt: t("create.taskPrompt"),
    baseBranch: t("create.baseBranch"),
    baseRef: t("create.baseRef"),
    variants: t("create.variants"),
    variantKey: t("create.variantKey"),
    variantLabel: t("create.variantLabel"),
    runner: t("create.runner"),
    executionPolicy: t("create.executionPolicy"),
    rulesAdd: t("create.rulesAdd"),
    rulesRemove: t("create.rulesRemove"),
    skillsAdd: t("create.skillsAdd"),
    skillsRemove: t("create.skillsRemove"),
    mcpsAdd: t("create.mcpsAdd"),
    mcpsRemove: t("create.mcpsRemove"),
    subagentsAdd: t("create.subagentsAdd"),
    subagentsRemove: t("create.subagentsRemove"),
    rubric: t("create.rubric"),
    optional: t("create.optional"),
    create: t("create.create"),
    creating: t("create.creating"),
    cancel: t("create.cancel"),
    errorGeneric: t("create.errorGeneric"),
    validationRequired: t("create.validationRequired"),
  };

  return (
    <>
      <ProjectTabs
        active="experiments"
        boardCount={board.totalTasks}
        slug={slug}
      />
      <ExperimentList
        createSlot={
          canManage(role) ? (
            <CreateExperimentModal
              defaultBaseBranch={project.mainBranch}
              defaultRubric={DEFAULT_EXPERIMENT_RUBRIC}
              labels={createLabels}
              slug={slug}
              tasks={tasks}
            />
          ) : null
        }
        items={experiments}
        labels={listLabels}
        slug={slug}
        taskKeyPrefix={project.taskKey}
      />
    </>
  );
}
