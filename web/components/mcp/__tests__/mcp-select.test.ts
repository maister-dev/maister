import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  McpSelect,
  type McpSelectLabels,
  type McpSelectOption,
} from "@/components/mcp/mcp-select";

const labels: McpSelectLabels = {
  empty: "none selected",
  placeholder: "type a ref",
  add: "Add",
  sourceLabels: { platform: "Platform", project: "Project", custom: "Custom" },
  trustLabels: { untrusted: "untrusted" },
  readinessLabels: { not_ready: "not ready" },
};

const options: McpSelectOption[] = [
  { value: "github", label: "GitHub", source: "platform", trust: "untrusted" },
  {
    value: "fs",
    label: "Filesystem",
    source: "project",
    readiness: "not_ready",
  },
];

describe("McpSelect (W-G, T7.1)", () => {
  it("groups options by source and renders trust/readiness badges", () => {
    const markup = renderToStaticMarkup(
      createElement(McpSelect, {
        testid: "sel",
        values: [],
        options,
        labels,
        onChange: vi.fn(),
      }),
    );

    expect(markup).toContain("Platform");
    expect(markup).toContain("Project");
    expect(markup).toContain('data-testid="sel-option-github"');
    expect(markup).toContain('data-testid="sel-option-fs"');
    expect(markup).toContain("untrusted");
    expect(markup).toContain("not ready");
  });

  it("marks selected values pressed and surfaces a forward-ref not in the catalog", () => {
    const markup = renderToStaticMarkup(
      createElement(McpSelect, {
        testid: "sel",
        values: ["github", "future-ref"],
        options,
        labels,
        onChange: vi.fn(),
      }),
    );

    expect(markup).toContain('aria-pressed="true"');
    // A selected value with no catalog entry (node free-add forward-ref) still
    // renders, in the custom group.
    expect(markup).toContain('data-testid="sel-option-future-ref"');
    expect(markup).toContain("Custom");
  });

  it("shows the free-add input only when allowFreeAdd (node free-add semantics)", () => {
    const withAdd = renderToStaticMarkup(
      createElement(McpSelect, {
        testid: "sel",
        values: [],
        options,
        labels,
        allowFreeAdd: true,
        onChange: vi.fn(),
      }),
    );

    expect(withAdd).toContain('data-testid="sel-input"');

    const without = renderToStaticMarkup(
      createElement(McpSelect, {
        testid: "sel",
        values: [],
        options,
        labels,
        onChange: vi.fn(),
      }),
    );

    expect(without).not.toContain('data-testid="sel-input"');
  });

  it("readOnly renders only the selected set with disabled toggles and no input", () => {
    const markup = renderToStaticMarkup(
      createElement(McpSelect, {
        testid: "sel",
        values: ["github"],
        options,
        labels,
        readOnly: true,
        onChange: vi.fn(),
      }),
    );

    expect(markup).toContain('data-testid="sel-option-github"');
    // The unselected option is hidden in read-only mode.
    expect(markup).not.toContain('data-testid="sel-option-fs"');
    expect(markup).not.toContain('data-testid="sel-input"');
    expect(markup).toContain("disabled");
  });

  it("shows the empty label when there are no options and no selection", () => {
    const markup = renderToStaticMarkup(
      createElement(McpSelect, {
        testid: "sel",
        values: [],
        options: [],
        labels,
        onChange: vi.fn(),
      }),
    );

    expect(markup).toContain("none selected");
  });

  it("ranks a flow-package group before the free-add custom group", () => {
    const markup = renderToStaticMarkup(
      createElement(McpSelect, {
        testid: "sel",
        // a custom forward-ref + a flow-package option (the raw
        // capability_records source, not the hub's "package" token).
        values: ["future-ref"],
        options: [
          { value: "aif-plan", label: "AIF Plan", source: "flow-package" },
        ],
        labels: {
          ...labels,
          sourceLabels: { ...labels.sourceLabels, "flow-package": "Package" },
        },
        allowFreeAdd: true,
        onChange: vi.fn(),
      }),
    );
    const pkgIdx = markup.indexOf('data-testid="sel-option-aif-plan"');
    const customIdx = markup.indexOf('data-testid="sel-option-future-ref"');

    expect(pkgIdx).toBeGreaterThan(-1);
    expect(customIdx).toBeGreaterThan(-1);
    expect(pkgIdx).toBeLessThan(customIdx);
  });
});
