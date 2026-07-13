"use client";

import type { StringListFieldLabels } from "@/components/flows/node-form/string-list-field";
import type { FlowMetadata } from "@/lib/config.schema";
import type { ReactElement, ReactNode } from "react";

import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";

import { StringListField } from "@/components/flows/node-form/string-list-field";

export type FlowMetadataFormLabels = {
  heading: string;
  hint: string;
  title: string;
  summary: string;
  routeWhen: string;
  routeWhenHint: string;
  labels: string;
  labelsList: StringListFieldLabels;
  links: {
    field: string;
    add: string;
    remove: string;
    title: string;
    url: string;
    kind: string;
  };
  sources: {
    field: string;
    add: string;
    remove: string;
    component: string;
    origin: string;
  };
};

type LinkRow = NonNullable<FlowMetadata["links"]>[number];
type SourceRow = NonNullable<FlowMetadata["sources"]>[number];

const LABEL_CLS =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute";
const FIELD_CLS =
  "min-w-0 flex-1 rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-amber disabled:opacity-60";

// Flow-level `metadata` editor for the Studio graph editor's right sidebar,
// shown when NO node is selected (the flow "header": title/summary/labels/
// route_when/links/sources). Controlled by the live manifest; blank rows are
// kept here and pruned at the canvas→YAML serialize boundary
// (pruneManifestMetadata), mirroring how NodeSideForm's list fields behave.
export function FlowMetadataForm({
  metadata,
  labels,
  readOnly = false,
  onChange,
}: {
  metadata: FlowMetadata | undefined;
  labels: FlowMetadataFormLabels;
  readOnly?: boolean;
  onChange: (next: FlowMetadata) => void;
}): ReactElement {
  const m: FlowMetadata = metadata ?? {};
  const links: LinkRow[] = m.links ?? [];
  const sources: SourceRow[] = m.sources ?? [];

  const patch = (next: Partial<FlowMetadata>): void =>
    onChange({ ...m, ...next });

  const setLinkAt = (index: number, row: Partial<LinkRow>): void =>
    patch({
      links: links.map((entry, i) =>
        i === index ? { ...entry, ...row } : entry,
      ),
    });

  const setSourceAt = (index: number, row: Partial<SourceRow>): void =>
    patch({
      sources: sources.map((entry, i) =>
        i === index ? { ...entry, ...row } : entry,
      ),
    });

  return (
    <div className="grid gap-3" data-testid="flow-metadata-form">
      <div>
        <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-ink">
          {labels.heading}
        </h3>
        <p className="mt-1 font-mono text-[10px] leading-[1.4] text-mute">
          {labels.hint}
        </p>
      </div>

      <Field label={labels.title}>
        <input
          className={FIELD_CLS}
          data-testid="flow-meta-title"
          disabled={readOnly}
          value={m.title ?? ""}
          onChange={(event) => patch({ title: event.target.value })}
        />
      </Field>

      <Field label={labels.summary}>
        <textarea
          className={`min-h-[56px] ${FIELD_CLS}`}
          data-testid="flow-meta-summary"
          disabled={readOnly}
          value={m.summary ?? ""}
          onChange={(event) => patch({ summary: event.target.value })}
        />
      </Field>

      <Field hint={labels.routeWhenHint} label={labels.routeWhen}>
        <textarea
          className={`min-h-[56px] ${FIELD_CLS}`}
          data-testid="flow-meta-route-when"
          disabled={readOnly}
          value={m.route_when ?? ""}
          onChange={(event) => patch({ route_when: event.target.value })}
        />
      </Field>

      <StringListField
        label={labels.labels}
        labels={labels.labelsList}
        readOnly={readOnly}
        testid="flow-meta-labels"
        values={m.labels ?? []}
        onChange={(next) => patch({ labels: next })}
      />

      <RowGroup
        add={labels.links.add}
        count={links.length}
        field={labels.links.field}
        readOnly={readOnly}
        testid="flow-meta-links"
        onAdd={() => patch({ links: [...links, { title: "", url: "" }] })}
      >
        {links.map((link, i) => (
          <Row
            key={i}
            index={i}
            readOnly={readOnly}
            remove={labels.links.remove}
            testid="flow-meta-link"
            onRemove={() => patch({ links: links.filter((_, j) => j !== i) })}
          >
            <input
              aria-label={`${labels.links.title} ${i + 1}`}
              className={FIELD_CLS}
              data-testid={`flow-meta-link-${i}-title`}
              disabled={readOnly}
              placeholder={labels.links.title}
              value={link.title}
              onChange={(event) => setLinkAt(i, { title: event.target.value })}
            />
            <input
              aria-label={`${labels.links.url} ${i + 1}`}
              className={FIELD_CLS}
              data-testid={`flow-meta-link-${i}-url`}
              disabled={readOnly}
              placeholder={labels.links.url}
              value={link.url}
              onChange={(event) => setLinkAt(i, { url: event.target.value })}
            />
            <input
              aria-label={`${labels.links.kind} ${i + 1}`}
              className={FIELD_CLS}
              data-testid={`flow-meta-link-${i}-kind`}
              disabled={readOnly}
              placeholder={labels.links.kind}
              value={link.kind ?? ""}
              onChange={(event) => setLinkAt(i, { kind: event.target.value })}
            />
          </Row>
        ))}
      </RowGroup>

      <RowGroup
        add={labels.sources.add}
        count={sources.length}
        field={labels.sources.field}
        readOnly={readOnly}
        testid="flow-meta-sources"
        onAdd={() =>
          patch({ sources: [...sources, { component: "", origin: "" }] })
        }
      >
        {sources.map((source, i) => (
          <Row
            key={i}
            index={i}
            readOnly={readOnly}
            remove={labels.sources.remove}
            testid="flow-meta-source"
            onRemove={() =>
              patch({ sources: sources.filter((_, j) => j !== i) })
            }
          >
            <input
              aria-label={`${labels.sources.component} ${i + 1}`}
              className={FIELD_CLS}
              data-testid={`flow-meta-source-${i}-component`}
              disabled={readOnly}
              placeholder={labels.sources.component}
              value={source.component}
              onChange={(event) =>
                setSourceAt(i, { component: event.target.value })
              }
            />
            <input
              aria-label={`${labels.sources.origin} ${i + 1}`}
              className={FIELD_CLS}
              data-testid={`flow-meta-source-${i}-origin`}
              disabled={readOnly}
              placeholder={labels.sources.origin}
              value={source.origin}
              onChange={(event) =>
                setSourceAt(i, { origin: event.target.value })
              }
            />
          </Row>
        ))}
      </RowGroup>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="grid gap-1">
      <span className={LABEL_CLS}>{label}</span>
      {hint ? (
        <span className="font-mono text-[10px] leading-[1.4] text-mute">
          {hint}
        </span>
      ) : null}
      {children}
    </label>
  );
}

function RowGroup({
  field,
  count,
  testid,
  add,
  readOnly,
  onAdd,
  children,
}: {
  field: string;
  count: number;
  testid: string;
  add: string;
  readOnly: boolean;
  onAdd: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="grid gap-1.5">
      <span className={LABEL_CLS}>
        {field} ({count})
      </span>
      <div className="grid gap-1.5" data-testid={testid}>
        {children}
      </div>
      {readOnly ? null : (
        <button
          className="inline-flex w-fit items-center gap-1 rounded-md border border-line bg-paper px-2 py-1 font-mono text-[10.5px] text-ink-2 hover:border-amber hover:text-ink"
          data-testid={`${testid}-add`}
          type="button"
          onClick={onAdd}
        >
          <PlusIcon className="h-3.5 w-3.5" />
          {add}
        </button>
      )}
    </div>
  );
}

function Row({
  index,
  testid,
  remove,
  readOnly,
  onRemove,
  children,
}: {
  index: number;
  testid: string;
  remove: string;
  readOnly: boolean;
  onRemove: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className="grid gap-1.5 rounded-md border border-line bg-ivory p-1.5"
      data-testid={`${testid}-${index}`}
    >
      {children}
      {readOnly ? null : (
        <button
          aria-label={remove}
          className="justify-self-end rounded-md border border-line px-1.5 py-1 text-mute hover:border-danger hover:text-danger"
          data-testid={`${testid}-remove-${index}`}
          type="button"
          onClick={onRemove}
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
