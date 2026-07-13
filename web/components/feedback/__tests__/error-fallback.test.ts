import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) =>
    (key: string, values?: Record<string, string>): string =>
      `${namespace}.${key}${values?.code ? `:${values.code}` : ""}`,
}));

import { ErrorFallback } from "@/components/feedback/error-fallback";

function render(error: unknown): string {
  return renderToStaticMarkup(
    createElement(ErrorFallback, { error, reset: () => {} }),
  );
}

describe("ErrorFallback", () => {
  it("renders localized recovery controls and a labelled recognized code", () => {
    const html = render({ code: "CONFLICT", message: "server secret" });

    expect(html).toContain("errorBoundary.title");
    expect(html).toContain("errorBoundary.diagnosticCode:CONFLICT");
    expect(html).toContain('href="/"');
    expect(html).toContain("errorBoundary.reset");
    expect(html).not.toContain("server secret");
  });

  it("uses generic localized copy without a diagnostic for unknown errors", () => {
    const html = render({ code: "UNKNOWN", message: "server secret" });

    expect(html).toContain("errorBoundary.generic");
    expect(html).not.toContain("diagnosticCode");
    expect(html).not.toContain("server secret");
  });
});
