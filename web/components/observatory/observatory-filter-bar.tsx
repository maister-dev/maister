"use client";

import type { ObservatoryFilterBarProps } from "@/components/observatory/types";
import type { ObservatoryHrefPatch } from "@/lib/observatory/href";
import type { ObservatoryRunKind } from "@/lib/observatory/run-kind";
import type { ReactElement, ReactNode } from "react";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { buildObservatoryHref } from "@/lib/observatory/href";
import { DELIVERY_RUN_KINDS } from "@/lib/observatory/run-kind";
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
  // Free-text DRAFTS, held in state rather than only in the DOM.
  //
  // A view tab is a `<Link>` whose href was built from the state the server
  // last rendered, so clicking one blurs the field (committing the draft) and
  // then navigates to a URL that does not carry it — the value round-trips
  // out of existence and the field re-renders empty. Keeping the draft here
  // means the text is still on screen to re-commit, which is what D7 promises
  // by mounting the bar once above the view switch.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // What THIS bar last committed per field. A URL value we put there must not
  // discard its own draft; a value that arrived from anywhere else (a heatmap
  // drill-down, a pasted link) must.
  const committed = useRef<Record<string, string>>({});
  const textValues: Record<string, string> = {
    flowId: current.flowId ?? "",
    nodeId: current.nodeId ?? "",
    artifactKind: current.artifactKind ?? "",
    artifactDefId: current.artifactDefId ?? "",
  };
  const previousText = useRef(textValues);

  useEffect(() => {
    const foreign = Object.keys(textValues).filter(
      (name) =>
        textValues[name] !== previousText.current[name] &&
        textValues[name] !== "" &&
        textValues[name] !== committed.current[name],
    );

    previousText.current = textValues;
    if (foreign.length === 0) return;

    setDrafts((previous) => {
      const next = { ...previous };

      for (const name of foreign) delete next[name];

      return next;
    });
    // `textValues` is rebuilt every render; the URL fields it reads are the
    // real dependency.
  }, [
    current.flowId,
    current.nodeId,
    current.artifactKind,
    current.artifactDefId,
  ]);

  // Every commit composes onto the ones still in flight.
  //
  // `current` is a SERVER prop: it only changes when a round-trip lands. A
  // second control touched before then would otherwise build its URL from the
  // pre-first-edit state and silently drop the first edit — and because the
  // selects are uncontrolled and re-keyed on their effective value, the
  // discarded one keeps SHOWING the reader's choice while the page is filtered
  // by something else. Patch values are absolute rather than deltas, so
  // replaying the merged patch onto whichever `current` is live is idempotent.
  const inFlight = useRef<ObservatoryHrefPatch>({});
  // The URL the server state represents. It changing is the ONLY evidence that
  // a navigation landed — `pending` is not, because a transition whose scope
  // schedules no state update settles before the page it asked for arrives.
  const currentHref = buildObservatoryHref(pathname, current);

  useEffect(() => {
    // Either our patch arrived, or the reader went somewhere else entirely
    // (Back, a heatmap drill-down). Both mean the accumulated patch is spent:
    // replaying it onto the next edit would re-impose a filter the URL no
    // longer carries.
    inFlight.current = {};
  }, [currentHref]);

  const commit = (patch: ObservatoryHrefPatch): void => {
    const merged = { ...inFlight.current, ...patch };

    inFlight.current = merged;
    startTransition(() => {
      router.replace(buildObservatoryHref(pathname, current, merged), {
        scroll: false,
      });
    });
  };
  const commitText = (name: string, value: string): void => {
    committed.current[name] = value;
    setDrafts((previous) => ({ ...previous, [name]: value }));
    commit({ [name]: value || null } as ObservatoryHrefPatch);
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
          {DELIVERY_RUN_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {labels.runKindName[kind]}
            </option>
          ))}
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
            draft={drafts.flowId}
            label={labels.flow}
            name="flowId"
            placeholder={labels.all}
            uncommittedLabel={labels.uncommitted}
            value={current.flowId ?? ""}
            onCommit={(value) => commitText("flowId", value)}
            onDraft={(value) =>
              setDrafts((previous) => ({ ...previous, flowId: value }))
            }
          />
          <TextField
            draft={drafts.nodeId}
            label={labels.node}
            name="nodeId"
            placeholder={labels.all}
            uncommittedLabel={labels.uncommitted}
            value={current.nodeId ?? ""}
            onCommit={(value) => commitText("nodeId", value)}
            onDraft={(value) =>
              setDrafts((previous) => ({ ...previous, nodeId: value }))
            }
          />
        </>
      ) : null}

      {isQuality ? (
        <>
          <TextField
            draft={drafts.artifactKind}
            label={labels.artifactKind}
            name="artifactKind"
            placeholder={labels.all}
            uncommittedLabel={labels.uncommitted}
            value={current.artifactKind ?? ""}
            onCommit={(value) => commitText("artifactKind", value)}
            onDraft={(value) =>
              setDrafts((previous) => ({ ...previous, artifactKind: value }))
            }
          />
          <TextField
            draft={drafts.artifactDefId}
            label={labels.artifactDefId}
            name="artifactDefId"
            placeholder={labels.all}
            uncommittedLabel={labels.uncommitted}
            value={current.artifactDefId ?? ""}
            onCommit={(value) => commitText("artifactDefId", value)}
            onDraft={(value) =>
              setDrafts((previous) => ({ ...previous, artifactDefId: value }))
            }
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
 * Free text commits on blur or Enter, never per keystroke — a commit per
 * keystroke is a server round-trip per keystroke.
 *
 * Controlled by `draft ?? value`: the draft (component state) wins while the
 * reader is editing and survives the remounts a URL change causes; once no
 * draft is held, the field shows whatever the URL says, so a drill-down link
 * that sets `nodeId` elsewhere still updates it.
 *
 * A draft the URL does not carry is ANNOUNCED. The bar deliberately keeps such
 * text on screen (the blur-then-tab sequence a view click causes would
 * otherwise destroy it), but a field showing a value the page is not filtered
 * by, with no signal, is a lie the reader cannot see — and the only way out is
 * to focus and blur it. Text, never colour alone.
 */
function TextField({
  draft,
  label,
  name,
  placeholder,
  uncommittedLabel,
  value,
  onCommit,
  onDraft,
}: {
  draft?: string;
  label: string;
  name: string;
  placeholder: string;
  uncommittedLabel: string;
  value: string;
  onCommit: (value: string) => void;
  onDraft: (value: string) => void;
}): ReactElement {
  const shown = draft ?? value;
  const uncommitted = shown.trim() !== value;
  const hintId = `observatory-filter-${name}-uncommitted`;

  return (
    <Field label={label}>
      <input
        aria-describedby={uncommitted ? hintId : undefined}
        className={INPUT_CLASS}
        name={name}
        placeholder={placeholder}
        type="text"
        value={shown}
        onBlur={(event) => {
          if (event.target.value.trim() !== value) {
            onCommit(event.target.value.trim());
          }
        }}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onCommit(event.currentTarget.value.trim());
        }}
      />
      {uncommitted ? (
        <span
          className="font-mono text-[10px] text-amber"
          data-testid={hintId}
          id={hintId}
        >
          {uncommittedLabel}
        </span>
      ) : null}
    </Field>
  );
}
