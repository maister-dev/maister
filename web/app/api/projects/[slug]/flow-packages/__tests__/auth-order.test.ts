import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import { LEGACY_STEPS_REFUSAL_MESSAGE } from "@/lib/flows/manifest-shape";

const mocks = vi.hoisted(() => ({
  authorizeManagePackages: vi.fn(),
  enableRevision: vi.fn(),
  errorResponse: vi.fn(),
  installFlowPlugin: vi.fn(),
  parseAuthorizedJson: vi.fn(),
  rollbackFlow: vi.fn(),
  setTrust: vi.fn(),
  upgradeFlow: vi.fn(),
}));

vi.mock("@/app/api/projects/[slug]/flow-packages/_lib", () => ({
  authorizeManagePackages: mocks.authorizeManagePackages,
  errorResponse: mocks.errorResponse,
  parseAuthorizedJson: mocks.parseAuthorizedJson,
}));
vi.mock("@/lib/flows", () => ({ installFlowPlugin: mocks.installFlowPlugin }));
vi.mock("@/lib/flows/lifecycle", () => ({
  enableRevision: mocks.enableRevision,
  rollbackFlow: mocks.rollbackFlow,
  setTrust: mocks.setTrust,
  upgradeFlow: mocks.upgradeFlow,
}));

type Handler = (
  req: NextRequest,
  context: { params: Promise<any> },
) => Promise<Response>;

function malformedRequest(url: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost${url}`, { body: "{", method: "POST" }),
  );
}

function params(): { params: Promise<{ slug: string; flowRefId: string }> } {
  return { params: Promise.resolve({ slug: "demo", flowRefId: "aif" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeManagePackages.mockRejectedValue(
    new MaisterError("UNAUTHENTICATED", "sign in"),
  );
  mocks.errorResponse.mockImplementation((err: MaisterError) =>
    Response.json(
      { code: err.code, message: err.message },
      { status: err.code === "UNAUTHENTICATED" ? 401 : 422 },
    ),
  );
  mocks.parseAuthorizedJson.mockImplementation(
    async ({
      req,
      schema,
    }: {
      req: NextRequest;
      schema: { parse(value: unknown): unknown };
    }) => schema.parse(await req.json()),
  );
});

describe("flow-package auth-first request boundary", () => {
  it.each([
    [
      "install",
      () => import("../install/route").then((module) => module.POST),
      "/api/projects/demo/flow-packages/install",
    ],
    [
      "enable",
      () => import("../[flowRefId]/enable/route").then((module) => module.POST),
      "/api/projects/demo/flow-packages/aif/enable",
    ],
    [
      "rollback",
      () =>
        import("../[flowRefId]/rollback/route").then((module) => module.POST),
      "/api/projects/demo/flow-packages/aif/rollback",
    ],
    [
      "upgrade",
      () =>
        import("../[flowRefId]/upgrade/route").then((module) => module.POST),
      "/api/projects/demo/flow-packages/aif/upgrade",
    ],
    [
      "trust",
      () => import("../[flowRefId]/trust/route").then((module) => module.POST),
      "/api/projects/demo/flow-packages/aif/trust",
    ],
  ])(
    "authenticates before parsing malformed %s bodies",
    async (_name, load, url) => {
      const handler = (await load()) as Handler;
      const res = await handler(malformedRequest(url), params());

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({
        code: "UNAUTHENTICATED",
      });
      expect(mocks.authorizeManagePackages).toHaveBeenCalledWith("demo");
    },
  );

  it("authenticates before checking an upgrade-preview query", async () => {
    const { GET } = await import("../[flowRefId]/upgrade-preview/route");
    const req = new NextRequest(
      new Request(
        "http://localhost/api/projects/demo/flow-packages/aif/upgrade-preview",
      ),
    );
    const res = await GET(req, params());

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("returns the locked CONFIG refusal for a legacy upgrade without an enable call", async () => {
    mocks.authorizeManagePackages.mockResolvedValue({
      db: {},
      project: { id: "project-1", slug: "demo" },
    });
    mocks.upgradeFlow.mockRejectedValue(
      new MaisterError("CONFIG", LEGACY_STEPS_REFUSAL_MESSAGE),
    );
    const { POST } = await import("../[flowRefId]/upgrade/route");
    const req = new NextRequest(
      new Request(
        "http://localhost/api/projects/demo/flow-packages/aif/upgrade",
        {
          body: JSON.stringify({ source: "file:///tmp/aif", version: "v1" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
    );
    const res = await POST(req, params());

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      code: "CONFIG",
      message: LEGACY_STEPS_REFUSAL_MESSAGE,
    });
    expect(mocks.enableRevision).not.toHaveBeenCalled();
  });
});
