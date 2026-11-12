import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { runtimeFileUrl, runtimePathUrl } from "@/lib/runtime-file-url";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("reads and removes live host files with literal URL-special characters", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maister-runtime-files-"));

  directories.push(root);
  const directory = path.join(root, "space # % ? каталог");

  await mkdir(directory);
  const file = runtimePathUrl(directory, "proof #%.txt");

  await writeFile(file, "runtime evidence");

  expect(fileURLToPath(file)).toBe(path.join(directory, "proof #%.txt"));
  expect(await readFile(runtimeFileUrl(fileURLToPath(file)), "utf8")).toBe(
    "runtime evidence",
  );
  await rm(file);
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects relative roots before filesystem access", () => {
  expect(() => runtimeFileUrl("private/evidence")).toThrow("absolute path");
  expect(() => runtimePathUrl("private", "evidence")).toThrow("absolute path");
});
