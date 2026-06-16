import type { ReactElement, ReactNode } from "react";

type Props = {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
};

// Shared settings-section frame: title (eyebrow) + optional right-aligned
// actions, an underline rule beneath the header, then content. Replaces the
// per-panel `border-t … pt-6` separator that orphaned a rule above each title.
export function PanelSection({
  title,
  actions,
  children,
}: Props): ReactElement {
  return (
    <section className="mt-8 first:mt-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <h3 className="m-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {title}
        </h3>
        {actions ? (
          <div className="flex items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
