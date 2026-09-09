/** Runtime-object HTTP representations are unencoded and bounded per response. */
export const MAX_OBJECT_RESPONSE_BYTES = 8 * 1024 * 1024;

export function objectDigest(sha256: string): string {
  return `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`;
}

export function objectEtag(generation: number, sha256: string): string {
  return `"${generation}-${sha256}"`;
}

/** Accept exactly one canonical SHA-256 Structured Field byte sequence. */
export function parseObjectDigest(header: string | null): string | null {
  const match = /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(header ?? "");

  if (!match) return null;
  const bytes = Buffer.from(match[1], "base64");

  return bytes.length === 32 && bytes.toString("base64") === match[1]
    ? bytes.toString("hex")
    : null;
}

export function parseObjectEtag(
  header: string | null,
): { generation: number; sha256: string } | null {
  const match = /^"([1-9][0-9]*)-([a-f0-9]{64})"$/.exec(header ?? "");
  const generation = match ? Number(match[1]) : NaN;

  return match && Number.isSafeInteger(generation) && generation <= 2_147_483_647
    ? { generation, sha256: match[2] }
    : null;
}

export function parseObjectContentRange(
  header: string | null,
): { start: number; end: number; total: number; length: number } | null {
  const match = /^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/([1-9][0-9]*)$/.exec(header ?? "");

  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  const length = end - start + 1;

  return [start, end, total].every(Number.isSafeInteger) &&
    end >= start && end < total && length <= MAX_OBJECT_RESPONSE_BYTES
    ? { start, end, total, length }
    : null;
}

export function parseObjectContentLength(header: string | null): number | null {
  if (header === null || !/^(0|[1-9][0-9]*)$/.test(header)) return null;
  const length = Number(header);

  return Number.isSafeInteger(length) && length <= MAX_OBJECT_RESPONSE_BYTES
    ? length
    : null;
}
