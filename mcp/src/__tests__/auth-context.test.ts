import { describe, expect, it } from "vitest";

import { httpAuthContext } from "@/auth";
import { resolveAuthHeader } from "@/auth";

// Coverage gap: httpAuthContext pure helper (inline in main.ts → extracted to auth.ts)

describe("httpAuthContext", () => {
  it("single string header → http ctx with that value as inboundAuthorization", () => {
    const ctx = httpAuthContext("Bearer mai_abc");

    expect(ctx.transport).toBe("http");
    expect(resolveAuthHeader(ctx)).toBe("Bearer mai_abc");
  });

  it("undefined → http ctx that resolveAuthHeader maps to null (→ 401)", () => {
    const ctx = httpAuthContext(undefined);

    expect(ctx.transport).toBe("http");
    expect(resolveAuthHeader(ctx)).toBeNull();
  });

  it("string[] (duplicate headers) → takes first element, resolveAuthHeader returns it", () => {
    const ctx = httpAuthContext(["Bearer mai_first", "Bearer mai_second"]);

    expect(ctx.transport).toBe("http");
    expect(resolveAuthHeader(ctx)).toBe("Bearer mai_first");
  });
});
