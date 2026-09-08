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
  requireProjectAction: vi.fn(async () => ({ role: "member" })),
}));

vi.mock("@/lib/execution-host/runtime-objects", () => ({
  getRuntimeObjectForRun: vi.fn(),
  openRuntimeObjectContent: vi.fn(),
}));

function loadedObject() {
  return {
    projectId: "project-1",
    localPackageId: null,
    createdByUserId: "user-1",
    object: {
      id: OBJECT_ID,
      logicalName: "scratch-upload-0123456789abcdef-evil.html",
      mimeType: "text/html",
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

  return GET(req, {
    params: Promise.resolve({ runId: RUN_ID, objectId: OBJECT_ID }),
  });
}

beforeEach(() => {
  vi.mocked(requireActiveSession).mockReset();
  vi.mocked(requireActiveSession).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(requireProjectAction).mockReset();
  vi.mocked(requireProjectAction).mockResolvedValue({
    role: "member",
  } as never);
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
    // AT-12 (D5): supplied MIME is never inline; the bytes are an opaque
    // attachment under nosniff + a sandboxing CSP, and never cached.
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="scratch-upload-0123456789abcdef-evil.html"; filename*=UTF-8''scratch-upload-0123456789abcdef-evil.html`,
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("owned");
    expect(requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "readRepoFiles",
    );
    expect(openRuntimeObjectContent).toHaveBeenCalledWith({
      db: {},
      runId: RUN_ID,
      objectId: OBJECT_ID,
      range: { start: 1, end: 5 },
    });
  });

  it("encodes a non-ASCII logical name without reflecting header-unsafe bytes", async () => {
    const unsafeObject = {
      ...loadedObject().object,
      logicalName: 'отчёт "final"\r\n.svg',
      mimeType: "image/svg+xml",
    };

    vi.mocked(getRuntimeObjectForRun).mockResolvedValueOnce({
      ...loadedObject(),
      object: unsafeObject,
    } as never);
    vi.mocked(openRuntimeObjectContent).mockResolvedValueOnce({
      object: unsafeObject,
      content: {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<svg/>"));
            controller.close();
          },
        }),
        contentLength: 6,
        contentRange: null,
        contentDigest: "sha-256=:abc=:",
      },
    } as never);

    const response = await invoke();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="final.svg"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20final.svg`,
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
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

  it("does not let a metadata-only viewer reconstruct private session content", async () => {
    vi.mocked(requireProjectAction).mockImplementationOnce(
      async (_projectId, action) => {
        if (action === "readRepoFiles")
          throw new MaisterError(
            "UNAUTHORIZED",
            "repository content permission is required",
          );

        return { role: "viewer" } as never;
      },
    );
    const response = await invoke();

    expect(response.status).toBe(403);
    expect(openRuntimeObjectContent).not.toHaveBeenCalled();
  });

  it("does not disclose an object selected outside the manager catalogued run", async () => {
    vi.mocked(getRuntimeObjectForRun).mockResolvedValueOnce(null);

    const response = await invoke();

    expect(response.status).toBe(404);
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(openRuntimeObjectContent).not.toHaveBeenCalled();
  });

  it("allows the owner of a projectless local-package assistant runtime object", async () => {
    vi.mocked(getRuntimeObjectForRun).mockResolvedValueOnce({
      ...loadedObject(),
      projectId: null,
      localPackageId: "package-1",
    } as never);

    const response = await invoke();

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("owned");
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(openRuntimeObjectContent).toHaveBeenCalledOnce();
  });

  it("hides a projectless local-package assistant object from another user", async () => {
    vi.mocked(requireActiveSession).mockResolvedValueOnce({
      id: "user-2",
    } as never);
    vi.mocked(getRuntimeObjectForRun).mockResolvedValueOnce({
      ...loadedObject(),
      projectId: null,
      localPackageId: "package-1",
    } as never);

    const response = await invoke();

    expect(response.status).toBe(404);
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
