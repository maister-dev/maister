import { describe, expect, it } from "vitest";

import { deriveRepoNameSafe } from "@/lib/repo-name";

// deriveRepoNameSafe is the client-safe core of repo-source.ts deriveRepoName:
// same segment/regex logic, but returns null instead of throwing so the
// Add-project form can prefill the name field without importing the
// `server-only` + node:* repo-source module.
describe("deriveRepoNameSafe", () => {
  const valid: Array<[string, string]> = [
    ["git@github.com:org/repo.git", "repo"],
    ["https://gitlab.com/grp/sub/app.git", "app"],
    ["https://github.com/org/repo", "repo"],
    ["git@github.com:org/my-repo.name_1.git", "my-repo.name_1"],
    ["ssh://git@host:22/org/svc.git", "svc"],
    ["git@gitverse.ru:kaa/beauty-ai.git", "beauty-ai"],
  ];

  for (const [url, name] of valid) {
    it(`derives ${name} from ${url}`, () => {
      expect(deriveRepoNameSafe(url)).toBe(name);
    });
  }

  const nullish: Array<[string, string]> = [
    ["trailing slash → empty segment", "https://github.com/org/"],
    ["dot-dot segment", "https://github.com/org/.."],
    ["single-dot segment", "https://github.com/org/."],
    ["garbage with spaces", "not a url"],
    ["empty string", ""],
  ];

  for (const [label, url] of nullish) {
    it(`returns null for ${label}`, () => {
      expect(deriveRepoNameSafe(url)).toBeNull();
    });
  }
});
