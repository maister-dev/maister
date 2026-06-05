import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import { describe, expect, it } from "vitest";

import { parseObservatorySearchParams } from "@/lib/observatory/filters";

describe("observatory page contract", () => {
  it("parses bounded GET filters for portfolio and project routes", () => {
    const parsed = parseObservatorySearchParams({
      flowId: " aif ",
      nodeId: ["checks"],
      windowDays: "999",
    });

    expect(parsed.filters).toEqual({
      flowId: "aif",
      nodeId: "checks",
      windowDays: 365,
    });
    expect(parsed.current.windowDays).toBe(365);
  });

  it("keeps EN and RU observatory message namespaces in parity", () => {
    expect(Object.keys(en.observatory).sort()).toEqual(
      Object.keys(ru.observatory).sort(),
    );
    expect(Object.keys(en.observatory.kind).sort()).toEqual(
      Object.keys(ru.observatory.kind).sort(),
    );
  });
});
