import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import { parseObservatorySearchParams } from "@/lib/observatory/filters";

describe("observatory page contract", () => {
  it("parses bounded GET filters for portfolio and project routes", () => {
    const parsed = parseObservatorySearchParams({
      artifactDefId: " junit ",
      artifactKind: " log ",
      flowId: " aif ",
      nodeId: ["checks"],
      windowDays: "999",
    });

    expect(parsed.filters).toEqual({
      artifactDefId: "junit",
      artifactKind: "log",
      flowId: "aif",
      nodeId: "checks",
      windowDays: 365,
    });
    expect(parsed.current.artifactKind).toBe("log");
    expect(parsed.current.windowDays).toBe(365);
  });

  it("does not cast invalid artifact kind query values into DB filters", () => {
    const parsed = parseObservatorySearchParams({
      artifactKind: "not_a_kind",
    });

    expect(parsed.filters.artifactKind).toBeUndefined();
    expect(parsed.current.artifactKind).toBe("not_a_kind");
  });

  it("keeps EN and RU observatory message namespaces in parity", () => {
    const flatKeys = (value: Record<string, unknown>, prefix = ""): string[] =>
      Object.entries(value).flatMap(([key, child]) =>
        child && typeof child === "object"
          ? flatKeys(child as Record<string, unknown>, `${prefix}${key}.`)
          : [`${prefix}${key}`],
      );

    expect(flatKeys(en.observatory).sort()).toEqual(
      flatKeys(ru.observatory).sort(),
    );
  });
});
