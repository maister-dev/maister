import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import {
  getRuntimeObjectForRun,
  openRuntimeObjectContent,
} from "@/lib/execution-host/runtime-objects";

const RUN_ID = "run-runtime-object";
const OBJECT_ID = "d0b23d15-a3de-49e8-a73f-5e9e96c847cb";

vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));

vi.mock("@/lib/authz", () => ({
  httpStatusForAuthz: (code: string) =>
    code === "UNAUTHENTICATED" ? 401 : code === "UNAUTHORIZED" ? 403 : null,
  requireActiveSession: vi.fn(async () => ({ id: "user-1" })),
  requireProjectAction: vi.fn(async () => ({ role: "viewer" })),
}));

vi.mock("@/lib/execution-host/runtime-objects", () => ({
  getRuntimeObjectForRun: vi.fn(),
  openRuntimeObjectContent: vi.fn(),
}));

function loadedObject() {
  return {
    projectId: "project-1",
    object: {
      id: OBJECT_ID,
      mimeType: "text/plain",
      sha256: "abc",
    },
  };
}

async function invoke(headers?: HeadersInit): Promise<Response> {
  const { GET } = await import("../route");
  const req = new NextRequest(
    new Request(
      `http://localhost/api/runs/${RUN_ID}/runtime-objects/${OBJECT_ID}/content`,
      { method: "GET", headers },
    ),
  );
  return GET(req, { params: Promise.resolve({ runId: RUN_ID, objectId: OBJECT_ID }) });
}

beforeEach(() => {
  vi.mocked(requireActiveSession).mockReset();
  vi.mocked(requireActiveSession).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(requireProjectAction).mockReset();
  vi.mocked(requireProjectAction).mockResolvedValue({ role: "viewer" } as never);
  vi.mocked(getRuntimeObjectForRun).mockReset();
  vi.mocked(getRuntimeObjectForRun).mockResolvedValue(loadedObject() as never);
  vi.mocked(openRuntimeObjectContent).mockReset();
  vi.mocked(openRuntimeObjectContent).mockResolvedValue({
    object: loadedObject().object,
    content: {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("owned"));
          controller.close();
        },
      }),
      contentLength: 5,
      contentRange: "bytes 1-5/8",
      contentDigest: "sha-256=:abc=:",
    },
  } as never);
});

describe("GET /api/runs/[runId]/runtime-objects/[objectId]/content", () => {
  it("authorizes the catalogued run and forwards one bounded range through the manager contract", async () => {
    const response = await invoke({ range: "bytes=1-5" });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-5/8");
    expect(response.headers.get("content-digest")).toBe("sha-256=:abc=:");
    expect(response.headers.get("etag")).toBe('"abc"');
    expect(await response.text()).toBe("owned");
    expect(requireProjectAction).toHaveBeenCalledWith("project-1", "readBoard");
    expect(openRuntimeObjectContent).toHaveBeenCalledWith({
      db: {},
      runId: RUN_ID,
      objectId: OBJECT_ID,
      range: { start: 1, end: 5 },
    });
  });

  it("returns 416 for a malformed range before contacting the host", async () => {
    const response = await invoke({ range: "bytes=-5" });

    expect(response.status).toBe(416);
    expect(await response.json()).toEqual({
      code: "PRECONDITION",
      message: "runtime object Range must use a single byte range",
    });
    expect(openRuntimeObjectContent).not.toHaveBeenCalled();
  });

  it("does not disclose an object selected outside the manager catalogued run", async () => {
    vi.mocked(getRuntimeObjectForRun).mockResolvedValueOnce(null);

    const response = await invoke();

    expect(response.status).toBe(404);
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(openRuntimeObjectContent).not.toHaveBeenCalled();
  });

  it("returns gone when catalogued bytes disappeared from the host", async () => {
    vi.mocked(openRuntimeObjectContent).mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "runtime object is unavailable", {
        details: { reason: "runtime_object_missing" },
      }),
    );

    const response = await invoke();

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      code: "PRECONDITION",
      message: "Runtime object content is gone.",
    });
  });
});
