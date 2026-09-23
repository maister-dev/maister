// The extracted HITL panel — markup and the one-implementation contract.
//
// `HitlCard` was monolithic: its own expansion state, its own header toggle, a
// lazy `inbox-context` fetch and a trailing response form, all in one component
// that only `/inbox` could render. The Desk needs the BODY of that card inside a
// table row, where the row is the header (`REQ-D16`, `REQ-D17`).
//
// So the body is extracted with its `expanded` state owned by the PARENT, and
// `/inbox` is rebuilt on it. Shipping the extraction without that rebuild would
// leave two copies of the same panel — the drift ADR-172 D1 exists to prevent.
//
// The interaction half (no fetch while collapsed, exactly one on expand) needs a
// DOM and lives in `hitl-panel.dom.test.ts`.

import type { HitlItem } from "@/lib/queries/hitl";

import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// One translator per namespace, cached in the hoisted factory. A fresh function
// per render becomes a changing `useCallback`/`useEffect` dep, which has looped
// this component's suite to a 4 GB OOM before.
const { translators } = vi.hoisted(() => ({
  translators: new Map<string, (key: string) => string>(),
}));

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const cached = translators.get(namespace);

    if (cached) return cached;

    const translate = (key: string): string => `${namespace}.${key}`;

    translators.set(namespace, translate);

    return translate;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { HitlPanel } from "@/components/inbox/hitl-panel";

const WEB_ROOT = path.resolve(__dirname, "../../..");

const BASE: HitlItem = {
  hitlRequestId: "h1",
  runId: "run-1",
  runKind: "flow",
  kind: "permission",
  answerState: "open",
  storedResponse: null,
  assignmentId: null,
  assignmentStatus: null,
  assignmentActionKind: null,
  assignmentRoleRefs: [],
  assignmentStaleEvidenceSummary: null,
  assigneeLabel: null,
  assigneeUserId: null,
  agent: "claude",
  branch: "maister/feature-x",
  flowRef: "bugfix",
  stage: { label: "review", type: "human" },
  taskRef: "ACME-12",
  taskTitle: "Refactor session store",
  prompt: "Allow npm install express-rate-limit?",
  options: [
    { optionId: "allow", label: "Allow" },
    { optionId: "deny", label: "Deny" },
  ],
  time: "2h",
  createdAt: "2026-07-02T10:00:00.000Z",
  schema: null,
  criticality: "critical",
};

function render(expanded: boolean, over: Partial<HitlItem> = {}): string {
  return renderToStaticMarkup(
    createElement(HitlPanel, {
      canAct: true,
      currentUserId: "u1",
      expanded,
      item: { ...BASE, ...over },
    }),
  );
}

describe("HitlPanel is a BODY, not a card", () => {
  it("renders no header, no toggle and no card frame of its own", () => {
    const html = render(false);

    // The parent owns the header: on `/inbox` it is the card's button, on the
    // Desk it is the table row. A panel that shipped its own would give the Desk
    // two nested disclosure controls for one thing.
    expect(html).not.toContain("<article");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain('data-testid="hitl-card"');
  });

  it("renders its actions while collapsed", () => {
    // The action row is NOT behind the disclosure — a reader must be able to
    // answer a permission request without expanding it first.
    const html = render(false);

    expect(html).toContain("inbox.viewRun");
    expect(html).toContain("/runs/run-1");
  });

  it("renders the context region only when the parent says expanded", () => {
    expect(render(false)).not.toContain('data-testid="hitl-panel-context"');
    expect(render(true)).toContain('data-testid="hitl-panel-context"');
  });

  it("server-renders the region without having fetched anything", () => {
    // Effects do not run in `renderToStaticMarkup`, so the region arrives empty
    // and fills in on the client. Stated rather than assumed, because the
    // loading and error branches are asserted in `hitl-panel.dom.test.ts` —
    // the layer that can actually see them.
    const html = render(true);

    expect(html).toContain('data-testid="hitl-panel-context"');
    expect(html).not.toContain("inbox.contextError");
  });
});

describe("T-D17 one implementation, not two", () => {
  it("rebuilds HitlCard on the extracted panel", () => {
    const card = readFileSync(
      path.join(WEB_ROOT, "components/inbox/hitl-card.tsx"),
      "utf8",
    );

    expect(card).toMatch(/<HitlPanel[\s/>]/u);
    expect(card).toContain("@/components/inbox/hitl-panel");
  });

  it("leaves no second copy of the panel body in the card", () => {
    const card = readFileSync(
      path.join(WEB_ROOT, "components/inbox/hitl-card.tsx"),
      "utf8",
    );

    // The three things that MOVED. Any of them still in the card means the
    // extraction copied rather than moved, and the two will drift.
    expect(card).not.toContain("inbox-context");
    expect(card).not.toContain("contextLoading");
    expect(card).not.toMatch(/<RunHitlResponse[\s/>]/u);
  });

  it("keeps the card owning the disclosure the panel does not", () => {
    const card = readFileSync(
      path.join(WEB_ROOT, "components/inbox/hitl-card.tsx"),
      "utf8",
    );

    expect(card).toContain("aria-expanded");
    expect(card).toContain("useState");
  });
});
