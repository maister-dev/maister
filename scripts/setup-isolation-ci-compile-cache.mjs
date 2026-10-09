import { spawnSync } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdtemp,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

class CompileCacheSetupError extends Error {
  name = "CompileCacheSetupError";
}

function assertSingleLinePath(value, name) {
  if (/[\r\n]/u.test(value))
    throw new CompileCacheSetupError(`${name} must not contain CR or LF`);
  if (!isAbsolute(value))
    throw new CompileCacheSetupError(`${name} must be an absolute path`);

  return value;
}

function requiredPath(name) {
  const value = process.env[name];

  if (!value) throw new CompileCacheSetupError(`${name} is required`);

  return assertSingleLinePath(value, name);
}

function assertContainedDirectory(root, directory) {
  const location = relative(root, directory);

  if (
    !location ||
    location === ".." ||
    location.startsWith(`..${sep}`) ||
    isAbsolute(location)
  )
    throw new CompileCacheSetupError(
      "compile cache witness directory must remain inside the fresh private cache",
    );
}

async function persistedCache(directory) {
  const counts = { files: 0, bytes: 0 };

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      const nested = await persistedCache(path);

      counts.files += nested.files;
      counts.bytes += nested.bytes;
    } else if (entry.isFile()) {
      counts.files += 1;
      counts.bytes += (await stat(path)).size;
    } else {
      throw new CompileCacheSetupError(
        "compile cache persistence contains a non-regular entry",
      );
    }
  }

  return counts;
}

async function prepareCompileCache() {
  const githubEnv = requiredPath("GITHUB_ENV");
  const runnerTemp = assertSingleLinePath(
    await realpath(requiredPath("RUNNER_TEMP")),
    "canonical RUNNER_TEMP",
  );
  const cacheRoot = assertSingleLinePath(
    await mkdtemp(join(runnerTemp, "maister-node-compile-cache-")),
    "compile cache path",
  );

  await chmod(cacheRoot, 0o700);
  const runtimeModule = new URL("../runtime/node-version.ts", import.meta.url)
    .href;
  const source = `
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { constants, enableCompileCache, getCompileCacheDir } from "node:module";
import { isAbsolute, relative, sep } from "node:path";

const initial = getCompileCacheDir();

assert(initial, "initial compile cache directory is unavailable; inherited NODE_DISABLE_COMPILE_CACHE must permit caching");
const directory = realpathSync(initial);
const location = relative(${JSON.stringify(cacheRoot)}, directory);

assert(location && location !== ".." && !location.startsWith(".." + sep) && !isAbsolute(location), "initial compile cache directory escaped the fresh private cache");
const result = enableCompileCache();

assert.equal(result.status, constants.compileCacheStatus.ALREADY_ENABLED, "compile cache must be enabled by the inherited NODE_COMPILE_CACHE");
assert.equal(realpathSync(result.directory), directory);
const { assertSupportedNode } = await import(${JSON.stringify(runtimeModule)});

assertSupportedNode(process.versions.node);
process.stdout.write(JSON.stringify({ pid: process.pid, node: process.versions.node, directory, status: "ALREADY_ENABLED", runtimeModule: ${JSON.stringify(runtimeModule)} }) + "\\n");
`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, NODE_COMPILE_CACHE: cacheRoot },
    },
  );

  if (child.error || child.status !== 0)
    throw new CompileCacheSetupError(
      `compile cache witness failed: node=${process.versions.node}, status=${child.status}, signal=${child.signal}; ${child.stderr.trim()}`,
      { cause: child.error },
    );
  const witness = JSON.parse(child.stdout);
  const cacheDirectory = assertSingleLinePath(
    await realpath(witness.directory),
    "compile cache witness path",
  );

  assertContainedDirectory(cacheRoot, cacheDirectory);
  if (
    witness.node !== process.versions.node ||
    witness.status !== "ALREADY_ENABLED" ||
    witness.runtimeModule !== runtimeModule
  )
    throw new CompileCacheSetupError(
      "compile cache witness does not match the selected Node and runtime module",
    );
  const persisted = await persistedCache(cacheDirectory);

  if (persisted.files === 0 || persisted.bytes === 0)
    throw new CompileCacheSetupError(
      "compile cache witness exited without persisting compiled runtime modules",
    );
  await appendFile(githubEnv, `NODE_COMPILE_CACHE=${cacheRoot}\n`, "utf8");
  process.stdout.write(
    JSON.stringify({
      event: "isolation-node-compile-cache-ready",
      node: witness.node,
      childPid: witness.pid,
      cacheRoot,
      cacheDirectory,
      cacheStatus: witness.status,
      cacheFiles: persisted.files,
      cacheBytes: persisted.bytes,
      runtimeModule,
    }) + "\n",
  );
}

await prepareCompileCache();
