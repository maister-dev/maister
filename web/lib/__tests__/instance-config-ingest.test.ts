import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eventIngestBatchRows } from "@/lib/instance-config";

const ENV_NAME = "MAISTER_EVENT_INGEST_BATCH_ROWS";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_NAME];
  delete process.env[ENV_NAME];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = saved;
});

describe("eventIngestBatchRows", () => {
  it.each([
    [undefined, 200],
    ["1", 1],
    ["1000", 1000],
  ])("reads %j as %i", (value, expected) => {
    if (value !== undefined) process.env[ENV_NAME] = value;

    expect(eventIngestBatchRows()).toBe(expected);
  });

  it.each(["", "0", "abc", "1001", "01", "1.5", " 200", "-5"])(
    "refuses %j with CONFIG",
    (value) => {
      process.env[ENV_NAME] = value;

      expect(() => eventIngestBatchRows()).toThrow(
        expect.objectContaining({ code: "CONFIG" }),
      );
    },
  );
});
