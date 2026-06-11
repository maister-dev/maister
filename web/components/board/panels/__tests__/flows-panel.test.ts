// T2.1 (spec §7.2 IA reachability): the project flows-tab cards are no longer
// decoy <div className="cursor-pointer"> blocks — each is a navigating
// <Link href="/projects/{projectSlug}/packages/{ref}"> to the read-only package
// viewer. A NEW required `projectSlug` prop is threaded in from the board page.
// A `canManageCatalog`-gated "New flow" entry links to /flows/new?project={slug}.
//
// FlowsPanel is an async Server Component calling getTranslations — rendered via
// `renderToStaticMarkup(await FlowsPanel(props))` with next-intl/server mocked to
// echo keys (the adapter-support-panel.test.ts convention; the panel itself is
// not refactored).

import type { ProjectFlow } from "@/lib/queries/project";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FlowsPanel } from "@/components/board/panels/flows-panel";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const flows: ProjectFlow[] = [
  {
    id: "flow-1",
    ref: "bugfix",
    source: "github.com/acme/maister-flow-bugfix",
    version: "v1.2.3",
    stepCount: 4,
  },
  {
    id: "flow-2",
    ref: "spec-clarify",
    source: "github.com/acme/maister-flow-spec",
    version: "v0.4.1",
    stepCount: 2,
  },
];

async function render(args: {
  projectSlug: string;
  canManageCatalog: boolean;
}): Promise<string> {
  const el = await FlowsPanel({
    flows,
    projectSlug: args.projectSlug,
    canManageCatalog: args.canManageCatalog,
  });

  return renderToStaticMarkup(el);
}

describe("FlowsPanel — cards link to the package viewer", () => {
  it("renders each flow card as a Link to /projects/{projectSlug}/packages/{ref}", async () => {
    const html = await render({ projectSlug: "acme", canManageCatalog: false });

    expect(html).toContain('href="/projects/acme/packages/bugfix"');
    expect(html).toContain('href="/projects/acme/packages/spec-clarify"');
    // the decoy div is gone — the card affordance is an anchor, not a bare div.
    expect(html).toContain("<a");
  });

  it("still renders the flow ref and step count in the card", async () => {
    const html = await render({ projectSlug: "acme", canManageCatalog: false });

    expect(html).toContain("bugfix");
    expect(html).toContain("spec-clarify");
    // Anchor to the step-count element, not a bare "4" that could match a class.
    expect(html).toContain(">4</b>");
  });
});

describe("FlowsPanel — manageCatalog-gated New flow entry", () => {
  it("renders a New flow link to /flows/new?project={slug} when canManageCatalog", async () => {
    const html = await render({ projectSlug: "acme", canManageCatalog: true });

    expect(html).toContain('href="/flows/new?project=acme"');
  });

  it("hides the New flow link when not canManageCatalog", async () => {
    const html = await render({ projectSlug: "acme", canManageCatalog: false });

    expect(html).not.toContain('href="/flows/new?project=acme"');
  });
});
