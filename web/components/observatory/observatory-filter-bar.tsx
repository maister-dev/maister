"use client";

import type { ObservatoryFilterBarProps } from "@/components/observatory/types";
import type { ObservatoryHrefPatch } from "@/lib/observatory/href";
import type { ObservatoryRunKind } from "@/lib/observatory/run-kind";
import type { ReactElement, ReactNode } from "react";

import { useRouter } from "next/navigation";
import { useRef, useTransition } from "react";

import { buildObservatoryHref } from "@/lib/observatory/href";
import { OBSERVATORY_PERIOD_PRESETS } from "@/lib/observatory/period";
import { isObservatoryRunKind } from "@/lib/observatory/run-kind";

/**
 * The auto-apply filter bar (ADR-177 D7) — the first in the app.
 *
 * The URL is the state: every control writes back to it through
 * `router.replace(…, { scroll: false })` inside a transition, so there is no
 * Apply button, no local mirror of a committed filter, and back/forward
 * restores exactly what the reader saw. Presets, selects and dates commit on
 * `change`; free text commits on blur or Enter, because a round-trip per
 * keystroke is a round-trip per keystroke.
 *
 * Mounted ONCE above the view switch, so text typed but not yet committed
 * survives a view change.
 *
 * Every control is UNCONTROLLED and re-keyed on its effective value. A
 * controlled input with no local state snaps back the instant `onChange` fires
 * — React re-renders it with the same prop long before the server round-trip
 * lands — so the reader watches their own edit undo itself.
 */
export function ObservatoryFilterBar({
  current,
  labels,
  pathname,
  projectOptions,
}: ObservatoryFilterBarProps): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // A custom range needs BOTH ends, and a half-entered one is dropped at parse
  // (D1) — so it never reaches the URL and the second date input would have no
  // partner to complete. Reading the pair off the DOM at commit time is the
  // one place a ref belongs here: an event-time read, not render state.
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);

  const commit = (patch: ObservatoryHrefPatch): void => {
    startTransition(() => {
      router.replace(buildObservatoryHref(pathname, current, patch), {
        scroll: false,
      });
    });
  };
  const commitRange = (): void =>
    commit({
      from: fromRef.current?.value || null,
      to: toRef.current?.value || null,
    });
  const presetLabel: Record<number, string> = {
    7: labels.period.preset7,
    30: labels.period.preset30,
    90: labels.period.preset90,
  };
  const isQuality = current.view === "quality";
  const showDrilldown = isQuality || current.view === "harness";

  return (
    <section
      aria-busy={pending}
      aria-label={labels.filters}
      className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-paper p-3"
      data-testid="observatory-filter-bar"
    >
      <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
        <legend className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
          {labels.period.label}
        </legend>
        <div className="inline-flex gap-0.5 rounded-full border border-line bg-ivory p-[3px]">
          {OBSERVATORY_PERIOD_PRESETS.map((preset) => (
            <button
              key={preset}
              aria-pressed={current.period.preset === preset}
              className={
                current.period.preset === preset
                  ? "inline-flex items-center rounded-full bg-paper px-3 py-[6px] font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.06em] text-ink shadow-[var(--shadow-sm)]"
                  : "inline-flex items-center rounded-full px-3 py-[6px] font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.06em] text-mute transition-colors hover:text-ink"
              }
              type="button"
              onClick={() => commit({ windowDays: preset })}
            >
              {presetLabel[preset]}
            </button>
          ))}
        </div>
      </fieldset>

      <Field label={labels.period.from}>
        <input
          key={`from:${current.period.from ?? ""}`}
          ref={fromRef}
          className={INPUT_CLASS}
          defaultValue={current.period.from ?? ""}
          name="from"
          type="date"
          onChange={commitRange}
        />
      </Field>
      <Field label={labels.period.to}>
        <input
          key={`to:${current.period.to ?? ""}`}
          ref={toRef}
          className={INPUT_CLASS}
          defaultValue={current.period.to ?? ""}
          name="to"
          type="date"
          onChange={commitRange}
        />
      </Field>

      <Field label={labels.runKind}>
        <select
          key={`runKind:${current.runKind}`}
          className={INPUT_CLASS}
          defaultValue={current.runKind}
          name="runKind"
          onChange={(event) =>
            commit({ runKind: toRunKind(event.target.value) })
          }
        >
          <option value="all">{labels.all}</option>
          <option value="flow">{labels.agentization.flow}</option>
          <option value="scratch">{labels.agentization.scratch}</option>
          <option value="agent">{labels.agentization.agent}</option>
        </select>
      </Field>

      {projectOptions ? (
        <Field label={labels.overview.project}>
          <select
            key={`project:${current.project ?? ""}`}
            className={INPUT_CLASS}
            defaultValue={current.project ?? ""}
            name="project"
            onChange={(event) =>
              commit({ project: event.target.value || null })
            }
          >
            <option value="">{labels.all}</option>
            {projectOptions.map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {showDrilldown ? (
        <>
          <TextField
            label={labels.flow}
            name="flowId"
            placeholder={labels.all}
            value={current.flowId ?? ""}
            onCommit={(value) => commit({ flowId: value || null })}
          />
          <TextField
            label={labels.node}
            name="nodeId"
            placeholder={labels.all}
            value={current.nodeId ?? ""}
            onCommit={(value) => commit({ nodeId: value || null })}
          />
        </>
      ) : null}

      {isQuality ? (
        <>
          <TextField
            label={labels.artifactKind}
            name="artifactKind"
            placeholder={labels.all}
            value={current.artifactKind ?? ""}
            onCommit={(value) => commit({ artifactKind: value || null })}
          />
          <TextField
            label={labels.artifactDefId}
            name="artifactDefId"
            placeholder={labels.all}
            value={current.artifactDefId ?? ""}
            onCommit={(value) => commit({ artifactDefId: value || null })}
          />
        </>
      ) : null}

      {current.period.clamped ? (
        <p className="m-0 self-center font-mono text-[10.5px] text-amber">
          {labels.period.clamped}
        </p>
      ) : null}
      {/* Text plus colour, never colour alone. */}
      <p
        aria-live="polite"
        className="m-0 self-center font-mono text-[10.5px] text-amber"
        data-testid="observatory-filter-pending"
      >
        {pending ? labels.period.pending : ""}
      </p>
    </section>
  );
}

const INPUT_CLASS =
  "h-9 min-w-0 rounded-medium border border-line bg-ivory px-2 font-mono text-[11.5px] text-ink outline-none transition-colors focus:border-amber";

function toRunKind(value: string): ObservatoryRunKind {
  return isObservatoryRunKind(value) ? value : "all";
}

function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}): ReactElement {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * Free text commits on blur or Enter, never per keystroke. `defaultValue`
 * rather than `value`: the field owns its own draft until the reader commits
 * it, which is what lets an uncommitted draft survive a view change.
 */
function TextField({
  label,
  name,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  name: string;
  placeholder: string;
  value: string;
  onCommit: (value: string) => void;
}): ReactElement {
  return (
    <Field label={label}>
      <input
        key={`${name}:${value}`}
        className={INPUT_CLASS}
        defaultValue={value}
        name={name}
        placeholder={placeholder}
        type="text"
        onBlur={(event) => {
          if (event.target.value.trim() !== value) {
            onCommit(event.target.value.trim());
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onCommit(event.currentTarget.value.trim());
        }}
      />
    </Field>
  );
}
