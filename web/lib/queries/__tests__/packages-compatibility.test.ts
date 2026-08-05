import { beforeEach, describe, expect, it, vi } from "vitest";

const loadFlowManifestMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/config", () => ({
  loadFlowManifest: loadFlowManifestMock,
}));

import {
  INVALID_PACKAGE_MANIFEST_REMEDIATION,
  createPackageCompatibilityResolver,
} from "@/lib/queries/packages";

const INSTALL = {
  id: "install-1",
  installedPath: "/private/maister/packages/install-1",
  manifest: {
    spec: { flows: [{ id: "aif", path: "flows/aif" }] },
  },
};

const GRAPH_MANIFEST = {
  schemaVersion: 1,
  name: "Aif",
  nodes: [
    {
      id: "done",
      type: "cli",
      action: { command: "true" },
      transitions: {},
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("package compatibility resolver", () => {
  it("memoizes concurrent checks for the same install", async () => {
    loadFlowManifestMock.mockResolvedValue(GRAPH_MANIFEST);
    const resolveCompatibility = createPackageCompatibilityResolver();

    const [first, second] = await Promise.all([
      resolveCompatibility(INSTALL),
      resolveCompatibility(INSTALL),
    ]);

    expect(first).toEqual({ compatible: true, incompatibilityReason: null });
    expect(second).toEqual(first);
    expect(loadFlowManifestMock).toHaveBeenCalledTimes(1);
  });

  it("keeps absolute manifest paths in structured logs, not client DTOs", async () => {
    loadFlowManifestMock.mockRejectedValueOnce(
      new Error(
        "Cannot read /private/maister/packages/install-1/flows/aif/flow.yaml",
      ),
    );
    const resolveCompatibility = createPackageCompatibilityResolver();

    const result = await resolveCompatibility(INSTALL);

    expect(result).toEqual({
      compatible: false,
      incompatibilityReason: INVALID_PACKAGE_MANIFEST_REMEDIATION,
    });
    expect(result.incompatibilityReason).not.toContain("/private/");
  });

  it("preserves an engine-incompatible range's canonical remediation", async () => {
    loadFlowManifestMock.mockResolvedValue({
      ...GRAPH_MANIFEST,
      compat: { engine_min: "4.0.0" },
    });
    const resolveCompatibility = createPackageCompatibilityResolver();

    await expect(resolveCompatibility(INSTALL)).resolves.toEqual({
      compatible: false,
      incompatibilityReason: "engine 3.4.0 < engine_min 4.0.0",
    });
  });
});
