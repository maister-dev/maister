import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ExecutionPolicyBadge,
  type ExecutionPolicyBadgeProps,
} from "@/components/runs/execution-policy-badge";

const labels = {
  supervised: "Supervised",
  assisted: "Assisted",
  unattended: "Unattended",
  custom: "custom",
};

function render(policy: ExecutionPolicyBadgeProps["policy"]): string {
  return renderToStaticMarkup(
    createElement(ExecutionPolicyBadge, { policy, labels }),
  );
}

describe("ExecutionPolicyBadge", () => {
  it("renders nothing for the supervised baseline or a null policy", () => {
    expect(render({ preset: "supervised" })).toBe("");
    expect(render(null)).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("renders an amber unattended chip", () => {
    const html = render({ preset: "unattended" });

    expect(html).toContain("Unattended");
    expect(html).toContain('data-preset="unattended"');
    expect(html).toContain("text-amber");
  });

  it("renders an assisted chip", () => {
    const html = render({ preset: "assisted" });

    expect(html).toContain("Assisted");
    expect(html).toContain('data-preset="assisted"');
  });

  it("flags a supervised policy carrying overrides as custom", () => {
    const html = render({
      preset: "supervised",
      overrides: { checks: "advisory" },
    });

    expect(html).toContain("Supervised");
    expect(html).toContain("custom");
    expect(html).toContain('data-preset="supervised"');
  });
});
