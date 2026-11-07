export type SafeErrorCause = Readonly<{
  name: string;
  code?: string | number;
  syscall?: string;
  signal?: string;
}>;

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)
    ? value
    : undefined;
}

/** Keep error identity across realms without copying messages, paths or stderr. */
export function safeErrorCauseChain(error: unknown): readonly SafeErrorCause[] {
  const chain: SafeErrorCause[] = [];
  const seen = new Set<object>();
  let current: unknown = error;

  while (
    current !== null &&
    typeof current === "object" &&
    !seen.has(current) &&
    chain.length < 4
  ) {
    seen.add(current);
    const name = "name" in current ? safeToken(current.name) : undefined;
    const rawCode = "code" in current ? current.code : undefined;
    const code =
      typeof rawCode === "number" && Number.isSafeInteger(rawCode)
        ? rawCode
        : typeof rawCode === "string" && /^[0-9A-Z]{5}$/.test(rawCode)
          ? rawCode
          : safeToken(rawCode);
    const syscall =
      "syscall" in current ? safeToken(current.syscall) : undefined;
    const signal = "signal" in current ? safeToken(current.signal) : undefined;

    chain.push({
      name: name ?? "Error",
      ...(code === undefined ? {} : { code }),
      ...(syscall === undefined ? {} : { syscall }),
      ...(signal === undefined ? {} : { signal }),
    });
    current = "cause" in current ? current.cause : undefined;
  }

  return chain;
}
