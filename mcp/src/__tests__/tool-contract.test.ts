import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { TOOL_SPECS } from "@/tools";

// Contract guard: the MCP facade `TOOL_SPECS` are a HAND-MAINTAINED mirror of
// the ext route zod schemas, and `dispatchTool` silently drops unknown args —
// so a route-side schema change that is not swept into the facade produces a
// SILENT capability gap (patch 2026-07-02-11.12). This test anchors every tool
// on the canonical external OpenAPI (docs R3: "API specs are the source of
// truth for the surface"), which the routes are themselves contract-tested and
// redocly-linted against. A drift on EITHER side (a tool that omits/ghosts a
// field, a wrong enum/type, a stale spec) trips this test — closing the gap the
// prevention note left open.

const here = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = resolve(
  here,
  "../../../docs/api/external/operations.openapi.yaml",
);

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  $ref?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
};

// Bounds the facade must mirror when the spec declares them — a bounds-only
// drift (tool max 200 vs spec max 100) is as silent as a type drift.
const MIRRORED_BOUNDS = ["minimum", "maximum", "minLength"] as const;

type OpenApiDoc = {
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: Array<{
          $ref?: string;
          name?: string;
          in?: string;
          required?: boolean;
        }>;
        requestBody?: {
          content?: Record<string, { schema?: JsonSchema }>;
        };
      }
    >
  >;
  components?: { schemas?: Record<string, JsonSchema> };
};

const openapi = parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiDoc;

// Resolve a single-file local `$ref` ("#/components/schemas/Foo"). The ext spec
// uses only local refs; a foreign ref would surface here as an undefined walk.
function deref<T extends { $ref?: string }>(node: T): T {
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    const segments = node.$ref.replace(/^#\//, "").split("/");
    let cur: unknown = openapi;

    for (const seg of segments) {
      cur = (cur as Record<string, unknown>)[seg];
    }

    return deref(cur as T);
  }

  return node;
}

// Each MCP tool maps to exactly one ext operation. The (method, path) pair is
// the same routing `resolveRouting` encodes; restating it here as the contract
// anchor means a divergence in either place is caught.
const TOOL_OP: Record<string, { method: string; path: string }> = {
  task_create: { method: "post", path: "/api/v1/ext/projects/{slug}/tasks" },
  task_list: { method: "get", path: "/api/v1/ext/projects/{slug}/tasks" },
  task_get: {
    method: "get",
    path: "/api/v1/ext/projects/{slug}/tasks/{taskId}",
  },
  task_update: {
    method: "patch",
    path: "/api/v1/ext/projects/{slug}/tasks/{taskId}",
  },
  flow_list: { method: "get", path: "/api/v1/ext/projects/{slug}/flows" },
  runner_list: { method: "get", path: "/api/v1/ext/projects/{slug}/runners" },
  run_launch: { method: "post", path: "/api/v1/ext/runs" },
  run_get: { method: "get", path: "/api/v1/ext/runs/{runId}" },
  run_delegate: { method: "post", path: "/api/v1/ext/runs/delegate" },
  run_plan: { method: "post", path: "/api/v1/ext/runs/plan" },
  run_collect: { method: "post", path: "/api/v1/ext/runs/collect" },
  run_cancel: { method: "post", path: "/api/v1/ext/runs/cancel" },
  run_message: { method: "post", path: "/api/v1/ext/runs/message" },
  run_promote: { method: "post", path: "/api/v1/ext/runs/promote" },
  run_rework: { method: "post", path: "/api/v1/ext/runs/rework" },
  readiness_get: {
    method: "get",
    path: "/api/v1/ext/runs/{runId}/readiness",
  },
  gate_report: {
    method: "post",
    path: "/api/v1/ext/runs/{runId}/gates/{gateId}/report",
  },
  memory_recall: {
    method: "get",
    path: "/api/v1/ext/projects/{slug}/memory",
  },
  memory_retain: {
    method: "post",
    path: "/api/v1/ext/projects/{slug}/memory",
  },
  hitl_list: { method: "get", path: "/api/v1/ext/runs/{runId}/hitl" },
  hitl_inbox: { method: "get", path: "/api/v1/ext/hitl" },
  hitl_respond: {
    method: "post",
    path: "/api/v1/ext/runs/{runId}/hitl/{hitlRequestId}/respond",
  },
  comment_list: {
    method: "get",
    path: "/api/v1/ext/projects/{slug}/tasks/{taskId}/comments",
  },
  comment_create: {
    method: "post",
    path: "/api/v1/ext/projects/{slug}/tasks/{taskId}/comments",
  },
  triage_set: {
    method: "post",
    path: "/api/v1/ext/projects/{slug}/tasks/{taskId}/triage",
  },
  relation_list: {
    method: "get",
    path: "/api/v1/ext/projects/{slug}/tasks/{taskId}/relations",
  },
  relation_add: {
    method: "post",
    path: "/api/v1/ext/projects/{slug}/tasks/{taskId}/relations",
  },
  relation_remove: {
    method: "delete",
    path: "/api/v1/ext/projects/{slug}/tasks/{taskId}/relations",
  },
};

function pathParams(pathTemplate: string): string[] {
  return [...pathTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

type OpParameter = {
  $ref?: string;
  name?: string;
  in?: string;
  schema?: JsonSchema;
  required?: boolean;
};

function requiredQueryParams(op: { parameters?: OpParameter[] }): string[] {
  const out: string[] = [];

  for (const raw of op.parameters ?? []) {
    const p = deref(raw);

    if (p.in === "query" && p.required === true && p.name) out.push(p.name);
  }

  return out;
}

function queryParamSchemas(op: {
  parameters?: OpParameter[];
}): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};

  for (const raw of op.parameters ?? []) {
    const p = deref(raw);

    if (p.in === "query" && p.name)
      out[p.name] = (p.schema ?? {}) as JsonSchema;
  }

  return out;
}

function bodySchema(op: {
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
}): JsonSchema | undefined {
  const raw = op.requestBody?.content?.["application/json"]?.schema;

  return raw ? deref(raw) : undefined;
}

// Base JSON-Schema type(s), with "null" stripped. Nullability is asserted
// separately where it carries clear-vs-omit semantics (triage priority /
// confidence); for the OTHER nullable optionals (gate report url/sha/summary/
// payload) `null` is collapsed to `undefined` server-side, so the facade need
// not advertise it. Comparing base types keeps this check on real type drift
// (string-vs-integer, string-vs-object) without that noise.
function baseTypeSet(schema: JsonSchema): Set<string> {
  const raw = schema.type;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

  return new Set(list.filter((t) => t !== "null"));
}

// Full enum set INCLUDING null — an OpenAPI `nullable` enum lists `null`
// explicitly (triage.priority), so the facade enum must carry it too.
function enumSet(schema: JsonSchema): Set<unknown> | null {
  return schema.enum ? new Set(schema.enum) : null;
}

function toolSpec(name: string): JsonSchema {
  return TOOL_SPECS[name].inputSchema as JsonSchema;
}

describe("TOOL_SPECS ↔ external OpenAPI contract", () => {
  it("maps every registered tool to an operation, and vice versa", () => {
    expect(Object.keys(TOOL_OP).sort()).toEqual(Object.keys(TOOL_SPECS).sort());
  });

  it("every mapped operation exists in the spec", () => {
    for (const [tool, { method, path }] of Object.entries(TOOL_OP)) {
      const op = openapi.paths[path]?.[method];

      expect(op, `${tool} → ${method.toUpperCase()} ${path}`).toBeDefined();
    }
  });

  describe.each(Object.entries(TOOL_OP))("%s", (toolName, { method, path }) => {
    // Optional-chain at collection time: a missing operation must fail the
    // existence test below, not crash the whole file with a TypeError while
    // vitest is still collecting.
    const op = openapi.paths[path]?.[method];

    it("has its operation in the spec", () => {
      expect(op, `${toolName} → ${method.toUpperCase()} ${path}`).toBeDefined();
    });

    if (!op) return;

    const params = pathParams(path);
    const queryFields = queryParamSchemas(op);
    const body = bodySchema(op);
    const bodyProps = body?.properties ?? {};
    const bodyRequired = body?.required ?? [];

    const spec = toolSpec(toolName);
    const toolProps = spec.properties ?? {};
    const toolRequired = spec.required ?? [];

    it("advertises exactly the operation's params + body properties", () => {
      const expected = new Set([
        ...params,
        ...Object.keys(queryFields),
        ...Object.keys(bodyProps),
      ]);

      expect(new Set(Object.keys(toolProps))).toEqual(expected);
    });

    it("marks exactly the path params + required body/query fields as required", () => {
      // Path params are always required (they are URL segments the agent MUST
      // supply); query params are optional with defaults (limit/offset) UNLESS
      // the spec marks the parameter `required: true` (memory_recall `q`).
      const expected = new Set([
        ...params,
        ...bodyRequired,
        ...requiredQueryParams(op),
      ]);

      expect(new Set(toolRequired)).toEqual(expected);
    });

    it("mirrors every body + query field's base type, enum, and bounds", () => {
      // Every typed input the agent sends — request-body fields AND query
      // params (comment_list limit/offset) — must match the spec. Path params
      // are structurally URL strings and checked for presence only, above.
      const typedFields = { ...bodyProps, ...queryFields };

      for (const [field, rawSchema] of Object.entries(typedFields)) {
        const openapiField = deref(rawSchema);
        const toolField = toolProps[field];

        expect(toolField, `${toolName}.${field} present`).toBeDefined();

        expect(baseTypeSet(toolField), `${toolName}.${field} type`).toEqual(
          baseTypeSet(openapiField),
        );

        const specEnum = enumSet(openapiField);

        if (specEnum) {
          expect(
            new Set(toolField.enum ?? []),
            `${toolName}.${field} enum`,
          ).toEqual(specEnum);
        }

        for (const bound of MIRRORED_BOUNDS) {
          const specBound = openapiField[bound];

          if (specBound !== undefined) {
            expect(toolField[bound], `${toolName}.${field} ${bound}`).toBe(
              specBound,
            );
          }
        }
      }
    });
  });

  // Nested composites: the generic loop compares only the top-level `target` /
  // `tasks` fields, so their inner shape is asserted explicitly here.
  it("run_delegate.target mirrors ExtDelegationTarget", () => {
    const openapiTarget = deref(
      bodySchema(openapi.paths["/api/v1/ext/runs/delegate"].post)!.properties!
        .target,
    );
    const toolTarget = (toolSpec("run_delegate").properties!.target ?? {}) as {
      properties?: Record<string, JsonSchema>;
    };

    expect(new Set(Object.keys(toolTarget.properties ?? {}))).toEqual(
      new Set(Object.keys(openapiTarget.properties ?? {})),
    );
  });

  it("run_plan tasks[] items mirror ExtRunPlanTask (props, required, enums)", () => {
    const openapiItem = deref(
      bodySchema(openapi.paths["/api/v1/ext/runs/plan"].post)!.properties!.tasks
        .items as JsonSchema,
    );
    const toolItem = (toolSpec("run_plan").properties!.tasks.items ??
      {}) as JsonSchema;
    const openapiItemProps = openapiItem.properties ?? {};

    expect(new Set(Object.keys(toolItem.properties ?? {}))).toEqual(
      new Set(Object.keys(openapiItemProps)),
    );
    expect(new Set(toolItem.required ?? [])).toEqual(
      new Set(openapiItem.required ?? []),
    );

    for (const [field, rawSchema] of Object.entries(openapiItemProps)) {
      const specField = deref(rawSchema);
      const toolField = (toolItem.properties ?? {})[field];
      const specEnum = enumSet(specField);

      if (specEnum) {
        expect(
          new Set(toolField?.enum ?? []),
          `run_plan.tasks[].${field} enum`,
        ).toEqual(specEnum);
      }

      for (const bound of MIRRORED_BOUNDS) {
        const specBound = specField[bound];

        if (specBound !== undefined) {
          expect(toolField?.[bound], `run_plan.tasks[].${field} ${bound}`).toBe(
            specBound,
          );
        }
      }
    }
  });

  // Nullable-with-clear-semantics: for these two the route distinguishes
  // `null` (clear → 'normal' / NULL) from `undefined` (leave unchanged), so the
  // facade MUST let the agent express null — unlike the gate-report nullables,
  // where null ≡ omit. The generic loop strips null from the base type; this
  // asserts the distinct capability directly.
  it("triage_set priority/confidence accept null (the clear path)", () => {
    const props = toolSpec("triage_set").properties!;

    expect(baseTypeSet({ type: props.priority.type }).has("string")).toBe(true);
    expect(props.priority.enum).toContain(null);

    const confidenceTypes = Array.isArray(props.confidence.type)
      ? props.confidence.type
      : [props.confidence.type];

    expect(confidenceTypes).toContain("number");
    expect(confidenceTypes).toContain("null");
  });
});
