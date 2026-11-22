import "server-only";

export { truncateUtf16 } from "./utf16";

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
