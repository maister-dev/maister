"use client";

import type { ReactElement } from "react";

import { useEffect, useId, useState } from "react";

import { useTheme } from "@/lib/theme";

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
  const { resolvedTheme } = useTheme();
  const [state, setState] = useState<DiagramState>({ kind: "pending" });

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram(): Promise<void> {
      try {
        const mod = await import("mermaid");
        const mermaid = mermaidApi(mod);

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          // Built-in presets render legible ER tables on either background
          // (dark = dark attribute boxes + light text + visible lines).
          // Hand-mapped base themeVariables mis-rendered alternating rows: the
          // even-row background fell back to lighten(background), washing out
          // the bright text.
          theme: resolvedTheme === "dark" ? "dark" : "default",
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
    // resolvedTheme re-renders the diagram with the new palette on theme toggle.
  }, [reactId, source, resolvedTheme]);

  if (state.kind === "rendered") {
    return (
      <div
        dangerouslySetInnerHTML={{ __html: state.svg }}
        className="my-3 overflow-auto rounded-[8px] border border-line bg-paper p-3"
        data-testid="mermaid-diagram"
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
