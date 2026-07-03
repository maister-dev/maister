import type { ExperimentRubric } from "@/lib/experiments/types";
import type { ReactElement } from "react";

export interface RubricEditorLabels {
  rubric: string;
  optional: string;
}

export function RubricEditor({
  labels,
  rubric,
}: {
  labels: RubricEditorLabels;
  rubric: ExperimentRubric;
}): ReactElement {
  return (
    <section className="rounded-[12px] border border-line bg-ivory p-4">
      <h3 className="m-0 mb-3 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-mute">
        {labels.rubric}
      </h3>
      <div className="grid grid-cols-1 gap-2">
        {rubric.criteria.map((criterion, index) => (
          <div
            key={criterion.id}
            className="rounded-[10px] border border-line bg-paper p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="m-0 text-[13px] font-semibold text-ink">
                  {criterion.label}
                </p>
                <p className="m-0 mt-1 text-[12px] leading-5 text-mute">
                  {criterion.guidance}
                </p>
              </div>
              {criterion.optional ? (
                <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                  {labels.optional}
                </span>
              ) : null}
            </div>
            <input
              defaultValue={criterion.id}
              name={`rubric.${index}.id`}
              type="hidden"
            />
            <input
              defaultValue={criterion.label}
              name={`rubric.${index}.label`}
              type="hidden"
            />
            <input
              defaultValue={criterion.guidance}
              name={`rubric.${index}.guidance`}
              type="hidden"
            />
            <input
              defaultValue={criterion.scale.min}
              name={`rubric.${index}.min`}
              type="hidden"
            />
            <input
              defaultValue={criterion.scale.max}
              name={`rubric.${index}.max`}
              type="hidden"
            />
            <input
              defaultValue={criterion.weight}
              name={`rubric.${index}.weight`}
              type="hidden"
            />
            {criterion.optional ? (
              <input
                defaultValue="true"
                name={`rubric.${index}.optional`}
                type="hidden"
              />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
