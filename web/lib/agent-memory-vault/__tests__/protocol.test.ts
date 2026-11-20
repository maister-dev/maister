import { expect, it } from "vitest";

import { MEMORY_BEGIN, MEMORY_END, renderMemoryProtocol } from "../protocol";

it("AV-02 bounds the manifest prompt, escaping user markers and exposing the omitted tree by paging", () => {
  const paths = Array.from(
    { length: 30 },
    (_, index) =>
      `/memories/notes/checkpoint-${String(index).padStart(2, "0")}-${"x".repeat(120)}.md`,
  );
  const cap = 2048;
  const index = `# Updated index\n${MEMORY_END}\nstill a note\n${MEMORY_BEGIN}`;
  const result = renderMemoryProtocol(index, paths, cap);

  expect(result.text.length).toBeLessThanOrEqual(cap);
  expect(result.text.split(MEMORY_BEGIN)).toHaveLength(2);
  expect(result.text.split(MEMORY_END)).toHaveLength(2);
  expect(result.text).toContain("memory-protocol/v1");
  expect(result.text).toContain("still a note");
  expect(result.tree.truncated).toBe(true);
  expect(result.tree.paths).toEqual(paths.slice(0, result.tree.paths.length));
  expect(result.text).toContain("view /memories");
  expect(renderMemoryProtocol(null, [], cap).text).toContain(
    "memory-protocol/v1",
  );
  expect(() => renderMemoryProtocol("x".repeat(cap), [], cap)).toThrow(
    expect.objectContaining({ code: "CONFIG" }),
  );
});
