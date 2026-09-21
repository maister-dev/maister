import { afterEach, describe, expect, it } from "vitest";

import {
  resolveMcpEnvVariables,
  resolveMcpHeaderRecord,
  resolveMcpHeaders,
  resolveMcpMap,
  resolveMcpValue,
} from "../mcp-values.js";

// ADR-179: the host is the ONLY place an `env:NAME` reference becomes a value.
// These cases pin the three resolution rules (literal verbatim, reference from
// process.env, unset reference -> "") and the bearer composition on both header
// shapes (ACP HttpHeader[] and the MCP SDK's Record).

const OWNED = [
  "MCP_VALUES_PRESENT",
  "MCP_VALUES_EMPTY",
  "MCP_VALUES_TOKEN",
] as const;

afterEach(() => {
  for (const name of OWNED) delete process.env[name];
});

describe("resolveMcpValue", () => {
  it("passes a literal through verbatim, interpolating nothing", () => {
    expect(resolveMcpValue("ERROR")).toBe("ERROR");
    // D2: a provisioner substituting inside literals would corrupt values meant
    // for the server, so `${X}` is eight characters, not a lookup.
    expect(resolveMcpValue("${MCP_VALUES_PRESENT}")).toBe(
      "${MCP_VALUES_PRESENT}",
    );
    expect(resolveMcpValue("")).toBe("");
  });

  it("resolves env:NAME from process.env", () => {
    process.env.MCP_VALUES_PRESENT = "resolved-1";

    expect(resolveMcpValue("env:MCP_VALUES_PRESENT")).toBe("resolved-1");
  });

  it('resolves an unset or empty reference to "" (D3, never fail-fast)', () => {
    expect(resolveMcpValue("env:MCP_VALUES_ABSENT_SENTINEL")).toBe("");

    process.env.MCP_VALUES_EMPTY = "";
    expect(resolveMcpValue("env:MCP_VALUES_EMPTY")).toBe("");
  });
});

describe("resolveMcpMap", () => {
  it("resolves each value independently and preserves the keys", () => {
    process.env.MCP_VALUES_PRESENT = "resolved-2";

    expect(
      resolveMcpMap({
        GITHUB_TOKEN: "env:MCP_VALUES_PRESENT",
        FASTMCP_LOG_LEVEL: "ERROR",
        MISSING: "env:MCP_VALUES_ABSENT_SENTINEL",
      }),
    ).toEqual({
      GITHUB_TOKEN: "resolved-2",
      FASTMCP_LOG_LEVEL: "ERROR",
      MISSING: "",
    });
  });

  it("returns an empty record for an absent map", () => {
    expect(resolveMcpMap(undefined)).toEqual({});
  });
});

describe("resolveMcpEnvVariables", () => {
  it("returns { name, value } entries in map order", () => {
    process.env.MCP_VALUES_PRESENT = "resolved-3";

    expect(
      resolveMcpEnvVariables({
        FIRST: "literal-1",
        SECOND: "env:MCP_VALUES_PRESENT",
      }),
    ).toEqual([
      { name: "FIRST", value: "literal-1" },
      { name: "SECOND", value: "resolved-3" },
    ]);
  });
});

describe("resolveMcpHeaders (ACP HttpHeader[])", () => {
  it("resolves declared headers in map order", () => {
    process.env.MCP_VALUES_PRESENT = "resolved-4";

    expect(
      resolveMcpHeaders(
        { "X-Tenant": "acme", "X-Key": "env:MCP_VALUES_PRESENT" },
        undefined,
      ),
    ).toEqual([
      { name: "X-Tenant", value: "acme" },
      { name: "X-Key", value: "resolved-4" },
    ]);
  });

  it("appends the composed Authorization header LAST", () => {
    process.env.MCP_VALUES_TOKEN = "tok-123";

    const out = resolveMcpHeaders(
      { "X-Tenant": "acme", "X-Trace": "on" },
      "env:MCP_VALUES_TOKEN",
    );

    expect(out).toHaveLength(3);
    expect(out.at(-1)).toEqual({
      name: "Authorization",
      value: "Bearer tok-123",
    });
  });

  it('composes "Bearer " when the referenced variable is unset', () => {
    expect(resolveMcpHeaders({}, "env:MCP_VALUES_ABSENT_SENTINEL")).toEqual([
      { name: "Authorization", value: "Bearer " },
    ]);
  });

  it("emits no Authorization header when bearerTokenEnv is absent", () => {
    expect(
      resolveMcpHeaders({ "X-Tenant": "acme" }, undefined).map((h) => h.name),
    ).toEqual(["X-Tenant"]);
  });
});

describe("resolveMcpHeaderRecord (MCP SDK Record)", () => {
  it("mirrors resolveMcpHeaders, with Authorization composed the same way", () => {
    process.env.MCP_VALUES_TOKEN = "tok-456";

    expect(
      resolveMcpHeaderRecord({ "X-Tenant": "acme" }, "env:MCP_VALUES_TOKEN"),
    ).toEqual({ "X-Tenant": "acme", Authorization: "Bearer tok-456" });
  });

  it("lets bearerTokenEnv win over a same-named declared header", () => {
    process.env.MCP_VALUES_TOKEN = "tok-789";

    // The schema refuses this pair at the boundary (D23); the resolver is
    // defence in depth and must not emit two conflicting Authorization values.
    expect(
      resolveMcpHeaderRecord(
        { authorization: "Basic abc" },
        "env:MCP_VALUES_TOKEN",
      ).Authorization,
    ).toBe("Bearer tok-789");
  });
});
