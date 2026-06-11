import { describe, expect, it } from "vitest";

import {
  MAISTER_ENGINE_VERSION,
  GRAPH_MIN_ENGINE_VERSION,
} from "@/lib/flows/engine-version";
import { nodeOutputSchema } from "@/lib/config.schema";

describe("config.schema — artifact produces[] fields", () => {
  it("asserts MAISTER_ENGINE_VERSION is 1.4.0 (bumped for M30)", () => {
    expect(MAISTER_ENGINE_VERSION).toBe("1.4.0");
  });

  it("asserts GRAPH_MIN_ENGINE_VERSION remains 1.1.0", () => {
    expect(GRAPH_MIN_ENGINE_VERSION).toBe("1.1.0");
  });

  describe("nodeOutputSchema with produces[]", () => {
    it("accepts a full valid produces entry with all optional fields", () => {
      const valid = {
        produces: [
          {
            id: "test-report",
            kind: "test_report",
            schema: "json-schema-ref",
            path: "outputs/report.json",
            ref: "test_artifact_v1",
            visibility: "shared",
            retention: "run",
            requiredFor: ["review"],
          },
        ],
      };

      expect(() => nodeOutputSchema.parse(valid)).not.toThrow();
    });

    it("accepts a minimal produces entry (id + kind only)", () => {
      const minimal = {
        produces: [
          {
            id: "artifact-1",
            kind: "diff",
          },
        ],
      };

      expect(() => nodeOutputSchema.parse(minimal)).not.toThrow();
    });

    it("accepts produces entries with different ARTIFACT_KINDS", () => {
      const kinds = [
        "diff",
        "log",
        "test_report",
        "lint_report",
        "ai_judgment",
        "human_note",
        "commit_set",
        "checkpoint",
        "preview",
        "generic_file",
      ];

      for (const kind of kinds) {
        const entry = {
          produces: [
            {
              id: `artifact-${kind}`,
              kind,
            },
          ],
        };

        expect(() => nodeOutputSchema.parse(entry)).not.toThrow(
          `should accept kind="${kind}"`,
        );
      }
    });

    it("rejects produces with invalid kind (not in ARTIFACT_KINDS)", () => {
      const invalid = {
        produces: [
          {
            id: "bad",
            kind: "bogus_kind",
          },
        ],
      };

      expect(() => nodeOutputSchema.parse(invalid)).toThrow();
    });

    it("accepts requiredFor as array of valid gates (review|merge)", () => {
      const valid = {
        produces: [
          {
            id: "art1",
            kind: "test_report",
            requiredFor: ["review", "merge"],
          },
        ],
      };

      expect(() => nodeOutputSchema.parse(valid)).not.toThrow();
    });

    it("accepts visibility as internal or shared", () => {
      const internal = {
        produces: [{ id: "a1", kind: "log", visibility: "internal" }],
      };
      const shared = {
        produces: [{ id: "a2", kind: "log", visibility: "shared" }],
      };

      expect(() => nodeOutputSchema.parse(internal)).not.toThrow();
      expect(() => nodeOutputSchema.parse(shared)).not.toThrow();
    });

    it("accepts retention as run or ephemeral", () => {
      const run = {
        produces: [{ id: "a1", kind: "log", retention: "run" }],
      };
      const ephemeral = {
        produces: [{ id: "a2", kind: "log", retention: "ephemeral" }],
      };

      expect(() => nodeOutputSchema.parse(run)).not.toThrow();
      expect(() => nodeOutputSchema.parse(ephemeral)).not.toThrow();
    });

    it("accepts empty produces array", () => {
      const empty = { produces: [] };

      expect(() => nodeOutputSchema.parse(empty)).not.toThrow();
    });

    it("accepts no produces key at all (passthrough)", () => {
      const noProduces = {};

      expect(() => nodeOutputSchema.parse(noProduces)).not.toThrow();
    });
  });
});
