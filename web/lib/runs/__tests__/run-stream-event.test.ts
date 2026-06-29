import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { appendRunStreamEvent } from "@/lib/runs/run-stream-event";

describe("appendRunStreamEvent", () => {
  it("appends a durable event with monotonicId one past the file max", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "run-stream-event-"));
    const file = path.join(dir, "run.events.jsonl");

    await writeFile(
      file,
      [
        JSON.stringify({ type: "session.update", monotonicId: 41 }),
        JSON.stringify({ type: "session.exited", monotonicId: 42 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const id = await appendRunStreamEvent(file, {
      type: "run.needs_input",
      data: { nodeId: "plan_review" },
    });

    expect(id).toBe(43);

    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;

    expect(last).toMatchObject({
      type: "run.needs_input",
      monotonicId: 43,
      nodeId: "plan_review",
      sessionName: "default",
    });
  });

  it("starts at monotonicId 1 when the events log does not yet exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "run-stream-event-"));
    const file = path.join(dir, "run.events.jsonl");

    const id = await appendRunStreamEvent(file, { type: "run.needs_input" });

    expect(id).toBe(1);
  });

  it("ignores malformed lines when computing the max monotonicId", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "run-stream-event-"));
    const file = path.join(dir, "run.events.jsonl");

    await writeFile(
      file,
      [
        "{ not valid json",
        JSON.stringify({ type: "session.update", monotonicId: 7 }),
        "",
      ].join("\n"),
      "utf8",
    );

    const id = await appendRunStreamEvent(file, { type: "run.needs_input" });

    expect(id).toBe(8);
  });
});
