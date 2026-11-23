import type { PackageInstallManifest } from "./attach";

export const ATTACHMENT_ORIGIN = "package-attachment";

/** Reproduce an attached server from the exact immutable release, including during an in-flight adoption. */
export function packageMcpMaterial(
  mcp: PackageInstallManifest["spec"]["mcps"][number],
  installId: string,
): Record<string, unknown> {
  const env = { ...(mcp.env ?? {}) };
  const isRequirement =
    mcp.command === undefined &&
    mcp.url === undefined &&
    mcp.transport === undefined;

  return isRequirement
    ? {
        origin: ATTACHMENT_ORIGIN,
        packageInstallId: installId,
        requirement: true,
        // A requirement declares SLOTS: the map keys. Since ADR-179 that is
        // also what `resolveBindTarget` reads, so an overlay against a
        // requirement or a package TEMPLATE can finally name them.
        env,
        headers: {},
        ...(mcp.recommendedPlatformServerId !== undefined
          ? { recommendedPlatformServerId: mcp.recommendedPlatformServerId }
          : {}),
      }
    : {
        origin: ATTACHMENT_ORIGIN,
        packageInstallId: installId,
        ...(mcp.transport !== undefined ? { transport: mcp.transport } : {}),
        ...(mcp.command !== undefined ? { command: mcp.command } : {}),
        ...(mcp.distribution ? { distribution: mcp.distribution } : {}),
        args: mcp.args ?? [],
        env,
        ...(mcp.url !== undefined ? { url: mcp.url } : {}),
        // Rebuilt wholesale per ingestion, so a version that DROPS these
        // leaves no stale entry behind (SET/CLEAR symmetry).
        headers: { ...(mcp.headers ?? {}) },
        bearerTokenEnv: mcp.bearerTokenEnv ?? null,
        ...(mcp.recommendedPlatformServerId !== undefined
          ? { recommendedPlatformServerId: mcp.recommendedPlatformServerId }
          : {}),
      };
}
