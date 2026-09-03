// ADR-165 T3.1 — wire shape (T1–T3): the envelope builder matches the OpenAPI
// contract fixture, the error mapper passes reason tokens through and folds
// FENCED into CONFLICT, and the transport layer carries no DB edge.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { buildEnvelope } from "@/lib/execution-host/ledger";
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
          fenceEpoch: 2,
        },
      },
      "ACP_PROTOCOL",
    );

    expect(err.code).toBe("CONFLICT");
    expect(err.details).toMatchObject({
      reason: "assignment_fenced",
      fenceEpoch: 2,
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
  const FORBIDDEN = [/@\/lib\/db\b/, /drizzle-orm/, /from "\.\.?\/db"/];

  for (const file of [
    "lib/execution-host/transports/local-direct.ts",
    "lib/supervisor-client.ts",
  ]) {
    it(`${file} imports nothing from the database layer`, () => {
      const source = readFileSync(resolve(WEB_DIR, file), "utf8");
      const imports = source
        .split("\n")
        .filter((line) => /^\s*(import|export) .* from "/.test(line));

      for (const line of imports) {
        for (const pattern of FORBIDDEN) {
          expect(line).not.toMatch(pattern);
        }
      }
    });
  }
});
