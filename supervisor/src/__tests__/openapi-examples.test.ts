// ADR-165 T2.5 — the OpenAPI/AsyncAPI examples are the shared contract
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
  SessionCommandEventSchema,
  StartSessionRequestSchema,
} from "../types";

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
      ["/sessions/{id}/prompt", "post", "enveloped"],
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

  it("session.command AsyncAPI examples parse", () => {
    const examples = asyncapi.components.messages.SessionCommand
      .examples as Array<{ payload: unknown }>;

    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const { payload } of examples) {
      expect(SessionCommandEventSchema.safeParse(payload).success).toBe(true);
    }
  });

  it("a deliberately broken fixture fails (harness proof)", () => {
    const broken = {
      ...(schemaExample("CommandEnvelope") as Record<string, unknown>),
      fence: { hostKey: "x" },
    };

    expect(CommandEnvelopeSchema.safeParse(broken).success).toBe(false);
  });
});
