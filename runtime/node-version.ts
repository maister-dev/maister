export const SUPPORTED_NODE_RANGE = ">=24.15.0 <25";

export class RuntimeVersionError extends Error {
  constructor(version: string) {
    super(`MAIster requires Node ${SUPPORTED_NODE_RANGE}; received ${version}`);
    this.name = "RuntimeVersionError";
  }
}

/** Both server entrypoints validate before opening durable stores or listeners. */
export function assertSupportedNode(version: string): void {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

  if (!parts || Number(parts[1]) !== 24 || Number(parts[2]) < 15)
    throw new RuntimeVersionError(version);
}
