export const SUPPORTED_NODE_RANGE = ">=24.15.0 <25 || >=26.13.0 <27";

export class RuntimeVersionError extends Error {
  constructor(version: string) {
    super(`MAIster requires Node ${SUPPORTED_NODE_RANGE}; received ${version}`);
    this.name = "RuntimeVersionError";
  }
}

/** Both server entrypoints validate before opening durable stores or listeners. */
export function assertSupportedNode(version: string): void {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

  if (!parts) throw new RuntimeVersionError(version);
  const major = Number(parts[1]);
  const minor = Number(parts[2]);

  if (!((major === 24 && minor >= 15) || (major === 26 && minor >= 13)))
    throw new RuntimeVersionError(version);
}
