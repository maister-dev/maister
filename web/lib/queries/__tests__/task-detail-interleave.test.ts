import { describe, expect, it } from "vitest";

import { interleaveTimeline } from "@/lib/queries/task-detail";

const user = { type: "user" as const, id: "u1", label: "User One" };

function comment(id: string, at: string) {
  return { id, body: `c-${id}`, actor: user, createdAt: new Date(at) };
}

function activity(id: string, kind: string, at: string) {
  return {
    id,
    eventKind: kind,
    payload: {},
    actor: user,
    createdAt: new Date(at),
  };
}

describe("interleaveTimeline (ADR-078 task timeline)", () => {
  it("merges comments and activity ascending by createdAt", () => {
    const items = interleaveTimeline(
      [
        comment("c2", "2026-06-02T00:00:00Z"),
        comment("c1", "2026-06-01T00:00:00Z"),
      ],
      [activity("a1", "task_created", "2026-05-31T00:00:00Z")],
    );

    expect(items.map((i) => i.id)).toEqual(["a1", "c1", "c2"]);
  });

  it("skips comment_added activity rows — the comment renders in their place", () => {
    const items = interleaveTimeline(
      [comment("c1", "2026-06-01T00:00:00Z")],
      [
        activity("a-dup", "comment_added", "2026-06-01T00:00:00Z"),
        activity("a-keep", "run_launched", "2026-06-02T00:00:00Z"),
      ],
    );

    expect(items.map((i) => i.id)).toEqual(["c1", "a-keep"]);
  });

  it("breaks createdAt ties deterministically by id", () => {
    const at = "2026-06-01T00:00:00Z";
    const items = interleaveTimeline(
      [comment("b", at)],
      [activity("a", "task_created", at), activity("c", "relation_added", at)],
    );

    expect(items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

// ADR-151 — the `comment_added` activity row is still skipped, but its payload
// carries the write-time mention truth. It is attached to the comment it
// describes so the timeline can footnote mentions that cannot summon; the
// chip in the body is never the authoritative signal.
describe("interleaveTimeline agent mentions (ADR-151)", () => {
  it("attaches mentionedAgents from the skipped comment_added row", () => {
    const items = interleaveTimeline(
      [comment("c1", "2026-06-01T00:00:00Z")],
      [
        {
          id: "a-dup",
          eventKind: "comment_added",
          payload: {
            commentId: "c1",
            mentionedAgents: [
              { id: "core:triager", name: "Triager", summonable: true },
              { id: "core:reviewer", name: "Reviewer", summonable: false },
            ],
          },
          actor: user,
          createdAt: new Date("2026-06-01T00:00:00Z"),
        },
      ],
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "comment",
      id: "c1",
      mentionedAgents: [
        { id: "core:triager", name: "Triager", summonable: true },
        { id: "core:reviewer", name: "Reviewer", summonable: false },
      ],
    });
  });

  it("leaves a comment without mentions untouched", () => {
    const items = interleaveTimeline(
      [comment("c1", "2026-06-01T00:00:00Z")],
      [activity("a-dup", "comment_added", "2026-06-01T00:00:00Z")],
    );

    expect(items[0]).not.toHaveProperty("mentionedAgents");
  });

  it("keeps agent_summon_suppressed as its own timeline row", () => {
    const items = interleaveTimeline(
      [comment("c1", "2026-06-01T00:00:00Z")],
      [
        activity(
          "a-sup",
          "agent_summon_suppressed",
          "2026-06-02T00:00:00Z",
        ),
      ],
    );

    expect(items.map((i) => i.id)).toEqual(["c1", "a-sup"]);
  });
});
