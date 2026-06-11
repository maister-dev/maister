// T15 — outbound-webhooks end-to-end through the REAL admin UI + the REAL
// delivery pipeline (fanout + signed drain + deliveries log + replay).
//
// What this proves, all against the running webServer (port 3100) and the
// dedicated e2e Postgres:
//   1. Admin creates a PLATFORM subscription via the Settings webhooks modal
//      (url → an in-process node:http stub, event_types=[run.review],
//      signing_secret_ref=env:WH_E2E_SECRET). The row appears in the table.
//   2. Ping (UI button) → the stub receives a `ping` POST whose
//      X-Maister-Signature VERIFIES against WH_E2E_SECRET (independent
//      node:crypto HMAC over the captured raw body), and the drawer surfaces
//      "Ping succeeded".
//   3. A forced outbox event (direct webhook_events insert against the seeded
//      `board` run/project so the fanout join resolves) is delivered by a real
//      drain (POST /api/cron/tick?jobKind=webhook_delivery, token-gated): the
//      stub receives the SIGNED delivery (signature verifies) and the Deliveries
//      drawer shows a `delivered` attempt.
//   4. Failure + replay: a second event against a stub returning 410 → the
//      delivery goes `dead` (a failed attempt, HTTP 410, visible in the drawer).
//      Clicking Replay re-queues it; with the stub back at 200 a second drain
//      flips it to `delivered`.
//
// Why the secret MUST be in the webServer env: the drain resolves
// `env:WH_E2E_SECRET` SERVER-SIDE at send time (lib/webhooks/signing.ts →
// resolveEnvRef(process.env)). playwright.config.ts wires WH_E2E_SECRET into
// webServer.env; this spec re-reads the same value via process.env to verify the
// HMAC. If it were unset, the drain would record a `config` failure and sign
// nothing — so it is wired first.
//
// Why 410 for the failure case (not 500): the deliveries drawer only exposes
// Replay for terminal deliveries (`delivered | dead`). A single 500 leaves the
// delivery `pending` (a scheduled retry, not replayable), so the failure phase
// uses 410 Gone → immediate `dead` → replayable, which is the exact UI path
// under test. The 500→retry classification is already pinned by the handler's
// integration test.
//
// Timing: after every drain trigger we poll the deliveries API (expect.poll),
// never a fixed sleep, before asserting the UI; the drawer fetches once on open,
// so we (re)open it only after the API confirms the terminal state.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { withE2EDb } from "./_seed/db";

// The deliveries drawer is a fixed right-edge panel with no role/test-id of its
// own; this class-fragment combo uniquely identifies it (no other element uses
// `fixed inset-y-0 right-0`). Scope Close/Replay/status assertions to it so the
// table's own Last-delivery status text (same labels) is never matched instead.
function drawer(page: Page) {
  return page.locator(".fixed.inset-y-0.right-0");
}

// The subscriptions table row for our seeded subscription.
function subRow(page: Page) {
  return page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "E2E T15 hook" }) });
}

// Must match playwright.config.ts webServer env. The stub verifies HMACs with
// this exact value; the drain resolves env:WH_E2E_SECRET to it server-side.
const WH_SECRET = process.env.WH_E2E_SECRET ?? "whsec_e2e_0123456789abcdef";
const CRON_TOKEN = process.env.MAISTER_CRON_TOKEN ?? "e2e-cron-token-change-me";
const CRON_HEADER = "X-Maister-Cron-Token";

type BoardFixture = { projectId: string; runId: string };

function loadBoard(): BoardFixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { board: BoardFixture } };

  return all.byKey.board;
}

// ---------------------------------------------------------------------------
// In-process HTTP stub — stand-in for a real webhook consumer. Captures every
// request (method/headers/raw body) and answers with a switchable status. Bound
// to 127.0.0.1 so the same-host webServer child process can reach it.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  headers: Record<string, string>;
  rawBody: string;
}

interface HttpStub {
  url: string;
  requests: CapturedRequest[];
  setStatus(status: number): void;
  pingRequests(): CapturedRequest[];
  deliveryRequests(): CapturedRequest[];
  close(): Promise<void>;
}

async function startStub(): Promise<HttpStub> {
  let status = 200;
  const requests: CapturedRequest[] = [];

  const server: Server = createServer((req, res) => {
    req.setEncoding("utf8");
    let rawBody = "";

    req.on("data", (c: string) => {
      rawBody += c;
    });
    req.on("end", () => {
      const headers: Record<string, string> = {};

      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
      }

      requests.push({ method: req.method ?? "", headers, rawBody });
      res.statusCode = status;
      res.end("ok");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    setStatus(next) {
      status = next;
    },
    pingRequests() {
      return requests.filter((r) => r.headers["x-maister-event"] === "ping");
    },
    deliveryRequests() {
      return requests.filter(
        (r) => r.headers["x-maister-event"] === "run.review",
      );
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Independent signature verification — exactly what a real consumer would do.
//   X-Maister-Signature: t=<unix>,v1=<hex>[,v1=<hex2>]
//   base = `${t}.${deliveryId}.${rawBody}`
// deliveryId is carried in the body (envelope.deliveryId) AND the
// X-Maister-Delivery-Id header; we read it from the header and confirm the body
// agrees, then verify the HMAC over the captured raw body.
// ---------------------------------------------------------------------------

function verifySignature(req: CapturedRequest, secret: string): boolean {
  const signatureHeader = req.headers["x-maister-signature"];
  const deliveryId = req.headers["x-maister-delivery-id"];

  if (!signatureHeader || !deliveryId) return false;

  const parts = signatureHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));

  if (!tPart) return false;

  const t = Number(tPart.slice("t=".length));

  if (!Number.isFinite(t)) return false;

  const base = `${t}.${deliveryId}.${req.rawBody}`;
  const expected = createHmac("sha256", secret).update(base).digest("hex");
  const expectedBytes = Uint8Array.from(Buffer.from(expected, "hex"));

  return parts
    .filter((p) => p.startsWith("v1="))
    .some((p) => {
      const got = Uint8Array.from(Buffer.from(p.slice("v1=".length), "hex"));

      return (
        got.length === expectedBytes.length &&
        timingSafeEqual(got, expectedBytes)
      );
    });
}

// ---------------------------------------------------------------------------
// Force one outbox event for the seeded `board` run/project. fanout_at IS NULL
// so the drain's fanout pass claims it, freezes the envelope, and inserts one
// pending delivery per matching subscription.
// ---------------------------------------------------------------------------

async function insertEvent(
  board: BoardFixture,
  type = "run.review",
): Promise<string> {
  const eventId = `e2e-wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await withE2EDb(async (pool) => {
    await pool.query(
      `INSERT INTO webhook_events (id, project_id, run_id, type, data, occurred_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
      [
        eventId,
        board.projectId,
        board.runId,
        type,
        JSON.stringify({ runId: board.runId, source: "e2e-t15" }),
      ],
    );
  });

  return eventId;
}

// Trigger ONE real drain cycle (fanout + drain) via the token-gated cron tick,
// scoped to the webhook_delivery scheduler job.
//
// The `webhook_delivery.default` job has a 60s cadence: a tick that claims it
// bumps next_run_at ~60s forward, so a second tick within the same minute would
// claim NOTHING and the drain would be a no-op. The replay phase needs a second
// drain seconds later, so force the job due first by resetting its next_run_at
// to now() against the e2e DB. (ensureDefaultSchedulerJobs upserts the row on
// the first tick; resetting an absent row is a harmless 0-row update, and the
// subsequent tick's ensure creates it due.)
async function drain(request: APIRequestContext): Promise<void> {
  await withE2EDb(async (pool) => {
    await pool.query(
      `UPDATE scheduler_jobs
         SET next_run_at = now() - interval '1 second',
             disabled_at = NULL,
             lease_expires_at = NULL
       WHERE id = 'webhook_delivery.default'`,
    );
  });

  const res = await request.post("/api/cron/tick?jobKind=webhook_delivery", {
    headers: { [CRON_HEADER]: CRON_TOKEN },
  });

  expect([200, 207]).toContain(res.status());
}

type DeliveryApiRow = {
  id: string;
  eventId: string;
  status: string;
  lastHttpStatus: number | null;
  attempts: { httpStatus: number | null }[];
};

async function listDeliveries(
  request: APIRequestContext,
  subId: string,
): Promise<DeliveryApiRow[]> {
  const res = await request.get(`/api/admin/webhooks/${subId}/deliveries`);

  expect(res.ok()).toBeTruthy();

  const body = (await res.json()) as { deliveries: DeliveryApiRow[] };

  return body.deliveries;
}

async function deliveryForEvent(
  request: APIRequestContext,
  subId: string,
  eventId: string,
): Promise<DeliveryApiRow | undefined> {
  return (await listDeliveries(request, subId)).find(
    (d) => d.eventId === eventId,
  );
}

// Drive a drain then poll the deliveries API until the event's delivery reaches
// `want` (delivered | dead). Polling the API — not the one-shot drawer fetch —
// is what keeps the timing robust.
async function drainUntil(
  request: APIRequestContext,
  subId: string,
  eventId: string,
  want: "delivered" | "dead",
): Promise<void> {
  await expect
    .poll(
      async () => {
        await drain(request);
        const delivery = await deliveryForEvent(request, subId, eventId);

        return delivery?.status;
      },
      { timeout: 30_000, intervals: [500, 1_000, 1_500, 2_000] },
    )
    .toBe(want);
}

// Run this file serially: the platform webhooks table is a GLOBAL surface, and
// the phases below share ONE subscription + stub across tests in order.
test.describe.configure({ mode: "serial" });

test.describe("outbound webhooks end-to-end", () => {
  let stub: HttpStub;
  let board: BoardFixture;
  let subId: string;

  test.beforeAll(async () => {
    stub = await startStub();
    board = loadBoard();
  });

  test.afterAll(async () => {
    await stub.close();
  });

  test("1. admin creates a platform subscription via the Settings modal", async ({
    page,
  }) => {
    await page.goto("/settings");

    // The platform webhooks panel renders for the admin (runtime present).
    await expect(
      page.getByRole("heading", { name: "Outbound webhooks" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add webhook" }).click();

    const modal = page.getByRole("dialog");

    await expect(modal).toBeVisible();

    // Label-derived accessible names for the secret inputs absorb the inline
    // hint spans and the substring "Name", so disambiguate: exact for the Name
    // field, the unique placeholder for the URL + the primary signing-secret
    // input (the secondary's placeholder is ...SECRET_NEXT).
    await modal.getByLabel("Name", { exact: true }).fill("E2E T15 hook");
    await modal.getByPlaceholder("https://example.com/hooks").fill(stub.url);
    // event_types checkbox (canonical taxonomy label).
    await modal
      .getByRole("checkbox", { name: "run.review", exact: true })
      .check();
    await modal
      .getByPlaceholder("env:WEBHOOK_SIGNING_SECRET", { exact: true })
      .fill("env:WH_E2E_SECRET");
    await modal.getByRole("button", { name: "Save" }).click();

    // The row appears in the subscriptions table.
    await expect(modal).toBeHidden();
    await expect(subRow(page)).toBeVisible();
    await expect(
      subRow(page).getByRole("cell", { name: "Platform" }),
    ).toBeVisible();
  });

  test("2. Ping delivers a signed `ping` POST the stub verifies", async ({
    page,
    request,
  }) => {
    stub.setStatus(200);

    // Resolve the created subscription id from the platform list API.
    const res = await request.get("/api/admin/webhooks");

    expect(res.ok()).toBeTruthy();

    const body = (await res.json()) as {
      subscriptions: { id: string; name: string }[];
    };
    const created = body.subscriptions.find((s) => s.name === "E2E T15 hook");

    expect(created).toBeDefined();
    subId = created!.id;

    await page.goto("/settings");

    const pingsBefore = stub.pingRequests().length;

    await subRow(page).getByRole("button", { name: "Ping" }).click();

    // The drawer surfaces the ping result inline ("Ping succeeded (200).").
    await expect(drawer(page).getByText(/Ping succeeded/)).toBeVisible();

    // The stub received exactly one new `ping` POST whose signature verifies.
    await expect
      .poll(() => stub.pingRequests().length)
      .toBeGreaterThan(pingsBefore);

    const ping = stub.pingRequests().at(-1)!;

    expect(ping.method).toBe("POST");
    expect(verifySignature(ping, WH_SECRET)).toBe(true);

    // The body is the `ping` envelope.
    const envelope = JSON.parse(ping.rawBody) as {
      type: string;
      deliveryId: string;
    };

    expect(envelope.type).toBe("ping");
    expect(envelope.deliveryId).toBe(ping.headers["x-maister-delivery-id"]);

    // Close the drawer so later table actions are not occluded.
    await drawer(page).getByRole("button", { name: "Close" }).click();
  });

  test("3. a forced event is delivered + signed, and the drawer shows it delivered", async ({
    page,
    request,
  }) => {
    expect(subId).toBeTruthy();
    stub.setStatus(200);

    const deliveriesBefore = stub.deliveryRequests().length;
    const eventId = await insertEvent(board, "run.review");

    // Real drain (fanout + signed send) until the delivery row is `delivered`.
    await drainUntil(request, subId, eventId, "delivered");

    // The stub received the signed run.review delivery; its signature verifies.
    await expect
      .poll(() => stub.deliveryRequests().length)
      .toBeGreaterThan(deliveriesBefore);

    const delivery = stub
      .deliveryRequests()
      .find((r) => (JSON.parse(r.rawBody) as { id: string }).id === eventId);

    expect(delivery).toBeDefined();
    expect(verifySignature(delivery!, WH_SECRET)).toBe(true);

    // Envelope carries the frozen run/project context + injected delivery fields.
    const envelope = JSON.parse(delivery!.rawBody) as {
      apiVersion: number;
      id: string;
      type: string;
      deliveryId: string;
      attempt: number;
      run: { id: string };
      project: { id: string };
    };

    expect(envelope.apiVersion).toBe(1);
    expect(envelope.type).toBe("run.review");
    expect(envelope.run.id).toBe(board.runId);
    expect(envelope.project.id).toBe(board.projectId);
    expect(envelope.attempt).toBe(1);

    // The Deliveries drawer (re-fetched on open, after the API confirmed the
    // terminal state) shows a `delivered` attempt for this subscription.
    await page.goto("/settings");
    await subRow(page).getByRole("button", { name: "Deliveries" }).click();

    // The newest delivery summary in the drawer reads "Delivered" (scoped to the
    // drawer so the table's own Last-delivery cell is not what we match).
    await expect(
      drawer(page).getByText("Delivered", { exact: true }).first(),
    ).toBeVisible();

    await drawer(page).getByRole("button", { name: "Close" }).click();
  });

  test("4. a 410 failure is replayable → replay + drain → delivered", async ({
    page,
    request,
  }) => {
    expect(subId).toBeTruthy();

    // --- Failure: stub returns 410 Gone → the delivery goes straight to `dead`
    // (a failed attempt, replayable in the drawer).
    stub.setStatus(410);

    const failEventId = await insertEvent(board, "run.review");

    await drainUntil(request, subId, failEventId, "dead");

    const deadRow = await deliveryForEvent(request, subId, failEventId);

    expect(deadRow?.status).toBe("dead");
    expect(deadRow?.lastHttpStatus).toBe(410);
    expect(deadRow?.attempts.some((a) => a.httpStatus === 410)).toBe(true);

    const failDeliveryId = deadRow!.id;

    // The drawer shows the failed (dead, HTTP 410) attempt + a Replay control.
    await page.goto("/settings");
    await subRow(page).getByRole("button", { name: "Deliveries" }).click();

    await expect(
      drawer(page).getByText("Dead", { exact: true }).first(),
    ).toBeVisible();
    await expect(drawer(page).getByText("410").first()).toBeVisible();

    // --- Replay: point the stub back to 200, click Replay, drain again →
    // the SAME delivery flips to `delivered`.
    stub.setStatus(200);

    const replayBefore = stub.deliveryRequests().length;

    await drawer(page).getByRole("button", { name: "Replay" }).first().click();

    // Replay re-queues to `pending`; a fresh drain delivers it. Poll the SAME
    // delivery row id until it is `delivered`.
    await expect
      .poll(
        async () => {
          await drain(request);
          const r = await listDeliveries(request, subId);

          return r.find((d) => d.id === failDeliveryId)?.status;
        },
        { timeout: 30_000, intervals: [500, 1_000, 1_500, 2_000] },
      )
      .toBe("delivered");

    // The stub received the replayed send (signature verifies).
    await expect
      .poll(() => stub.deliveryRequests().length)
      .toBeGreaterThan(replayBefore);

    const replayed = stub.deliveryRequests().at(-1)!;

    expect(verifySignature(replayed, WH_SECRET)).toBe(true);

    // Re-open the drawer (one-shot fetch) and confirm the delivery now reads
    // "Delivered".
    await page.goto("/settings");
    await subRow(page).getByRole("button", { name: "Deliveries" }).click();

    await expect(
      drawer(page).getByText("Delivered", { exact: true }).first(),
    ).toBeVisible();

    await drawer(page).getByRole("button", { name: "Close" }).click();
  });
});
