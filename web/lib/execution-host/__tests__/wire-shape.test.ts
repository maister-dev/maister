// ADR-166 T3.1 — wire shape (T1–T3): the envelope builder matches the OpenAPI
// contract fixture, the error mapper passes reason tokens through and folds
// FENCED into CONFLICT, and the transport layer carries no DB edge.

import type { ExecutionCommand } from "@/lib/db/schema";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { buildEnvelope } from "@/lib/execution-host/ledger";
import { isRefusedPermissionDelivery } from "@/lib/execution-host/permission-handoff-evidence";
import {
  hostPressuredError,
  isHostPressuredError,
  isHostPressureRefusal,
  refusalClosesAdmissionFence,
} from "@/lib/execution-host/host-pressure";
import {
  supervisorErrorToMaister,
  UNKNOWN_OUTCOME_TRANSPORT,
} from "@/lib/supervisor-client";

const WEB_DIR = resolve(__dirname, "../../..");
const OPENAPI = parse(
  readFileSync(resolve(WEB_DIR, "../docs/api/supervisor.openapi.yaml"), "utf8"),
) as {
  components: { schemas: Record<string, { example?: unknown }> };
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: {
          content: Record<
            string,
            { examples?: Record<string, { value: unknown }> }
          >;
        };
      }
    >
  >;
};

const PATH_FIELDS = [
  "worktreePath",
  "repoPath",
  "confineRoot",
  "runId",
  "projectSlug",
];

function schemaExample(name: string): Record<string, unknown> {
  const example = OPENAPI.components.schemas[name]?.example;

  if (!example) throw new Error(`OpenAPI schema ${name} has no example`);

  return example as Record<string, unknown>;
}

function routeExample(
  path: string,
  method: string,
  name: string,
): Record<string, unknown> {
  const example =
    OPENAPI.paths[path]?.[method]?.requestBody?.content["application/json"]
      ?.examples?.[name]?.value;

  if (!example) throw new Error(`no example ${name} on ${method} ${path}`);

  return example as Record<string, unknown>;
}

describe("T1 buildEnvelope ↔ OpenAPI CommandEnvelope", () => {
  const fixture = schemaExample("CommandEnvelope");
  const envelope = buildEnvelope({
    commandId: "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a",
    kind: "session.prompt",
    hostKey: "eh_3f9c2b1a4d5e6f708192a3b4c5d6e7f8",
    assignmentId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
    assignmentEpoch: 1,
    runId: "run-abc",
    payload: { stepId: "plan", prompt: "hi" },
    issuedAt: new Date("2026-09-02T10:00:00.000Z"),
  });

  it("has exactly the fixture's top-level, command, and fence keys", () => {
    expect(Object.keys(envelope).sort()).toEqual(Object.keys(fixture).sort());
    expect(Object.keys(envelope.command).sort()).toEqual(
      Object.keys(fixture.command as object).sort(),
    );
    expect(Object.keys(envelope.fence).sort()).toEqual(
      Object.keys(fixture.fence as object).sort(),
    );
    expect(envelope.command.issuedAt).toBe("2026-09-02T10:00:00.000Z");
  });

  it("a session.create payload (handle form) never carries a path field", () => {
    const create = routeExample("/sessions", "post", "enveloped");
    const payload = create.payload as Record<string, unknown>;

    expect(typeof payload.executionWorkspaceId).toBe("string");
    for (const field of PATH_FIELDS) {
      expect(payload).not.toHaveProperty(field);
    }
    // The fence — not the payload — is where the run identity lives.
    expect((create.fence as Record<string, unknown>).runId).toBeDefined();
  });
});

describe("T2 supervisorErrorToMaister", () => {
  it("maps FENCED to CONFLICT with reason assignment_fenced and keeps the wire details", () => {
    const err = supervisorErrorToMaister(
      409,
      {
        code: "FENCED",
        message: "stale epoch",
        details: {
          reason: "assignment_fenced",
          runId: "run-abc",
          commandEpoch: 1,
          hostEpoch: 2,
        },
      },
      "ACP_PROTOCOL",
    );

    expect(err.code).toBe("CONFLICT");
    expect(err.details).toMatchObject({
      reason: "assignment_fenced",
      hostEpoch: 2,
      commandEpoch: 1,
      httpStatus: 409,
    });
  });

  it("passes details.reason through for a known code", () => {
    const err = supervisorErrorToMaister(
      409,
      {
        code: "PRECONDITION",
        message: "unknown execution workspace",
        details: { reason: "unknown_workspace" },
      },
      "ACP_PROTOCOL",
    );

    expect(err.code).toBe("PRECONDITION");
    expect(err.details?.reason).toBe("unknown_workspace");
  });

  it("ADR-183: the host-pressure refusal predicate maps exactly PRECONDITION/event_outbox_backpressure", () => {
    const refusal = supervisorErrorToMaister(
      409,
      {
        code: "PRECONDITION",
        message: "runtime event outbox is under backpressure",
        details: { reason: "event_outbox_backpressure" },
      },
      "ACP_PROTOCOL",
    );

    expect(isHostPressureRefusal(refusal)).toBe(true);
    const mapped = hostPressuredError(refusal, "cmd-1");

    expect(mapped.code).toBe("EXECUTOR_UNAVAILABLE");
    expect(mapped.details).toEqual({
      reason: "host_pressured",
      hostReason: "event_outbox_backpressure",
      commandId: "cmd-1",
    });
    expect(isHostPressuredError(mapped)).toBe(true);
    // Every other reason, and the token under any other code, is not pressure.
    for (const [code, reason] of [
      ["PRECONDITION", "unknown_workspace"],
      ["EXECUTOR_UNAVAILABLE", "event_outbox_backpressure"],
      ["CONFLICT", "event_outbox_backpressure"],
    ] as const) {
      expect(
        isHostPressureRefusal(
          supervisorErrorToMaister(
            409,
            { code, message: "x", details: { reason } },
            "ACP_PROTOCOL",
          ),
        ),
      ).toBe(false);
    }
    expect(isHostPressureRefusal(new Error("event_outbox_backpressure"))).toBe(
      false,
    );
    expect(isHostPressuredError(refusal)).toBe(false);
  });

  // ADR-183 amendment 2026-09-28: the wire names which limit refused. Every
  // limit is a park, but only a host-wide one closes the admission fence — a
  // `wallet` refusal is one teardown's own funding. An older host names none.
  it("ADR-183 amendment: only a host-wide outbox limit closes the admission fence", () => {
    const limits = (
      OPENAPI.components.schemas.OutboxLimit as unknown as { enum: string[] }
    ).enum;

    expect(limits).toEqual([
      "unacknowledged",
      "retained",
      "physical",
      "control",
      "wallet",
    ]);
    for (const outboxLimit of limits) {
      const refusal = supervisorErrorToMaister(
        409,
        {
          code: "PRECONDITION",
          message: "x",
          details: { reason: "event_outbox_backpressure", outboxLimit },
        },
        "ACP_PROTOCOL",
      );

      expect(isHostPressureRefusal(refusal), outboxLimit).toBe(true);
      expect(refusalClosesAdmissionFence(refusal), outboxLimit).toBe(
        outboxLimit !== "wallet",
      );
    }
    const olderHost = supervisorErrorToMaister(
      409,
      {
        code: "PRECONDITION",
        message: "x",
        details: { reason: "event_outbox_backpressure" },
      },
      "ACP_PROTOCOL",
    );

    expect(refusalClosesAdmissionFence(olderHost)).toBe(true);
    expect(
      refusalClosesAdmissionFence(
        supervisorErrorToMaister(
          409,
          { code: "PRECONDITION", message: "x", details: { reason: "other" } },
          "ACP_PROTOCOL",
        ),
      ),
    ).toBe(false);
  });

  it("ADR-183 P0-4: a host outbox refusal of a permission input voids its delivery intent", () => {
    const input = (lastError: Record<string, unknown>) =>
      ({
        kind: "session.input",
        state: "failed",
        lastError,
      }) as unknown as ExecutionCommand;

    expect(
      isRefusedPermissionDelivery(
        input({
          code: "PRECONDITION",
          message: "hard",
          details: { reason: "event_outbox_backpressure", httpStatus: 409 },
        }),
      ),
    ).toBe(true);
    // The 503 refusal still counts; an unknown outcome or another 409 never.
    expect(
      isRefusedPermissionDelivery(
        input({ code: "EXECUTOR_UNAVAILABLE", details: { httpStatus: 503 } }),
      ),
    ).toBe(true);
    expect(
      isRefusedPermissionDelivery(
        input({
          code: "PRECONDITION",
          details: { reason: "unknown_workspace", httpStatus: 409 },
        }),
      ),
    ).toBe(false);
  });

  it("falls back for an unknown code and a bodyless response", () => {
    expect(
      supervisorErrorToMaister(500, { code: "WHATEVER" }, "CHECKPOINT").code,
    ).toBe("CHECKPOINT");
    expect(supervisorErrorToMaister(502, null, "ACP_PROTOCOL")).toMatchObject({
      code: "ACP_PROTOCOL",
      message: "supervisor 502",
    });
    // The definitive mapper never mints the unknown-outcome marker.
    expect(
      supervisorErrorToMaister(
        503,
        { code: "EXECUTOR_UNAVAILABLE" },
        "ACP_PROTOCOL",
      ).details?.transport,
    ).not.toBe(UNKNOWN_OUTCOME_TRANSPORT);
  });
});

describe("T3 transport layer has no DB edge", () => {
  const FORBIDDEN = [/@\/lib\/db\b/, /drizzle-orm/, /^\.\.?\/db$/];

  for (const file of [
    "lib/execution-host/transports/local-direct.ts",
    "lib/supervisor-client.ts",
  ]) {
    it(`${file} imports nothing from the database layer`, () => {
      const source = readFileSync(resolve(WEB_DIR, file), "utf8");
      // Every module specifier of an import/export-from statement, whether the
      // clause sits on one line or spans several (`} from "…"`).
      const specifiers = [
        ...source.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"/g),
      ].map((m) => m[1]);

      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        for (const pattern of FORBIDDEN) {
          expect(specifier).not.toMatch(pattern);
        }
      }
    });
  }
});
