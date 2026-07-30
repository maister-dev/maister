import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import { checkFlowRequirements } from "@/lib/flows/requirements-check";

const CWD = process.cwd();

describe("checkFlowRequirements (ADR-091)", () => {
  it("no-ops on undefined or empty requirements", async () => {
    await expect(
      checkFlowRequirements(undefined, CWD),
    ).resolves.toBeUndefined();
    await expect(checkFlowRequirements([], CWD)).resolves.toBeUndefined();
  });

  it("passes when every probe exits 0", async () => {
    await expect(
      checkFlowRequirements(
        [
          { name: "always", probe: "exit 0" },
          { name: "true", probe: "true" },
        ],
        CWD,
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses with PRECONDITION listing each failed probe and its hint", async () => {
    let caught: unknown;

    try {
      await checkFlowRequirements(
        [
          {
            name: "openspec CLI",
            probe: "exit 1",
            hint: "npm i -g @fission-ai/openspec@1.4.1 (or run os-init)",
          },
          { name: "passing", probe: "true" },
          { name: "node>=20", probe: "false" },
        ],
        CWD,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MaisterError);
    expect((caught as MaisterError).code).toBe("PRECONDITION");

    const message = (caught as MaisterError).message;

    expect(message).toContain("openspec CLI");
    expect(message).toContain("npm i -g @fission-ai/openspec@1.4.1");
    expect(message).toContain("node>=20");
    // a passing probe is never listed as a failure
    expect(message).not.toContain("- passing:");
  });

  describe("probe env isolation (ADR-153)", () => {
    const SENTINEL = "WEB_TIER_SENTINEL_SECRET";

    beforeEach(() => {
      vi.stubEnv(SENTINEL, "leak-me");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("withholds a web-tier secret env var from probes while allow-listed vars pass", async () => {
      // The secret-presence probe must FAIL (var invisible to the child) while
      // the PATH probe passes — proving the allow-list, not an empty env.
      let caught: unknown;

      try {
        await checkFlowRequirements(
          [
            {
              name: "sees-secret",
              probe: 'test -n "${WEB_TIER_SENTINEL_SECRET:-}"',
            },
            { name: "has-path", probe: 'test -n "$PATH"' },
          ],
          CWD,
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(MaisterError);
      expect((caught as MaisterError).code).toBe("PRECONDITION");
      expect((caught as MaisterError).message).toContain("sees-secret");
      expect((caught as MaisterError).message).not.toContain("- has-path:");
    });
  });
});
