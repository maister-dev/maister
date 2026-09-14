// S4.8 / D9 step 6: the manager catalogues an imported object under the kind
// the ordinary read path and retention understand. The mapping is closed: a
// source class this build does not know is refused, never guessed.

import { describe, expect, it } from "vitest";

import { catalogKindFor } from "../catalog";

describe("catalogKindFor", () => {
  it("maps every frozen source class onto a catalogue kind", () => {
    expect(catalogKindFor("raw_transcript")).toBe("raw_transcript");
    expect(catalogKindFor("cost_diagnostic")).toBe("cost_diagnostic");
    expect(catalogKindFor("step_log")).toBe("session_log");
    expect(catalogKindFor("session_metadata")).toBe("checkpoint");
    expect(catalogKindFor("upload")).toBe("attachment");
    expect(catalogKindFor("file_evidence")).toBe("evidence");
    expect(catalogKindFor("manager_owned")).toBe("evidence");
  });

  it("refuses a source class it does not know", () => {
    expect(() => catalogKindFor("holographic")).toThrow(/catalog_kind_unknown/);
  });
});
