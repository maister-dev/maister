import "server-only";

import type { PinnedCatalogSource } from "./catalog-sources";
import type { CatalogClient } from "./catalog-client";
import type { CatalogRequirements, SearchResult } from "./catalog-contract";

import { createHash } from "node:crypto";

import { z } from "zod";

import {
  isMcpDistribution,
  npmVersionPattern,
  npmNamePattern,
  npmBinPattern,
} from "../../../runtime/mcp-distribution";

import { CatalogError } from "./catalog-client";
import {
  catalogRequirementName,
  maxCatalogRequirementNames,
} from "./catalog-contract";

import { isBlockedAddress } from "@/lib/webhooks/destination";

const registry = "https://registry.modelcontextprotocol.io/v0.1/servers";
const identity = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
});
const descriptor = identity.extend({
  description: z.string().max(1600).optional(),
  title: z.string().max(256).optional(),
  remotes: z
    .array(
      z.object({
        type: z.string(),
        url: z.string(),
        headers: z.array(z.unknown()).optional(),
        variables: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
  packages: z
    .array(
      z.object({
        registryType: z.string(),
        identifier: z.string(),
        version: z.string().optional(),
        registryBaseUrl: z.string().optional(),
        transport: z.object({ type: z.string() }),
        runtimeArguments: z.array(z.unknown()).optional(),
        packageArguments: z.array(z.unknown()).optional(),
        environmentVariables: z.array(z.unknown()).optional(),
      }),
    )
    .default([]),
});

const namedSlot = z.object({ name: catalogRequirementName });

function declaredSlotNames(entries: readonly unknown[] = []): string[] {
  return entries.flatMap((entry) => {
    const parsed = namedSlot.safeParse(entry);

    return parsed.success ? [parsed.data.name] : [];
  });
}

/** Only identifiers cross the review boundary. Registry descriptions, defaults and literal endpoints may carry credentials. */
function reviewRequirements(
  names: readonly string[],
  key: (name: string) => string,
): CatalogRequirements | undefined {
  const visible = new Map<string, string>();

  for (const name of names) {
    if (
      !catalogRequirementName.safeParse(name).success ||
      visible.has(key(name))
    )
      continue;
    if (visible.size === maxCatalogRequirementNames)
      return { names: [...visible.values()], more: true };
    visible.set(key(name), name);
  }

  return visible.size
    ? { names: [...visible.values()], more: false }
    : undefined;
}

function requirementSummary(
  label: string,
  requirements?: CatalogRequirements,
): string {
  return requirements
    ? ` ${label} include ${requirements.names.join(", ")}${requirements.more ? " and more" : ""}.`
    : "";
}

export async function fetchRegistryPage(
  q: string,
  cursor: string | undefined,
  read: CatalogClient,
): Promise<{ results: SearchResult[]; cursor: string | null }> {
  const url = new URL(registry);

  url.searchParams.set("search", q);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", "30");
  if (cursor) url.searchParams.set("cursor", cursor);
  const data = z
    .object({
      servers: z.array(z.object({ server: identity })).max(30),
      metadata: z.object({
        nextCursor: z
          .string()
          .refine(
            (token) => Buffer.byteLength(token, "utf8") <= 1400,
            "Registry cursor exceeds the encoded query budget",
          )
          .optional(),
      }),
    })
    .parse(await read(url));

  return {
    results: data.servers.map(({ server }) => ({
      kind: "mcp",
      sourceId: "mcp-registry",
      resultId: server.name + "@" + server.version,
      name: server.name,
      publisher: server.name.split("/")[0],
    })),
    cursor: data.metadata.nextCursor ?? null,
  };
}

export async function registryDescriptor(
  selector: string,
  read: CatalogClient,
): Promise<PinnedCatalogSource> {
  const at = selector.lastIndexOf("@");

  if (at < 1 || at === selector.length - 1)
    throw new CatalogError(422, "Select a versioned Registry record");
  const name = selector.slice(0, at),
    version = selector.slice(at + 1);
  const url = new URL(
    registry +
      "/" +
      encodeURIComponent(name) +
      "/versions/" +
      encodeURIComponent(version),
  );
  const { server } = z.object({ server: descriptor }).parse(await read(url));

  if (
    server.name !== name ||
    (version !== "latest" && server.version !== version)
  )
    throw new CatalogError(
      422,
      "Registry response does not match reviewed identity",
    );

  return reviewMcp(
    server,
    {
      kind: "mcp",
      sourceId: "mcp-registry",
      selector: name + "@" + server.version,
      sourceUrl:
        registry +
        "/" +
        encodeURIComponent(name) +
        "/versions/" +
        encodeURIComponent(server.version),
      publisher: name.split("/")[0],
      name,
      pin: server.version,
      files: {},
      notices: [],
      configuration: [],
    },
    read,
  );
}

export async function reviewMcp(
  raw: unknown,
  source: PinnedCatalogSource,
  read: CatalogClient,
): Promise<PinnedCatalogSource> {
  const server = descriptor.parse(raw);
  const id = server.name
    .split("/")
    .at(-1)!
    .replace(/[^a-zA-Z0-9._-]/g, "-");

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,126}$/.test(id))
    throw new CatalogError(422, "MCP record has no usable local reference");
  if (server.remotes.length + server.packages.length !== 1)
    throw new CatalogError(
      422,
      "Choose a reviewed descriptor with exactly one remote or distribution",
    );
  const remote = server.remotes[0];

  if (remote) {
    if (
      remote.type !== "streamable-http" ||
      remote.headers?.length ||
      Object.keys(remote.variables ?? {}).length ||
      /[{}]/.test(remote.url)
    ) {
      const headers = reviewRequirements(
        declaredSlotNames(remote.headers),
        (name) => name.toLowerCase(),
      );
      const urlVariables = reviewRequirements(
        [
          ...Object.keys(remote.variables ?? {}),
          ...Array.from(
            remote.url.matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]{0,63})\}/g),
            (match) => match[1]!,
          ),
        ],
        (name) => name,
      );

      throw new CatalogError(
        422,
        "Only concrete Streamable HTTP endpoints without required credentials are supported." +
          requirementSummary("Header names", headers) +
          requirementSummary("URL variables", urlVariables),
        { reason: "remote_requirements_unsupported", headers, urlVariables },
      );
    }
    if (!URL.canParse(remote.url))
      throw new CatalogError(422, "Invalid MCP endpoint");
    const url = new URL(remote.url);
    const host = url.hostname.replace(/^\[|\]$/g, "");

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !host.includes(".") ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      isBlockedAddress(host)
    )
      throw new CatalogError(422, "MCP requires a public HTTPS endpoint");

    return {
      ...source,
      configuration: ["Streamable HTTP", url.href],
      mcp: {
        id,
        transport: "http",
        url: url.href,
        ...(server.description ? { description: server.description } : {}),
      },
    };
  }
  const pkg = server.packages[0];

  if (
    pkg.registryType !== "npm" ||
    pkg.transport.type !== "stdio" ||
    !pkg.version ||
    !npmVersionPattern.test(pkg.version) ||
    (pkg.registryBaseUrl &&
      pkg.registryBaseUrl.replace(/\/$/, "") !==
        "https://registry.npmjs.org") ||
    !npmNamePattern.test(pkg.identifier) ||
    pkg.runtimeArguments?.length ||
    pkg.packageArguments?.length ||
    pkg.environmentVariables?.length
  ) {
    const environmentVariables = reviewRequirements(
      declaredSlotNames(pkg.environmentVariables),
      (name) => name,
    );

    throw new CatalogError(
      422,
      "This distribution requires unsupported installation or configuration." +
        requirementSummary("Environment variables", environmentVariables),
      { reason: "distribution_requirements_unsupported", environmentVariables },
    );
  }
  const metadata = z
    .object({
      name: z.string(),
      version: z.string(),
      mcpName: z.string(),
      dist: z.object({
        integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
      }),
      bin: z.union([z.string(), z.record(z.string(), z.string())]),
      license: z.string().optional(),
      peerDependencies: z.record(z.string(), z.unknown()).optional(),
      os: z.array(z.string()).optional(),
      cpu: z.array(z.string()).optional(),
      dependencies: z.record(z.string(), z.unknown()).optional(),
      optionalDependencies: z.record(z.string(), z.unknown()).optional(),
      scripts: z.record(z.string(), z.string()).optional(),
    })
    .parse(
      await read(
        new URL(
          "https://registry.npmjs.org/" +
            encodeURIComponent(pkg.identifier) +
            "/" +
            encodeURIComponent(pkg.version),
        ),
      ),
    );
  const bins =
    typeof metadata.bin === "string"
      ? [pkg.identifier.split("/").at(-1)!]
      : Object.keys(metadata.bin);

  if (
    metadata.name !== pkg.identifier ||
    metadata.version !== pkg.version ||
    metadata.mcpName !== server.name ||
    bins.length !== 1 ||
    !npmBinPattern.test(bins[0]) ||
    !metadata.license?.trim() ||
    Object.keys(metadata.peerDependencies ?? {}).length ||
    Object.keys(metadata.dependencies ?? {}).length ||
    Object.keys(metadata.optionalDependencies ?? {}).length ||
    ["preinstall", "install", "postinstall"].some((k) =>
      Object.hasOwn(metadata.scripts ?? {}, k),
    )
  )
    throw new CatalogError(
      422,
      "npm artifact must be publisher-linked, self-contained and provide one executable without install hooks",
    );
  const executable = bins[0],
    integrity = metadata.dist.integrity;
  const artifactDigest = createHash("sha256")
    .update(
      JSON.stringify([
        server.name,
        pkg.identifier,
        pkg.version,
        integrity,
        executable,
      ]),
    )
    .digest("hex");
  const distribution = {
    registryName: server.name,
    packageName: pkg.identifier,
    version: pkg.version,
    integrity,
    executable,
    artifactDigest,
    runtime: "node" as const,
  };

  if (!isMcpDistribution(distribution))
    throw new CatalogError(422, "Unsupported npm distribution identity");

  return {
    ...source,
    notices: metadata.license
      ? [...source.notices, metadata.license]
      : source.notices,
    configuration: [
      "npm/stdio",
      pkg.identifier + "@" + pkg.version,
      integrity,
      executable,
      ...(metadata.os?.length ? ["os: " + metadata.os.join(", ")] : []),
      ...(metadata.cpu?.length ? ["cpu: " + metadata.cpu.join(", ")] : []),
    ],
    mcp: { id, transport: "stdio", command: executable, distribution },
  };
}
