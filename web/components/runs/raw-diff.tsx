import type { ReactElement } from "react";

// M22 Phase 5 (T5.3): the raw diff <pre> block extracted from the M18 review
// panel so the panel and the workbench diff share one renderer. Raw text only —
// no syntax highlighting (Phase 2).
export function RawDiff({ diff }: { diff: string }): ReactElement {
  return (
    <pre className="mb-4 max-h-[420px] overflow-auto rounded-lg border border-line-soft bg-paper p-4 font-mono text-[11px] leading-[1.45] text-ink-2">
      {diff}
    </pre>
  );
}
