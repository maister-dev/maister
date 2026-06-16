"use client";

import type { ReactElement } from "react";

import { useEffect, useId, useState } from "react";

type MermaidApi = typeof import("mermaid");

type DiagramState =
  | { kind: "pending" }
  | { kind: "rendered"; svg: string }
  | { kind: "error"; message: string };

function cleanDiagramId(rawId: string): string {
  return `maister-mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function mermaidApi(module: MermaidApi): MermaidApi["default"] {
  return module.default;
}

export function MermaidDiagram({ source }: { source: string }): ReactElement {
  const reactId = useId();
  const [state, setState] = useState<DiagramState>({ kind: "pending" });

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram(): Promise<void> {
      try {
        const module = await import("mermaid");
        const mermaid = mermaidApi(module);

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
        });

        const { svg } = await mermaid.render(cleanDiagramId(reactId), source);

        if (!cancelled) setState({ kind: "rendered", svg });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (!cancelled) setState({ kind: "error", message });
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [reactId, source]);

  if (state.kind === "rendered") {
    return (
      <div
        className="my-3 overflow-auto rounded-[8px] border border-line bg-paper p-3"
        data-testid="mermaid-diagram"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    );
  }

  return (
    <div
      className="my-3 rounded-[8px] border border-line bg-paper p-3"
      data-mermaid-error={state.kind === "error" ? state.message : undefined}
      data-testid="mermaid-diagram"
    >
      <pre className="overflow-auto font-mono text-[12px] leading-[1.5] text-ink-2">
        {source}
      </pre>
    </div>
  );
}
