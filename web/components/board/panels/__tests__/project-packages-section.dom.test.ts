// @vitest-environment jsdom

// ADR-132 §c (T15): selecting a fork's cut whose package name collides with
// an existing attachment must NOT fire a doomed POST — the section shows the
// rename explainer (fork shares its upstream's name) with a link to the
// fork's Studio editor and keeps Attach disabled until a non-colliding
// option is picked.

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) =>
    (key: string): string =>
      `${namespace}.${key}`,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/projects/demo",
}));

import { ProjectPackagesSection } from "@/components/board/panels/project-packages-section";

const roots: Root[] = [];
const fetchMock = vi.fn();

const attachment = {
  id: "att-1",
  packageInstallId: "inst-1",
  packageName: "aif",
  versionLabel: "aif/v1.0.0",
  resolvedRevision: "a".repeat(40),
  trustStatus: "trusted_by_policy",
  affectedProjectCount: undefined as number | undefined,
  attachedAt: "2026-06-12T10:00:00.000Z",
  updateAvailable: false,
  upgradeTarget: null,
  downgradeTargets: [] as {
    installId: string;
    versionLabel: string;
    compatible: boolean;
    incompatibilityReason: string | null;
  }[],
  flows: ["aif-dev"],
};

const installs = [
  {
    id: "inst-cut",
    name: "aif",
    versionLabel: "local-abcdef123456",
    resolvedRevision: "d".repeat(40),
    trustStatus: "trusted_by_policy",
    flows: ["aif-dev"],
    compatible: true,
    incompatibilityReason: null,
    sourceLocalPackageId: "lp-9",
  },
  {
    id: "inst-3",
    name: "core",
    versionLabel: "core/v0.1.0",
    resolvedRevision: "c".repeat(40),
    trustStatus: "trusted_by_policy",
    flows: ["triager"],
    compatible: true,
    incompatibilityReason: null,
    sourceLocalPackageId: null,
  },
];

function render(attachmentView = attachment): HTMLElement {
  const host = document.createElement("div");

  document.body.appendChild(host);
  const root = createRoot(host);

  roots.push(root);
  act(() => {
    root.render(
      createElement(ProjectPackagesSection, {
        slug: "demo",
        isAdmin: true,
        canTrust: true,
        attachments: [attachmentView],
        availableInstalls: installs,
      }),
    );
  });

  return host;
}

async function selectOption(host: HTMLElement, value: string): Promise<void> {
  const select = host.querySelector(
    "#attach-package-select",
  ) as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;

  await act(async () => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function attachButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "packages.attachPackage",
  );

  if (!button) throw new Error("attach button not found");

  return button;
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("ProjectPackagesSection name-collision pre-flight", () => {
  it("selecting the colliding fork cut shows the rename explainer with the editor link and disables Attach", async () => {
    const host = render();

    await selectOption(host, "inst-cut");

    expect(host.textContent).toContain("packages.attachNameTakenExplainer");
    const link = host.querySelector('a[href="/studio/edit/lp-9"]');

    expect(link).not.toBeNull();
    expect(attachButton(host).disabled).toBe(true);
  });

  it("selecting a non-colliding install shows no explainer and keeps Attach enabled", async () => {
    const host = render();

    await selectOption(host, "inst-3");

    expect(host.textContent).not.toContain("packages.attachNameTakenExplainer");
    expect(attachButton(host).disabled).toBe(false);
  });

  it("closes the trust confirmation after success and releases it after a network failure", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const host = render({
      ...attachment,
      affectedProjectCount: 2,
      trustStatus: "untrusted",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await click(
      [...host.querySelectorAll("button")].find(
        (button) => button.textContent === "packages.trust",
      )!,
    );
    await click(
      document.body.querySelector(
        '[data-testid="package-trust-confirm-submit"]',
      )!,
    );

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/projects/demo/packages/att-1/trust",
    );
    expect(
      document.body.querySelector('[data-testid="package-trust-confirm"]'),
    ).toBeNull();

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await click(
      [...host.querySelectorAll("button")].find(
        (button) => button.textContent === "packages.trust",
      )!,
    );
    await click(
      document.body.querySelector(
        '[data-testid="package-trust-confirm-submit"]',
      )!,
    );

    expect(
      document.body.querySelector(
        '[data-testid="package-trust-confirm-submit"]',
      ),
    ).not.toHaveProperty("disabled", true);
  });
});
