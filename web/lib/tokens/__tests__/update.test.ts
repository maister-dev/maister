import { describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors";
import { resolveEffectiveTokenFields } from "@/lib/tokens/update";

// I10 (D6). `normalizeTokenScopes([])` returns `["*"]` — a benign "default to
// full" on the CREATE path, and a silent grant of full access on the UPDATE
// path. The service must refuse an empty resolved scope set ITSELF; the route's
// zod `.min(1)` is a second line, never the only one. This test calls the
// resolver directly, with no route and no database, so it fails if the guard is
// ever moved out to the validator.
describe("lib/tokens/update — resolveEffectiveTokenFields", () => {
  it("I10: refuses an empty resolved scope set CONFIG at the service layer, never normalizing it to the wildcard", () => {
    const stored = {
      name: "Personal",
      scopes: ["hitl:respond:human"],
      expires_at: null,
    };

    // Removing the only scope the token holds resolves to an empty set. The
    // account surface reaches this without ever sending `scopes: []`.
    const err = (() => {
      try {
        resolveEffectiveTokenFields(stored, { humanHitl: false }, "account");

        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(isMaisterError(err) && err.code).toBe("CONFIG");
    expect(isMaisterError(err) && err.message).toMatch(/scope/i);
  });
});
