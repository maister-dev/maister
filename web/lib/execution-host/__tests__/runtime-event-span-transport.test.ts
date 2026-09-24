// ADR-167 D5 amendment — the local-direct span read is an optimisation over
// the canonical feed: it never throws, and every refusal is logged with a
// bounded cause so an operator can tell a transient blip from a permanent
// incompatibility (an older host, schema drift).
import type { Logger } from "pino";
import type { Db } from "../db";
import type {
  ExecutionHostTransport,
  RuntimeEventSpanPage,
} from "../contracts";
import type { RuntimeEventEnvelope } from "../runtime-events";

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { MaisterError } from "@/lib/errors";

const wire = vi.hoisted(() => ({
  checkSupervisorHealth: vi.fn(),
  readRuntimeEventSpan: vi.fn(),
}));

vi.mock("@/lib/supervisor-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supervisor-client")>()),
  checkSupervisorHealth: wire.checkSupervisorHealth,
  readRuntimeEventSpan: wire.readRuntimeEventSpan,
}));

const { RuntimeEventSpanSchema } = await import("../runtime-events");
const { createLocalDirectTransport } = await import(
  "../transports/local-direct"
);
const { hostSpanPages, HostSpanUnavailable } = await import(
  "../prompt-host-span"
);
const { createFakeExecutionHost } = await import(
  "@/test-support/fake-execution-host"
);

const ENVELOPE = JSON.parse(
  readFileSync(
    new URL(
      "../../../../contracts/fixtures/runtime-events/envelope.valid.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown> & { streamId: string; hostKey: string };
const STREAM = ENVELOPE.streamId;

const at = (sequence: string) => ({ ...ENVELOPE, sequence });

function body(overrides: Record<string, unknown>) {
  return {
    streamId: STREAM,
    after: "10",
    through: "12",
    state: "complete",
    nextAfter: null,
    events: [at("11"), at("12")],
    ...overrides,
  };
}

function capture() {
  const warn = vi.fn();

  return { warn, logger: { warn } as unknown as Logger };
}

beforeEach(() => {
  wire.checkSupervisorHealth.mockReset().mockResolvedValue({
    kind: "ready",
    version: "test",
    health: {
      status: "ok",
      host: { hostKey: ENVELOPE.hostKey, bootId: ENVELOPE.hostBootId },
    },
  });
  wire.readRuntimeEventSpan.mockReset();
});

describe("RuntimeEventSpanSchema (web mirror)", () => {
  it.each([
    ["after", "abc"],
    ["after", "1.5"],
    ["through", "1e3"],
    ["nextAfter", "x1"],
  ])("refuses a non-decimal %s (%s) instead of throwing", (field, value) => {
    const result = RuntimeEventSpanSchema.safeParse(
      body({
        [field]: value,
        ...(field === "nextAfter" ? { state: "partial" } : {}),
      }),
    );

    expect(result.success).toBe(false);
  });

  it("accepts every page shape the host sends", () => {
    for (const page of [
      body({}),
      body({
        through: "20",
        state: "partial",
        nextAfter: "12",
      }),
      body({
        state: "unavailable",
        reason: "beyond_emitted",
        events: [],
      }),
    ])
      expect(RuntimeEventSpanSchema.safeParse(page).success).toBe(true);
  });

  it("refuses a page whose cursor cannot advance or lies about its rows", () => {
    for (const page of [
      // `nextAfter` must be the page's last row, strictly inside the range.
      body({ through: "20", state: "partial", nextAfter: "10" }),
      body({ through: "20", state: "partial", nextAfter: "11" }),
      body({ through: "20", state: "partial", nextAfter: "12", events: [] }),
      body({ through: "12", state: "partial", nextAfter: "12" }),
      // `complete` ends exactly at `through`.
      body({ through: "13" }),
      body({ events: [] }),
      // A reason only on an unavailable page, and one always there.
      body({ reason: "beyond_emitted" }),
      body({ state: "unavailable", events: [] }),
    ])
      expect(RuntimeEventSpanSchema.safeParse(page).success).toBe(false);
  });
});

describe("local-direct readRuntimeEventSpan", () => {
  const input = { streamId: STREAM, after: "10", through: "12" };

  it("returns a verified page", async () => {
    wire.readRuntimeEventSpan.mockResolvedValue(body({}));

    await expect(
      createLocalDirectTransport().readRuntimeEventSpan(input),
    ).resolves.toMatchObject({ state: "complete", nextAfter: null });
  });

  it.each([
    [
      "a non-decimal cursor (schema drift)",
      () => wire.readRuntimeEventSpan.mockResolvedValue(body({ after: "abc" })),
      { failure: "schema", issuePath: "after" },
    ],
    [
      "a stuck partial cursor",
      () =>
        wire.readRuntimeEventSpan.mockResolvedValue({
          ...body({ state: "partial", nextAfter: "10" }),
          through: "12",
        }),
      { failure: "schema" },
    ],
    [
      "a 404 from an older host",
      () =>
        wire.readRuntimeEventSpan.mockRejectedValue(
          new MaisterError("EXECUTOR_UNAVAILABLE", "not found", {
            details: { httpStatus: 404 },
          }),
        ),
      { failure: "wire", code: "EXECUTOR_UNAVAILABLE", httpStatus: 404 },
    ],
    [
      "a 409 refusal",
      () =>
        wire.readRuntimeEventSpan.mockRejectedValue(
          new MaisterError("PRECONDITION", "span", {
            details: { httpStatus: 409, reason: "invalid_event_span" },
          }),
        ),
      {
        failure: "wire",
        code: "PRECONDITION",
        httpStatus: 409,
        reason: "invalid_event_span",
      },
    ],
    [
      "a network or timeout failure",
      () =>
        wire.readRuntimeEventSpan.mockRejectedValue(
          new MaisterError("EXECUTOR_UNAVAILABLE", "readRuntimeEventSpan", {
            details: { reason: "timeout" },
          }),
        ),
      { failure: "wire", code: "EXECUTOR_UNAVAILABLE", reason: "timeout" },
    ],
    [
      "a host that is not ready",
      () =>
        wire.checkSupervisorHealth.mockResolvedValue({
          kind: "unavailable",
          reason: "unreachable",
        }),
      { failure: "health", health: "unavailable" },
    ],
    [
      "an envelope from another host",
      () =>
        wire.readRuntimeEventSpan.mockResolvedValue(
          body({
            events: [at("11"), { ...at("12"), hostKey: "other-host" }],
          }),
        ),
      { failure: "identity" },
    ],
    [
      "an unexpected throw",
      () => wire.readRuntimeEventSpan.mockRejectedValue(new TypeError("boom")),
      { failure: "unexpected", error: "TypeError" },
    ],
  ])(
    "never throws for %s and logs the cause",
    async (_name, arrange, logged) => {
      arrange();
      const { warn, logger } = capture();

      await expect(
        createLocalDirectTransport({ logger }).readRuntimeEventSpan(input),
      ).resolves.toEqual({ state: "unavailable", reason: "request_failed" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatchObject({
        streamId: STREAM,
        after: "10",
        through: "12",
        ...logged,
      });
      expect(warn.mock.calls[0][1]).toBe("runtime-event-span-read-failed");
    },
  );

  it("keeps a ZodError's first issue path bounded", async () => {
    wire.readRuntimeEventSpan.mockRejectedValue(
      new ZodError([
        {
          code: "custom",
          path: ["events", 3, "payload", "x".repeat(500)],
          message: "m",
        },
      ]),
    );
    const { warn, logger } = capture();

    await createLocalDirectTransport({ logger }).readRuntimeEventSpan(input);
    expect(
      (warn.mock.calls[0][0] as { issuePath: string }).issuePath.length,
    ).toBeLessThanOrEqual(120);
  });
});

// The pager trusts no transport to advance: a fake or future remote transport
// that skips the schema must still not loop until the caller's abort.
describe("hostSpanPages cursor", () => {
  async function drain(pages: RuntimeEventSpanPage[]): Promise<string[]> {
    const read = vi.fn(async () => pages.shift()!);
    const seen: string[] = [];

    for await (const page of hostSpanPages({
      db: {} as Db,
      transport: {
        readRuntimeEventSpan: read,
      } as unknown as ExecutionHostTransport,
      executionHostId: "host-row",
      hostKey: ENVELOPE.hostKey,
      streamId: STREAM,
      streamRowId: "stream-row",
      hostSessionId: "another-session",
      after: 10n,
      through: 14n,
      signal: AbortSignal.timeout(5_000),
    }))
      seen.push(...page.map((event) => String(event.hostSequence)));

    return seen;
  }
  const events = (...sequences: string[]) =>
    sequences.map(at) as unknown as RuntimeEventEnvelope[];

  it("chains partial pages to the terminal row", async () => {
    await expect(
      drain([
        { state: "partial", nextAfter: "12", events: events("11", "12") },
        { state: "complete", nextAfter: null, events: events("13", "14") },
      ]),
    ).resolves.toEqual(["11", "12", "13", "14"]);
  });

  it.each([
    ["a cursor that does not advance", "10", events("11")],
    ["a cursor behind the page's last row", "11", events("11", "12")],
    ["a cursor past the page's last row", "13", events("11", "12")],
    ["an empty partial page", "12", events()],
    ["a missing cursor", null, events("11")],
  ])("refuses %s as page_cursor", async (_name, nextAfter, rows) => {
    const failure = await drain([
      { state: "partial", nextAfter, events: rows },
      { state: "partial", nextAfter, events: rows },
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HostSpanUnavailable);
    expect((failure as InstanceType<typeof HostSpanUnavailable>).reason).toBe(
      "page_cursor",
    );
  });
});

// The fake answers what the route + local-direct answer, rule by rule; the
// rules the real child cannot reach cheaply in `host-parity` are pinned here.
describe("fake host span read", () => {
  async function seeded(count: number, payloadBytes = 0) {
    const fake = createFakeExecutionHost();

    for (let index = 0; index < count; index += 1)
      await fake.deliverCanonical(
        {
          ...at(String(index)),
          hostKey: fake.identity.hostKey,
          payload:
            payloadBytes > 0 ? { text: "x".repeat(payloadBytes) } : { index },
        } as unknown as RuntimeEventEnvelope,
        async () => {},
      );

    return fake;
  }
  const read = (
    fake: Awaited<ReturnType<typeof seeded>>,
    after: string,
    through: string,
  ) =>
    fake.transport.readRuntimeEventSpan({ streamId: STREAM, after, through });

  it("pages at 500 rows and at 1 MiB, like the route", async () => {
    const rows = await seeded(502);

    await expect(read(rows, "0", "501")).resolves.toMatchObject({
      state: "partial",
      nextAfter: "500",
    });
    const bytes = await seeded(8, 300 * 1024);
    const page = await read(bytes, "0", "7");

    expect(page).toMatchObject({ state: "partial", nextAfter: "3" });
  });

  it("refuses a malformed range, a host that is not ready and a foreign envelope as request_failed", async () => {
    const fake = await seeded(3);
    const failed = { state: "unavailable", reason: "request_failed" };

    await expect(read(fake, "abc", "2")).resolves.toEqual(failed);
    await expect(read(fake, "0", "1e3")).resolves.toEqual(failed);
    fake.setHealth({
      kind: "unavailable",
      reason: "unreachable",
      message: "down",
    });
    await expect(read(fake, "0", "2")).resolves.toEqual(failed);
    fake.setHealth({
      kind: "ready",
      identity: { ...fake.identity, hostKey: "another-host" },
      version: "fake",
      sessions: { live: 0, exited: 0, crashed: 0 },
    });
    await expect(read(fake, "0", "2")).resolves.toEqual(failed);
  });

  it("clears queued faults and removes a call hook", async () => {
    const fake = await seeded(3);
    const seen = vi.fn();
    const remove = fake.onCall("readRuntimeEventSpan", seen);

    fake.failOnce("readRuntimeEventSpan", new Error("queued"));
    fake.clearFaults();
    await expect(read(fake, "0", "2")).resolves.toMatchObject({
      state: "complete",
    });
    remove();
    await read(fake, "0", "2");
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
