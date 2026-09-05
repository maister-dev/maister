import { SupervisorError } from "./types";

const STRING_CHUNK_CHARS = 8192;

function invalidContent(): SupervisorError {
  return new SupervisorError(
    "ACP_PROTOCOL",
    "session content is not bounded plain JSON",
    {
      details: { reason: "required_output_incomplete" },
    },
  );
}

/** Encodes strings without building a second complete escaped string or buffer. */
function* stringParts(value: string): Generator<string> {
  yield '"';
  for (let offset = 0; offset < value.length; ) {
    let end = Math.min(offset + STRING_CHUNK_CHARS, value.length);
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);

    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      end -= 1;
    yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
    offset = end;
  }
  yield '"';
}

function* jsonParts(value: unknown, depth: number): Generator<string> {
  if (depth > 40) throw invalidContent();
  if (typeof value === "string") {
    yield* stringParts(value);
  } else if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    yield JSON.stringify(value);
  } else if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) yield ",";
      yield* jsonParts(
        value[index] === undefined ? null : value[index],
        depth + 1,
      );
    }
    yield "]";
  } else if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    yield "{";
    let separator = "";

    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      yield separator;
      yield* stringParts(key);
      yield ":";
      yield* jsonParts(entry, depth + 1);
      separator = ",";
    }
    yield "}";
  } else {
    throw invalidContent();
  }
}

/** Same bytes as JSON.stringify for session JSON, in chunks of at most 48 KiB. */
export function* encodeSessionContent(
  value: Record<string, unknown>,
): Generator<Uint8Array> {
  const encoder = new TextEncoder();

  for (const part of jsonParts(value, 0)) yield encoder.encode(part);
}
