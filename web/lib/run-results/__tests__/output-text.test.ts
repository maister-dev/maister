// TRC-04: a child's legacy `outputText` is composed only from artifacts a
// producer deliberately recorded.
//
// `outputTextFromArtifacts` picks the newest inline row whose kind is one of
// `log | human_note | ai_judgment`. `log` is a legitimate MANIFEST kind — a
// flow can declare a `producer:"runner"` log artifact and mean it — so the
// predicate can never key on `kind` alone. It must key on the PRODUCER: a row
// the artifact projector synthesized from an ACP frame was never a deliberate
// output, and an orchestrator reading one as its child's answer is reading
// tool telemetry as a result.
//
// After TRC-01 no new run produces a projector log row at all. This guard is
// what keeps that from being the ONLY thing standing between a projector row
// and a parent run's `outputText` — correctness here must not depend on
// another file happening not to write one.

import type { ArtifactRow } from "@/lib/run-results/collect";

import { describe, expect, it } from "vitest";

import { outputTextFromArtifacts } from "@/lib/run-results/collect";

// T2.4 adds `producer` to `ArtifactRow`; until then the fixture names the
// column the predicate must read.
function rows(
  ...specs: { kind: string; producer: string; text: string; at: string }[]
): ArtifactRow[] {
  return specs.map((spec, index) => ({
    id: `artifact-${index}`,
    kind: spec.kind,
    locator: { kind: "inline", text: spec.text },
    uri: null,
    nodeId: "implement",
    validity: "current",
    producer: spec.producer,
    createdAt: new Date(spec.at),
  })) as unknown as ArtifactRow[];
}

describe("outputTextFromArtifacts", () => {
  // UT-TRC-04
  it("UT-TRC-04: skips a projector-derived row and takes the producer's own", async () => {
    const result = outputTextFromArtifacts(
      rows(
        {
          kind: "log",
          producer: "projector",
          text: "Run check · tool-1 · completed",
          at: "2026-09-17T10:00:02.000Z",
        },
        {
          kind: "log",
          producer: "runner",
          text: "the answer the flow meant to publish",
          at: "2026-09-17T10:00:01.000Z",
        },
      ),
    );

    expect(result).toBe("the answer the flow meant to publish");
  });

  it("UT-TRC-04: returns undefined when every candidate row is projector-derived", async () => {
    const result = outputTextFromArtifacts(
      rows({
        kind: "log",
        producer: "projector",
        text: "Run check · tool-1 · completed",
        at: "2026-09-17T10:00:00.000Z",
      }),
    );

    expect(result).toBeUndefined();
  });

  // `log` stays a declarable manifest kind (D2) — the predicate narrows by
  // producer, never by kind, or it would silently drop a flow's own log output.
  it("UT-TRC-04: still accepts a runner-produced log, human note and judgment", async () => {
    for (const kind of ["log", "human_note", "ai_judgment"]) {
      expect(
        outputTextFromArtifacts(
          rows({
            kind,
            producer: "runner",
            text: `deliberate ${kind}`,
            at: "2026-09-17T10:00:00.000Z",
          }),
        ),
      ).toBe(`deliberate ${kind}`);
    }
  });
});
