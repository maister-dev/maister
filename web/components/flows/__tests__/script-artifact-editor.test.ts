import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ScriptArtifactEditor,
  type ScriptArtifactEditorLabels,
} from "@/components/flows/artifact-editors/script-artifact-editor";

const labels: ScriptArtifactEditorLabels = {
  editorAriaLabel: "Script editor",
  trustBannerTitle: "Execution is gated by trust",
  trustBanner: "Scripts never run until explicit executable trust.",
};

function render(readOnly = false): string {
  return renderToStaticMarkup(
    createElement(ScriptArtifactEditor, {
      content: "#!/usr/bin/env bash\nset -e\necho hi\n",
      onChange: () => undefined,
      readOnly,
      labels,
    }),
  );
}

describe("ScriptArtifactEditor", () => {
  it("renders the exec/trust banner with its testid and copy", () => {
    const html = render();

    expect(html).toContain('data-testid="script-exec-trust-banner"');
    expect(html).toContain(
      "Scripts never run until explicit executable trust.",
    );
  });

  it("marks the banner as an informational note for assistive tech", () => {
    const html = render();

    expect(html).toContain('role="note"');
  });

  it("mounts the shared shell code editor", () => {
    const html = render();

    expect(html).toContain('data-testid="code-editor"');
  });

  it("renders the banner regardless of readOnly", () => {
    expect(render(true)).toContain('data-testid="script-exec-trust-banner"');
  });
});
