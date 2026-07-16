import { describe, expect, it } from "vitest";

import { redactEvidenceText } from "@/lib/evaluations/evidence/capture";

describe("redactEvidenceText", () => {
  it("returns text unchanged when there is nothing to redact", () => {
    const result = redactEvidenceText("diff --git a/x b/x\n+const y = 1;\n");

    expect(result.redactions).toBe(0);
    expect(result.kinds).toEqual([]);
    expect(result.text).toContain("const y = 1;");
  });

  it("masks explicit host paths passed by the caller (longest-first)", () => {
    const result = redactEvidenceText(
      "opened /repos/app/web/src/index.ts and /repos/app/web",
      { hostPaths: ["/repos/app/web", "/repos/app/web/src"] },
    );

    expect(result.text).not.toContain("/repos/app/web");
    expect(result.text).toContain("[REDACTED_PATH]");
    expect(result.kinds).toContain("host_path");
    expect(result.redactions).toBeGreaterThanOrEqual(2);
  });

  it("masks generic host filesystem roots even without an explicit path", () => {
    const result = redactEvidenceText(
      "traceback at /Users/alice/secret/project/main.py line 3",
    );

    expect(result.text).not.toContain("/Users/alice");
    expect(result.kinds).toContain("host_path");
  });

  it("masks secret-shaped tokens without mangling ordinary diff content", () => {
    const result = redactEvidenceText(
      [
        "+AWS_KEY=AKIAIOSFODNN7EXAMPLE",
        "+api_key: sk-abcdefghijklmnopqrstuvwx",
        '+const authorization = "Bearer aabbccddeeff00112233445566778899";',
        "+const total = additions + deletions;",
      ].join("\n"),
    );

    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(result.text).toContain("[REDACTED_SECRET]");
    // Ordinary code is preserved.
    expect(result.text).toContain("const total = additions + deletions;");
    expect(result.kinds).toContain("aws_access_key");
    expect(result.redactions).toBeGreaterThanOrEqual(3);
  });
});
