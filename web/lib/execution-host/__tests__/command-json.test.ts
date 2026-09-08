import { expect, it } from "vitest";

import {
  canonicalCommandJson,
  CommandJsonError,
} from "../../../../runtime/command-json";

it("canonicalizes request data with UTF-16 key ordering and unchanged array order", () => {
  const source = {
    z: [3, { beta: "é", alpha: "e\u0301" }, 1],
    "\uffff": true,
    "😀": false,
    a: -0,
  };

  expect(canonicalCommandJson(source)).toBe(
    '{"a":0,"z":[3,{"alpha":"é","beta":"é"},1],"😀":false,"￿":true}',
  );
  expect(canonicalCommandJson({ value: 1e30 })).toBe('{"value":1e+30}');
  expect(source.z[0]).toBe(3);
});

it("refuses non-JSON values and invalid Unicode without exposing their content", () => {
  for (const value of [
    NaN,
    Infinity,
    undefined,
    [undefined],
    new Date(),
    "private-input-\ud800",
    { "\udfff": true },
  ]) {
    expect(() => canonicalCommandJson(value)).toThrow(CommandJsonError);
    try {
      canonicalCommandJson(value);
    } catch (error) {
      expect(String(error)).not.toContain("private-input");
    }
  }
  const cyclic: { self?: unknown } = {};

  cyclic.self = cyclic;
  expect(() => canonicalCommandJson(cyclic)).toThrow(CommandJsonError);
});
