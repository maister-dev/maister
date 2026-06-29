import type { NextRequest } from "next/server";
import type { MaisterError as RuntimeMaisterError } from "@/lib/errors";
import type {
  LaunchProgressEvent,
  LaunchStage,
} from "@/lib/runs/launch-progress";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { launchProgress } from "@/lib/runs/launch-progress";

// ADR-110 staged-stream addendum: the assistant POST streams its staged launch
// progress (mirroring the scratch route). Sync gates stay JSON errors; only the
// generator head's first `precondition` yield commits to `text/event-stream`.
const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  assertHoldsLock: vi.fn(),
  getLocalPackage: vi.fn(),
  launchLocalPackageAssistantStaged: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({ requireGlobalRole: mocks.requireGlobalRole }));
vi.mock("@/lib/local-packages/lock", () => ({
  assertHoldsLock: mocks.assertHoldsLock,
}));
vi.mock("@/lib/local-packages/service", () => ({
  getLocalPackage: mocks.getLocalPackage,
}));
vi.mock("@/lib/scratch-runs/service", () => ({
  launchLocalPackageAssistantStaged: mocks.launchLocalPackageAssistantStaged,
}));

let POST: (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

const packageId = "pkg-1";

function launchRequest(overrides: Record<string, unknown> = {}): NextRequest {
  return new Request(
    `http://x/api/studio/local-packages/${packageId}/assistant`,
    {
      method: "POST",
      body: JSON.stringify({
        sessionId: "sess-1",
        prompt: "add a flow",
        runnerId: "runner-1",
        intent: "auto",
        ...overrides,
      }),
    },
  ) as NextRequest;
}

function call(req: NextRequest): Promise<Response> {
  return POST(req, { params: Promise.resolve({ id: packageId }) });
}

function parseSseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data:"))
    .map(
      (block) =>
        JSON.parse(block.slice(block.indexOf("data:") + 5).trim()) as Record<
          string,
          unknown
        >,
    );
}

function terminalResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: "run-9",
    dialogUrl: "/scratch-runs/run-9",
    status: {
      runId: "run-9",
      projectId: "",
      name: "pkg assistant",
      runStatus: "NeedsInput",
      dialogStatus: "Running",
      branchName: "main",
      baseBranch: "main",
      baseCommit: "abc1234",
      targetBranch: "main",
      workMode: "edit",
      reasoningEffort: "medium",
      planMode: "off",
    },
    actionResult: { status: "applied" },
    ...overrides,
  };
}

function okGen(
  result = terminalResult(),
): AsyncGenerator<LaunchProgressEvent, unknown, void> {
  return (async function* () {
    yield launchProgress("precondition");
    yield launchProgress("materializing", "claude");
    yield launchProgress("spawning");
    yield launchProgress("session_ready", undefined, {
      runId: "run-9",
      dialogUrl: "/scratch-runs/run-9",
    });

    return result;
  })();
}

beforeEach(async () => {
  mocks.requireGlobalRole.mockReset().mockResolvedValue({ id: "user-1" });
  mocks.assertHoldsLock.mockReset().mockResolvedValue(undefined);
  mocks.getLocalPackage
    .mockReset()
    .mockResolvedValue({ id: packageId, status: "active" });
  mocks.launchLocalPackageAssistantStaged.mockReset().mockReturnValue(okGen());

  ({ POST } = await import("../route"));
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("POST /api/studio/local-packages/[id]/assistant (staged stream)", () => {
  it("streams ordered launch-progress frames then a narrow launch_result (AC4)", async () => {
    const res = await call(launchRequest());

    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = parseSseFrames(await res.text());
    const stages = frames
      .filter((f) => f.type === "scratch.launch_progress")
      .map((f) => f.stage as LaunchStage);

    expect(stages).toEqual([
      "precondition",
      "materializing",
      "spawning",
      "session_ready",
    ]);

    const ready = frames.find((f) => f.stage === "session_ready");

    expect(ready).toMatchObject({
      runId: "run-9",
      dialogUrl: "/scratch-runs/run-9",
    });

    const resultFrame = frames.find((f) => f.type === "scratch.launch_result");

    // The route maps the service's ScratchRunResponse → the narrow shape.
    expect(resultFrame?.result).toEqual({
      runId: "run-9",
      dialogStatus: "Running",
      actionResult: { status: "applied" },
    });
  });

  it("maps a null actionResult on the narrow result (FR5)", async () => {
    const result = terminalResult();

    delete (result as { actionResult?: unknown }).actionResult;
    mocks.launchLocalPackageAssistantStaged.mockReturnValue(okGen(result));

    const res = await call(launchRequest());
    const frames = parseSseFrames(await res.text());
    const resultFrame = frames.find((f) => f.type === "scratch.launch_result");

    expect(resultFrame?.result).toMatchObject({
      runId: "run-9",
      dialogStatus: "Running",
      actionResult: null,
    });
  });

  it("returns a JSON 404 (not a stream) when the package is missing (AC5)", async () => {
    mocks.getLocalPackage.mockResolvedValue(null);

    const res = await call(launchRequest());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(body.code).toBe("NOT_FOUND");
    expect(mocks.launchLocalPackageAssistantStaged).not.toHaveBeenCalled();
  });

  it("returns a JSON 409 (not a stream) on a lock conflict (AC5)", async () => {
    const { MaisterError } = (await import("@/lib/errors")) as {
      MaisterError: typeof RuntimeMaisterError;
    };

    mocks.assertHoldsLock.mockRejectedValue(
      new MaisterError("CONFLICT", "editor lock not held"),
    );

    const res = await call(launchRequest());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(body.code).toBe("CONFLICT");
    expect(mocks.launchLocalPackageAssistantStaged).not.toHaveBeenCalled();
  });

  it("keeps a generator-head failure as JSON with its HTTP status (AC5)", async () => {
    const { MaisterError } = (await import("@/lib/errors")) as {
      MaisterError: typeof RuntimeMaisterError;
    };

    mocks.launchLocalPackageAssistantStaged.mockReturnValue(
      (async function* (): AsyncGenerator<LaunchProgressEvent, unknown, void> {
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "supervisor unavailable",
        );
      })(),
    );

    const res = await call(launchRequest());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
  });

  it("emits an in-stream error frame on a post-open turn failure (AC6)", async () => {
    const { MaisterError } = (await import("@/lib/errors")) as {
      MaisterError: typeof RuntimeMaisterError;
    };

    mocks.launchLocalPackageAssistantStaged.mockReturnValue(
      (async function* () {
        yield launchProgress("precondition");
        yield launchProgress("materializing", "claude");
        throw new MaisterError("CRASH", "turn boom");
      })(),
    );

    const res = await call(launchRequest());

    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = parseSseFrames(await res.text());

    expect(frames.map((f) => f.stage)).toContain("precondition");
    expect(frames.find((f) => f.type === "error")).toMatchObject({
      type: "error",
      code: "CRASH",
    });
  });

  it("rejects an invalid body as JSON 422 (AC5)", async () => {
    const res = await call(launchRequest({ prompt: "" }));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(body.code).toBe("CONFIG");
    expect(mocks.launchLocalPackageAssistantStaged).not.toHaveBeenCalled();
  });
});
