import type { AgentMcpServer } from "@/lib/capabilities/agent-map";

import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import { applyMcpOverlays } from "@/lib/mcp/materialization-gate";

// ADR-129 (W-C): the overlay rewrites env/header/arg/url NAMES only — the ACP
// wire shape is unchanged and the supervisor still resolves values from
// process.env by NAME. A remap targeting an undeclared slot is a CONFIG (422).

const stdio = (name: string, envKeys: string[]): AgentMcpServer => ({
  name,
  transport: "stdio",
  command: "npx",
  args: ["-y", "server"],
  envKeys,
});

describe("applyMcpOverlays (W-C)", () => {
  it("rewrites an env slot NAME to the remapped bare name (no value crosses)", () => {
    const [out] = applyMcpOverlays(
      [stdio("github", ["GITHUB_TOKEN", "GH_HOST"])],
      new Map([["github", { envRemap: { GITHUB_TOKEN: "env:PROJ_A_GH" } }]]),
    );

    expect(out.envKeys).toEqual(["PROJ_A_GH", "GH_HOST"]);
    // The remapped value is a NAME, never the secret value.
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("gives project A and project B different names for the same server", () => {
    const server = stdio("github", ["API_TOKEN"]);
    const [a] = applyMcpOverlays(
      [server],
      new Map([["github", { envRemap: { API_TOKEN: "env:PROJ_A_TOKEN" } }]]),
    );
    const [b] = applyMcpOverlays(
      [server],
      new Map([["github", { envRemap: { API_TOKEN: "env:PROJ_B_TOKEN" } }]]),
    );

    expect(a.envKeys).toEqual(["PROJ_A_TOKEN"]);
    expect(b.envKeys).toEqual(["PROJ_B_TOKEN"]);
  });

  it("overrides args and url without touching secret material", () => {
    const http: AgentMcpServer = {
      name: "remote",
      transport: "http",
      url: "https://default/mcp",
      headerKeys: ["Authorization"],
    };
    const [out] = applyMcpOverlays(
      [http],
      new Map([
        [
          "remote",
          {
            urlOverride: "https://proj-a.example/mcp",
            headerRemap: { Authorization: "env:PROJ_A_AUTH" },
          },
        ],
      ]),
    );

    expect(out.url).toBe("https://proj-a.example/mcp");
    expect(out.headerKeys).toEqual(["PROJ_A_AUTH"]);
  });

  it("leaves a server without an overlay untouched", () => {
    const server = stdio("fs", ["FS_ROOT"]);
    const [out] = applyMcpOverlays([server], new Map());

    expect(out).toBe(server);
  });

  it("rejects a remap targeting an undeclared slot with CONFIG (defensive re-validation)", () => {
    expect(() =>
      applyMcpOverlays(
        [stdio("github", ["GITHUB_TOKEN"])],
        new Map([["github", { envRemap: { NOT_A_SLOT: "env:X" } }]]),
      ),
    ).toThrow(MaisterError);
  });
});
