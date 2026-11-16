import "server-only";

// UTF-8-boundary-safe byte truncation. Returns the largest prefix whose UTF-8
// encoding is <= maxBytes without splitting a multibyte sequence.
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");

  if (buf.length <= maxBytes) return text;

  let end = maxBytes;

  // Walk back off any continuation byte (0b10xxxxxx) so we cut on a code-point
  // boundary — decoding the slice never yields a replacement char.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;

  return buf.subarray(0, end).toString("utf8");
}

/** Respect a UTF-16 schema limit without emitting a half of an astral code point. */
export function truncateUtf16(text: string, maxUnits: number): string {
  let end = Math.min(text.length, maxUnits);

  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);

    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      end -= 1;
  }

  return text.slice(0, end);
}
