import type { Invocation } from "./process-invocation";
import type { LinuxIsolationPolicy } from "./linux-isolation";

import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  IsolationPolicyError,
  linuxRuntimePaths,
  prepareLinuxIsolationPolicy,
} from "./linux-isolation";

const WEB_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPOSITORY_DIRECTORY = path.dirname(WEB_DIRECTORY);

function publicDirectory(): readonly string[] {
  const directory = path.join(WEB_DIRECTORY, "public");

  try {
    if (!lstatSync(directory).isDirectory())
      throw new IsolationPolicyError(
        "public application tree is not a directory",
      );

    return [directory];
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new IsolationPolicyError("public application tree is unavailable", {
      cause,
    });
  }
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function traceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);

    if (entry.isDirectory()) return traceFiles(candidate);

    return entry.isFile() && entry.name.endsWith(".nft.json")
      ? [candidate]
      : [];
  });
}

function traceInputs(buildDirectory: string): readonly string[] {
  const traces = traceFiles(buildDirectory);

  if (!traces.length)
    throw new IsolationPolicyError(
      "production build has no executable dependency traces",
    );

  return [
    ...new Set(
      traces.flatMap((trace) => {
        const value: unknown = JSON.parse(readFileSync(trace, "utf8"));

        if (
          typeof value !== "object" ||
          value === null ||
          !("files" in value) ||
          !Array.isArray(value.files) ||
          !value.files.every((file) => typeof file === "string")
        )
          throw new IsolationPolicyError(
            "production dependency trace has an invalid file inventory",
          );

        return (value.files as string[]).map((file) =>
          path.resolve(path.dirname(trace), file),
        );
      }),
    ),
  ];
}

function dependencyLinks(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);

    if (entry.isDirectory() && entry.name.startsWith("@"))
      return dependencyLinks(candidate);

    return entry.isSymbolicLink() ? [candidate] : [];
  });
}

/** Follows the installed pnpm dependency links, retaining only required package trees. */
function packageDirectories(
  inputs: readonly string[],
  store: string,
): readonly string[] {
  const selected = new Set<string>();
  const pending = [...inputs];

  while (pending.length) {
    const candidate = realpathSync(pending.pop()!);

    if (!within(store, candidate))
      throw new IsolationPolicyError(
        "production package dependency escapes the installed virtual store",
      );
    const packageName = path.relative(store, candidate).split(path.sep)[0];
    const directory = path.join(store, packageName, "node_modules");

    if (!packageName || !within(directory, candidate))
      throw new IsolationPolicyError(
        "unsupported pnpm virtual-store dependency layout",
      );
    if (selected.has(directory)) continue;
    selected.add(directory);
    pending.push(...dependencyLinks(directory));
  }

  return [...selected];
}

export type LinuxWebPolicyInput = Readonly<{
  invocation: Invocation;
  deniedRoots: readonly string[];
  writableRoots: readonly string[];
  protectedFiles: readonly Readonly<{ path: string; optional?: boolean }>[];
}>;

/** Builds the production view from the fresh build and installed dependency graph. */
export async function prepareLinuxWebPolicy(
  input: LinuxWebPolicyInput,
): Promise<LinuxIsolationPolicy> {
  const buildDirectory = path.join(WEB_DIRECTORY, ".next");
  const store = realpathSync(
    path.join(REPOSITORY_DIRECTORY, "node_modules", ".pnpm"),
  );
  const runtimeInputs = traceInputs(buildDirectory);
  const moduleDirectory = path.join(WEB_DIRECTORY, "node_modules");
  const entryLinks = ["next", "pino", "tsx", "next-intl"].map((name) =>
    path.join(moduleDirectory, name),
  );
  const packages = packageDirectories(
    [
      ...entryLinks,
      ...runtimeInputs
        .map((file) => realpathSync(file))
        .filter((file) => within(store, file)),
    ],
    store,
  );
  const links = dependencyLinks(moduleDirectory).filter((link) =>
    packages.some((directory) => within(directory, realpathSync(link))),
  );

  for (const file of runtimeInputs) {
    const canonical = realpathSync(file);

    if (
      !within(REPOSITORY_DIRECTORY, file) ||
      !within(REPOSITORY_DIRECTORY, canonical) ||
      [file, canonical].some((candidate) =>
        /(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.git(?:\/|$)/u.test(candidate),
      )
    )
      throw new IsolationPolicyError(
        "production trace exports material outside approved application sources",
      );
  }
  const sourceTrees = [
    "app",
    "lib",
    "components",
    "config",
    "i18n",
    "styles",
    "types",
  ]
    .map((directory) => path.join(WEB_DIRECTORY, directory))
    .filter((directory) =>
      runtimeInputs.some((file) => within(directory, file)),
    );
  const sources = [
    buildDirectory,
    ...sourceTrees,
    ...publicDirectory(),
    path.join(REPOSITORY_DIRECTORY, "runtime"),
    ...[
      "server.ts",
      "lib/server-lifecycle.ts",
      "next.config.mjs",
      "package.json",
      "tsconfig.json",
      "i18n/request.ts",
    ].map((file) => path.join(WEB_DIRECTORY, file)),
    path.join(REPOSITORY_DIRECTORY, "package.json"),
    ...runtimeInputs.filter(
      (file) =>
        !within(buildDirectory, file) &&
        !within(store, realpathSync(file)) &&
        !sourceTrees.some((directory) => within(directory, file)),
    ),
  ];

  for (const source of sources) {
    if (
      !within(REPOSITORY_DIRECTORY, source) ||
      /(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.git(?:\/|$)/u.test(source)
    )
      throw new IsolationPolicyError(
        "production trace exports material outside approved application sources",
      );
  }
  const nativeModules = runtimeInputs.filter((file) => file.endsWith(".node"));
  const operatingSystemInputs = [
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/localtime",
    "/usr/lib/git-core",
    ...linuxRuntimePaths([
      process.execPath,
      "/usr/bin/git",
      "/bin/sh",
      ...nativeModules,
    ]),
  ];
  const paths = [
    ...new Set([...sources, ...packages, ...operatingSystemInputs]),
  ];
  const directories = paths.filter((candidate) =>
    lstatSync(candidate).isDirectory(),
  );
  const readOnlyPaths = paths.filter(
    (candidate) =>
      !directories.some(
        (other) => other !== candidate && within(other, candidate),
      ),
  );

  return prepareLinuxIsolationPolicy({
    ...input,
    cwd: WEB_DIRECTORY,
    readOnlyPaths,
    readOnlySymlinks: links,
    environmentKeys: [
      "NEXT_TELEMETRY_DISABLED",
      "LOG_LEVEL",
      "PORT",
      "DB_URL",
      "AUTH_SECRET",
      "MAISTER_RUNTIME_ROOT",
      "MAISTER_WORKTREES_ROOT",
      "MAISTER_SUPERVISOR_URL",
      "MAISTER_API_BASE_URL",
      "TSX_DISABLE_CACHE",
    ],
  });
}
