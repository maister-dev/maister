import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import {
  PackageForkButton,
  forkErrorMessage,
  type ForkButtonLabels,
} from "@/components/flows/package-fork-button";

const labels: ForkButtonLabels = {
  fork: "Fork to edit",
  pending: "Forking…",
  errorConflict: "A flow with that name already exists.",
  errorConfig: "The package bundle is not available on disk.",
  errorUnauthorized: "You do not have permission to fork this package.",
  errorGeneric: "Could not fork the package. Try again.",
};

describe("forkErrorMessage", () => {
  it("maps CONFLICT to the slug-collision message", () => {
    expect(forkErrorMessage("CONFLICT", labels)).toBe(labels.errorConflict);
  });

  it("maps CONFIG to the missing-bundle message", () => {
    expect(forkErrorMessage("CONFIG", labels)).toBe(labels.errorConfig);
  });

  it("maps UNAUTHORIZED to the permission message", () => {
    expect(forkErrorMessage("UNAUTHORIZED", labels)).toBe(
      labels.errorUnauthorized,
    );
  });

  it("maps PRECONDITION (foreign/unknown revision) to the generic fallback", () => {
    expect(forkErrorMessage("PRECONDITION", labels)).toBe(labels.errorGeneric);
  });

  it("falls back to the generic message for an unknown code", () => {
    expect(forkErrorMessage("CRASH", labels)).toBe(labels.errorGeneric);
    expect(forkErrorMessage("totally-unknown", labels)).toBe(
      labels.errorGeneric,
    );
  });
});

describe("PackageForkButton", () => {
  it("renders the idle fork label with the fork-button testid", () => {
    const html = renderToStaticMarkup(
      createElement(PackageForkButton, {
        projectSlug: "demo",
        flowRefId: "bugfix",
        revisionId: "rev-1",
        labels,
      }),
    );

    expect(html).toContain('data-testid="package-fork-button"');
    expect(html).toContain("Fork to edit");
    expect(html).not.toContain("Forking…");
  });
});
