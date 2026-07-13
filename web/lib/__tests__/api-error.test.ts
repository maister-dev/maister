import { describe, expect, it } from "vitest";

import { readApiError } from "@/lib/api-error";

const t = (key: string, values?: Record<string, string | number>): string =>
  values ? `${key}:${JSON.stringify(values)}` : key;

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readApiError", () => {
  it("uses an approved localized key for a known error code", async () => {
    await expect(
      readApiError(
        response({ code: "CONFLICT", message: "server secret" }, 409),
        t,
      ),
    ).resolves.toBe("CONFLICT");
  });

  it.each([
    [{ code: "UNKNOWN", message: "server secret" }, 500],
    [{ message: "server secret" }, 500],
    [{ code: "UNKNOWN" }, 500],
  ])("never exposes raw API detail for %#", async (body, status) => {
    await expect(readApiError(response(body, status), t)).resolves.toBe(
      "requestFailed",
    );
  });
});
