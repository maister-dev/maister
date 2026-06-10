import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { pingSubscription } from "@/lib/webhooks/ping";

// =============================================================================
// T10 — test-ping service (TDD red).
//
// DQ8 ping: build a synthetic `ping` envelope (synthetic event id, real
// subscription, fresh deliveryId), sign with the same HMAC scheme, POST
// SYNCHRONOUSLY (10s timeout) and return { ok, httpStatus, durationMs,
// errorKind? }. NO PERSISTENCE — ping writes nothing to the DB (documented 2PC
// exemption). The signature must verify with a real consumer's node:crypto.
//
// A DB harness is present ONLY to assert the no-persistence invariant (counts
// across webhook_events/deliveries/attempts stay 0).
//
// RED now: ping.ts does not exist.
// =============================================================================

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

const SECRET = "whsec_ping_0123456789abcdef";

// ---------------------------------------------------------------------------
// In-process HTTP stub.
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
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

// Independent signature verification — what a real consumer does over the raw
// captured body. base = `${t}.${deliveryId}.${rawBody}`. The deliveryId is the
// ping's fresh id, taken from the captured X-Maister-Delivery-Id header.
function verifySignature(
  signatureHeader: string,
  deliveryId: string,
  rawBody: string,
  secret: string,
): boolean {
  const parts = signatureHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));

  if (!tPart) return false;

  const t = Number(tPart.slice("t=".length));

  if (!Number.isFinite(t)) return false;

  const base = `${t}.${deliveryId}.${rawBody}`;
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

async function countRows(): Promise<{
  events: number;
  deliveries: number;
  attempts: number;
}> {
  const r = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM webhook_events) AS events,
      (SELECT count(*)::int FROM webhook_deliveries) AS deliveries,
      (SELECT count(*)::int FROM webhook_delivery_attempts) AS attempts
  `);

  return r.rows[0] as unknown as {
    events: number;
    deliveries: number;
    attempts: number;
  };
}

// A subscription row shape exactly as the service consumes it (no DB read —
// ping takes the resolved subscription directly).
function subscription(url: string) {
  return {
    id: "sub-ping-1",
    url,
    method: "POST" as const,
    headers: {} as Record<string, string>,
    signingSecretRef: "env:WH_PING_SECRET",
    secondarySigningSecretRef: null,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

let stub: HttpStub;
let savedSecret: string | undefined;
let savedTimeout: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE webhook_subscriptions, webhook_events, webhook_deliveries,
             webhook_delivery_attempts RESTART IDENTITY CASCADE
  `);

  savedSecret = process.env.WH_PING_SECRET;
  savedTimeout = process.env.MAISTER_WEBHOOK_TIMEOUT_MS;
  process.env.WH_PING_SECRET = SECRET;
  delete process.env.MAISTER_WEBHOOK_TIMEOUT_MS;

  stub = await startStub();
});

afterEach(async () => {
  if (savedSecret === undefined) delete process.env.WH_PING_SECRET;
  else process.env.WH_PING_SECRET = savedSecret;

  if (savedTimeout === undefined) delete process.env.MAISTER_WEBHOOK_TIMEOUT_MS;
  else process.env.MAISTER_WEBHOOK_TIMEOUT_MS = savedTimeout;

  await stub?.close();
});

// ===========================================================================
// 1. 200 -> ok:true, a signed `ping` envelope on the wire, NO persistence.
// ===========================================================================

describe("pingSubscription — success", () => {
  it("POSTs a signed ping envelope, returns ok, and persists nothing", async () => {
    stub.setStatus(200);

    const result = await pingSubscription({
      subscription: subscription(stub.url),
      db,
    });

    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.errorKind).toBeUndefined();

    // Exactly one POST.
    expect(stub.requests).toHaveLength(1);

    const sent = stub.requests[0];

    expect(sent.method).toBe("POST");

    // Body is a `ping` envelope.
    const body = JSON.parse(sent.rawBody) as Record<string, any>;

    expect(body.apiVersion).toBe(1);
    expect(body.type).toBe("ping");
    expect(body.data.message).toBe("MAIster webhook ping");
    expect(body.deliveryId).toBeDefined();
    expect(body.attempt).toBe(1);

    // Headers wired.
    expect(sent.headers["content-type"]).toContain("application/json");
    expect(sent.headers["user-agent"]).toBe("MAIster-Webhooks/1");
    expect(sent.headers["x-maister-event"]).toBe("ping");
    expect(sent.headers["x-maister-delivery-id"]).toBe(body.deliveryId);
    expect(sent.headers["x-maister-signature"]).toBeDefined();

    // Signature VERIFIES over the captured raw body — a real consumer accepts it.
    expect(
      verifySignature(
        sent.headers["x-maister-signature"],
        sent.headers["x-maister-delivery-id"],
        sent.rawBody,
        SECRET,
      ),
    ).toBe(true);

    // NO persistence — the 2PC-exempt invariant.
    const counts = await countRows();

    expect(counts.events).toBe(0);
    expect(counts.deliveries).toBe(0);
    expect(counts.attempts).toBe(0);
  });
});

// ===========================================================================
// 2. non-2xx -> ok:false with the http status surfaced, still no persistence.
// ===========================================================================

describe("pingSubscription — non-2xx", () => {
  it("returns ok:false with the http status on a 500", async () => {
    stub.setStatus(500);

    const result = await pingSubscription({
      subscription: subscription(stub.url),
      db,
    });

    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(500);

    expect(stub.requests).toHaveLength(1);

    const counts = await countRows();

    expect(counts.events).toBe(0);
    expect(counts.deliveries).toBe(0);
    expect(counts.attempts).toBe(0);
  });
});
