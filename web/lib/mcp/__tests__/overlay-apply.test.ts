import type { AgentMcpServer } from "@/lib/capabilities/agent-map";

import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import { applyMcpOverlays } from "@/lib/mcp/materialization-gate";

// ADR-129 (W-C), amended by ADR-179: the overlay replaces the VALUE for a key
// the target declares and PRESERVES the key. The key is the SERVER's contract —
// the pre-ADR-179 behavior renamed it, so the server never received the variable
// it reads. The ACP wire shape is unchanged and the execution host still
// resolves each `env:NAME`. A remap targeting an undeclared slot is a CONFIG.

const stdio = (name: string, env: Record<string, string>): AgentMcpServer => ({
  name,
  transport: "stdio",
  command: "npx",
  args: ["-y", "server"],
  env,
});

describe("applyMcpOverlays (W-C, value semantics)", () => {
  it("replaces the VALUE for a declared key and keeps the KEY", () => {
    const [out] = applyMcpOverlays(
      [
        stdio("github", {
          GITHUB_TOKEN: "env:GITHUB_TOKEN",
          GH_HOST: "github.com",
        }),
      ],
      new Map([["github", { envRemap: { GITHUB_TOKEN: "env:PROJ_A_GH" } }]]),
    );

    // The assertion that fails if the key is renamed again.
    expect(Object.keys(out.env ?? {})).toEqual(["GITHUB_TOKEN", "GH_HOST"]);
    expect(out.env).toEqual({
      GITHUB_TOKEN: "env:PROJ_A_GH",
      // A key the overlay does not name keeps its own value.
      GH_HOST: "github.com",
    });
  });

  it("gives project A and project B different SOURCES for the same key", () => {
    const server = stdio("github", { API_TOKEN: "env:SHARED_TOKEN" });
    const [a] = applyMcpOverlays(
      [server],
      new Map([["github", { envRemap: { API_TOKEN: "env:PROJ_A_TOKEN" } }]]),
    );
    const [b] = applyMcpOverlays(
      [server],
      new Map([["github", { envRemap: { API_TOKEN: "env:PROJ_B_TOKEN" } }]]),
    );

    expect(a.env).toEqual({ API_TOKEN: "env:PROJ_A_TOKEN" });
    expect(b.env).toEqual({ API_TOKEN: "env:PROJ_B_TOKEN" });
  });

  it("accepts a LITERAL overlay value and replaces the value verbatim (D32)", () => {
    const [out] = applyMcpOverlays(
      [stdio("github", { GH_HOST: "github.com" })],
      new Map([["github", { envRemap: { GH_HOST: "ghe.internal" } }]]),
    );

    // A project overriding a non-secret literal is exactly why overlay values
    // share the server grammar — no host variable needed.
    expect(out.env).toEqual({ GH_HOST: "ghe.internal" });
  });

  it("overrides args and url, and replaces a declared header value", () => {
    const http: AgentMcpServer = {
      name: "remote",
      transport: "http",
      url: "https://default/mcp",
      headers: { "X-Tenant": "default" },
    };
    const [out] = applyMcpOverlays(
      [http],
      new Map([
        [
          "remote",
          {
            urlOverride: "https://proj-a.example/mcp",
            headerRemap: { "X-Tenant": "proj-a" },
          },
        ],
      ]),
    );

    expect(out.url).toBe("https://proj-a.example/mcp");
    expect(out.headers).toEqual({ "X-Tenant": "proj-a" });
  });

  it("replaces bearerTokenEnv on an http target", () => {
    const [out] = applyMcpOverlays(
      [
        {
          name: "remote",
          transport: "http",
          url: "https://default/mcp",
          headers: {},
          bearerTokenEnv: "env:SHARED_TOKEN",
        },
      ],
      new Map([["remote", { bearerTokenEnv: "env:PROJ_A_TOKEN" }]]),
    );

    expect(out.bearerTokenEnv).toBe("env:PROJ_A_TOKEN");
  });

  it("refuses a bearerTokenEnv overlay against a stdio target with CONFIG", () => {
    expect(() =>
      applyMcpOverlays(
        [stdio("github", { GITHUB_TOKEN: "env:GITHUB_TOKEN" })],
        new Map([["github", { bearerTokenEnv: "env:PROJ_A_TOKEN" }]]),
      ),
    ).toThrow(MaisterError);
  });

  it("leaves a server without an overlay untouched", () => {
    const server = stdio("fs", { FS_ROOT: "/workspace" });
    const [out] = applyMcpOverlays([server], new Map());

    expect(out).toBe(server);
  });

  it("rejects a remap targeting an undeclared slot with CONFIG (defensive re-validation)", () => {
    expect(() =>
      applyMcpOverlays(
        [stdio("github", { GITHUB_TOKEN: "env:GITHUB_TOKEN" })],
        new Map([["github", { envRemap: { NOT_A_SLOT: "env:X" } }]]),
      ),
    ).toThrow(MaisterError);
  });

  it("rejects a malformed env: overlay value with CONFIG", () => {
    expect(() =>
      applyMcpOverlays(
        [stdio("github", { GITHUB_TOKEN: "env:GITHUB_TOKEN" })],
        new Map([["github", { envRemap: { GITHUB_TOKEN: "env:1BAD" } }]]),
      ),
    ).toThrow(MaisterError);
  });
});
