import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// (M36 Phase 3) The import route must reject oversized uploads on the DECLARED
// File.size/count BEFORE materializing any bytes (File.arrayBuffer). These pin
// that the caps fire ahead of collectImportEntries — the post-fix invariant.
const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  getLocalPackage: vi.fn(),
  collectImportEntries: vi.fn(),
  commitImport: vi.fn(),
  previewImport: vi.fn(),
  assertHoldsLock: vi.fn(),
  importMaxBytes: vi.fn(),
  importMaxEntries: vi.fn(),
  importMaxFileBytes: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({ requireGlobalRole: mocks.requireGlobalRole }));
vi.mock("@/lib/local-packages/service", () => ({
  getLocalPackage: mocks.getLocalPackage,
}));
vi.mock("@/lib/local-packages/import", () => ({
  collectImportEntries: mocks.collectImportEntries,
  commitImport: mocks.commitImport,
  previewImport: mocks.previewImport,
}));
vi.mock("@/lib/local-packages/lock", () => ({
  assertHoldsLock: mocks.assertHoldsLock,
}));
vi.mock("@/lib/instance-config", () => ({
  importMaxBytes: mocks.importMaxBytes,
  importMaxEntries: mocks.importMaxEntries,
  importMaxFileBytes: mocks.importMaxFileBytes,
}));

import { POST } from "../route";

function folderReq(files: { path: string; content: string }[]): NextRequest {
  const fd = new FormData();

  fd.set("mode", "preview");
  fd.set("kind", "folder");
  fd.set("paths", JSON.stringify(files.map((f) => f.path)));
  for (const f of files) {
    fd.append("files", new File([f.content], f.path.split("/").pop() ?? "f"));
  }

  return new NextRequest(
    new Request("http://x/api/studio/local-packages/lp1/import", {
      method: "POST",
      body: fd,
    }),
  );
}

function archiveReq(content: string): NextRequest {
  const fd = new FormData();

  fd.set("mode", "preview");
  fd.set("kind", "archive");
  fd.append("files", new File([content], "a.zip"));

  return new NextRequest(
    new Request("http://x/api/studio/local-packages/lp1/import", {
      method: "POST",
      body: fd,
    }),
  );
}

function ctx() {
  return { params: Promise.resolve({ id: "lp1" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireGlobalRole.mockResolvedValue({ id: "u1", role: "member" });
  mocks.getLocalPackage.mockResolvedValue({
    id: "lp1",
    status: "active",
    workingDir: "/tmp/x",
  });
  mocks.collectImportEntries.mockResolvedValue({
    entries: [{ path: "a.txt", bytes: new Uint8Array([1]) }],
  });
  mocks.previewImport.mockResolvedValue({ files: [], totalBytes: 0 });
  // Generous defaults; each test tightens one cap.
  mocks.importMaxBytes.mockReturnValue(50_000_000);
  mocks.importMaxEntries.mockReturnValue(2000);
  mocks.importMaxFileBytes.mockReturnValue(10_000_000);
});

describe("POST .../import — pre-materialize caps", () => {
  it("rejects a folder file over the per-file cap before materializing", async () => {
    mocks.importMaxFileBytes.mockReturnValue(4);

    const res = await POST(
      folderReq([{ path: "a/big.txt", content: "hello world" }]),
      ctx(),
    );

    expect(res.status).toBe(422);
    expect(mocks.collectImportEntries).not.toHaveBeenCalled();
  });

  it("rejects a folder whose total exceeds the cap before materializing", async () => {
    mocks.importMaxBytes.mockReturnValue(8);

    const res = await POST(
      folderReq([
        { path: "a.txt", content: "12345" },
        { path: "b.txt", content: "12345" },
      ]),
      ctx(),
    );

    expect(res.status).toBe(422);
    expect(mocks.collectImportEntries).not.toHaveBeenCalled();
  });

  it("rejects too many folder files before materializing", async () => {
    mocks.importMaxEntries.mockReturnValue(1);

    const res = await POST(
      folderReq([
        { path: "a.txt", content: "x" },
        { path: "b.txt", content: "y" },
      ]),
      ctx(),
    );

    expect(res.status).toBe(422);
    expect(mocks.collectImportEntries).not.toHaveBeenCalled();
  });

  it("rejects an oversized archive before materializing", async () => {
    mocks.importMaxBytes.mockReturnValue(4);

    const res = await POST(archiveReq("hello world"), ctx());

    expect(res.status).toBe(422);
    expect(mocks.collectImportEntries).not.toHaveBeenCalled();
  });

  it("accepts an upload within the caps (reaches collectImportEntries)", async () => {
    const res = await POST(
      folderReq([{ path: "a.txt", content: "ok" }]),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(mocks.collectImportEntries).toHaveBeenCalledTimes(1);
  });
});
