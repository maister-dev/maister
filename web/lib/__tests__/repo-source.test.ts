import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors";
import {
  cloneRepo,
  deriveRepoName,
  detectProvider,
  gitInit,
  isGitRepo,
  readRemoteOrigin,
  redactUrl,
  resolveProjectSource,
} from "@/lib/repo-source";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
}

// Build a local bare repo with one seeded commit; returns the bare repo path.
async function seedBareRepo(
  root: string,
  name: string,
  seedFile: string,
  seedContent: string,
): Promise<string> {
  const work = join(root, `${name}-work`);
  const bare = join(root, `${name}.git`);

  await mkdir(work, { recursive: true });
  git(work, "init");
  await writeFile(join(work, seedFile), seedContent);
  git(work, "add", ".");
  git(
    work,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "seed",
  );
  git(root, "clone", "--bare", work, bare);

  return bare;
}

describe("detectProvider", () => {
  const cases: Array<[string, string]> = [
    ["git@github.com:org/repo.git", "github"],
    ["https://github.com/org/repo.git", "github"],
    ["git@gitlab.com:grp/app.git", "gitlab"],
    ["https://gitlab.example.com/grp/app.git", "gitlab"],
    ["git@gitverse.ru:org/repo.git", "gitverse"],
    ["https://gitverse.ru/org/repo.git", "gitverse"],
    ["git@gitea.example.org:org/repo.git", "gitea"],
    ["https://gitea.internal/org/repo.git", "gitea"],
    ["git@example.com:org/repo.git", "generic"],
    ["https://example.com/org/repo.git", "generic"],
    ["ssh://git@github.com:22/org/repo.git", "github"],
    ["https://GITHUB.COM/org/repo.git", "github"],
  ];

  for (const [url, provider] of cases) {
    it(`maps ${url} -> ${provider}`, () => {
      expect(detectProvider(url)).toBe(provider);
    });
  }
});

describe("deriveRepoName", () => {
  const cases: Array<[string, string]> = [
    ["git@github.com:org/repo.git", "repo"],
    ["https://gitlab.com/grp/sub/app.git", "app"],
    ["https://github.com/org/repo", "repo"],
    ["git@github.com:org/my-repo.name_1.git", "my-repo.name_1"],
  ];

  for (const [url, name] of cases) {
    it(`derives ${name} from ${url}`, () => {
      expect(deriveRepoName(url)).toBe(name);
    });
  }

  it("throws PRECONDITION when the URL yields '..'", () => {
    try {
      deriveRepoName("https://github.com/org/..");
      throw new Error("expected throw");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("PRECONDITION");
    }
  });

  it("throws PRECONDITION when the URL yields an empty name", () => {
    try {
      deriveRepoName("https://github.com/org/");
      throw new Error("expected throw");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("PRECONDITION");
    }
  });
});

describe("redactUrl", () => {
  it("redacts a password in scheme://user:password@host", () => {
    expect(
      redactUrl("https://x-access-token:TOKEN@github.com/org/repo.git"),
    ).toBe("https://x-access-token:***@github.com/org/repo.git");
  });

  it("leaves a bare git@host untouched (no secret)", () => {
    expect(redactUrl("git@github.com:org/repo.git")).toBe(
      "git@github.com:org/repo.git",
    );
  });

  it("leaves a password-free https URL untouched", () => {
    expect(redactUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
  });

  it("redacts a token embedded mid-string (git stderr blob)", () => {
    const stderr =
      "fatal: repository 'https://x-access-token:ghp_SECRET@github.com/org/repo.git' not found";

    const out = redactUrl(stderr);

    expect(out).not.toContain("ghp_SECRET");
    expect(out).toContain("x-access-token:***@github.com");
  });
});

describe("git helpers", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repo-source-git-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("isGitRepo is false on a plain dir, true after gitInit", async () => {
    const dir = join(root, "plain");

    await mkdir(dir, { recursive: true });
    expect(await isGitRepo(dir)).toBe(false);

    await gitInit(dir);
    expect(await isGitRepo(dir)).toBe(true);
  });

  it("readRemoteOrigin returns null with no origin, the URL once added", async () => {
    const dir = join(root, "repo");

    await mkdir(dir, { recursive: true });
    await gitInit(dir);
    expect(await readRemoteOrigin(dir)).toBeNull();

    git(dir, "remote", "add", "origin", "https://example.com/org/repo.git");
    expect(await readRemoteOrigin(dir)).toBe(
      "https://example.com/org/repo.git",
    );
  });

  it("cloneRepo never leaks an embedded token into the error message", async () => {
    // 127.0.0.1:1 refuses instantly — offline, deterministic, no network.
    const url = "https://x-access-token:ghp_SECRET@127.0.0.1:1/org/repo.git";

    try {
      await cloneRepo({ url, target: join(root, "refused") });
      throw new Error("expected cloneRepo to fail");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("PRECONDITION");
      expect((err as Error).message).not.toContain("ghp_SECRET");
    }
  });

  it("cloneRepo clones a local bare repo via file:// into the target", async () => {
    const bare = await seedBareRepo(root, "src", "README.md", "hello\n");
    const target = join(root, "cloned");

    await cloneRepo({ url: `file://${bare}`, target });

    expect(await pathExists(target)).toBe(true);
    expect(await pathExists(join(target, "README.md"))).toBe(true);
  });
});

describe("resolveProjectSource", () => {
  let root: string;
  let reposDir: string;
  let savedReposRoot: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repo-source-resolve-"));
    reposDir = join(root, "repos-root");
    savedReposRoot = process.env.MAISTER_REPOS_ROOT;
    process.env.MAISTER_REPOS_ROOT = reposDir;
  });

  afterEach(async () => {
    if (savedReposRoot === undefined) delete process.env.MAISTER_REPOS_ROOT;
    else process.env.MAISTER_REPOS_ROOT = savedReposRoot;
    await rm(root, { recursive: true, force: true });
  });

  it("clone mode: clones a local bare repo under reposRoot", async () => {
    const bare = await seedBareRepo(
      root,
      "proj",
      "maister.yaml",
      "schemaVersion: 2\n",
    );

    const result = await resolveProjectSource({
      repoUrl: `file://${bare}`,
      target: "myapp",
    });

    expect(result.dir).toBe(join(reposDir, "myapp"));
    expect(result.repoUrl).toBe(`file://${bare}`);
    expect(result.provider).toBe("generic");
    expect(result.gitStatus).toBe("remote");
    expect(result.clonedByUs).toBe(true);
    expect(await pathExists(join(result.dir, "maister.yaml"))).toBe(true);
  });

  it("clone mode: throws PRECONDITION when the target path already exists", async () => {
    const bare = await seedBareRepo(root, "proj2", "f.txt", "x\n");
    const existing = join(reposDir, "taken");

    await mkdir(existing, { recursive: true });

    try {
      await resolveProjectSource({
        repoUrl: `file://${bare}`,
        target: "taken",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("PRECONDITION");
    }
  });

  it("clone mode: removes the partial target when the clone fails", async () => {
    // file:// to a nonexistent bare repo → clone fails; the partial target
    // dir must not be left behind under reposRoot.
    try {
      await resolveProjectSource({
        repoUrl: "file:///nonexistent/maister-missing.git",
        target: "willfail",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("PRECONDITION");
    }

    expect(await pathExists(join(reposDir, "willfail"))).toBe(false);
  });

  it("existing-local with origin: back-fills repoUrl and provider", async () => {
    const dir = join(root, "local-with-origin");

    await mkdir(dir, { recursive: true });
    git(dir, "init");
    git(dir, "remote", "add", "origin", "git@github.com:org/repo.git");

    const result = await resolveProjectSource({ target: dir });

    expect(result.dir).toBe(dir);
    expect(result.repoUrl).toBe("git@github.com:org/repo.git");
    expect(result.provider).toBe("github");
    expect(result.gitStatus).toBe("remote");
    expect(result.clonedByUs).toBe(false);
  });

  it("existing-local non-git: reports initialized WITHOUT mutating (init deferred to route)", async () => {
    const dir = join(root, "non-git");

    await mkdir(dir, { recursive: true });

    const result = await resolveProjectSource({ target: dir });

    expect(result.dir).toBe(dir);
    expect(result.repoUrl).toBeNull();
    expect(result.provider).toBeNull();
    expect(result.gitStatus).toBe("initialized");
    expect(result.clonedByUs).toBe(false);
    // resolveProjectSource must NOT have run git init — the route does it only
    // after the manifest validates and the registration is committed.
    expect(await isGitRepo(dir)).toBe(false);
  });

  it("existing-local git with no remote: reports no-remote", async () => {
    const dir = join(root, "git-no-remote");

    await mkdir(dir, { recursive: true });
    git(dir, "init");

    const result = await resolveProjectSource({ target: dir });

    expect(result.dir).toBe(dir);
    expect(result.repoUrl).toBeNull();
    expect(result.provider).toBeNull();
    expect(result.gitStatus).toBe("no-remote");
    expect(result.clonedByUs).toBe(false);
  });

  it("throws PRECONDITION when neither repoUrl nor target is given", async () => {
    try {
      await resolveProjectSource({});
      throw new Error("expected throw");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("PRECONDITION");
    }
  });

  it("throws PRECONDITION when target directory is not found (no repoUrl)", async () => {
    try {
      await resolveProjectSource({ target: join(root, "does-not-exist") });
      throw new Error("expected throw");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("PRECONDITION");
    }
  });
});
