"use client";

import type {
  ExperimentRubric,
  ExperimentVariant,
  ExperimentVariantConfig,
} from "@/lib/experiments/types";
import type { ExperimentFlowOption } from "@/lib/experiments/service";
import type { TaskDTO } from "@/lib/services/tasks";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import clsx from "clsx";

import { RubricEditor } from "@/components/experiments/rubric-editor";
import {
  csv,
  VariantEditor,
  type VariantEditorLabels,
} from "@/components/experiments/variant-editor";

export interface CreateExperimentLabels extends VariantEditorLabels {
  trigger: string;
  title: string;
  close: string;
  experimentTitle: string;
  experimentDescription: string;
  taskMode: string;
  existingTask: string;
  newTask: string;
  task: string;
  taskTitle: string;
  taskPrompt: string;
  taskFlow: string;
  baseBranch: string;
  baseRef: string;
  rubric: string;
  optional: string;
  create: string;
  creating: string;
  cancel: string;
  errorGeneric: string;
  validationRequired: string;
}

export interface CreateExperimentFormProps {
  labels: CreateExperimentLabels;
  tasks: CreateExperimentTaskOption[];
  flows: ExperimentFlowOption[];
  defaultBaseBranch: string;
  defaultVariants: ExperimentVariant[];
  defaultRubric: ExperimentRubric;
  busy: boolean;
  error: string | null;
  onSubmit?: (form: HTMLFormElement) => void;
  onCancel?: () => void;
}

type CreatedTaskResponse = {
  taskId: string;
};

type CreateExperimentTaskOption = Pick<
  TaskDTO,
  "id" | "number" | "title" | "taskKey" | "flowId"
>;

function nonEmpty(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseExecutionPolicy(value: string | undefined): unknown {
  if (!value) return undefined;

  return JSON.parse(value) as unknown;
}

function formIndexes(form: FormData, pattern: RegExp): number[] {
  return Array.from(form.keys())
    .map((key) => {
      const match = pattern.exec(key);

      return match ? Number(match[1]) : null;
    })
    .filter(
      (index): index is number => index !== null && Number.isInteger(index),
    )
    .sort((left, right) => left - right);
}

function overlayClass(
  form: FormData,
  index: number,
  key: "rules" | "skills" | "mcps" | "subagents",
): { add?: string[]; remove?: string[] } | undefined {
  const add = csv(form.get(`variant.${index}.${key}Add`));
  const remove = csv(form.get(`variant.${index}.${key}Remove`));

  if (add.length === 0 && remove.length === 0) return undefined;

  return {
    ...(add.length > 0 ? { add } : {}),
    ...(remove.length > 0 ? { remove } : {}),
  };
}

function variantConfig(form: FormData, index: number): ExperimentVariantConfig {
  const runnerId = nonEmpty(form.get(`variant.${index}.runnerId`));
  const executionPolicy = parseExecutionPolicy(
    nonEmpty(form.get(`variant.${index}.executionPolicy`)),
  ) as ExperimentVariantConfig["executionPolicy"] | undefined;
  const capabilityOverlay = {
    rules: overlayClass(form, index, "rules"),
    skills: overlayClass(form, index, "skills"),
    mcps: overlayClass(form, index, "mcps"),
    subagents: overlayClass(form, index, "subagents"),
  };
  const overlayEntries = Object.entries(capabilityOverlay).filter(
    ([, value]) => value !== undefined,
  );

  return {
    ...(runnerId ? { runnerId } : {}),
    ...(executionPolicy ? { executionPolicy } : {}),
    ...(overlayEntries.length > 0
      ? { capabilityOverlay: Object.fromEntries(overlayEntries) }
      : {}),
  };
}

function variantsFromForm(form: FormData): ExperimentVariant[] {
  return formIndexes(form, /^variant\.(\d+)\.key$/)
    .map((index) => {
      const key = nonEmpty(form.get(`variant.${index}.key`));
      const label = nonEmpty(form.get(`variant.${index}.label`));

      if (!key || !label) return null;

      return { key, label, config: variantConfig(form, index) };
    })
    .filter((variant): variant is ExperimentVariant => variant !== null);
}

function rubricFromForm(form: FormData): ExperimentRubric {
  const criteria = formIndexes(form, /^rubric\.(\d+)\.id$/)
    .map((index) => {
      const id = nonEmpty(form.get(`rubric.${index}.id`));
      const label = nonEmpty(form.get(`rubric.${index}.label`));
      const guidance = nonEmpty(form.get(`rubric.${index}.guidance`));
      const min = Number(nonEmpty(form.get(`rubric.${index}.min`)) ?? "1");
      const max = Number(nonEmpty(form.get(`rubric.${index}.max`)) ?? "5");
      const weight = Number(
        nonEmpty(form.get(`rubric.${index}.weight`)) ?? "1",
      );

      if (!id || !label || !guidance) return null;

      return {
        id,
        label,
        guidance,
        scale: { min, max },
        weight,
        ...(nonEmpty(form.get(`rubric.${index}.optional`)) === "true"
          ? { optional: true }
          : {}),
      };
    })
    .filter(
      (criterion): criterion is ExperimentRubric["criteria"][number] =>
        criterion !== null,
    );

  return { criteria };
}

function defaultTaskId(tasks: CreateExperimentTaskOption[]): string {
  return tasks[0]?.id ?? "";
}

function nextVariantKey(variants: ExperimentVariant[]): string {
  const used = new Set(variants.map((variant) => variant.key));

  for (let code = 97; code <= 122; code += 1) {
    const candidate = String.fromCharCode(code);

    if (!used.has(candidate)) return candidate;
  }

  return `v${variants.length + 1}`;
}

function createBlankVariant(variants: ExperimentVariant[]): ExperimentVariant {
  const nextIndex = variants.length + 1;

  return {
    key: nextVariantKey(variants),
    label: `Variant ${nextIndex}`,
    config: {},
  };
}

export function CreateExperimentForm({
  labels,
  tasks,
  flows,
  defaultBaseBranch,
  defaultVariants,
  defaultRubric,
  busy,
  error,
  onSubmit,
  onCancel,
}: CreateExperimentFormProps): ReactElement {
  const [variants, setVariants] = useState(defaultVariants);
  const flowIds = new Set(flows.map((flow) => flow.id));
  const configuredTasks = tasks.filter(
    (task) => task.flowId !== null && flowIds.has(task.flowId),
  );
  const defaultTaskMode = configuredTasks.length > 0 ? "existing" : "new";

  return (
    <form
      className="flex max-h-[80vh] flex-col overflow-hidden"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(event.currentTarget);
      }}
    >
      <div className="flex-1 space-y-4 overflow-auto px-5 py-5">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
              {labels.experimentTitle}
            </span>
            <input
              required
              className="rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink"
              name="title"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
              {labels.baseBranch}
            </span>
            <input
              required
              className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink"
              defaultValue={defaultBaseBranch}
              name="baseBranch"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
            {labels.experimentDescription}
          </span>
          <textarea
            className="min-h-[70px] rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink"
            name="description"
          />
        </label>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
              {labels.taskMode}
            </span>
            <select
              className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink"
              defaultValue={defaultTaskMode}
              name="taskMode"
            >
              <option value="existing">{labels.existingTask}</option>
              <option value="new">{labels.newTask}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
              {labels.task}
            </span>
            <select
              className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink"
              defaultValue={defaultTaskId(configuredTasks)}
              name="taskId"
            >
              {configuredTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.taskKey}-{task.number} · {task.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
              {labels.taskTitle}
            </span>
            <input
              className="rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink"
              name="taskTitle"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
              {labels.taskFlow}
            </span>
            <select
              className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink"
              defaultValue={flows[0]?.id ?? ""}
              disabled={flows.length === 0}
              name="flowId"
            >
              {flows.map((flow) => (
                <option key={flow.id} value={flow.id}>
                  {flow.ref}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
              {labels.baseRef}
            </span>
            <input
              className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink"
              name="baseRef"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
            {labels.taskPrompt}
          </span>
          <textarea
            className="min-h-[70px] rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink"
            name="taskPrompt"
          />
        </label>
        <VariantEditor
          labels={labels}
          variants={variants}
          onAddVariant={() =>
            setVariants((current) =>
              current.length >= 12
                ? current
                : [...current, createBlankVariant(current)],
            )
          }
          onRemoveVariant={(index) =>
            setVariants((current) =>
              current.length <= 2
                ? current
                : current.filter((_, currentIndex) => currentIndex !== index),
            )
          }
        />
        <RubricEditor
          labels={{ rubric: labels.rubric, optional: labels.optional }}
          rubric={defaultRubric}
        />
        {error ? (
          <div
            className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700"
            role="alert"
          >
            {error}
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
        <button
          className="rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold text-mute hover:text-ink"
          type="button"
          onClick={onCancel}
        >
          {labels.cancel}
        </button>
        <button
          className={clsx(
            "rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white",
            busy && "opacity-60",
          )}
          data-testid="create-experiment-submit"
          disabled={busy}
          type="submit"
        >
          {busy ? labels.creating : labels.create}
        </button>
      </div>
    </form>
  );
}

export function CreateExperimentModal({
  slug,
  labels,
  tasks,
  flows,
  defaultBaseBranch,
  defaultRubric,
}: {
  slug: string;
  labels: CreateExperimentLabels;
  tasks: CreateExperimentTaskOption[];
  flows: ExperimentFlowOption[];
  defaultBaseBranch: string;
  defaultRubric: ExperimentRubric;
}): ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const defaultVariants = useMemo<ExperimentVariant[]>(
    () => [
      { key: "a", label: "Control", config: {} },
      { key: "b", label: "Candidate", config: {} },
    ],
    [],
  );

  async function submit(formEl: HTMLFormElement): Promise<void> {
    const form = new FormData(formEl);

    setBusy(true);
    setError(null);

    try {
      let taskId = nonEmpty(form.get("taskId"));

      if (form.get("taskMode") === "new") {
        const flowId = nonEmpty(form.get("flowId"));

        if (!flowId) throw new Error(labels.validationRequired);

        const taskRes = await fetch(`/api/projects/${slug}/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: nonEmpty(form.get("taskTitle")),
            prompt: nonEmpty(form.get("taskPrompt")),
            flowId,
          }),
        });

        if (!taskRes.ok) throw new Error(labels.errorGeneric);

        const task = (await taskRes.json()) as CreatedTaskResponse;

        taskId = task.taskId;
      }

      if (!taskId) throw new Error(labels.validationRequired);

      const res = await fetch(`/api/projects/${slug}/experiments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId,
          title: nonEmpty(form.get("title")),
          description: nonEmpty(form.get("description")),
          baseBranch: nonEmpty(form.get("baseBranch")),
          baseRef: nonEmpty(form.get("baseRef")),
          variants: variantsFromForm(form),
          rubric: rubricFromForm(form),
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
          message?: string;
        } | null;

        throw new Error(body?.message ?? body?.code ?? labels.errorGeneric);
      }

      setOpen(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : labels.errorGeneric);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="inline-flex items-center gap-1.5 rounded-lg border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white hover:bg-amber-2"
        type="button"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">+</span>
        {labels.trigger}
      </button>
      {open ? (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <button
            aria-label={labels.close}
            className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
            type="button"
            onClick={() => setOpen(false)}
          />
          <div
            aria-modal="true"
            className="relative w-full max-w-[960px] overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
            role="dialog"
          >
            <header className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="m-0 text-base font-bold text-ink">
                {labels.title}
              </h2>
              <button
                aria-label={labels.close}
                className="font-mono text-sm text-mute hover:text-ink"
                type="button"
                onClick={() => setOpen(false)}
              >
                x
              </button>
            </header>
            <CreateExperimentForm
              busy={busy}
              defaultBaseBranch={defaultBaseBranch}
              defaultRubric={defaultRubric}
              defaultVariants={defaultVariants}
              error={error}
              flows={flows}
              labels={labels}
              tasks={tasks}
              onCancel={() => setOpen(false)}
              onSubmit={(form) => void submit(form)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
