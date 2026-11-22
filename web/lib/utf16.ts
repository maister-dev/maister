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
