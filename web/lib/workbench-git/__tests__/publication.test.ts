import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  resolvePublishName,
  type PublishNameInput,
} from "@/lib/workbench-git/publication";

// ADR-181 D4 step 2 — the ONE name rule. An EXISTING publication on the target
// remote fixes the name; forking a second public branch would also fork a
// second PR (the reopen → re-promote regression this order exists to prevent).

const INTERNAL = "maister/task-1/attempt-2";

function input(over: Partial<PublishNameInput> = {}): PublishNameInput {
  return {
    runId: "0b3e7c1a-0000-4000-8000-000000000000",
    internalBranch: INTERNAL,
    remote: "origin",
    requested: null,
    template: "feature/{task_key}-{slug}",
    taskKey: "ABC-1",
    taskTitle: "Renamed title",
    recordedBranch: null,
    recordedRemote: null,
    legacyPrHead: false,
    upstream: null,
    ...over,
  };
}

function refusal(over: Partial<PublishNameInput>): MaisterError {
  try {
    resolvePublishName(input(over));
  } catch (err) {
    expect(err).toBeInstanceOf(MaisterError);

    return err as MaisterError;
  }
  throw new Error("expected a refusal");
}

describe("resolvePublishName", () => {
  it("renders the template when nothing is published yet", () => {
    expect(resolvePublishName(input())).toEqual({
      name: "feature/ABC-1-renamed-title",
      source: "template",
    });
  });

  it("takes the operator's name when nothing fixes one", () => {
    expect(
      resolvePublishName(input({ requested: "feature/hand-picked" })),
    ).toEqual({ name: "feature/hand-picked", source: "request" });
  });

  it("lets the upstream on this remote fix the name", () => {
    expect(
      resolvePublishName(
        input({ upstream: { remote: "origin", branch: "feature/ABC-1-old" } }),
      ),
    ).toEqual({ name: "feature/ABC-1-old", source: "upstream" });
  });

  // A task title edited after the publish must not re-render a new slug when
  // the upstream config was lost (a re-attach from the archive ref).
  it("keeps the recorded publication when the upstream is gone", () => {
    expect(
      resolvePublishName(
        input({
          recordedBranch: "feature/ABC-1-original-title",
          recordedRemote: "origin",
        }),
      ),
    ).toEqual({ name: "feature/ABC-1-original-title", source: "upstream" });
  });

  // Before ADR-181 a PR was opened from the INTERNAL name with no record.
  it("keeps a pre-ADR-181 PR's internal head on origin", () => {
    expect(resolvePublishName(input({ legacyPrHead: true }))).toEqual({
      name: INTERNAL,
      source: "upstream",
    });
  });

  it("does not let another remote's publication fix this remote's name", () => {
    expect(
      resolvePublishName(
        input({
          remote: "fork",
          recordedBranch: "feature/ABC-1-original-title",
          recordedRemote: "origin",
          legacyPrHead: true,
          upstream: { remote: "origin", branch: "feature/ABC-1-old" },
        }),
      ),
    ).toEqual({ name: "feature/ABC-1-renamed-title", source: "template" });
  });

  it.each([
    ["an upstream", { upstream: { remote: "origin", branch: "feature/x" } }],
    [
      "a recorded publication",
      { recordedBranch: "feature/x", recordedRemote: "origin" },
    ],
    ["a pre-ADR-181 PR head", { legacyPrHead: true }],
  ] as const)("refuses to rename a branch fixed by %s", (_label, fixed) => {
    const err = refusal({ ...fixed, requested: "feature/another" });

    expect(err.code).toBe("PRECONDITION");
    expect(err.details?.reason).toBe("public_name_fixed");
  });

  it("accepts a request equal to the fixed name", () => {
    expect(
      resolvePublishName(
        input({
          recordedBranch: "feature/x",
          recordedRemote: "origin",
          requested: "feature/x",
        }),
      ),
    ).toEqual({ name: "feature/x", source: "upstream" });
  });
});
