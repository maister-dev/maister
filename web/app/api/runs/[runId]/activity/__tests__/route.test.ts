import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked db chain: select returns the seeded `runRow`; update.set.where
// returns a row with id (so bumpKeepalive returns ok:true).
const state: { runRow: Record<string, unknown> | null } = { runRow: null };

const selectChain = () => ({
  from: () => ({
    where: async () => (state.runRow ? [state.runRow] : []),
  }),
});

const updateChain = (_table: unknown) => ({
  set: () => ({
    where: () => ({
      returning: async () => (state.runRow ? [{ id: state.runRow.id }] : []),
    }),
  }),
});

const fakeDb = {
  select: () => selectChain(),
  update: updateChain,
};

vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

let POST: (
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) => Promise<Response>;

beforeEach(async () => {
  state.runRow = null;
  ({ POST } = await import("../route"));
});

afterEach(() => {
  vi.resetModules();
});

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

function reqCtx(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

async function makeReq(): Promise<Request> {
  return new Request("http://x/api/runs/activity", { method: "POST" });
}

describe("POST /api/runs/[runId]/activity — M8 T7", () => {
  it("rejects non-UUID runId with 400", async () => {
    const res = await POST(await makeReq(), reqCtx("not-a-uuid"));

    expect(res.status).toBe(400);
  });

  it("returns 404 when run is missing", async () => {
    state.runRow = null;
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(404);
  });

  it("returns 204 on Running", async () => {
    state.runRow = { id: VALID_UUID, status: "Running" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(204);
  });

  it("returns 204 on NeedsInput", async () => {
    state.runRow = { id: VALID_UUID, status: "NeedsInput" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(204);
  });

  it("returns 409 with nextAction:respond on NeedsInputIdle", async () => {
    state.runRow = { id: VALID_UUID, status: "NeedsInputIdle" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { nextAction?: string };

    expect(body.nextAction).toBe("respond");
  });

  it("returns 410 on Done", async () => {
    state.runRow = { id: VALID_UUID, status: "Done" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(410);
  });

  it("returns 410 on Failed", async () => {
    state.runRow = { id: VALID_UUID, status: "Failed" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(410);
  });

  it("returns 410 on Crashed", async () => {
    state.runRow = { id: VALID_UUID, status: "Crashed" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(410);
  });

  it("returns 410 on Abandoned", async () => {
    state.runRow = { id: VALID_UUID, status: "Abandoned" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(410);
  });

  it("returns 410 on Review", async () => {
    state.runRow = { id: VALID_UUID, status: "Review" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(410);
  });

  it("returns 409 on Pending (not yet live)", async () => {
    state.runRow = { id: VALID_UUID, status: "Pending" };
    const res = await POST(await makeReq(), reqCtx(VALID_UUID));

    expect(res.status).toBe(409);
  });
});
