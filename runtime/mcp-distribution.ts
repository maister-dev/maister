/** Exact identity of a self-contained npm stdio distribution. */
export type McpDistribution = {
  registryName: string;
  packageName: string;
  version: string;
  integrity: string;
  executable: string;
  artifactDigest: string;
  runtime: "node";
};

export const npmNamePattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const npmVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const npmBinPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isMcpDistribution(value: unknown): value is McpDistribution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  return (
    Object.keys(d).length === 7 &&
    d.runtime === "node" &&
    typeof d.registryName === "string" &&
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(d.registryName) &&
    d.registryName.length <= 255 &&
    typeof d.packageName === "string" &&
    d.packageName.length <= 214 &&
    npmNamePattern.test(d.packageName) &&
    typeof d.version === "string" &&
    d.version.length <= 128 &&
    npmVersionPattern.test(d.version) &&
    typeof d.integrity === "string" &&
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(d.integrity) &&
    typeof d.executable === "string" &&
    d.executable.length <= 128 &&
    npmBinPattern.test(d.executable) &&
    typeof d.artifactDigest === "string" &&
    /^[a-f0-9]{64}$/.test(d.artifactDigest)
  );
}

export type McpPreparationRequest = McpDistribution & { refId: string };
export type McpPreparationReceipt = {
  hostId: string;
  commandId: string;
  assignmentEpoch: number;
  artifactDigest: string;
  runtime: string;
  cacheHit: boolean;
};
