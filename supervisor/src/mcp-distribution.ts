import type { McpDistribution } from "../../runtime/mcp-distribution";
import type { ReasonToken, SupervisorErrorDetails } from "./types";

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, posix, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import pino from "pino";
import { Parser } from "tar";
import { z } from "zod";

import { isMcpDistribution } from "../../runtime/mcp-distribution";

import { SupervisorError } from "./types";

const satisfiesNode: (version: string, range: string) => boolean =
  createRequire(import.meta.url)("semver/functions/satisfies");
const installerInstance = randomUUID();
const maxArchiveBytes = 16 * 1024 * 1024;
const maxUnpackedBytes = 64 * 1024 * 1024;
const maxOtherStageReclaims = 16;
const stagedDirectoryPattern =
  /^([a-f0-9]{64})\.stage-(\d+)-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})-[A-Za-z0-9]{6}$/;
const log = pino({
  name: "mcp-install",
  level: process.env.LOG_LEVEL ?? "info",
});
const installing = new Map<string, Promise<PreparedMcp>>();

type PreparedMcp = { entry: string; cacheHit: boolean };
type PrepareOptions = {
  cacheRoot: string;
  allowedDigests: readonly string[];
  assertCurrent: () => void;
  fetchArchive?: (distribution: McpDistribution) => Promise<Uint8Array>;
};

function refusal(
  reason: ReasonToken,
  message: string,
  context?: Pick<SupervisorErrorDetails, "artifactDigest">,
): SupervisorError {
  const details = { reason, ...context };

  log.warn(details, "MCP distribution refused");

  return new SupervisorError("PRECONDITION", message, { details });
}

function safeRelative(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 1024 &&
    !/[\\:\x00-\x1f]/.test(name) &&
    name === posix.normalize(name) &&
    !posix.isAbsolute(name) &&
    name
      .split("/")
      .every((part) => part !== "." && part !== ".." && part !== "")
  );
}

async function archiveBytes(d: McpDistribution): Promise<Uint8Array> {
  const name = d.packageName.split("/").at(-1)!;
  const url =
    "https://registry.npmjs.org/" +
    d.packageName +
    "/-/" +
    name +
    "-" +
    d.version +
    ".tgz";

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 429 || res.status >= 500)
          throw new Error("registry returned " + res.status);
        throw refusal(
          "mcp_distribution_unsupported",
          "npm registry returned " +
            res.status +
            " for the pinned distribution",
        );
      }
      if (!res.body) throw new Error("registry returned no archive");
      const reader = res.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];

      try {
        for (;;) {
          const result = await reader.read();

          if (result.done) break;
          size += result.value.length;
          if (size > maxArchiveBytes) {
            await reader.cancel();
            throw refusal(
              "mcp_distribution_unsupported",
              "npm archive exceeds size limit",
            );
          }
          chunks.push(result.value);
        }
      } finally {
        reader.releaseLock();
      }

      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof SupervisorError) throw error;
      if (attempt >= 3)
        throw new SupervisorError(
          "EXECUTOR_UNAVAILABLE",
          "Failed to fetch the pinned npm release after three attempts",
          { cause: error },
        );
      log.warn(
        { attempt, digest: d.artifactDigest },
        "retrying pinned npm artifact fetch",
      );
      await new Promise((done) => setTimeout(done, attempt * 200));
    }
  }
}

async function unpack(
  bytes: Uint8Array,
  d: McpDistribution,
): Promise<Map<string, Buffer>> {
  if (
    bytes.length > maxArchiveBytes ||
    "sha512-" + createHash("sha512").update(bytes).digest("base64") !==
      d.integrity
  )
    throw refusal(
      "mcp_distribution_integrity",
      "Pinned npm archive integrity check failed",
    );
  let tar: Buffer;

  try {
    tar = gunzipSync(bytes, { maxOutputLength: maxUnpackedBytes });
  } catch {
    throw refusal(
      "mcp_distribution_unsupported",
      "Pinned MCP archive exceeds the decompression limit or is not gzip",
    );
  }
  const files = new Map<string, Buffer>();
  const seen = new Set<string>();
  const parser = new Parser({ strict: true });

  await new Promise<void>((ok, fail) => {
    parser.on("error", (error: unknown) =>
      fail(
        error instanceof SupervisorError
          ? error
          : refusal(
              "mcp_distribution_unsupported",
              "MCP tar directory is malformed",
            ),
      ),
    );
    parser.on("end", ok);
    parser.on("entry", (entry) => {
      const full = entry.path.replace(/\/$/, "");
      const file = full.slice("package/".length);
      const directory = entry.type === "Directory";

      if (
        (!directory && entry.type !== "File") ||
        (full !== "package" && !full.startsWith("package/")) ||
        (full === "package" ? !directory : !safeRelative(file)) ||
        seen.has(full.toLowerCase()) ||
        seen.size >= 2048
      ) {
        parser.abort(
          refusal(
            "mcp_distribution_unsupported",
            "npm archive has unsupported or duplicate member",
          ),
        );

        return;
      }
      seen.add(full.toLowerCase());
      if (directory) {
        entry.resume();

        return;
      }
      const parts: Buffer[] = [];

      entry.on("data", (chunk: Buffer) => parts.push(chunk));
      entry.on("end", () => files.set(file, Buffer.concat(parts)));
    });
    parser.end(tar);
  });

  return files;
}

const packageSchema = z.object({
  name: z.string(),
  version: z.string(),
  mcpName: z.string(),
  license: z.string().min(1),
  bin: z.union([z.string(), z.record(z.string(), z.string())]),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  engines: z.object({ node: z.string().optional() }).optional(),
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
});

function entryPath(files: Map<string, Buffer>, d: McpDistribution): string {
  const json = files.get("package.json");

  if (!json)
    throw refusal(
      "mcp_distribution_unsupported",
      "npm archive lacks package.json",
    );
  let pkg: z.infer<typeof packageSchema>;

  try {
    pkg = packageSchema.parse(JSON.parse(json.toString("utf8")) as unknown);
  } catch {
    throw refusal(
      "mcp_distribution_unsupported",
      "MCP archive manifest must name its publisher, license and executable",
    );
  }
  if (
    pkg.name !== d.packageName ||
    pkg.version !== d.version ||
    pkg.mcpName !== d.registryName
  )
    throw refusal(
      "mcp_distribution_integrity",
      "npm publisher, name or version differs from reviewed metadata",
    );
  if (
    [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies].some(
      (deps) => Object.keys(deps ?? {}).length > 0,
    ) ||
    ["preinstall", "install", "postinstall"].some((hook) =>
      Object.hasOwn(pkg.scripts ?? {}, hook),
    ) ||
    [...files.keys()].some(
      (path) => path.includes("node_modules/") || path.endsWith(".node"),
    )
  )
    throw refusal(
      "mcp_distribution_unsupported",
      "Only self-contained npm distributions without install hooks are supported",
    );
  if (
    pkg.engines?.node &&
    !satisfiesNode(process.versions.node, pkg.engines.node)
  )
    throw refusal(
      "mcp_distribution_runtime",
      "The assigned Node runtime does not satisfy this npm distribution",
    );
  for (const [values, current] of [
    [pkg.os, process.platform],
    [pkg.cpu, process.arch],
  ] as const) {
    if (
      values &&
      (values.includes("!" + current) ||
        (values.some((v) => !v.startsWith("!")) && !values.includes(current)))
    )
      throw refusal(
        "mcp_distribution_runtime",
        "This npm distribution cannot run on this host",
      );
  }
  const bin =
    typeof pkg.bin === "string"
      ? d.executable === basename(pkg.name)
        ? pkg.bin
        : undefined
      : Object.hasOwn(pkg.bin, d.executable)
        ? pkg.bin[d.executable]
        : undefined;
  const path = bin?.replace(/^\.\//, "");

  if (
    !path ||
    !safeRelative(path) ||
    !files.has(path) ||
    !(
      /\.[cm]?js$/.test(path) ||
      files
        .get(path)!
        .subarray(0, 32)
        .toString()
        .startsWith("#!/usr/bin/env node")
    )
  )
    throw refusal(
      "mcp_distribution_unsupported",
      "Reviewed npm executable must be a packaged JavaScript entry",
    );

  return path;
}

async function verifyTree(
  dir: string,
  files: Map<string, Buffer>,
  prefix = "",
): Promise<number> {
  let count = 0;

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;

    if (entry.isDirectory()) {
      count += await verifyTree(join(dir, entry.name), files, rel + "/");
      continue;
    }
    const expected = files.get(rel);

    if (
      !entry.isFile() ||
      !expected ||
      !(await readFile(join(dir, entry.name))).equals(expected)
    )
      throw refusal(
        "mcp_distribution_integrity",
        "Installed MCP tree differs from the reviewed artifact",
      );
    count++;
  }

  return count;
}

function stageOwnerIsLive(pid: number, instance: string): boolean {
  if (pid === process.pid) return instance === installerInstance;
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}

/** A cold install also reclaims a bounded number of stages for other digests in its runtime cache. */
async function reclaimDeadStages(
  parent: string,
  digest: string,
): Promise<void> {
  let otherReclaimed = 0;

  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = stagedDirectoryPattern.exec(entry.name);

    if (!match) continue;
    const [, artifactDigest, pidText, instance] = match;
    const other = artifactDigest !== digest;
    const pid = Number(pidText);

    if (other && otherReclaimed >= maxOtherStageReclaims) continue;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) continue;
    if (stageOwnerIsLive(pid, instance)) continue;

    await rm(join(parent, entry.name), { recursive: true, force: true });
    if (other) otherReclaimed++;
    log.debug({ artifactDigest, pid }, "Reclaimed dead MCP installation stage");
  }
}

async function install(
  d: McpDistribution,
  options: PrepareOptions,
  dest: string,
): Promise<PreparedMcp> {
  const archive = join(dest, "archive.tgz");
  const info = await lstat(dest).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  if (
    info &&
    (!info.isDirectory() ||
      !(await lstat(archive)).isFile() ||
      !(await lstat(join(dest, "package"))).isDirectory())
  )
    throw refusal(
      "mcp_distribution_integrity",
      "MCP cache entry has an invalid owner layout",
    );
  const bytes = info
    ? await readFile(archive)
    : await (options.fetchArchive ?? archiveBytes)(d);
  const files = await unpack(bytes, d);
  const executable = entryPath(files, d);

  if (info) {
    if ((await verifyTree(join(dest, "package"), files)) !== files.size)
      throw refusal(
        "mcp_distribution_integrity",
        "Installed MCP tree is incomplete",
      );
  } else {
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await reclaimDeadStages(dirname(dest), d.artifactDigest);
    const stage = await mkdtemp(
      join(
        dirname(dest),
        d.artifactDigest +
          ".stage-" +
          process.pid +
          "-" +
          installerInstance +
          "-",
      ),
    );

    try {
      await writeFile(join(stage, "archive.tgz"), bytes, { mode: 0o600 });
      for (const [name, content] of files) {
        const target = join(stage, "package", name);

        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { flag: "wx", mode: 0o600 });
      }
      options.assertCurrent();
      try {
        await rename(stage, dest);
      } catch (error) {
        if (
          !["ENOTEMPTY", "EEXIST"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;

        return await install(d, options, dest);
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  return { entry: join(dest, "package", executable), cacheHit: !!info };
}

export async function prepareMcpDistribution(
  d: McpDistribution,
  options: PrepareOptions,
): Promise<PreparedMcp> {
  if (!isMcpDistribution(d))
    throw refusal(
      "mcp_distribution_unsupported",
      "Malformed npm MCP descriptor",
    );
  const identity = JSON.stringify([
    d.registryName,
    d.packageName,
    d.version,
    d.integrity,
    d.executable,
  ]);

  if (createHash("sha256").update(identity).digest("hex") !== d.artifactDigest)
    throw refusal(
      "mcp_distribution_integrity",
      "MCP descriptor digest differs from its pinned tuple",
    );
  if (!options.allowedDigests.includes(d.artifactDigest))
    throw refusal(
      "mcp_distribution_untrusted",
      `Approve reviewed MCP descriptor ${d.artifactDigest} in MAISTER_MCP_ALLOWED_DIGESTS on this host`,
      { artifactDigest: d.artifactDigest },
    );
  options.assertCurrent();
  const dest = join(
    resolve(options.cacheRoot),
    process.platform + "-" + process.arch + "-" + process.version,
    d.artifactDigest,
  );
  const pending = installing.get(dest);

  if (pending) {
    await pending;
    options.assertCurrent();

    return install(d, options, dest);
  }
  const work = install(d, options, dest);

  installing.set(dest, work);
  try {
    const result = await work;

    options.assertCurrent();
    log.info(
      {
        artifactDigest: d.artifactDigest,
        cacheHit: result.cacheHit,
        platform: process.platform,
        arch: process.arch,
      },
      "MCP distribution prepared",
    );

    return result;
  } finally {
    installing.delete(dest);
  }
}
