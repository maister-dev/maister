import { describe, expect, it } from "vitest";

import { resolveAuthHeader } from "@/auth";

describe("resolveAuthHeader — http transport", () => {
  it("returns the inbound Authorization header verbatim when present", () => {
    expect(
      resolveAuthHeader({
        transport: "http",
        inboundAuthorization: "Bearer mai_abc123",
      }),
    ).toBe("Bearer mai_abc123");
  });

  it("returns null when the inbound Authorization is missing", () => {
    expect(resolveAuthHeader({ transport: "http" })).toBeNull();
  });

  it("returns null when the inbound Authorization is an empty string", () => {
    expect(
      resolveAuthHeader({ transport: "http", inboundAuthorization: "" }),
    ).toBeNull();
  });

  it("NEVER consults env under http — env token is ignored when inbound is missing", () => {
    expect(
      resolveAuthHeader({
        transport: "http",
        env: { MAISTER_PROJECT_TOKEN: "mai_env_should_be_ignored" },
      } as unknown as Parameters<typeof resolveAuthHeader>[0]),
    ).toBeNull();
  });
});

describe("resolveAuthHeader — stdio transport", () => {
  it("returns 'Bearer <token>' when MAISTER_PROJECT_TOKEN is set", () => {
    expect(
      resolveAuthHeader({
        transport: "stdio",
        env: { MAISTER_PROJECT_TOKEN: "mai_local_token" },
      }),
    ).toBe("Bearer mai_local_token");
  });

  it("returns null when MAISTER_PROJECT_TOKEN is absent", () => {
    expect(resolveAuthHeader({ transport: "stdio", env: {} })).toBeNull();
  });

  it("returns null when MAISTER_PROJECT_TOKEN is an empty string", () => {
    expect(
      resolveAuthHeader({
        transport: "stdio",
        env: { MAISTER_PROJECT_TOKEN: "" },
      }),
    ).toBeNull();
  });
});
