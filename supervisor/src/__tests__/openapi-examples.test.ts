// ADR-166 T2.5 — the OpenAPI/AsyncAPI examples are the shared contract
// fixtures: every documented example must parse with the local Zod schema, and
// a deliberately broken fixture proves the harness has teeth.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  AdoptWorkspaceRequestSchema,
  CommandEnvelopeSchema,
  CommandReceiptSchema,
  EnvRefsRequestSchema,
  EnvRefsResponseSchema,
  McpProbeRequestSchema,
  McpServerInputSchema,
  REASON_TOKENS,
  SessionCommandEventSchema,
  StartSessionRequestSchema,
} from "../types";
import { RuntimeEventSpanSchema } from "../runtime-events";

const DOCS = resolve(fileURLToPath(import.meta.url), "../../../../docs/api");
const openapi = parse(
  readFileSync(resolve(DOCS, "supervisor.openapi.yaml"), "utf8"),
);
const asyncapi = parse(
  readFileSync(resolve(DOCS, "async/supervisor-sse.asyncapi.yaml"), "utf8"),
);

function schemaExample(name: string): unknown {
  const schema = openapi.components?.schemas?.[name];

  if (!schema) throw new Error(`OpenAPI schema ${name} missing`);
  if (schema.example === undefined)
    throw new Error(`OpenAPI schema ${name} has no example`);

  return schema.example;
}

describe("supervisor OpenAPI 0.8.0 examples ↔ Zod", () => {
  // ADR-179: these four are only parity-checked because they carry an
  // `example` — a component without one is silently skipped by this harness.
  it("McpServerInput example parses", () => {
    expect(
      McpServerInputSchema.safeParse(schemaExample("McpServerInput")).success,
    ).toBe(true);
  });

  it("McpProbeRequest example parses", () => {
    expect(
      McpProbeRequestSchema.safeParse(schemaExample("McpProbeRequest")).success,
    ).toBe(true);
  });

  it("EnvRefsRequest example parses", () => {
    expect(
      EnvRefsRequestSchema.safeParse(schemaExample("EnvRefsRequest")).success,
    ).toBe(true);
  });

  it("EnvRefsResponse example parses", () => {
    expect(
      EnvRefsResponseSchema.safeParse(schemaExample("EnvRefsResponse")).success,
    ).toBe(true);
  });

  it("CommandEnvelope example parses", () => {
    expect(
      CommandEnvelopeSchema.safeParse(schemaExample("CommandEnvelope")).success,
    ).toBe(true);
  });

  it("AdoptWorkspaceRequest example parses", () => {
    expect(
      AdoptWorkspaceRequestSchema.safeParse(
        schemaExample("AdoptWorkspaceRequest"),
      ).success,
    ).toBe(true);
  });

  it("StartSessionRequest example (handle form) parses", () => {
    const result = StartSessionRequestSchema.safeParse(
      schemaExample("StartSessionRequest"),
    );

    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data.executionWorkspaceId).toMatch(/^ws_/);
  });

  it("CommandReceipt example parses", () => {
    expect(
      CommandReceiptSchema.safeParse(schemaExample("CommandReceipt")).success,
    ).toBe(true);
  });

  it("every route-level enveloped request example parses with the envelope schema", () => {
    const routes: Array<[string, string, string]> = [
      ["/workspaces/adopt", "post", "gitWorktree"],
      ["/workspaces/{id}", "delete", "release"],
      ["/sessions", "post", "enveloped"],
      ["/sessions/{id}/prompts", "post", "enveloped"],
      ["/sessions/{id}/checkpoint", "post", "enveloped"],
      ["/sessions/{id}/cancel", "post", "enveloped"],
      ["/sessions/{id}/input", "post", "envelopedSelect"],
      ["/sessions/{id}", "delete", "enveloped"],
    ];

    for (const [path, method, name] of routes) {
      const example =
        openapi.paths[path][method].requestBody.content["application/json"]
          .examples[name].value;

      expect(
        CommandEnvelopeSchema.safeParse(example).success,
        `${method} ${path}`,
      ).toBe(true);
    }
  });

  // ADR-167 D5 amendment: every documented span shape — complete, partial and
  // each unavailable reason — is a response the route may actually send.
  it("runtime event span examples parse", () => {
    const examples = openapi.paths["/runtime-events/span"].get.responses["200"]
      .content["application/json"].examples as Record<
      string,
      { value: unknown }
    >;

    expect(Object.keys(examples).sort()).toEqual([
      "beyondEmitted",
      "complete",
      "partial",
      "replayFloorLost",
      "streamIdentityChanged",
    ]);
    for (const { value } of Object.values(examples))
      expect(RuntimeEventSpanSchema.safeParse(value).success).toBe(true);
  });

  // The schema carries the route's invariants, so a malformed example (or a
  // host answer the manager must refuse) cannot parse.
  it("runtime event span schema refuses a state its fields contradict", () => {
    const examples = openapi.paths["/runtime-events/span"].get.responses["200"]
      .content["application/json"].examples as Record<
      string,
      { value: Record<string, unknown> }
    >;
    const complete = examples.complete.value;
    const partial = examples.partial.value;
    const unavailable = examples.replayFloorLost.value;
    const envelope = (complete.events as unknown[])[0];

    for (const broken of [
      { ...unavailable, reason: undefined },
      { ...complete, reason: "beyond_emitted" },
      { ...partial, reason: "beyond_emitted" },
      { ...partial, nextAfter: null },
      { ...complete, nextAfter: "41" },
      { ...unavailable, nextAfter: "41" },
      { ...unavailable, events: [envelope] },
      { ...partial, events: Array.from({ length: 501 }, () => envelope) },
    ])
      expect(RuntimeEventSpanSchema.safeParse(broken).success).toBe(false);
  });

  it("runtime event span refusal examples carry a published reason", () => {
    const responses = openapi.paths["/runtime-events/span"].get.responses;
    const documented = new Set<string>(
      openapi.components.schemas.ReasonToken.enum as string[],
    );
    const refusals = [
      ["409", "PRECONDITION"],
      ["503", "EXECUTOR_UNAVAILABLE"],
    ] as const;

    for (const [status, code] of refusals) {
      const examples = Object.values(
        responses[status].content["application/json"].examples as Record<
          string,
          {
            value: {
              code: string;
              message: string;
              details: { reason: string };
            };
          }
        >,
      );

      expect(examples.length, status).toBeGreaterThan(0);
      for (const { value } of examples) {
        expect(value.code, status).toBe(code);
        expect(typeof value.message, status).toBe("string");
        expect(documented.has(value.details.reason), status).toBe(true);
      }
    }
  });

  it("session.command AsyncAPI examples parse", () => {
    const examples = asyncapi.components.messages.SessionCommand
      .examples as Array<{ payload: unknown }>;

    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const { payload } of examples) {
      expect(SessionCommandEventSchema.safeParse(payload).success).toBe(true);
    }
  });

  // S4.3: the enum IS the published discriminator — callers are told to branch
  // on `details.reason` and never on message text. Two earlier increments added
  // tokens to the code without the document and nothing noticed, so the mirror
  // is asserted whole rather than for the newest tokens alone.
  it("publishes every refusal reason the host can emit", () => {
    const documented = new Set<string>(
      openapi.components.schemas.ReasonToken.enum as string[],
    );

    expect(REASON_TOKENS.filter((token) => !documented.has(token))).toEqual([]);
  });

  it("a deliberately broken fixture fails (harness proof)", () => {
    const broken = {
      ...(schemaExample("CommandEnvelope") as Record<string, unknown>),
      fence: { hostKey: "x" },
    };

    expect(CommandEnvelopeSchema.safeParse(broken).success).toBe(false);
  });
});
