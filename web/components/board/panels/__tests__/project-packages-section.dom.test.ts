// @vitest-environment jsdom

// ADR-132 §c (T15): selecting a fork's cut whose package name collides with
// an existing attachment must NOT fire a doomed POST — the section shows the
// rename explainer (fork shares its upstream's name) with a link to the
// fork's Studio editor and keeps Attach disabled until a non-colliding
// option is picked.

import type { ProjectDependencyView } from "@/lib/project-dependencies/view";

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) =>
    Object.assign((key: string): string => `${namespace}.${key}`, {
      has: (key: string) => !key.includes("unknown_"),
    }),
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
  sourceLocalPackageName: null,
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
    sourceLocalPackageName: "MAIster AIF — Codex High",
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
    sourceLocalPackageName: null,
  },
];

const failedPin = {
  id: "decl-1",
  kind: "package" as const,
  ref: "beauty-tools",
  generation: 2,
  source: "https://example.org/beauty",
  version: "v2",
  path: null,
  attempt: 3,
  state: "failed" as const,
  stage: "resolve",
  reason: "fetch_failed",
  effectiveRevision: null,
  effectiveAttachmentId: null,
  resolvedRevision: null,
  memberRef: null,
  readiness: "unresolved" as const,
  actions: { edit: true, retry: true, recoverSetup: false },
};

function render(
  attachmentView = attachment,
  declarations: ProjectDependencyView[] = [],
): HTMLElement {
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
        declarations,
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
  fetchMock.mockReset();
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("ProjectPackagesSection name-collision pre-flight", () => {
  it("acknowledges a committed attach while its worker still has a link to repair", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const host = render();
    await selectOption(host, "inst-3");
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          code: "PRECONDITION",
          message: "Repair pending",
          details: {
            mutationAccepted: true,
            reason: "project_flow_link_pending",
            operationId: "op",
            memberRef: "review",
            linkReason: "project_flow_link_conflict",
          },
        },
        { status: 409 },
      ),
    );
    await click(attachButton(host));
    expect(host.textContent).toContain("packages.flowLinkOccupied");
    expect(attachButton(host).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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

  it("keeps refused trust open, then closes on committed trust and links to the affected project's durable setup", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(
        Response.json(
          { code: "CONFLICT", details: { reason: "setup_pending" } },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            code: "FLOW_INSTALL",
            details: {
              reason: "setup_failed",
              trustAccepted: true,
              projectSlug: "second-project",
              declarationId: "decl-two",
            },
          },
          { status: 502 },
        ),
      );
    const host = render({ ...attachment, trustStatus: "untrusted" });

    await click(
      [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "packages.trust",
      )!,
    );
    const confirm = () =>
      document.body.querySelector(
        '[data-testid="package-trust-confirm-submit"]',
      );

    await click(confirm()!);
    expect(confirm()).not.toBeNull();
    expect(
      document.querySelector('[role="dialog"] [role="alert"]'),
    ).not.toBeNull();
    await click(confirm()!);
    expect(confirm()).toBeNull();
    const link = host.querySelector(
      'a[href="/projects/second-project?tab=packages#dependency-decl-two"]',
    );

    expect(link?.textContent).toBe("dependencies.inspectTrustedSetup");
    expect(host.textContent).toContain("dependencies.trustAccepted");
  });
});

it("submits retry for the exact failed declaration displayed by the server", async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockClear()
    .mockResolvedValueOnce(new Response("{}", { status: 202 }));
  const host = render(attachment, [failedPin]);
  const row = host.querySelector("#dependency-decl-1");

  expect(row?.textContent).toContain("beauty-tools");
  await click(row!.querySelector('[data-action="retry"]')!);
  const [url, options] = fetchMock.mock.calls[0]!;

  expect(url).toBe("/api/projects/demo/dependency-declarations/decl-1/retry");
  expect(JSON.parse(options.body)).toEqual({
    expectedGeneration: 2,
    expectedAttempt: 3,
  });
});

it.each([
  ["lost response", 3, null, "editConfirmed"],
  ["stale_generation", 3, null, "editConfirmed"],
  ["stale_generation", 4, null, "conflict"],
  ["lost response", 3, "different/path", "conflict"],
  ["lost response", 2, null, "requestFailed"],
] as const)(
  "reconciles %s with the saved pin at generation %s, path %s",
  async (failure, generation, path, notice) => {
    vi.stubGlobal("fetch", fetchMock);
    if (failure === "lost response")
      fetchMock.mockRejectedValueOnce(new Error("network"));
    else
      fetchMock.mockResolvedValueOnce(
        Response.json({ details: { reason: failure } }, { status: 409 }),
      );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        declarations: [
          {
            ...failedPin,
            generation,
            version: generation === 2 ? "v2" : "v3",
            path,
          },
        ],
      }),
    );
    const host = render(attachment, [failedPin]);

    await click(
      [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "dependencies.edit",
      )!,
    );
    const form = document.body.querySelector<HTMLFormElement>(
      '[role="dialog"] form',
    )!;

    form.querySelector<HTMLInputElement>('[name="version"]')!.value = "v3";
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(
      fetchMock.mock.calls.map(([url, options]) => [
        url,
        options.method ?? "GET",
      ]),
    ).toEqual([
      ["/api/projects/demo/dependency-declarations/decl-1", "PATCH"],
      ["/api/projects/demo/packages", "GET"],
    ]);
    expect(document.body.textContent).toContain(`dependencies.${notice}`);
    expect(document.body.querySelector('[role="dialog"]') !== null).toBe(
      notice === "requestFailed",
    );
  },
);

it("keeps a rejected edit open and associates the translated correction with its field", async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear().mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        code: "CONFIG",
        details: { field: "version" },
      }),
      { status: 422 },
    ),
  );
  const host = render(attachment, [failedPin]);

  await click(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "dependencies.edit",
    )!,
  );
  const form = document.body.querySelector<HTMLFormElement>(
    '[role="dialog"] form',
  )!;
  const field = form.querySelector<HTMLInputElement>('[name="version"]')!;

  field.value = "release candidate";
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  expect(field.value).toBe("release candidate");
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(
    document.getElementById(field.getAttribute("aria-describedby")!)
      ?.textContent,
  ).toBe("dependencies.validation.version");
});

it("submits the reviewed setup witness when server refreshes the row during confirmation", async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockClear()
    .mockResolvedValueOnce(new Response("{}", { status: 202 }));
  const uncertain: ProjectDependencyView = {
    ...failedPin,
    state: "recovery_required",
    reason: "setup_uncertain",
    stage: "setup",
    memberRef: "capability:beauty",
    resolvedRevision: "abc123",
    actions: { edit: true, retry: false, recoverSetup: true },
  };
  const host = render(attachment, [uncertain]);

  await click(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "dependencies.recover",
    )!,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  act(() =>
    roots.at(-1)!.render(
      createElement(ProjectPackagesSection, {
        slug: "demo",
        isAdmin: true,
        canTrust: true,
        attachments: [attachment],
        availableInstalls: installs,
        declarations: [
          {
            ...uncertain,
            generation: 3,
            attempt: 1,
            memberRef: "capability:other",
            resolvedRevision: "def456",
          },
        ],
      }),
    ),
  );
  const confirmation = [
    ...document.body.querySelectorAll('[role="dialog"] button'),
  ].find((b) => b.textContent === "dependencies.confirmRecovery");

  await click(confirmation!);
  const [url, options] = fetchMock.mock.calls[0]!;

  expect(url).toBe(
    "/api/projects/demo/dependency-declarations/decl-1/recover-setup",
  );
  expect(JSON.parse(options.body)).toEqual({
    expectedGeneration: 2,
    expectedAttempt: 3,
    memberRef: "capability:beauty",
    resolvedRevision: "abc123",
    action: "rerun_setup",
  });
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "dependencies.recoveryQueued",
  );
});

it("shows localized status on retry, omits raw unknown stage names, and tolerates non-JSON 409 bodies", async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockClear()
    .mockResolvedValueOnce(new Response("{}", { status: 202 }))
    .mockResolvedValueOnce(new Response("gateway conflict", { status: 409 }));
  const host = render(attachment, [
    { ...failedPin, stage: "unknown_internal_stage" },
  ]);
  const row = host.querySelector("#dependency-decl-1")!;

  expect(row.textContent).not.toContain("unknown_internal_stage");
  await click(row.querySelector('[data-action="retry"]')!);
  expect(row.querySelector('[role="status"]')?.textContent).toBe(
    "dependencies.retryQueued",
  );
  await click(row.querySelector('[data-action="retry"]')!);
  expect(row.querySelector('[role="alert"]')?.textContent).toBe(
    "dependencies.conflict",
  );
});
